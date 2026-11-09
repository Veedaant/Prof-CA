import {
  prep, totalOf, periodsBetween, fyPeriods, matchDocuments, monthlyTable, rateTable, partyTable, exceptionTable, docListTable, discrepancyList,
  annotateMonths, monthDiscrepancies, groupTotals, r2, TOL, zero,
} from "./engine.js";
import { loadBooks, loadPortal } from "./books.js";
import { emptyFigures } from "./gstr3bParser.js";

const TAX = ["igst", "cgst", "sgst", "cess"];
const OUT_FIELDS = ["taxable", "igst", "cgst", "sgst"];
const ITC_FIELDS = ["igst", "cgst", "sgst", "cess"];
const fmt = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const addT = (...ts) => { const o = zero(); for (const t of ts) for (const k of Object.keys(o)) o[k] = r2(o[k] + (Number(t?.[k]) || 0)); return o; };
const taxSum = (t) => r2(TAX.reduce((s, k) => s + (t?.[k] || 0), 0));
const fold = (rows) => rows.map((r) => (r.gstin ? r : { ...r, party: "Unregistered / B2C (consolidated)" }));
const registered = (rows) => rows.filter((r) => r.gstin);
const eligible = (rows) => rows.filter((r) => !r.rcm && r.itc !== false);

function readiness(periods, parts) {
  return periods.map((p) => {
    const row = { period: p };
    for (const [k, set] of Object.entries(parts)) row[k] = set.has(p) ? "Yes" : "-";
    return row;
  });
}
const readinessCols = (extra) => [{ key: "period", label: "Month", type: "period" }, ...extra.map(([k, l]) => ({ key: k, label: l, type: "status" }))];

function figuresOf(f) {
  const x = f || emptyFigures();
  const o = x.outward, i = x.itc;
  return {
    out_ab: addT(o.a, o.b), out_a: o.a, out_b: o.b, out_c: o.c, out_d: o.d, out_e: o.e,
    out_taxable: r2(o.a.taxable + o.b.taxable + o.c.taxable),
    itc_claim: addT(i.import_goods, i.import_services, i.isd, i.other), itc_other: i.other, itc_rcm: i.rcm, itc_rev: addT(i.reversed_rules, i.reversed_others), itc_inelig: addT(i.ineligible_17_5, i.ineligible_others),
    itc_all: addT(i.import_goods, i.import_services, i.rcm, i.isd, i.other),
  };
}
const fig3b = (portal, p) => (portal.gstr3b[p] ? figuresOf(portal.gstr3b[p]) : null);

function rowsAsPeriodTotals(map, periods, pick) {
  const rows = [];
  for (const p of periods) if (map[p]) { const t = pick(map[p], p); rows.push({ ...t, period: p, type: "inv", gstin: "", party: "", inv_no: p, rate: 0 }); }
  return rows;
}

/** GSTR-3B working compiled from the books for each month */
export function workingFromBooks(sales, purchases, periods) {
  const out = {};
  for (const p of periods) {
    const s = prep(sales.filter((r) => r.period === p)), b = prep(purchases.filter((r) => r.period === p));
    const f = emptyFigures();
    const sa = s.filter((r) => (r.rate || 0) > 0), sc = s.filter((r) => !(r.rate > 0));
    f.outward.a = totalOf(sa); f.outward.c = totalOf(sc);
    const rcm = b.filter((r) => r.rcm);
    f.outward.d = totalOf(rcm);
    f.itc.rcm = { igst: f.outward.d.igst, cgst: f.outward.d.cgst, sgst: f.outward.d.sgst, cess: f.outward.d.cess };
    const ok = b.filter((r) => !r.rcm && r.itc !== false), bad = b.filter((r) => !r.rcm && r.itc === false);
    const t = totalOf(ok); f.itc.other = { igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess };
    const u = totalOf(bad); f.itc.ineligible_others = { igst: u.igst, cgst: u.cgst, sgst: u.sgst, cess: u.cess };
    out[p] = f;
  }
  return out;
}

const outReason = (la, lb) => (r) => {
  const taxD = r2(TAX.reduce((s, k) => s + (r[`${k}_d`] || 0), 0));
  if (Math.abs(taxD) <= TOL) return { reason: "Taxable value differs but tax is the same: supplies at 0% / nil-rated / exempt / non-GST treated differently, or an invoice with only a taxable-value difference.", action: "Check the classification of nil-rated, exempt and zero-rated supplies in both records and correct the table (3.1(a)/(b)/(c) in GSTR-3B; tables 8/6 in GSTR-1)." };
  if (taxD > 0) return { reason: `${la} shows ${fmt(taxD)} more tax than ${lb}. Typically invoices missed / reported in a different month, credit notes or amendments taken in ${lb} but not ${la}, or tax under-reported.`, action: `Drill down in the party pivot and invoice exceptions below. If ${lb} is the filed return and is short, pay the difference with interest u/s 50 (18% p.a.) in the next GSTR-3B (or DRC-03) and report/amend it in GSTR-1.` };
  return { reason: `${lb} shows ${fmt(-taxD)} more tax than ${la}. Typically supplies reported in the return but not recorded in books, advances, sales returns / cancellations not reversed in the return, or excess tax paid.`, action: `Verify against invoices. If the return is excess, adjust it through credit notes / amendment tables of the next GSTR-1 and take the credit in the next GSTR-3B (or claim a refund of excess cash paid). If books are short, record the missing entries.` };
};

function inReason(la, lb, kind) {
  return (r) => {
    const taxD = r2(ITC_FIELDS.reduce((s, k) => s + (r[`${k}_d`] || 0), 0));
    if (kind === "books3b") {
      return taxD > 0
        ? { reason: "ITC recorded in the books is more than claimed in GSTR-3B: ITC not yet claimed (invoice not in GSTR-2B / blocked credit u/s 17(5) / missed).", action: "Claim the unclaimed eligible ITC in a following GSTR-3B once it appears in GSTR-2B, within the s.16(4) time limit (30 November following the FY, or filing of annual return, whichever is earlier). Identify blocked credits and keep them out." }
        : { reason: "ITC claimed in GSTR-3B is more than recorded in the books: ITC claimed without a booked invoice, claimed from a prior / later period or provisionally.", action: "Reverse the excess through Table 4(B)(2) of the next GSTR-3B with interest u/s 50(3) (24% p.a.) or book the missing purchase entries if they are valid." };
    }
    if (kind === "rcm") return { reason: "RCM liability / ITC in books differs from GSTR-3B 3.1(d)/4A(3): RCM invoices not accounted, RCM paid in a different month, or RCM ITC not claimed in the same month.", action: "RCM tax must be paid in cash first and the ITC claimed in the same or later 3B. Reconcile with the self-invoices / payment challans and correct in the next GSTR-3B." };
    return taxD > 0
      ? { reason: `ITC claimed in GSTR-3B exceeds ITC available in GSTR-2B by ${fmt(taxD)}: ITC taken on invoices not yet in GSTR-2B (provisional), supplier default, or credit from earlier months' balance.`, action: "Rule 36(4) / s.16(2)(aa): ITC only on invoices reflected in GSTR-2B. Reverse the excess in 4(B)(2) with interest, or obtain the supplier filings. Track cumulative difference below - timing differences should wash out." }
      : { reason: `ITC available in GSTR-2B exceeds that claimed in GSTR-3B by ${fmt(-taxD)}: invoices in 2B not booked/ineligible (blocked credit, personal use, goods not received), or ITC carried forward to a later month.`, action: "Review the unclaimed 2B items. Claim eligible ITC in the next GSTR-3B (before the s.16(4) limit); document ineligible items under 4(D)(2)." };
  };
}

