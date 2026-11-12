import { r2, monthsOfFy, monthLabel, monthOf } from "../banking/common.js";
import { normInv, normName } from "../recon/sheetParser.js";
import { validGstin } from "../gstRules.js";
import { nameScore, tokensOf } from "../banking/parties.js";
import { categoryOf, tdsTcsKind } from "./workDocs.js";
import { latestByMonth } from "./reco.js";
import { buildRcmReco } from "./rcmReco.js";

/**
 * The final reconciliation of the input side: the books (ITC register and TDS / TCS ledgers), GSTR-2B and the finalised GSTR-3B
 * working, set against each other month by month, party by party and document by document.
 * Every line, whichever side it comes from, is { side, month, party, gstin, no, date, type, category, igst, cgst, sgst, cess, tot }.
 */

export const HEADS = ["igst", "cgst", "sgst", "cess"];
/** What is compared: normal ITC and credit / debit notes. Reverse charge is compared in its own rows; the rest is shown for information. */
const ITC_CATEGORIES = ["Normal ITC", "Credit / debit note"];
const COMPARABLE = [...ITC_CATEGORIES, "RCM"];
const TOLERANCE = 1;

const zero = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0, tot: 0 });
const addTo = (a, l) => { for (const h of HEADS) a[h] += l[h] || 0; a.tot += l.tot ?? HEADS.reduce((s, h) => s + (l[h] || 0), 0); return a; };
const round = (a) => ({ igst: r2(a.igst), cgst: r2(a.cgst), sgst: r2(a.sgst), cess: r2(a.cess), tot: r2(a.tot) });
export const sumLines = (lines) => round(lines.reduce(addTo, zero()));
const minus = (a, b) => ({ igst: r2(a.igst - b.igst), cgst: r2(a.cgst - b.cgst), sgst: r2(a.sgst - b.sgst), cess: r2(a.cess - b.cess), tot: r2(a.tot - b.tot) });
const same = (d) => HEADS.every((h) => Math.abs(d[h]) <= TOLERANCE) && Math.abs(d.tot) <= TOLERANCE * 2;

const line = (side, o) => {
  const tax = { igst: o.igst || 0, cgst: o.cgst || 0, sgst: o.sgst || 0, cess: o.cess || 0 };
  return { side, month: o.month || "", party: o.party || "", gstin: o.gstin || "", no: o.no || "", date: o.date || "", type: o.type || "inv", category: o.category, file: o.file || "", taxable: o.taxable || 0, ...tax, tot: o.tot ?? HEADS.reduce((s, h) => s + tax[h], 0), treat: o.treat || "" };
};

/* ------------------------------------------------------------------ the lines of each side */

/** Books: the register lines (from buildItcRows) and the TDS / TCS ledger entries. */
export function booksLines(registerRows, tdsTcsFiles) {
  const out = registerRows.map((r) => line("Books", {
    month: r.month, party: r.party, gstin: r.gstin, no: r.no, date: r.date, file: r.file, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess,
    type: /credit/i.test(r.doc) ? "cn" : /debit/i.test(r.doc) ? "dn" : "inv",
    category: /credit|debit/i.test(r.doc) ? "Credit / debit note" : r.rcmFlag ? "RCM" : /exempt/i.test(r.kind) ? "Exempt / nil" : "Normal ITC",
    // reverse charge: the ITC is the tax the books show as paid
    ...(r.rcmFlag && !r.itc ? { tot: r.rcm } : {}),
  }));
  for (const f of tdsTcsFiles) {
    for (const e of f.data?.entries || []) {
      const text = `${e.party} ${e.narration}`;
      const category = tdsTcsKind(text) || "TDS / TCS";
      out.push(line("Books", { month: monthOf(e.date), party: e.party, no: e.vchNo, date: e.date, file: f.name, category, tot: r2((e.debit || 0) - (e.credit || 0)) }));
    }
  }
  return out;
}

