import { normInv, normGstin, normName } from "./sheetParser.js";

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const TOL = 1;
export const MONEY = ["taxable", "igst", "cgst", "sgst", "cess"];
const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
const sumTax = (t) => r2((t.igst || 0) + (t.cgst || 0) + (t.sgst || 0) + (t.cess || 0));
const FIELD_LABEL = { taxable: "Taxable value", igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess" };

export function periodsBetween(from, to) {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}

export function fyPeriods(fy) {
  const y = Number(String(fy).slice(0, 4));
  return periodsBetween(`${y}-04`, `${y + 1}-03`);
}

/** credit notes reduce, everything else adds */
export function prep(rows) {
  return rows.map((r) => {
    const s = r.type === "cn" ? -1 : 1;
    return { ...r, taxable: r.taxable * s, igst: r.igst * s, cgst: r.cgst * s, sgst: r.sgst * s, cess: (r.cess || 0) * s };
  });
}

function add(t, r) { for (const f of MONEY) t[f] = r2((t[f] || 0) + (Number(r[f]) || 0)); return t; }
export function totalOf(rows) { return rows.reduce(add, zero()); }
export function groupTotals(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, { ...zero(), docs: new Set() }); const t = m.get(k); add(t, r); t.docs.add(`${r.gstin || r.party}|${r.inv_no}|${r.type}`); }
  return m;
}

const partyKey = (r) => normGstin(r.gstin) || `N:${normName(r.party)}`;
const docKey = (r) => `${partyKey(r)}|${normInv(r.inv_no)}|${r.type === "cn" ? "cn" : r.type === "dn" ? "dn" : "inv"}`;

export function aggregateDocs(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = docKey(r);
    let d = m.get(k);
    if (!d) { d = { key: k, gstin: r.gstin || "", party: r.party || "", inv_no: r.inv_no || "", type: r.type, date: r.date, period: r.period, ...zero(), rates: new Set() }; m.set(k, d); }
    add(d, r);
    if (r.rate) d.rates.add(r.rate);
    if (!d.party && r.party) d.party = r.party;
    if (!d.gstin && r.gstin) d.gstin = r.gstin;
  }
  return m;
}

const near = (a, b) => Math.abs(a - b) <= TOL;
const taxOf = (d) => d.igst + d.cgst + d.sgst + d.cess;
const diffFields = (a, b) => MONEY.filter((f) => !near(a[f] || 0, b[f] || 0));

const KIND_TEXT = {
  value_mismatch: { sev: "high" }, only_a: { sev: "high" }, only_b: { sev: "high" },
  gstin_mismatch: { sev: "high" }, invno_mismatch: { sev: "medium" }, tax_type: { sev: "high" },
  rate_mismatch: { sev: "medium" }, rounding: { sev: "low" }, period_mismatch: { sev: "medium" },
};