/* ------------------------------------------------------------------ output */

export async function buildOutput(firmId, client, from, to) {
  const periods = periodsBetween(from, to);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const sales = books.sales;
  const g1Periods = portal.periods.gstr1, tbPeriods = portal.periods.gstr3b;
  const noG1 = new Set(periods.filter((p) => !g1Periods.has(p)));
  const noTb = new Set(periods.filter((p) => !tbPeriods.has(p)));
  const booksP = prep(sales), g1P = prep(portal.gstr1);
  const comparable = (rows, set) => rows.filter((r) => set.has(r.period));

  const sections = [];
  const discrepancies = [];

  sections.push({ key: "ready", title: "Data readiness", note: "Months for which each source is available. Comparisons are done only for months where the portal file has been uploaded.", columns: readinessCols([["books", "Books (approved invoices / ledger)"], ["gstr1", "GSTR-1 (portal Excel)"], ["gstr3b", "GSTR-3B (PDF)"]]),
    rows: readiness(periods, { books: new Set(sales.map((r) => r.period)), gstr1: g1Periods, gstr3b: tbPeriods }) });

  // part 1 : books vs GSTR-1
  const L1 = "Books", L2 = "GSTR-1";
  const m1 = annotateMonths(monthlyTable({ periods, a: booksP, b: g1P, fields: OUT_FIELDS, labelA: L1, labelB: L2, skip: noG1 }), outReason(L1, L2));
  sections.push({ key: "books_g1_month", title: "1. Month-wise summary - Books vs GSTR-1 (portal)", note: "Credit notes are deducted and debit notes added. A month with no portal file is shown as 'No file'.", ...m1 });
  discrepancies.push(...monthDiscrepancies(m1, "Output: Books vs GSTR-1", outReason(L1, L2), OUT_FIELDS));
  const cmpA = comparable(booksP, g1Periods), cmpB = comparable(g1P, g1Periods);
  sections.push({ key: "books_g1_rate", title: "2. Tax-rate-wise summary - Books vs GSTR-1", columns: rateTable({ a: cmpA, b: cmpB, fields: OUT_FIELDS, labelA: L1, labelB: L2 }).columns, rows: rateTable({ a: cmpA, b: cmpB, fields: OUT_FIELDS, labelA: L1, labelB: L2 }).rows });
  const pt = partyTable({ a: fold(cmpA), b: fold(cmpB), fields: OUT_FIELDS, labelA: L1, labelB: L2 });
  sections.push({ key: "books_g1_party", title: "3. Party-wise pivot with GSTIN - Books vs GSTR-1", note: "Customers without a GSTIN are consolidated as B2C. Sorted by largest difference.", ...pt });
  const match = matchDocuments(registered(cmpA), registered(cmpB), "output");
  const et = exceptionTable(match.exceptions, "output", L1, L2);
  sections.push({ key: "books_g1_docs", title: `4. Invoice-level mismatches (B2B / notes) - ${match.matched} matched, ${match.exceptions.length} exceptions`, note: "Only registered-party (GSTIN) documents are matched one-to-one; B2C is compared in the totals above.", ...et });
  discrepancies.push(...discrepancyList(match.exceptions, "Output: Books vs GSTR-1"));

  // part 2 : GSTR-1 vs 3B
  const tb = (p) => fig3b(portal, p);
  const g1Tot = (rows) => rows;
  void g1Tot;
  const tbA = rowsAsPeriodTotals(Object.fromEntries(periods.map((p) => [p, tb(p)]).filter(([, v]) => v)), periods, (f) => ({ taxable: f.out_taxable, igst: f.out_ab.igst, cgst: f.out_ab.cgst, sgst: f.out_ab.sgst, cess: f.out_ab.cess }));
  const both = new Set(periods.filter((p) => g1Periods.has(p) && tbPeriods.has(p)));
  const noBoth = new Set(periods.filter((p) => !both.has(p)));
  const m2 = annotateMonths(monthlyTable({ periods, a: comparable(g1P, both), b: tbA.filter((r) => both.has(r.period)), fields: OUT_FIELDS, labelA: "GSTR-1", labelB: "GSTR-3B", skip: noBoth }), outReason("GSTR-1", "GSTR-3B"));
  sections.push({ key: "g1_3b", title: "5. GSTR-1 (portal) vs GSTR-3B Table 3.1 - month-wise", note: "GSTR-3B side = 3.1(a) + (b) for tax and 3.1(a)+(b)+(c) for taxable value. Needs both the GSTR-1 Excel and the GSTR-3B PDF for the month.", ...m2 });
  discrepancies.push(...monthDiscrepancies(m2, "Output: GSTR-1 vs GSTR-3B", outReason("GSTR-1", "GSTR-3B"), OUT_FIELDS));

  // part 3 : books vs 3B
  const m3 = annotateMonths(monthlyTable({ periods, a: comparable(booksP, tbPeriods), b: tbA, fields: OUT_FIELDS, labelA: "Books", labelB: "GSTR-3B", skip: noTb }), outReason("Books", "GSTR-3B"));
  sections.push({ key: "books_3b", title: "6. Books vs GSTR-3B Table 3.1 - month-wise (final tie-out)", ...m3 });
  discrepancies.push(...monthDiscrepancies(m3, "Output: Books vs GSTR-3B", outReason("Books", "GSTR-3B"), OUT_FIELDS));

  // three-way
  const g = (rows, p, f) => r2(groupTotals(rows, (r) => r.period).get(p)?.[f] || 0);
  const three = periods.map((p) => ({
    period: p, books_taxable: g(booksP, p, "taxable"), g1_taxable: g1Periods.has(p) ? g(g1P, p, "taxable") : null, tb_taxable: tbPeriods.has(p) ? tb(p).out_taxable : null,
    books_tax: taxSum(totalOf(booksP.filter((r) => r.period === p))), g1_tax: g1Periods.has(p) ? taxSum(totalOf(g1P.filter((r) => r.period === p))) : null, tb_tax: tbPeriods.has(p) ? taxSum(tb(p).out_ab) : null,
  }));
  sections.push({ key: "three_way", title: "7. Three-way summary (feeds GSTR-9 / 9C)", note: "Blank = file not uploaded.", columns: [{ key: "period", label: "Month", type: "period" }, ...[["books_taxable", "Taxable - Books"], ["g1_taxable", "Taxable - GSTR-1"], ["tb_taxable", "Taxable - GSTR-3B"], ["books_tax", "Tax - Books"], ["g1_tax", "Tax - GSTR-1"], ["tb_tax", "Tax - GSTR-3B"]].map(([key, label]) => ({ key, label, type: "money" }))], rows: three });

  sections.push({ ...docListTable(sales.length ? booksP : [], "Books"), key: "books_sales_data", title: "8. Sales data as per books (compiled from approved invoices and sales ledgers)", note: `${sales.length} line-rows. Invoices + sales-ledger rows (ledger rows that duplicate an approved invoice number are skipped).` });

  return finish("Output Reconciliation", client, from, to, periods, sections, discrepancies, {
    pending_approval: books.pending_approval, ledgers: books.ledgerInfo,
    missing: [...(noG1.size ? [`GSTR-1 Excel for ${[...noG1].join(", ")}`] : []), ...(noTb.size ? [`GSTR-3B PDF for ${[...noTb].join(", ")}`] : []), ...(sales.length ? [] : ["No approved sales data / sales ledger for this range"])],
  });
}