/** GSTR-2B: every line, with the month of its file. */
export function g2bLines(g2bFiles) {
  return g2bFiles.flatMap((f) => (f.data?.rows || []).map((r) => {
    const s = r.type === "cn" ? -1 : 1;
    return line("GSTR-2B", {
      month: f.period || "", party: r.party, gstin: r.gstin, no: r.inv_no, date: r.date, file: f.name, type: r.type === "cn" ? "cn" : r.type === "dn" ? "dn" : "inv",
      igst: s * (r.igst || 0), cgst: s * (r.cgst || 0), sgst: s * (r.sgst || 0), cess: s * (r.cess || 0),
      category: tdsTcsKind(`${r.party} ${r.reason} ${r.src}`) || (r.reverse ? "RCM" : r.avail === "No" ? "ITC not available" : r.src === "impg" ? "Import" : r.src === "isd" ? "ISD" : r.type === "cn" || r.type === "dn" ? "Credit / debit note" : "Normal ITC"),
    });
  }));
}

/** The finalised 3B working: the documents of the final file, or else of the latest working of each month. */
export function tbLines(finalFile, workFiles) {
  const fromDocs = (docs, file) => docs.map((d) => line("GSTR-3B", {
    month: d.month || "", party: d.party, gstin: d.gstin, no: d.inv_no, date: d.date, file, type: d.type, category: categoryOf(d),
    igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess, treat: d.treat, taxable: d.taxable,
  }));
  if (finalFile?.data?.docs?.length) return { lines: fromDocs(finalFile.data.docs, finalFile.name), source: "final", name: finalFile.name };
  const { byMonth } = latestByMonth(workFiles.filter((f) => f.data));
  const lines = [...byMonth.values()].flatMap((f) => fromDocs((f.data.docs || []).map((d) => ({ ...d, month: d.month || f.period })), f.name));
  return { lines, source: lines.length ? "workings" : "none", name: "" };
}

/* ------------------------------------------------------------------ month by month */

const forItc = (lines) => lines.filter((l) => ITC_CATEGORIES.includes(l.category));

export function monthTable(fy, aLines, bLines) {
  const months = monthsOfFy(fy);
  const extra = [...new Set([...aLines, ...bLines].map((l) => l.month).filter((m) => m && !months.includes(m)))].sort();
  return [...months, ...extra].map((m) => {
    const a = sumLines(forItc(aLines).filter((l) => l.month === m)), b = sumLines(forItc(bLines).filter((l) => l.month === m));
    const has = (ls) => ls.some((l) => l.month === m && ITC_CATEGORIES.includes(l.category));
    return { month: m, label: monthLabel(m), a: has(aLines) ? a : null, b: has(bLines) ? b : null, diff: minus(a, b), both: has(aLines) && has(bLines), hasA: has(aLines), hasB: has(bLines) };
  });
}

/* ------------------------------------------------------------------ party by party */

const partyKey = (l) => (validGstin(l.gstin) ? `G${l.gstin}` : `N${normName(l.party)}`);

export function pivot(aLines, bLines) {
  const map = new Map();
  const put = (l, which) => {
    const key = `${partyKey(l)}|${l.category}`;
    let r = map.get(key);
    if (!r) { r = { party: l.party, gstin: l.gstin, category: l.category, a: { docs: 0, ...zero() }, b: { docs: 0, ...zero() } }; map.set(key, r); }
    if (!r.party && l.party) r.party = l.party;
    if (!r.gstin && l.gstin) r.gstin = l.gstin;
    r[which].docs++;
    addTo(r[which], l);
  };
  aLines.forEach((l) => put(l, "a"));
  bLines.forEach((l) => put(l, "b"));
  const rows = [...map.values()].map((r) => {
    const a = { docs: r.a.docs, ...round(r.a) }, b = { docs: r.b.docs, ...round(r.b) };
    const diff = minus(a, b);
    const comparable = COMPARABLE.includes(r.category);
    const status = !comparable ? "For information" : !a.docs ? "Only in the second" : !b.docs ? "Only in the first" : same(diff) ? "Matches" : "Amount differs";
    return { party: r.party, gstin: r.gstin, category: r.category, a, b, diff, status };
  });
  return rows.sort((x, y) => (Math.abs(y.diff.tot) - Math.abs(x.diff.tot)) || String(x.party).localeCompare(String(y.party)));
}

/* ------------------------------------------------------------------ document by document */