/** reason + action text, by context ("output" books-vs-GSTR-1, "input" books-vs-GSTR-2B). */
function explain(ctx, kind, doc) {
  const out = ctx === "output";
  const A = out ? "books" : "books", B = out ? "GSTR-1 (portal)" : "GSTR-2B";
  const T = {
    only_a: out
      ? ["Invoice is in the books but is not reported in the GSTR-1 downloaded from the portal. Likely omitted from the return, reported in a later month, or filed under a different invoice number / GSTIN.", "Check the later months' GSTR-1. If it is not reported anywhere, report it in the next GSTR-1 (current-period table or amendment) and pay the tax with interest u/s 50 through the next GSTR-3B. Keep this in view for GSTR-9 Table 10/11."]
      : ["Purchase is in the books but not reflected in GSTR-2B. The supplier may not have filed GSTR-1 / IFF on time, may have reported it in a later period or under a wrong GSTIN.", "Follow up with the supplier to file / correct. Do not claim ITC beyond what is in GSTR-2B (Rule 36(4) / s.16(2)(aa)). If ITC was already claimed, reverse it and re-claim once the invoice appears in GSTR-2B (before the s.16(4) time limit)."],
    only_b: out
      ? ["Reported in the GSTR-1 on the portal but not found in the books. Possible duplicate entry, cancelled / returned invoice not reversed in GSTR-1, wrong GSTIN of the client, or the sale was not recorded in the books.", "Verify with the client. If the sale is genuine, record it in the books. If it is wrong, amend it through the amendment tables of the next GSTR-1 (credit note / amendment) and adjust the liability in GSTR-3B."]
      : ["Appears in GSTR-2B but not in the purchase books. Likely a purchase not yet booked, a supplier's wrong GSTIN entry (not the client's purchase), or a duplicate.", "Confirm with the supplier and the client. If it is genuine, book it and claim ITC; if it belongs to someone else, ignore it and ask the supplier to amend. Do not claim ITC without the invoice / goods received."],
    gstin_mismatch: [`Same document number but the party GSTIN differs between books and ${B}. Usually a wrong GSTIN in the books or in the return.`, out ? "Correct the GSTIN: amend through B2B amendment (table 9A) in GSTR-1 if the return is wrong, or correct the master in the books." : "Update the supplier GSTIN in the books; ask the supplier to correct if the portal GSTIN is wrong. ITC is allowed only against the correct GSTIN."],
    invno_mismatch: [`Same party and same amounts but the invoice number differs between books and ${B} (typing error, prefix / zero difference, or different numbering series).`, out ? "Correct the invoice number in the books or amend it in GSTR-1 (table 9A) so that the number is uniform." : "Correct the invoice number in the books to match the supplier's invoice so the ITC tracks to GSTR-2B."],
    tax_type: [`The same value is charged as IGST in one source and CGST+SGST in the other - the place of supply / tax type differs.`, out ? "Check the place of supply. If GSTR-1 is wrong, amend it and adjust the IGST/CGST/SGST liability in GSTR-3B (cross-utilisation is refundable via RFD-01 if tax was paid under the wrong head, s.77)." : "Check the place of supply with the supplier. The ITC head follows GSTR-2B; ask the supplier to amend and avoid claiming under the wrong head."],
    rate_mismatch: [`Tax rate differs between books and ${B} (taxable value is comparable but the tax charged is different).`, out ? "Verify the correct rate / HSN. If the books are correct, amend the GSTR-1; if the return is right, correct the books and the invoice. Differential tax is payable with interest if the return under-reported it." : "Verify the rate with the supplier's invoice. Claim ITC only for the tax actually charged / shown in GSTR-2B."],
    value_mismatch: [`Taxable value or tax amount differs between books and ${B}. Typical causes: discount / freight / round-off treated differently, partial invoice reported, wrong amount keyed or an amendment not carried in the books.`, out ? "Compare the invoice with both records. Amend GSTR-1 (table 9A) if the return is wrong, or correct the books. If tax was short-reported, pay the difference with interest in the next GSTR-3B." : "Match with the supplier's invoice. Claim the lower of books and GSTR-2B until the supplier amends."],
    rounding: ["Minor rounding difference.", "No action needed beyond a rounding adjustment; consider a standard round-off ledger."],
    period_mismatch: [`The document is in both records but in different months (invoice date / return period differs) - a timing difference.`, out ? "No tax loss if reported in a later period, but check interest on late reporting and make sure the annual totals (GSTR-9 Tables 4/10/11) agree." : "ITC can be claimed in the month the invoice appears in GSTR-2B (not before). Check that it was not claimed earlier; reverse and re-claim if it was."],
  };
  const [reason, action] = T[kind] || ["Difference found.", "Review the document."];
  void A; void doc;
  return { reason, action };
}