/* ------------------------------------------------------------------- input */

export async function buildInput(firmId, client, from, to) {
  const periods = periodsBetween(from, to);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const pur = books.purchases;
  const b2bP = prep(portal.gstr2b);
  const tbPeriods = portal.periods.gstr3b, b2Periods = portal.periods.gstr2b;
  const noTb = new Set(periods.filter((p) => !tbPeriods.has(p))), no2b = new Set(periods.filter((p) => !b2Periods.has(p)));
  const purP = prep(pur);
  const sections = [], discrepancies = [];
  const tb = (p) => fig3b(portal, p);
  const tbRows = (pick) => rowsAsPeriodTotals(Object.fromEntries(periods.map((p) => [p, tb(p)]).filter(([, v]) => v)), periods, pick);

  sections.push({ key: "ready", title: "Data readiness", columns: readinessCols([["books", "Books (approved purchases / ledger)"], ["gstr3b", "GSTR-3B (PDF)"], ["gstr2b", "GSTR-2B (portal Excel)"]]),
    rows: readiness(periods, { books: new Set(pur.map((r) => r.period)), gstr3b: tbPeriods, gstr2b: b2Periods }) });

  // working summary (books)
  const working = workingFromBooks(books.sales, pur, periods);
  const wRows = periods.map((p) => {
    const w = working[p], all = totalOf(purP.filter((r) => r.period === p && !r.rcm));
    return { period: p, books_igst: all.igst, books_cgst: all.cgst, books_sgst: all.sgst, books_cess: all.cess, blocked: taxSum(w.itc.ineligible_others), itc_igst: w.itc.other.igst, itc_cgst: w.itc.other.cgst, itc_sgst: w.itc.other.sgst, itc_cess: w.itc.other.cess, rcm: taxSum(w.itc.rcm) };
  });
  sections.push({ key: "working", title: "1. GSTR-3B working - ITC compiled from purchase books", note: "GST on purchases as per books, less ITC marked ineligible (ledger column), plus RCM ITC. This is the 'working' that is tied to the 3B PDF next.",
    columns: [{ key: "period", label: "Month", type: "period" }, ...[["books_igst", "GST in books - IGST"], ["books_cgst", "CGST"], ["books_sgst", "SGST"], ["books_cess", "Cess"], ["blocked", "Ineligible / blocked"], ["itc_igst", "ITC claimable - IGST"], ["itc_cgst", "CGST"], ["itc_sgst", "SGST"], ["itc_cess", "Cess"], ["rcm", "RCM ITC"]].map(([key, label]) => ({ key, label, type: "money" }))], rows: wRows });

  // 2: working vs 3B (other than RCM)
  const f3A = (f) => ({ igst: f.itc_claim.igst, cgst: f.itc_claim.cgst, sgst: f.itc_claim.sgst, cess: f.itc_claim.cess });
  const wA = rowsAsPeriodTotals(Object.fromEntries(periods.map((p) => [p, working[p]])), periods, (f) => ({ ...f.itc.other, taxable: 0 })).filter((r) => tbPeriods.has(r.period));
  const m2 = annotateMonths(monthlyTable({ periods, a: wA, b: tbRows((f) => ({ ...f3A(f), taxable: 0 })), fields: ITC_FIELDS, labelA: "Working", labelB: "3B filed", skip: noTb }), inReason("Working", "3B", "books3b"));
  sections.push({ key: "work_3b", title: "2. Working vs GSTR-3B PDF - ITC availed (4A other than RCM)", note: "3B side = 4A(1) + (2) + (4) + (5). Verifies credit claimed per working equals that in the filed 3B.", ...m2 });
  discrepancies.push(...monthDiscrepancies(m2, "Input: Working vs GSTR-3B", inReason("Working", "3B", "books3b"), ITC_FIELDS));

  const rcmBooks = rowsAsPeriodTotals(Object.fromEntries(periods.map((p) => [p, working[p]])), periods, (f) => ({ ...f.outward.d })).filter((r) => tbPeriods.has(r.period));
  const m2r = annotateMonths(monthlyTable({ periods, a: rcmBooks, b: tbRows((f) => ({ ...f.out_d })), fields: ["igst", "cgst", "sgst", "cess"], labelA: "Working", labelB: "3B 3.1(d)", skip: noTb }), inReason("Working", "3B", "rcm"));
  sections.push({ key: "work_3b_rcm", title: "2A. RCM - working vs GSTR-3B 3.1(d) liability", ...m2r });
  discrepancies.push(...monthDiscrepancies(m2r, "Input: RCM", inReason("Working", "3B", "rcm"), ITC_FIELDS));
  const m2c = annotateMonths(monthlyTable({ periods, a: rcmBooks, b: tbRows((f) => ({ ...f.itc_rcm })), fields: ["igst", "cgst", "sgst", "cess"], labelA: "Working", labelB: "3B 4A(3)", skip: noTb }), inReason("Working", "3B", "rcm"));
  sections.push({ key: "work_3b_rcm_itc", title: "2B. RCM - working vs GSTR-3B 4A(3) ITC", ...m2c });

  // 3: 3B vs 2B
  const have2b = periods.filter((p) => b2Periods.has(p) && tbPeriods.has(p));
  const both = new Set(have2b);
  const b2avail = (rows) => rows.filter((r) => r.itc !== false && !r.rcm);
  const m3 = monthlyTable({ periods, a: tbRows((f) => ({ ...f3A(f), taxable: 0 })).filter((r) => both.has(r.period)), b: b2avail(b2bP).filter((r) => both.has(r.period)), fields: ITC_FIELDS, labelA: "3B claimed", labelB: "2B available", skip: new Set(periods.filter((p) => !both.has(p))) });
  let cum = 0;
  for (const r of m3.rows) { if (r._total) { r.cum = r2(cum); continue; } if (r.status !== "No file") cum += ITC_FIELDS.reduce((s, k) => s + r[`${k}_d`], 0); r.cum = r2(cum); }
  m3.columns.push({ key: "cum", label: "Cumulative diff (3B - 2B)", type: "money", diff: true });
  annotateMonths(m3, inReason("3B", "2B", "3b2b"));
  sections.push({ key: "3b_2b", title: "3. ITC available as per GSTR-2B vs claimed in GSTR-3B - month-wise (IGST / CGST / SGST)", note: "2B available = rows with ITC availability 'Yes', excluding reverse-charge rows. The cumulative column separates pure timing from real excess/short claims.", ...m3 });
  discrepancies.push(...monthDiscrepancies(m3, "Input: GSTR-3B vs GSTR-2B", inReason("3B", "2B", "3b2b"), ITC_FIELDS));

  // 4: party pivot 2B vs books/claimed
  const cmpBooks = eligible(purP).filter((r) => b2Periods.has(r.period)), cmp2b = b2avail(b2bP);
  const pp = partyTable({ a: fold(cmpBooks), b: fold(cmp2b), fields: ["taxable", "igst", "cgst", "sgst"], labelA: "Books/claimed", labelB: "2B" });
  sections.push({ key: "party", title: "4. Party-wise ITC pivot with GSTIN - GSTR-2B vs books (as claimed in 3B)", note: "GSTR-3B has no party detail; the working/books ITC is what has been claimed in GSTR-3B.", ...pp });
  const match = matchDocuments(registered(cmpBooks), registered(cmp2b), "input");
  sections.push({ key: "docs", title: `5. Invoice-level mismatches - Books vs GSTR-2B - ${match.matched} matched, ${match.exceptions.length} exceptions`, ...exceptionTable(match.exceptions, "input", "Books", "2B") });
  discrepancies.push(...discrepancyList(match.exceptions, "Input: Books vs GSTR-2B"));

  // 6: four-way final
  const four = periods.map((p) => {
    const w = working[p], all = totalOf(purP.filter((r) => r.period === p && !r.rcm));
    const f = tb(p);
    const two = b2Periods.has(p) ? totalOf(b2avail(b2bP).filter((r) => r.period === p)) : null;
    const r = {
      period: p, books: taxSum(all), blocked: taxSum(w.itc.ineligible_others), working: taxSum(w.itc.other), claimed: f ? taxSum(f3A(f)) : null, avail2b: two ? taxSum(two) : null,
    };
    r.d_working_3b = r.claimed == null ? null : r2(r.working - r.claimed); r.d_3b_2b = r.claimed == null || r.avail2b == null ? null : r2(r.claimed - r.avail2b);
    return r;
  });
  sections.push({ key: "final", title: "6. Final tie-out: Books -> Working -> GSTR-3B -> GSTR-2B (total ITC excl. RCM)", note: "Books less blocked = working. Working should equal 3B claimed; 3B claimed should not exceed 2B.", columns: [{ key: "period", label: "Month", type: "period" }, ...[["books", "GST per books"], ["blocked", "Ineligible / blocked"], ["working", "Working ITC"], ["claimed", "3B claimed"], ["avail2b", "2B available"], ["d_working_3b", "Working - 3B"], ["d_3b_2b", "3B - 2B"]].map(([key, label]) => ({ key, label, type: "money", diff: key.startsWith("d_") }))], rows: four });

  sections.push({ ...docListTable(pur.length ? purP : [], "Books"), key: "books_purchase_data", title: "7. Purchase data as per books (compiled from approved purchase invoices, purchase-side notes and purchase ledgers)" });
  return finish("Input Reconciliation", client, from, to, periods, sections, discrepancies, {
    pending_approval: books.pending_approval, ledgers: books.ledgerInfo,
    missing: [...(noTb.size ? [`GSTR-3B PDF for ${[...noTb].join(", ")}`] : []), ...(no2b.size ? [`GSTR-2B Excel for ${[...no2b].join(", ")}`] : []), ...(pur.length ? [] : ["No approved purchase data / purchase ledger for this range"])],
  });
}