const docKey = (l) => `${partyKey(l)}|${normInv(l.no)}|${l.type === "cn" ? "cn" : "in"}`;

/** Pairs the documents of two sides: by party and invoice number, then by invoice number and a similar party name. */
export function matchDocuments(aLines, bLines) {
  const group = (lines) => {
    const m = new Map();
    for (const l of lines) {
      const k = docKey(l);
      const g = m.get(k) || m.set(k, { ...l, tax: zero(), months: new Set() }).get(k);
      addTo(g.tax, l);
      if (l.month) g.months.add(l.month);
    }
    return [...m.values()];
  };
  const A = group(aLines), B = group(bLines);
  const bByKey = new Map(B.map((b) => [docKey(b), b]));
  const pairs = [];
  const usedB = new Set();
  const rest = [];
  for (const a of A) {
    const b = bByKey.get(docKey(a));
    if (b && !usedB.has(b)) { usedB.add(b); pairs.push({ a, b }); } else rest.push(a);
  }
  const byInv = new Map();
  for (const b of B) if (!usedB.has(b)) { const k = `${normInv(b.no)}|${b.type === "cn" ? "cn" : "in"}`; byInv.set(k, [...(byInv.get(k) || []), b]); }
  for (const a of rest) {
    const cands = (byInv.get(`${normInv(a.no)}|${a.type === "cn" ? "cn" : "in"}`) || []).filter((b) => !usedB.has(b));
    const ta = tokensOf(a.party);
    const b = cands.find((c) => nameScore({ tokens: ta }, tokensOf(c.party)) >= 0.6 || (a.gstin && a.gstin === c.gstin));
    if (b) { usedB.add(b); pairs.push({ a, b }); } else pairs.push({ a, b: null });
  }
  for (const b of B) if (!usedB.has(b)) pairs.push({ a: null, b });
  return pairs;
}

export const PAIRS = {
  tb_g2b: { a: "GSTR-3B", b: "GSTR-2B", first: "claimed in the 3B working", second: "in GSTR-2B" },
  books_tb: { a: "Books", b: "GSTR-3B", first: "in the books", second: "claimed in the 3B working" },
  books_g2b: { a: "Books", b: "GSTR-2B", first: "in the books", second: "in GSTR-2B" },
};