/** Compare two row sets at document level. Returns exceptions[] and match stats. */
export function matchDocuments(rowsA, rowsB, ctx) {
  const A = aggregateDocs(rowsA), B = aggregateDocs(rowsB);
  const ex = [];
  let matched = 0;
  const onlyA = new Map(), onlyB = new Map();
  for (const [k, a] of A) {
    const b = B.get(k);
    if (!b) { onlyA.set(k, a); continue; }
    const df = diffFields(a, b);
    const periodDiff = a.period && b.period && a.period !== b.period;
    if (!df.length) {
      if (periodDiff) ex.push(exception(ctx, "period_mismatch", a, b));
      else matched++;
      continue;
    }
    let kind = "value_mismatch";
    const aInter = a.igst > 0, bInter = b.igst > 0;
    if (near(a.taxable, b.taxable) && near(taxOf(a), taxOf(b)) && aInter !== bInter) kind = "tax_type";
    else if (near(a.taxable, b.taxable) && !near(taxOf(a), taxOf(b))) kind = "rate_mismatch";
    else if (df.every((f) => Math.abs((a[f] || 0) - (b[f] || 0)) <= 5)) kind = "rounding";
    ex.push(exception(ctx, kind, a, b));
  }
  for (const [k, b] of B) if (!A.has(k)) onlyB.set(k, b);

  // second pass: same invoice number, different GSTIN
  const bByInv = new Map();
  for (const b of onlyB.values()) { const k = `${normInv(b.inv_no)}|${b.type}`; (bByInv.get(k) || bByInv.set(k, []).get(k)).push(b); }
  for (const [k, a] of [...onlyA]) {
    const c = bByInv.get(`${normInv(a.inv_no)}|${a.type}`);
    if (normInv(a.inv_no) && c && c.length === 1 && near(a.taxable, c[0].taxable)) {
      ex.push(exception(ctx, "gstin_mismatch", a, c[0]));
      onlyA.delete(k); onlyB.delete(c[0].key);
    }
  }
  // third pass: same party and same amounts, different invoice number
  const bByAmt = new Map();
  for (const b of onlyB.values()) { const k = `${partyKey(b)}|${Math.round(b.taxable)}|${Math.round(taxOf(b))}`; (bByAmt.get(k) || bByAmt.set(k, []).get(k)).push(b); }
  for (const [k, a] of [...onlyA]) {
    const c = bByAmt.get(`${partyKey(a)}|${Math.round(a.taxable)}|${Math.round(taxOf(a))}`);
    if (c && c.length === 1 && onlyB.has(c[0].key)) {
      ex.push(exception(ctx, "invno_mismatch", a, c[0]));
      onlyA.delete(k); onlyB.delete(c[0].key);
    }
  }
  for (const a of onlyA.values()) ex.push(exception(ctx, "only_a", a, null));
  for (const b of onlyB.values()) ex.push(exception(ctx, "only_b", null, b));
  const sevOrder = { high: 0, medium: 1, low: 2 };
  ex.sort((x, y) => sevOrder[x.severity] - sevOrder[y.severity] || Math.abs(y.tax_diff + y.taxable_diff) - Math.abs(x.tax_diff + x.taxable_diff));
  return { exceptions: ex, matched, docs_a: A.size, docs_b: B.size };
}

function exception(ctx, kind, a, b) {
  const ref = a || b;
  const { reason, action } = explain(ctx, kind, ref);
  const ta = a ? a.taxable : 0, tb = b ? b.taxable : 0;
  const xa = a ? taxOf(a) : 0, xb = b ? taxOf(b) : 0;
  return {
    kind, severity: KIND_TEXT[kind].sev,
    party: ref.party, gstin: ref.gstin || (a && b ? b.gstin : ""), inv_no: ref.inv_no, doc_type: ref.type === "cn" ? "Credit note" : ref.type === "dn" ? "Debit note" : "Invoice",
    date_a: a?.date || "", date_b: b?.date || "", period_a: a?.period || "", period_b: b?.period || "",
    taxable_a: r2(ta), taxable_b: r2(tb), tax_a: r2(xa), tax_b: r2(xb),
    taxable_diff: r2(ta - tb), tax_diff: r2(xa - xb),
    gstin_b: b?.gstin || "", inv_no_b: b?.inv_no || "",
    reason, action,
  };
}

const KIND_LABEL = {
  only_a: (c) => (c === "output" ? "In books, not in GSTR-1" : "In books, not in GSTR-2B"),
  only_b: (c) => (c === "output" ? "In GSTR-1, not in books" : "In GSTR-2B, not in books"),
  value_mismatch: () => "Amount mismatch", gstin_mismatch: () => "GSTIN mismatch", invno_mismatch: () => "Invoice no. mismatch",
  tax_type: () => "IGST vs CGST/SGST", rate_mismatch: () => "Tax rate mismatch", rounding: () => "Rounding", period_mismatch: () => "Month mismatch",
};
export const kindLabel = (ctx, kind) => KIND_LABEL[kind](ctx);

/* ------------------------------- table builders ------------------------------- */

const money = (key, label) => ({ key, label, type: "money" });