/* ------------------------------------------------------------------ GSTR-3B */

export async function buildGstr3b(firmId, client, from, to) {
  const periods = periodsBetween(from, to);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const w = workingFromBooks(books.sales, books.purchases, periods);
  const rows = periods.map((p) => {
    const f = w[p], itc = addT(f.itc.other, f.itc.rcm);
    const liab = addT(f.outward.a, f.outward.d);
    const filed = portal.gstr3b[p] ? figuresOf(portal.gstr3b[p]) : null;
    return {
      period: p, taxable_a: f.outward.a.taxable, exempt: f.outward.c.taxable, rcm_taxable: f.outward.d.taxable,
      igst: f.outward.a.igst, cgst: f.outward.a.cgst, sgst: f.outward.a.sgst, itc_igst: itc.igst, itc_cgst: itc.cgst, itc_sgst: itc.sgst,
      net_igst: r2(liab.igst - itc.igst), net_cgst: r2(liab.cgst - itc.cgst), net_sgst: r2(liab.sgst - itc.sgst),
      filed: filed ? "Uploaded" : "-", filed_tax: filed ? taxSum(filed.out_ab) : null,
    };
  });
  const sections = [{
    key: "working", title: "GSTR-3B working from books", note: "Outward liability 3.1(a), nil/exempt 3.1(c), RCM 3.1(d), ITC 4A and the net cash/ITC payable per head (before opening ITC balance). Upload the filed GSTR-3B PDFs under Output / Input Reconciliation to compare.",
    columns: [{ key: "period", label: "Month", type: "period" }, ...[["taxable_a", "3.1(a) taxable"], ["exempt", "3.1(c) nil/exempt"], ["rcm_taxable", "3.1(d) RCM taxable"], ["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST"], ["itc_igst", "ITC IGST"], ["itc_cgst", "ITC CGST"], ["itc_sgst", "ITC SGST"], ["net_igst", "Net IGST payable"], ["net_cgst", "Net CGST payable"], ["net_sgst", "Net SGST payable"]].map(([key, label]) => ({ key, label, type: "money" })), { key: "filed", label: "3B PDF", type: "status" }, { key: "filed_tax", label: "Tax per filed 3B", type: "money" }],
    rows,
  }];
  return finish("GSTR-3B", client, from, to, periods, sections, [], { pending_approval: books.pending_approval, ledgers: books.ledgerInfo, missing: [] });
}