const rs = (n) => `Rs ${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Why a document differs, and what to do, for each pair of sides. */
function remark(pair, kind, a, b) {
  if (kind === "amount") {
    const d = r2(a.tax.tot - b.tax.tot);
    return `Tax differs by ${rs(d)} (${PAIRS[pair].a} ${rs(a.tax.tot)}, ${PAIRS[pair].b} ${rs(b.tax.tot)}). Check the tax amount keyed or reported: a partly claimed invoice, a wrong head, or a note not adjusted.`;
  }
  if (kind === "month") return `The same amount, but in ${monthLabel([...a.months][0])} on one side and ${monthLabel([...b.months][0])} on the other. A timing difference: no change in the total for the year.`;
  const only = kind === "a_only" ? "a" : "b";
  const where = `${[...(only === "a" ? a : b).months].map(monthLabel).join(", ") || "no month"}`;
  const m = {
    tb_g2b: {
      a: `Claimed in the 3B working (${where}) but not in GSTR-2B. ITC is allowed only on what appears in GSTR-2B (section 16(2)(aa)): hold it until the supplier reports it, or reverse it.`,
      b: `In GSTR-2B (${where}) but not claimed in the 3B working. Claim it in a later return if it is eligible (section 16(4) time limit), or confirm it is blocked or reverse charge.`,
    },
    books_tb: {
      a: `Booked in the books (${where}) but not claimed in the 3B working. Claim it if eligible and it is in GSTR-2B, or find why it was left out.`,
      b: `Claimed in the 3B working (${where}) but not booked. Book the purchase if it is genuine, or remove the claim.`,
    },
    books_g2b: {
      a: `Booked in the books (${where}) but not in GSTR-2B. The supplier may not have filed or reported it: follow up. ITC is not available until it appears in GSTR-2B.`,
      b: `In GSTR-2B (${where}) but not booked. A purchase not recorded: book it if it is genuine and the goods or services were received.`,
    },
  };
  return m[pair][only];
}

/** The documents that differ in the comparable categories, for the differences sheets. */
export function documentDifferences(pair, aLines, bLines) {
  const comparable = (ls) => ls.filter((l) => COMPARABLE.includes(l.category));
  const out = [];
  for (const { a, b } of matchDocuments(comparable(aLines), comparable(bLines))) {
    const base = (x) => ({ party: x.party, gstin: x.gstin, category: x.category, no: x.no, date: x.date });
    if (a && !b) out.push({ ...base(a), kind: "a_only", type: `Only ${PAIRS[pair].first}`, a: a.tax, b: null, aMonth: [...a.months][0] || "", bMonth: "", diff: a.tax.tot, remark: remark(pair, "a_only", a, null) });
    else if (!a && b) out.push({ ...base(b), kind: "b_only", type: `Only ${PAIRS[pair].second}`, a: null, b: b.tax, aMonth: "", bMonth: [...b.months][0] || "", diff: r2(-b.tax.tot), remark: remark(pair, "b_only", null, b) });
    else {
      const d = minus(a.tax, b.tax);
      const am = [...a.months][0] || "", bm = [...b.months][0] || "";
      if (!same(d)) out.push({ ...base(a), kind: "amount", type: "Amount differs", a: a.tax, b: b.tax, aMonth: am, bMonth: bm, diff: d.tot, remark: remark(pair, "amount", a, b) });
      else if (am && bm && am !== bm) out.push({ ...base(a), kind: "month", type: "Month differs", a: a.tax, b: b.tax, aMonth: am, bMonth: bm, diff: 0, remark: remark(pair, "month", a, b) });
    }
  }
  const order = { amount: 0, a_only: 1, b_only: 2, month: 3 };
  return out.sort((x, y) => order[x.kind] - order[y.kind] || String(x.party).localeCompare(String(y.party)));
}

/* ------------------------------------------------------------------ GSTR-9 and GSTR-9C working */

export function gstr9Summary({ books, g2b, tb, workFiles, rcmReco }) {
  const { byMonth } = latestByMonth(workFiles.filter((f) => f.data));
  const t4 = (k) => sumLines([...byMonth.values()].map((f) => (f.data.t4[k] ? { ...f.data.t4[k] } : zero())));
  const fromDocs = (cat) => sumLines(tb.filter((l) => l.category === cat));
  const haveWork = byMonth.size > 0;
  const a5 = haveWork ? t4("a5") : fromDocs("Normal ITC"), a3 = haveWork ? t4("a3") : fromDocs("RCM");
  const a1 = haveWork ? t4("a1") : zero(), a2 = haveWork ? t4("a2") : zero(), a4 = haveWork ? t4("a4") : zero();
  const b1 = haveWork ? t4("b1") : zero(), b2 = haveWork ? t4("b2") : sumLines(tb.filter((l) => l.category === "Credit / debit note"));
  const add = (...xs) => sumLines(xs);
  const sub = (a, b) => minus(a, b);
  const a6a = add(a1, a2, a3, a4, a5), rev = add(b1, b2), net = sub(a6a, rev);
  const g2bItc = sumLines(forItc(g2b));
  const booksItc = sumLines(books.filter((l) => ITC_CATEGORIES.includes(l.category) || l.category === "RCM"));
  const src = haveWork ? "Table 4 of the monthly 3B workings" : "documents of the 3B working (Table 4 lines not available)";
  const row = (ref, text, v, source = "") => ({ ref, text, v, source });
  const manual = (ref, text, note) => ({ ref, text, v: null, source: note });

  const tbOnly = documentDifferences("tb_g2b", tb, g2b).filter((d) => d.kind === "a_only");
  const g2bOnly = documentDifferences("tb_g2b", tb, g2b).filter((d) => d.kind === "b_only");
  const sumDocs = (ds, side) => sumLines(ds.map((d) => ({ ...(d[side] || zero()) })));

  const booksTb = documentDifferences("books_tb", books, tb);

  // reverse charge: the return against the RCM working on the expense ledgers (sheet 12)
  const five = (o) => ({ igst: o?.igst || 0, cgst: o?.cgst || 0, sgst: o?.sgst || 0, cess: o?.cess || 0, tot: o?.tot || 0 });
  const rt = rcmReco.totals, haveLedger = rcmReco.summary.hasLedger;
  const rcmPaid = sumLines([five(rt.paid)]), rcmLedger = sumLines([five(rt.ledger)]), rcmClaimed = sumLines([five(rt.claimed)]);
  const rcmSrc = `GSTR-3B: ${rcmReco.summary.filedMonths} month(s) from the filed return, ${rcmReco.summary.workingMonths} from the 3B workings.`;
  const rcm9 = [
    row("4G", "Inward supplies on which tax is payable on reverse charge: tax paid as per GSTR-3B Table 3.1(d)", rcmPaid, rcmSrc),
    haveLedger ? row("", "   as per the RCM working on the expense ledgers (Books, RCM)", rcmLedger, "The RCM working Excel; month by month on sheet 12.") : manual("", "   as per the RCM working on the expense ledgers", "Upload the expense ledgers under Books > RCM to work this out."),
    ...(haveLedger ? [row("", "   difference (3B 3.1(d) less RCM working)", sub(rcmPaid, rcmLedger), "Explained month by month on sheet 12.")] : []),
    row("6C+6D", "ITC claimed on reverse charge: GSTR-3B Table 4(A)(3)", rcmClaimed, rcmSrc),
    ...(haveLedger ? [
      row("", "   ITC on RCM available as per the RCM working (eligible lines only)", { tot: rt.ledgerItc }, "Sheet 12. Blocked, apportioned and to-be-checked lines are left out."),
      row("", "   difference (claimed less available)", { tot: r2(rcmClaimed.tot - rt.ledgerItc) }, "Sheet 12."),
    ] : []),
  ];
  const rcm9c = haveLedger ? [
    row("RCM", "Reverse-charge tax as per the RCM working (books)", rcmLedger, "The RCM working Excel; sheet 12."),
    row("RCM", "Reverse-charge tax as per the annual return (Table 4G, from GSTR-3B 3.1(d))", rcmPaid, rcmSrc),
    row("RCM", "Un-reconciled reverse-charge tax (working less return)", sub(rcmLedger, rcmPaid), "Explained month by month on sheet 12."),
  ] : [manual("RCM", "Reverse-charge tax: the RCM working against the annual return", "Upload the expense ledgers under Books > RCM to work this out.")];

  return {
    gstr9: [
      row("6A", "Total ITC availed through GSTR-3B (Table 4(A))", a6a, src),
      row("6B", "Inward supplies other than imports and reverse charge (4(A)(5))", a5, src),
      row("6C+6D", "Inward supplies liable to reverse charge, from unregistered and registered persons (4(A)(3))", a3, src),
      row("6E", "Import of goods (4(A)(1))", a1, src),
      row("6F", "Import of services (4(A)(2))", a2, src),
      row("6G", "ITC received from ISD (4(A)(4))", a4, src),
      manual("6H", "ITC reclaimed in the year (other than in 6B)", "Not in the workings: enter from the ledger of reclaimed ITC."),
      row("7", "ITC reversed through GSTR-3B: Table 4(B)(1), rules 38, 42, 43 and section 17(5), and 4(B)(2), others", rev, `${src}. The split into rules 37, 39, 42, 43 and section 17(5) is not in the workings.`),
      row("7I", "Net ITC available for utilisation (6A less the reversals)", net, "Worked out."),
      row("8A", "ITC as per GSTR-2B: B2B invoices and credit / debit notes marked available, normal supply", g2bItc, "GSTR-2B files of all months."),
      row("8B", "ITC availed on inward supplies: 6B (and 6H)", a5, src),
      manual("8C", "ITC of the previous year availed in this year, and of this year to be availed next", "Not in the workings: enter from the books."),
      row("8D", "Difference: 2B less ITC availed", sub(g2bItc, a5), "Worked out. Explained by the next two lines and the unclaimed or ineligible items."),
      row("", "   of which: invoices in GSTR-2B not claimed in the 3B working", sumDocs(g2bOnly, "b"), "From sheet 6: documents only in GSTR-2B."),
      row("", "   of which: invoices claimed in the 3B working but not in GSTR-2B", sumDocs(tbOnly, "a"), "From sheet 6: documents only in the 3B working."),
      ...rcm9,
    ],
    gstr9c: [
      row("12A", "ITC availed as per the books: normal ITC, credit and debit notes, and reverse-charge tax booked", booksItc, "Input ITC ledger files. Audited financial statements may differ."),
      manual("12B", "ITC booked in earlier years and claimed in this year", "Not in the workings: enter from the books."),
      manual("12C", "ITC booked in this year to be claimed in later years", "Not in the workings: enter from the books."),
      row("12D", "ITC as per the books (12A, 12B, 12C taken as nil)", booksItc, "Worked out."),
      row("12E", "ITC claimed in the annual return: net ITC available (7I)", net, "From the 3B workings."),
      row("12F", "Un-reconciled ITC (12D less 12E)", sub(booksItc, net), "Worked out. Explained by sheet 8: books against the 3B working."),
      row("", "   of which: documents only in the books (not claimed in 3B)", sumDocs(booksTb.filter((d) => d.kind === "a_only"), "a"), "From sheet 8."),
      row("", "   of which: documents only in the 3B working (not in the books)", sumDocs(booksTb.filter((d) => d.kind === "b_only"), "b"), "From sheet 8."),
      ...rcm9c,
    ],
    tdsTcs: ["TDS", "TCS", "TDS / TCS"].map((c) => ({ category: c, books: sumLines(books.filter((l) => l.category === c)), gstr2b: sumLines(g2b.filter((l) => l.category === c)), tb: sumLines(tb.filter((l) => l.category === c)) })).filter((r) => r.books.tot || r.gstr2b.tot || r.tb.tot),
  };
}

/* ------------------------------------------------------------------ everything together */

export function buildFinalReco({ fy, registerRows, tdsTcsFiles, g2bFiles, workFiles, finalFile, rcm, portalFiles = [] }) {
  const books = booksLines(registerRows, tdsTcsFiles);
  const g2b = g2bLines(g2bFiles.filter((f) => f.data));
  const tbSrc = tbLines(finalFile, workFiles);
  const tb = tbSrc.lines;
  const pairs = {};
  const sides = { tb_g2b: [tb, g2b], books_tb: [books, tb], books_g2b: [books, g2b] };
  for (const [id, [a, b]] of Object.entries(sides)) {
    const months = monthTable(fy, a, b);
    const pv = pivot(a, b);
    const diffs = documentDifferences(id, a, b);
    pairs[id] = {
      id, ...PAIRS[id], months, pivot: pv, diffs,
      summary: {
        monthsDiffering: months.filter((m) => m.both && !same(m.diff)).length, monthsCompared: months.filter((m) => m.both).length,
        partiesDiffering: pv.filter((p) => ["Amount differs", "Only in the first", "Only in the second"].includes(p.status)).length, parties: pv.length,
        documentsDiffering: diffs.length,
      },
    };
  }
  const warnings = [];
  if (!books.length) warnings.push("No Input ITC register (with party and invoice details) is uploaded under Books, so the books side is empty.");
  if (!g2b.length) warnings.push("No GSTR-2B is uploaded under GST Portal, so the GSTR-2B side is empty.");
  if (tbSrc.source === "none") warnings.push("No document lines are available for the 3B working. Upload the finalised combined 3B working in this step, or workings that list their documents (the ITC Documents sheet).");
  if (tbSrc.source === "workings") warnings.push("The finalised 3B working is not uploaded, so the latest monthly workings of Step 1 are used.");
  // reverse charge: the working on the expense ledgers against the RCM booked, paid and claimed (sheet 12)
  const rcmReco = buildRcmReco({ fy, rcm, registerRows, workFiles, portalFiles });
  return {
    fy, books, g2b, tb, tbSource: tbSrc.source, tbName: tbSrc.name, pairs, warnings, rcm, rcmReco,
    gstr9: gstr9Summary({ books, g2b, tb, workFiles, rcmReco }),
    ready: { books: books.length > 0, g2b: g2b.length > 0, tb: tb.length > 0 },
  };
}