export function measureColumns(fields, labelA, labelB, lead) {
  const cols = [...lead];
  for (const f of fields) cols.push(money(`${f}_a`, `${FIELD_LABEL[f]} - ${labelA}`), money(`${f}_b`, `${FIELD_LABEL[f]} - ${labelB}`), { ...money(`${f}_d`, `${FIELD_LABEL[f]} diff`), diff: true });
  cols.push({ key: "status", label: "Status", type: "status" });
  return cols;
}

export function measureRow(lead, a, b, fields) {
  const row = { ...lead };
  let ok = true;
  for (const f of fields) {
    row[`${f}_a`] = r2(a?.[f] || 0); row[`${f}_b`] = r2(b?.[f] || 0); row[`${f}_d`] = r2(row[`${f}_a`] - row[`${f}_b`]);
    if (Math.abs(row[`${f}_d`]) > TOL) ok = false;
  }
  row.status = ok ? "Matched" : "Difference";
  return row;
}

export function totalRow(rows, fields, lead) {
  const t = { ...lead };
  for (const f of fields) for (const s of ["a", "b", "d"]) t[`${f}_${s}`] = r2(rows.reduce((x, r) => x + (r[`${f}_${s}`] || 0), 0));
  t.status = fields.every((f) => Math.abs(t[`${f}_d`]) <= TOL) ? "Matched" : "Difference";
  t._total = true;
  return t;
}

export function monthlyTable({ periods, a, b, fields, labelA, labelB, skip = new Set() }) {
  const ta = groupTotals(a, (r) => r.period), tb = groupTotals(b, (r) => r.period);
  const rows = periods.map((p) => {
    const row = measureRow({ period: p, docs_a: ta.get(p)?.docs.size || 0, docs_b: tb.get(p)?.docs.size || 0 }, ta.get(p), tb.get(p), fields);
    if (skip.has(p)) { row.status = "No file"; }
    return row;
  });
  const t = totalRow(rows.filter((r) => r.status !== "No file"), fields, { period: "Total", docs_a: 0, docs_b: 0 });
  t.docs_a = rows.reduce((x, r) => x + r.docs_a, 0); t.docs_b = rows.reduce((x, r) => x + r.docs_b, 0);
  return {
    columns: measureColumns(fields, labelA, labelB, [{ key: "period", label: "Month", type: "period" }, { key: "docs_a", label: `Docs - ${labelA}`, type: "int" }, { key: "docs_b", label: `Docs - ${labelB}`, type: "int" }]),
    rows: [...rows, t],
  };
}

export function rateTable({ a, b, fields, labelA, labelB }) {
  const ta = groupTotals(a, (r) => r.rate || 0), tb = groupTotals(b, (r) => r.rate || 0);
  const rates = [...new Set([...ta.keys(), ...tb.keys()])].sort((x, y) => x - y);
  const rows = rates.map((rt) => measureRow({ rate: `${rt}%` }, ta.get(rt), tb.get(rt), fields));
  return { columns: measureColumns(fields, labelA, labelB, [{ key: "rate", label: "Tax rate", type: "text" }]), rows: [...rows, totalRow(rows, fields, { rate: "Total" })] };
}

export function partyTable({ a, b, fields, labelA, labelB }) {
  const mk = (rows) => { const m = new Map(); for (const r of rows) { const k = partyKey(r); if (!m.has(k)) m.set(k, { ...zero(), gstin: r.gstin || "", party: r.party || "", docs: new Set() }); const t = m.get(k); add(t, r); t.docs.add(docKey(r)); if (!t.gstin && r.gstin) t.gstin = r.gstin; if (!t.party && r.party) t.party = r.party; } return m; };
  const A = mk(a), B = mk(b);
  const keys = [...new Set([...A.keys(), ...B.keys()])];
  const rows = keys.map((k) => {
    const x = A.get(k), y = B.get(k);
    return measureRow({ gstin: x?.gstin || y?.gstin || "", party: x?.party || y?.party || "", docs_a: x?.docs.size || 0, docs_b: y?.docs.size || 0 }, x, y, fields);
  }).sort((p, q) => Math.abs(q.taxable_d || 0) + Math.abs(q.igst_d || 0) + Math.abs(q.cgst_d || 0) - Math.abs(p.taxable_d || 0) - Math.abs(p.igst_d || 0) - Math.abs(p.cgst_d || 0));
  return {
    columns: measureColumns(fields, labelA, labelB, [{ key: "gstin", label: "GSTIN", type: "text" }, { key: "party", label: "Party", type: "text" }, { key: "docs_a", label: `Docs - ${labelA}`, type: "int" }, { key: "docs_b", label: `Docs - ${labelB}`, type: "int" }]),
    rows: [...rows, totalRow(rows, fields, { gstin: "", party: "Total" })],
  };
}