/* ------------------------------------------------------------------ GSTR-9 */

function annual(periods, books, portal) {
  const bs = prep(books.sales), bp = prep(books.purchases), g1 = prep(portal.gstr1), b2 = prep(portal.gstr2b);
  const f = periods.map((p) => portal.gstr3b[p] && figuresOf(portal.gstr3b[p])).filter(Boolean);
  const sum3b = (pick) => f.reduce((t, x) => addT(t, pick(x)), zero());
  return { bs, bp, g1, b2, f, sum3b };
}

const srcRows = (cols, rows) => ({ columns: cols, rows });
const tcols = (extra) => [{ key: "table", label: "Table", type: "text" }, { key: "desc", label: "Description", type: "long" }, ...extra.map(([key, label, type]) => ({ key, label, type: type || "money" }))];

export async function buildGstr9(firmId, client, fy) {
  const periods = fyPeriods(fy);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const { bs, bp, g1, b2, f, sum3b } = annual(periods, books, portal);
  const sections = [], discrepancies = [];
  const have = { g1: portal.periods.gstr1.size, tb: f.length, b2: portal.periods.gstr2b.size };

  const split = (rows) => ({
    b2c: totalOf(rows.filter((r) => r.type === "inv" && !r.gstin && !r.rcm)), b2b: totalOf(rows.filter((r) => r.type === "inv" && r.gstin && !r.rcm)),
    cn: totalOf(rows.filter((r) => r.type === "cn")), dn: totalOf(rows.filter((r) => r.type === "dn")), nil: totalOf(rows.filter((r) => !(r.rate > 0) && r.type === "inv")),
  });
  const B = split(bs), G = have.g1 ? split(g1) : null;
  const T3 = f.length ? { a: sum3b((x) => x.out_a), b: sum3b((x) => x.out_b), c: sum3b((x) => x.out_c), d: sum3b((x) => x.out_d), e: sum3b((x) => x.out_e) } : null;
  const pick = (t, k) => (t ? t[k] : null);
  const t4 = [];
  const line = (table, desc, b, g, t, suggested) => t4.push({ table, desc, books_taxable: b?.taxable ?? 0, books_tax: b ? taxSum(b) : 0, g1_taxable: pick(g, "taxable"), g1_tax: g ? taxSum(g) : null, tb_taxable: pick(t, "taxable"), tb_tax: t ? taxSum(t) : null, sug_taxable: suggested?.taxable ?? 0, sug_tax: suggested ? taxSum(suggested) : 0 });
  const sug = (b, g) => (G ? g : b);
  line("4A", "Supplies made to un-registered persons (B2C)", B.b2c, G?.b2c, null, sug(B.b2c, G?.b2c));
  line("4B", "Supplies made to registered persons (B2B)", B.b2b, G?.b2b, null, sug(B.b2b, G?.b2b));
  line("4C-4F", "Zero rated / SEZ / deemed exports / advances (enter manually from shipping bills / receipts)", zero(), null, T3 ? T3.b : null, T3 ? T3.b : zero());
  line("4G", "Inward supplies on which tax is to be paid on reverse charge", totalOf(bp.filter((r) => r.rcm)), null, T3?.d, T3 ? T3.d : totalOf(bp.filter((r) => r.rcm)));
  line("4I", "Credit notes issued in respect of 4B / 4A (-)", B.cn, G?.cn, null, sug(B.cn, G?.cn));
  line("4J", "Debit notes issued (+)", B.dn, G?.dn, null, sug(B.dn, G?.dn));
  const tot = (key) => t4.filter((r) => ["4A", "4B", "4C-4F", "4G", "4J"].includes(r.table)).reduce((s, r) => s + r[key], 0) + t4.filter((r) => r.table === "4I").reduce((s, r) => s + r[key], 0);
  t4.push({ table: "4N", desc: "Supplies and advances on which tax is payable (4A to 4G + 4J, net of 4I)", books_taxable: r2(tot("books_taxable")), books_tax: r2(tot("books_tax")), g1_taxable: G ? r2(tot("g1_taxable")) : null, g1_tax: G ? r2(tot("g1_tax")) : null, tb_taxable: T3 ? taxSum({ igst: 0 }) + r2(T3.a.taxable + T3.b.taxable + T3.d.taxable) : null, tb_tax: T3 ? r2(taxSum(T3.a) + taxSum(T3.b) + taxSum(T3.d)) : null, sug_taxable: r2(tot("sug_taxable")), sug_tax: r2(tot("sug_tax")), _total: true });
  const c5 = [["5A", "Zero rated supply (export) without payment of tax", T3?.b?.taxable ?? 0], ["5D", "Exempted / nil-rated supplies", T3 ? T3.c.taxable : B.nil.taxable], ["5F", "Non-GST supply", T3 ? T3.e.taxable : 0]];
  c5.forEach(([t, d, v]) => t4.push({ table: t, desc: d, books_taxable: t === "5D" ? B.nil.taxable : 0, books_tax: 0, g1_taxable: null, g1_tax: null, tb_taxable: v, tb_tax: 0, sug_taxable: v, sug_tax: 0 }));
  sections.push({ key: "t4", title: "Part II - Tables 4 & 5: Outward supplies", note: `Sources: books | GSTR-1 portal (${have.g1} months uploaded) | GSTR-3B (${have.tb} months). 'Suggested' = GSTR-1 where uploaded, else books. Taxes shown as IGST+CGST+SGST+Cess.`,
    ...srcRows(tcols([["books_taxable", "Taxable - Books"], ["books_tax", "Tax - Books"], ["g1_taxable", "Taxable - GSTR-1"], ["g1_tax", "Tax - GSTR-1"], ["tb_taxable", "Taxable - GSTR-3B"], ["tb_tax", "Tax - GSTR-3B"], ["sug_taxable", "Suggested taxable"], ["sug_tax", "Suggested tax"]]), t4) });

  // ITC tables
  const bpo = bp.filter((r) => !r.rcm), rcmb = bp.filter((r) => r.rcm);
  const eligB = totalOf(eligible(bp)), inelB = totalOf(bpo.filter((r) => r.itc === false));
  const F = (pickF) => (f.length ? sum3b(pickF) : null);
  const itcRow = (table, desc, b, tbv, b2v) => ({ table, desc, books: b ? taxSum(b) : 0, tb: tbv ? taxSum(tbv) : null, b2: b2v ? taxSum(b2v) : null, books_igst: b?.igst ?? 0, books_cgst: b?.cgst ?? 0, books_sgst: b?.sgst ?? 0, tb_igst: tbv?.igst ?? null, tb_cgst: tbv?.cgst ?? null, tb_sgst: tbv?.sgst ?? null });
  const b2all = totalOf(b2.filter((r) => r.itc !== false && !r.rcm));
  const t6 = [
    itcRow("6B", "ITC on inward supplies (other than imports, RCM, ISD) - goods & services", eligible(bp).length ? totalOf(eligible(bp)) : zero(), F((x) => x.itc_other), have.b2 ? b2all : null),
    itcRow("6C/6D", "ITC on inward supplies liable to reverse charge", totalOf(rcmb), F((x) => x.itc_rcm), null),
    itcRow("6E/6F", "Import of goods / services", zero(), F((x) => addT(x.itc_claim, { igst: -x.itc_other.igst - 0, cgst: 0, sgst: 0, cess: 0 })) && null, null),
    itcRow("6G", "ITC received from ISD", zero(), F((x) => x.itc_claim) && null, null),
    itcRow("7A-7H", "ITC reversed / ineligible (Rule 37, 38, 42, 43, 17(5))", inelB, F((x) => x.itc_rev), null),
  ];
  const totAll = itcRow("6J", "Total ITC availed (6B + 6C/D + 6E-G)", addT(eligB), F((x) => x.itc_all), have.b2 ? b2all : null);
  totAll._total = true; t6.push(totAll);
  sections.push({ key: "t6", title: "Part III - Tables 6, 7 & 8: Input tax credit", note: "Table 8A is read from the GSTR-2B Excel files. Table 8D = difference between ITC availed (8B) and 2B (8A) - to be explained in 9C.", columns: tcols([["books", "ITC - Books"], ["tb", "ITC - GSTR-3B"], ["b2", "ITC - GSTR-2B"], ["books_igst", "Books IGST"], ["books_cgst", "Books CGST"], ["books_sgst", "Books SGST"], ["tb_igst", "3B IGST"], ["tb_cgst", "3B CGST"], ["tb_sgst", "3B SGST"]]), rows: t6 });
  const d8 = { table: "8D", desc: "ITC availed (3B) less ITC per GSTR-2B (8B - 8A) - positive means excess ITC claimed", books: null, tb: totAll.tb != null && totAll.b2 != null ? r2(totAll.tb - totAll.b2) : null, b2: null, _total: true };
  t6.push(d8);
  if (d8.tb != null && Math.abs(d8.tb) > TOL) discrepancies.push({ severity: d8.tb > 0 ? "high" : "medium", area: "GSTR-9 Table 8", issue: "ITC per 3B differs from 2B", period: fy, party: "", gstin: "", ref: `8D = ${fmt(d8.tb)}`, amount: Math.abs(d8.tb), reason: d8.tb > 0 ? "More ITC was availed than appears in GSTR-2B for the year - provisional / un-matched credit. Explain in GSTR-9C and reverse any ineligible portion with interest before filing." : "ITC in 2B exceeds what was availed - unclaimed ITC; it can still be claimed only up to the s.16(4) limit (30 Nov following the FY).", action: d8.tb > 0 ? "Run the monthly 3B vs 2B table in Input Reconciliation, reverse excess ITC through DRC-03 / Table 7 of GSTR-9 and pay interest." : "Claim eligible ITC in GSTR-3B up to September/November of the next year if still eligible (or in Table 6H/13 of GSTR-9)." });

  // Table 9 tax payable
  const t9 = [["IGST", "igst"], ["CGST", "cgst"], ["SGST", "sgst"], ["Cess", "cess"]].map(([n, k]) => ({
    head: n, books_payable: r2(B.b2c[k] + B.b2b[k] + B.dn[k] + B.cn[k] + totalOf(bp.filter((r) => r.rcm))[k]),
    tb_payable: T3 ? r2(T3.a[k] + T3.b[k] + T3.d[k]) : null, itc_claimed: f.length ? r2(sum3b((x) => x.itc_all)[k] - sum3b((x) => x.itc_rev)[k]) : null,
  })).map((r) => ({ ...r, cash: r.tb_payable == null || r.itc_claimed == null ? null : r2(Math.max(r.tb_payable - r.itc_claimed, 0)), diff: r.tb_payable == null ? null : r2(r.books_payable - r.tb_payable) }));
  sections.push({ key: "t9", title: "Part IV - Table 9: Tax payable vs paid (derived)", note: "Cash paid = payable less ITC utilised, assuming the full net ITC was utilised. Replace with actual challan data when finalising GSTR-9.", columns: [{ key: "head", label: "Tax head", type: "text" }, ...[["books_payable", "Payable - Books"], ["tb_payable", "Payable - GSTR-3B"], ["itc_claimed", "Net ITC claimed (3B)"], ["cash", "Cash payable"], ["diff", "Books - 3B"]].map(([key, label]) => ({ key, label, type: "money", diff: key === "diff" }))], rows: t9 });

  // HSN
  const hsn = (rows) => { const m = new Map(); for (const r of rows) { const k = r.hsn || "N/A"; const e = m.get(k) || { hsn: k, rate: new Set(), ...zero() }; e.taxable = r2(e.taxable + r.taxable); e.igst = r2(e.igst + r.igst); e.cgst = r2(e.cgst + r.cgst); e.sgst = r2(e.sgst + r.sgst); if (r.rate) e.rate.add(r.rate); m.set(k, e); } return [...m.values()].map((e) => ({ ...e, rate: [...e.rate].map((x) => `${x}%`).join(", ") })).sort((a, b) => b.taxable - a.taxable); };
  const hcols = [{ key: "hsn", label: "HSN / SAC", type: "text" }, { key: "rate", label: "Rate", type: "text" }, ...["taxable", "igst", "cgst", "sgst"].map((k) => ({ key: k, label: k === "taxable" ? "Taxable value" : k.toUpperCase(), type: "money" }))];
  sections.push({ key: "t17", title: "Table 17: HSN-wise summary of outward supplies (books)", columns: hcols, rows: hsn(bs) });
  sections.push({ key: "t18", title: "Table 18: HSN-wise summary of inward supplies (books)", columns: hcols, rows: hsn(bpo) });

  const mrows = periods.map((p) => {
    const s = totalOf(bs.filter((r) => r.period === p)), g = portal.periods.gstr1.has(p) ? totalOf(g1.filter((r) => r.period === p)) : null, t = portal.gstr3b[p] ? figuresOf(portal.gstr3b[p]) : null;
    return { period: p, b_tx: s.taxable, b_tax: taxSum(s), g_tx: g?.taxable ?? null, g_tax: g ? taxSum(g) : null, t_tx: t?.out_taxable ?? null, t_tax: t ? taxSum(t.out_ab) : null, itc_b: taxSum(totalOf(eligible(bp).filter((r) => r.period === p))), itc_3b: t ? taxSum(t.itc_all) : null, itc_2b: portal.periods.gstr2b.has(p) ? taxSum(totalOf(b2.filter((r) => r.period === p && r.itc !== false && !r.rcm))) : null };
  });
  sections.push({ key: "months", title: "Month-wise matrix (basis for all GSTR-9 tables)", columns: [{ key: "period", label: "Month", type: "period" }, ...[["b_tx", "Taxable - Books"], ["b_tax", "Tax - Books"], ["g_tx", "Taxable - GSTR-1"], ["g_tax", "Tax - GSTR-1"], ["t_tx", "Taxable - 3B"], ["t_tax", "Tax - 3B"], ["itc_b", "ITC - Books"], ["itc_3b", "ITC - 3B"], ["itc_2b", "ITC - 2B"]].map(([key, label]) => ({ key, label, type: "money" }))], rows: mrows });
  const missing = [];
  const m1 = periods.filter((p) => !portal.periods.gstr1.has(p)), m3 = periods.filter((p) => !portal.gstr3b[p]), m2 = periods.filter((p) => !portal.periods.gstr2b.has(p));
  if (m1.length) missing.push(`GSTR-1 Excel for ${m1.length} month(s)`); if (m3.length) missing.push(`GSTR-3B PDF for ${m3.length} month(s)`); if (m2.length) missing.push(`GSTR-2B Excel for ${m2.length} month(s)`);
  return finish("GSTR-9 Annual Return Working", client, periods[0], periods[11], periods, sections, discrepancies, { pending_approval: books.pending_approval, ledgers: books.ledgerInfo, missing, fy });
}

/* ------------------------------------------------------------------ GSTR-9C */

export async function buildGstr9c(firmId, client, fy, finTurnover) {
  const periods = fyPeriods(fy);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const { bs, bp, g1, b2, f, sum3b } = annual(periods, books, portal);
  const sections = [], discrepancies = [];
  const booksSales = totalOf(bs), g1T = portal.periods.gstr1.size ? totalOf(g1) : null;
  const T3 = f.length ? { a: sum3b((x) => x.out_a), b: sum3b((x) => x.out_b), c: sum3b((x) => x.out_c), d: sum3b((x) => x.out_d) } : null;
  const gstr9Turnover = T3 ? r2(T3.a.taxable + T3.b.taxable + T3.c.taxable) : (g1T ? g1T.taxable : booksSales.taxable);
  const fin = finTurnover != null && Number.isFinite(finTurnover) ? finTurnover : null;
  const p5 = [
    { table: "5A", desc: "Turnover as per audited financial statements (enter via 'Audited turnover' box; defaults to books)", amount: fin ?? booksSales.taxable },
    { table: "5B-5N", desc: "Adjustments (unbilled revenue, advances, credit notes, deemed supply, etc.) - enter in your final working", amount: 0 },
    { table: "5O", desc: "Turnover as per books of account (sales ledgers + approved invoices, net of notes)", amount: booksSales.taxable },
    { table: "5P", desc: "Turnover as per GSTR-1 (portal)", amount: g1T ? g1T.taxable : null },
    { table: "5Q", desc: "Annual turnover as per GSTR-9 (from GSTR-3B 3.1(a)+(b)+(c); else GSTR-1; else books)", amount: gstr9Turnover },
    { table: "5R", desc: "Unreconciled turnover (5A - 5Q)", amount: r2((fin ?? booksSales.taxable) - gstr9Turnover), _total: true },
  ];
  sections.push({ key: "t5", title: "Part II - Table 5: Reconciliation of gross turnover", columns: [{ key: "table", label: "Table", type: "text" }, { key: "desc", label: "Description", type: "long" }, { key: "amount", label: "Amount", type: "money" }], rows: p5 });
  const unrec = p5[5].amount;
  if (Math.abs(unrec) > TOL) discrepancies.push({ severity: "high", area: "GSTR-9C Table 5", issue: "Unreconciled turnover", period: fy, party: "", gstin: "", ref: `5R = ${fmt(unrec)}`, amount: Math.abs(unrec), reason: unrec > 0 ? "Turnover in financial statements/books is higher than turnover reported in the returns: unreported sales, advances, sales of fixed assets / other income, or timing of invoices across the FY boundary." : "Turnover reported in the returns exceeds the books: sales returns / cancellations not adjusted in the return, advances, duplicate reporting.", action: unrec > 0 ? "Identify the items (Table 5B-5N), pay tax with interest on any unreported taxable supply through DRC-03 and disclose in GSTR-9C Table 14/15." : "Obtain the credit note / cancellation documents and reconcile the difference in Table 14 (reasons for unreconciled difference)." });

  // table 7 taxable turnover
  const nil = totalOf(bs.filter((r) => !(r.rate > 0)));
  sections.push({ key: "t7", title: "Part II - Table 7: Reconciliation of taxable turnover", columns: [{ key: "table", label: "Table", type: "text" }, { key: "desc", label: "Description", type: "long" }, { key: "amount", label: "Amount", type: "money" }], rows: [
    { table: "7A", desc: "Turnover as reconciled (5Q)", amount: gstr9Turnover },
    { table: "7B", desc: "Less: exempt / nil-rated / zero-rated / non-GST turnover", amount: T3 ? r2(T3.b.taxable + T3.c.taxable) : nil.taxable },
    { table: "7E", desc: "Taxable turnover as per books (rate > 0)", amount: r2(booksSales.taxable - nil.taxable) },
    { table: "7F", desc: "Taxable turnover as per GSTR-9 (7A - 7B)", amount: r2(gstr9Turnover - (T3 ? T3.b.taxable + T3.c.taxable : nil.taxable)) },
    { table: "7G", desc: "Unreconciled taxable turnover (7E - 7F)", amount: r2(booksSales.taxable - nil.taxable - (gstr9Turnover - (T3 ? T3.b.taxable + T3.c.taxable : nil.taxable))), _total: true },
  ] });

  // table 9 rate wise
  const rate = (rows) => { const m = groupTotals(rows, (r) => r.rate || 0); return m; };
  const rb = rate(bs.filter((r) => r.rate > 0)), rg = g1T ? rate(g1.filter((r) => r.rate > 0)) : new Map();
  const rates = [...new Set([...rb.keys(), ...rg.keys()])].sort((a, b) => a - b);
  const t9 = rates.map((rt) => {
    const x = rb.get(rt) || zero(), y = rg.get(rt);
    return { rate: `${rt}%`, b_tx: x.taxable, b_tax: taxSum(x), g_tx: y?.taxable ?? null, g_tax: y ? taxSum(y) : null, calc: r2(x.taxable * rt / 100), d: y ? r2(taxSum(x) - taxSum(y)) : null };
  });
  sections.push({ key: "t9", title: "Part II - Table 9: Reconciliation of rate-wise liability and amount payable", note: "Books tax vs tax at the stated rate, and vs GSTR-1. Differences must be paid / explained.", columns: [{ key: "rate", label: "Rate", type: "text" }, ...[["b_tx", "Taxable - Books"], ["b_tax", "Tax - Books"], ["calc", "Tax at rate"], ["g_tx", "Taxable - GSTR-1"], ["g_tax", "Tax - GSTR-1"], ["d", "Books - GSTR-1 tax"]].map(([key, label]) => ({ key, label, type: "money", diff: key === "d" }))], rows: t9 });

  // table 12 ITC
  const booksItc = totalOf(eligible(bp)), rcmItc = totalOf(bp.filter((r) => r.rcm)), blocked = totalOf(bp.filter((r) => !r.rcm && r.itc === false));
  const tbItc = f.length ? sum3b((x) => x.itc_all) : null, tbRev = f.length ? sum3b((x) => x.itc_rev) : null, b2all = portal.periods.gstr2b.size ? totalOf(b2.filter((r) => r.itc !== false && !r.rcm)) : null;
  const t12 = [
    { table: "12A", desc: "ITC availed as per audited financial statements / books (non-RCM, eligible)", amount: taxSum(booksItc) },
    { table: "12B", desc: "RCM ITC as per books", amount: taxSum(rcmItc) },
    { table: "12C", desc: "ITC blocked / ineligible per books", amount: taxSum(blocked) },
    { table: "12D", desc: "ITC booked in books (A + B)", amount: r2(taxSum(booksItc) + taxSum(rcmItc)) },
    { table: "12E", desc: "ITC availed as per GSTR-9 (GSTR-3B 4A less 4B)", amount: tbItc ? r2(taxSum(tbItc) - taxSum(tbRev)) : null },
    { table: "12F", desc: "ITC as per GSTR-2B (annual)", amount: b2all ? taxSum(b2all) : null },
    { table: "12G", desc: "Unreconciled ITC (12D - 12E)", amount: tbItc ? r2(taxSum(booksItc) + taxSum(rcmItc) - (taxSum(tbItc) - taxSum(tbRev))) : null, _total: true },
  ];
  sections.push({ key: "t12", title: "Part II - Table 12 & 13: Reconciliation of ITC", columns: [{ key: "table", label: "Table", type: "text" }, { key: "desc", label: "Description", type: "long" }, { key: "amount", label: "Amount", type: "money" }], rows: t12 });
  const u12 = t12[6].amount;
  if (u12 != null && Math.abs(u12) > TOL) discrepancies.push({ severity: "high", area: "GSTR-9C Table 12", issue: "Unreconciled ITC", period: fy, party: "", gstin: "", ref: `12G = ${fmt(u12)}`, amount: Math.abs(u12), reason: u12 > 0 ? "ITC booked in the purchase books exceeds ITC availed in GSTR-3B: unclaimed / blocked ITC, ITC claimed in the next year or invoices not in GSTR-2B." : "ITC claimed in GSTR-3B exceeds the books: credits claimed without booked invoices, opening-balance credit or transitional items.", action: u12 > 0 ? "Claim any eligible ITC within the s.16(4) time limit or write it off as blocked credit; document in Table 13 (reasons)." : "Reverse excess ITC with interest before filing GSTR-9; disclose in Table 14." });
  if (b2all && tbItc) {
    const d = r2(taxSum(tbItc) - taxSum(tbRev) - taxSum(b2all));
    if (Math.abs(d) > TOL) discrepancies.push({ severity: d > 0 ? "high" : "medium", area: "GSTR-9C Table 12", issue: "ITC per 3B differs from 2B", period: fy, party: "", gstin: "", ref: `3B - 2B = ${fmt(d)}`, amount: Math.abs(d), reason: d > 0 ? "ITC availed is more than available in GSTR-2B for the year." : "ITC in 2B is not fully availed.", action: "Use the monthly Input Reconciliation to find the months and suppliers." });
  }

  const missing = [];
  if (!portal.periods.gstr1.size) missing.push("GSTR-1 Excel (portal)"); if (!f.length) missing.push("GSTR-3B PDFs"); if (!portal.periods.gstr2b.size) missing.push("GSTR-2B Excel files");
  if (fin == null) missing.push("Audited turnover (5A) - defaulted to books turnover");
  return finish("GSTR-9C Reconciliation Statement Working", client, periods[0], periods[11], periods, sections, discrepancies, { pending_approval: books.pending_approval, ledgers: books.ledgerInfo, missing, fy });
}

function finish(title, client, from, to, periods, sections, discrepancies, extra) {
  const sev = { high: 0, medium: 1, low: 2 };
  discrepancies.sort((a, b) => sev[a.severity] - sev[b.severity] || b.amount - a.amount);
  const high = discrepancies.filter((d) => d.severity === "high").length;
  return {
    title, client: { id: client.id, name: client.name, gstin: client.gstin }, from, to, periods, ...extra,
    summary: { total: discrepancies.length, high, medium: discrepancies.filter((d) => d.severity === "medium").length, low: discrepancies.filter((d) => d.severity === "low").length },
    sections, discrepancies: discrepancies.slice(0, 1000),
  };
}