export function exceptionTable(ex, ctx, labelA, labelB) {
  return {
    columns: [
      { key: "severity", label: "Severity", type: "status" }, { key: "kind_label", label: "Issue", type: "text" }, { key: "party", label: "Party", type: "text" }, { key: "gstin", label: "GSTIN", type: "text" },
      { key: "inv_no", label: "Document no.", type: "text" }, { key: "doc_type", label: "Type", type: "text" }, { key: "period_a", label: `Month - ${labelA}`, type: "period" }, { key: "period_b", label: `Month - ${labelB}`, type: "period" },
      money("taxable_a", `Taxable - ${labelA}`), money("taxable_b", `Taxable - ${labelB}`), { ...money("taxable_diff", "Taxable diff"), diff: true },
      money("tax_a", `Tax - ${labelA}`), money("tax_b", `Tax - ${labelB}`), { ...money("tax_diff", "Tax diff"), diff: true },
      { key: "reason", label: "Possible reason", type: "long" }, { key: "action", label: "Recommended action", type: "long" },
    ],
    rows: ex.map((e) => ({ ...e, kind_label: kindLabel(ctx, e.kind) })),
  };
}

export function docListTable(rows, title) {
  const docs = [...aggregateDocs(rows).values()].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.inv_no).localeCompare(String(b.inv_no)));
  return {
    title,
    columns: [
      { key: "period", label: "Month", type: "period" }, { key: "date", label: "Date", type: "text" }, { key: "inv_no", label: "Document no.", type: "text" }, { key: "doc_type", label: "Type", type: "text" },
      { key: "gstin", label: "GSTIN", type: "text" }, { key: "party", label: "Party", type: "text" }, { key: "rates", label: "Rate(s)", type: "text" },
      money("taxable", "Taxable value"), money("igst", "IGST"), money("cgst", "CGST"), money("sgst", "SGST"), money("cess", "Cess"),
    ],
    rows: docs.map((d) => ({ ...d, doc_type: d.type === "cn" ? "Credit note" : d.type === "dn" ? "Debit note" : "Invoice", rates: [...d.rates].sort((x, y) => x - y).map((x) => `${x}%`).join(", "), rates_set: undefined })),
  };
}

export function discrepancyList(ex, area, limit = 500) {
  return ex.slice(0, limit).map((e) => ({
    severity: e.severity, area, issue: kindLabel(area.startsWith("Input") ? "input" : "output", e.kind), period: e.period_a || e.period_b, party: e.party, gstin: e.gstin,
    ref: e.inv_no, amount: r2(Math.abs(e.tax_diff) || Math.abs(e.taxable_diff)), reason: e.reason, action: e.action,
  }));
}

/** annotate month rows of a measure table with a reason for the difference */
export function annotateMonths(table, reasonFn) {
  table.columns.splice(table.columns.length, 0, { key: "reason", label: "Possible reason", type: "long" }, { key: "action", label: "Recommended action", type: "long" });
  for (const r of table.rows) {
    if (r.status !== "Difference") continue;
    const x = reasonFn(r);
    r.reason = x.reason; r.action = x.action;
  }
  return table;
}

export function monthDiscrepancies(table, area, reasonFn, fields) {
  const out = [];
  for (const r of table.rows) {
    if (r._total || r.status !== "Difference") continue;
    const x = reasonFn(r);
    out.push({ severity: "high", area, issue: "Month-wise difference", period: r.period, party: "", gstin: "", ref: fields.filter((f) => Math.abs(r[`${f}_d`]) > TOL).map((f) => `${FIELD_LABEL[f]} ${r[`${f}_d`] > 0 ? "+" : ""}${r[`${f}_d`]}`).join("; "), amount: r2(fields.reduce((s, f) => s + Math.abs(r[`${f}_d`] || 0), 0) - (fields.includes("taxable") ? Math.abs(r.taxable_d || 0) : 0)), reason: x.reason, action: x.action });
  }
  return out;
}

export { zero, sumTax, r2, partyKey, docKey, FIELD_LABEL };
