import {
  prep, periodsBetween, matchDocuments, monthlyTable, rateTable, partyTable, exceptionTable, docListTable, discrepancyList,
  annotateMonths, monthDiscrepancies, groupTotals, aggregateDocs, docKey, r2, TOL,
} from "./engine.js";
import { loadBooks, loadPortal } from "./books.js";
import { emptyFigures } from "./gstr3bParser.js";

const TAX = ["igst", "cgst", "sgst", "cess"];
const OUT = ["taxable", "igst", "cgst", "sgst"];
const fmt = (n) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mcol = (key, label, extra = {}) => ({ key, label, type: "money", ...extra });
const MONEY_COLS = [mcol("taxable", "Taxable value"), mcol("igst", "IGST"), mcol("cgst", "CGST"), mcol("sgst", "SGST"), mcol("cess", "Cess")];
const taxOf = (t) => r2(TAX.reduce((s, k) => s + (t?.[k] || 0), 0));
const fold = (rows) => rows.map((r) => (r.gstin ? r : { ...r, party: "Unregistered / B2C (consolidated)" }));
const registered = (rows) => rows.filter((r) => r.gstin);
const docType = (t) => (t === "cn" ? "Credit note" : t === "dn" ? "Debit note" : "Invoice");

const reason = (la, lb) => (r) => {
  const taxD = r2(TAX.reduce((s, k) => s + (r[`${k}_d`] || 0), 0));
  if (Math.abs(taxD) <= TOL) return { reason: "Taxable value differs but tax is the same: nil-rated / exempt / zero-rated / non-GST supplies classified differently, or a taxable-value-only difference on an invoice.", action: "Check the classification of nil-rated, exempt and zero-rated supplies on both sides and correct the table." };
  if (taxD > 0) return { reason: `${la} shows ${fmt(taxD)} more tax than ${lb}: invoices missed or reported in a different month, credit notes / amendments taken on one side only, or tax under-reported on ${lb}.`, action: `Drill down in the party and invoice sheets. If ${lb} is a filed return and short, pay the difference with interest u/s 50 and report / amend it in GSTR-1; if ${la} is wrong, correct the entries.` };
  return { reason: `${lb} shows ${fmt(-taxD)} more tax than ${la}: supplies reported but not recorded, advances, returns / cancellations not reversed, or excess tax paid.`, action: `Verify against source invoices. Record missing entries on ${la}, or adjust excess in ${lb} through amendment / credit notes in the next GSTR-1 and 3B (or claim a refund).` };
};

function summaryByMonth(periods, rows) {
  const g = groupTotals(rows, (r) => r.period);
  const out = periods.map((p) => { const t = g.get(p); return { period: p, docs: t?.docs.size || 0, ...Object.fromEntries(["taxable", "igst", "cgst", "sgst", "cess"].map((k) => [k, t?.[k] || 0])), tax: t ? taxOf(t) : 0 }; });
  const tot = { period: "Total", docs: out.reduce((s, r) => s + r.docs, 0), _total: true };
  for (const k of ["taxable", "igst", "cgst", "sgst", "cess", "tax"]) tot[k] = r2(out.reduce((s, r) => s + r[k], 0));
  return { columns: [{ key: "period", label: "Month", type: "period" }, { key: "docs", label: "Documents", type: "int" }, ...MONEY_COLS, mcol("tax", "Total tax")], rows: [...out, tot] };
}

function summaryByMonthRate(periods, rows) {
  const out = [];
  for (const p of periods) {
    const g = groupTotals(rows.filter((r) => r.period === p), (r) => r.rate || 0);
    for (const rate of [...g.keys()].sort((a, b) => a - b)) { const t = g.get(rate); out.push({ period: p, rate: `${rate}%`, docs: t.docs.size, ...Object.fromEntries(["taxable", "igst", "cgst", "sgst", "cess"].map((k) => [k, t[k]])) }); }
  }
  return { columns: [{ key: "period", label: "Month", type: "period" }, { key: "rate", label: "Tax rate", type: "text" }, { key: "docs", label: "Documents", type: "int" }, ...MONEY_COLS], rows: out };
}

function entryRows(rows, matchFn) {
  return [...rows].sort((a, b) => a.period.localeCompare(b.period) || (a.rate || 0) - (b.rate || 0) || String(a.date).localeCompare(String(b.date)) || String(a.inv_no).localeCompare(String(b.inv_no)))
    .map((r) => ({ ...r, doc_type: docType(r.type), ...(matchFn ? matchFn(r) : {}) }));
}
const ENTRY_COLS = [
  { key: "period", label: "Month", type: "period" }, { key: "rate", label: "Rate %", type: "text" }, { key: "date", label: "Date", type: "text" }, { key: "inv_no", label: "Document no.", type: "text" }, { key: "doc_type", label: "Type", type: "text" },
  { key: "party", label: "Party", type: "text" }, { key: "gstin", label: "GSTIN", type: "text" }, ...MONEY_COLS,
];

/** shared comparison: month, rate, party, document sheets + discrepancies */
function compare({ title, area, periods, A, B, la, lb, availA, availB, docs = true }) {
  const both = new Set(periods.filter((p) => availA.has(p) && availB.has(p)));
  const skip = new Set(periods.filter((p) => !both.has(p)));
  const a = A.filter((r) => both.has(r.period)), b = B.filter((r) => both.has(r.period));
  const rf = reason(la, lb);
  const m = annotateMonths(monthlyTable({ periods, a, b, fields: OUT, labelA: la, labelB: lb, skip }), rf);
  const sections = [{ key: "month", title: `Month-wise: ${la} vs ${lb}`, note: "Credit notes deducted, debit notes added. 'No file' = one side is missing for that month and the month is excluded from totals.", ...m }];
  const discrepancies = monthDiscrepancies(m, area, rf, OUT);
  if (docs) {
    sections.push({ key: "rate", title: `Tax-rate-wise: ${la} vs ${lb}`, ...rateTable({ a, b, fields: OUT, labelA: la, labelB: lb }) });
    sections.push({ key: "party", title: `Party-wise pivot with GSTIN: ${la} vs ${lb}`, note: "Customers without a GSTIN are consolidated as B2C.", ...partyTable({ a: fold(a), b: fold(b), fields: OUT, labelA: la, labelB: lb }) });
    const match = matchDocuments(registered(a), registered(b), "output");
    sections.push({ key: "docs", title: `Document-level mismatches (GSTIN parties) - ${match.matched} matched, ${match.exceptions.length} exceptions`, ...exceptionTable(match.exceptions, "output", la, lb) });
    discrepancies.push(...discrepancyList(match.exceptions, area));
  }
  return { title, sections, discrepancies, missing: periods.filter((p) => skip.has(p)).length ? [`Comparison skipped for ${[...skip].join(", ")} - ${la} or ${lb} not available`] : [] };
}

function booksReport(periods, ledRows, invRows) {
  const ledP = prep(ledRows);
  const ledDocs = aggregateDocs(ledP), invDocs = aggregateDocs(prep(invRows));
  const near = (x, y) => Math.abs(x - y) <= TOL;
  const status = (r) => {
    const k = docKey(r);
    const inv = invDocs.get(k), led = ledDocs.get(k);
    if (!inv) return { db_status: "Not in system invoices", db_taxable: null, db_tax: null };
    const diff = !near(led.taxable, inv.taxable) || !near(taxOf(led), taxOf(inv));
    return { db_status: diff ? "Value differs" : "Matched", db_taxable: inv.taxable, db_tax: taxOf(inv) };
  };
  const entries = entryRows(ledP, status);
  const matchSec = [];
  const keys = new Set([...ledDocs.keys(), ...invDocs.keys()]);
  const exc = [];
  for (const k of keys) {
    const l = ledDocs.get(k), i = invDocs.get(k);
    if (l && i && near(l.taxable, i.taxable) && near(taxOf(l), taxOf(i))) continue;
    const d = l || i;
    const row = { issue: !i ? "In ledger, no invoice in system" : !l ? "Invoice in system, not in ledger" : "Value differs", party: d.party, gstin: d.gstin, inv_no: d.inv_no, doc_type: docType(d.type), period: d.period, taxable_a: l?.taxable ?? null, taxable_b: i?.taxable ?? null, tax_a: l ? taxOf(l) : null, tax_b: i ? taxOf(i) : null };
    if (!i) { row.reason = "Sale recorded in the ledger but no approved invoice has been uploaded for it, or the invoice number / party is written differently in the invoice."; row.action = "Ask the client to upload and approve the invoice, or confirm it is a ledger-only entry (e.g. an adjustment / journal)."; }
    else if (!l) { row.reason = "An approved invoice exists in the system but the sales ledger uploaded by the client does not contain it: ledger incomplete, a different month, or entered with a different number."; row.action = "Ask the client for the complete ledger for the month, or confirm that the invoice belongs to another period."; }
    else { row.reason = "Ledger and invoice amounts differ: wrong rate or amount keyed in the ledger, round-off, or a revised invoice."; row.action = "Check the invoice against the ledger; correct whichever is wrong before filing GSTR-1."; }
    exc.push(row);
  }
  const discrepancies = exc.map((e) => ({ severity: e.issue === "Value differs" ? "medium" : "high", area: "Books vs system invoices", issue: e.issue, period: e.period, party: e.party, gstin: e.gstin, ref: e.inv_no, amount: r2(Math.abs((e.tax_a ?? 0) - (e.tax_b ?? 0)) || Math.abs((e.taxable_a ?? 0) - (e.taxable_b ?? 0))), reason: e.reason, action: e.action }));
  matchSec.push({ key: "match", title: `Match with sales invoices in the system - ${exc.length} exceptions`, columns: [
    { key: "issue", label: "Issue", type: "text" }, { key: "period", label: "Month", type: "period" }, { key: "inv_no", label: "Document no.", type: "text" }, { key: "doc_type", label: "Type", type: "text" }, { key: "party", label: "Party", type: "text" }, { key: "gstin", label: "GSTIN", type: "text" },
    mcol("taxable_a", "Taxable - Ledger"), mcol("taxable_b", "Taxable - Invoices"), mcol("tax_a", "Tax - Ledger"), mcol("tax_b", "Tax - Invoices"), { key: "reason", label: "Possible reason", type: "long" }, { key: "action", label: "Recommended action", type: "long" },
  ], rows: exc });
  return {
    title: "Books data working (sales ledgers + credit / debit notes)",
    sections: [
      { key: "month", title: "Month-wise summary of sales ledger (net of credit notes)", ...summaryByMonth(periods, ledP) },
      { key: "monthrate", title: "Month-wise and rate-wise summary", ...summaryByMonthRate(periods, ledP) },
      { key: "entries", title: "Each ledger entry, month by month and rate-wise, with match against system invoices", note: "Credit notes appear as negative values. 'Match' compares the document with the approved sales invoice in the system.", columns: [...ENTRY_COLS, { key: "db_status", label: "Match with system invoice", type: "status" }, mcol("db_taxable", "Taxable - invoice"), mcol("db_tax", "Tax - invoice")], rows: entries },
      ...matchSec,
    ],
    discrepancies,
    missing: ledRows.length ? [] : ["No sales ledger uploaded by the client for this period"],
  };
}

function workingReport(periods, invRows) {
  const P = prep(invRows);
  return {
    title: "GSTR-1 working compiled from approved invoices",
    sections: [
      { key: "month", title: "Month-wise GSTR-1 working", ...summaryByMonth(periods, P) },
      { key: "monthrate", title: "Month-wise and rate-wise", ...summaryByMonthRate(periods, P) },
      { key: "b2b", title: "B2B / B2C / credit and debit notes - document list", columns: [...ENTRY_COLS.filter((c) => c.key !== "rate"), { key: "rates", label: "Rate(s)", type: "text" }], rows: docListTable(P, "").rows },
    ],
    discrepancies: [],
    missing: invRows.length ? [] : ["No client-approved sales invoices in the system for this period"],
  };
}

function figureTotals(portal, p) {
  const f = portal.gstr3b[p] || emptyFigures();
  const ab = { taxable: f.outward.a.taxable + f.outward.b.taxable, igst: f.outward.a.igst + f.outward.b.igst, cgst: f.outward.a.cgst + f.outward.b.cgst, sgst: f.outward.a.sgst + f.outward.b.sgst, cess: f.outward.a.cess + f.outward.b.cess };
  return { ...ab, taxable_all: ab.taxable + f.outward.c.taxable };
}

export async function buildOutputPack(firmId, client, from, to) {
  const periods = periodsBetween(from, to);
  const [books, portal] = await Promise.all([loadBooks(firmId, client, periods), loadPortal(firmId, client.id, periods)]);
  const ledRows = books.ledgerRows.sales;
  const invRows = books.sales.filter((r) => r.src === "invoice");
  const ledP = prep(ledRows), invP = prep(invRows), g1P = prep(portal.gstr1);
  const has = (rows) => new Set(rows.map((r) => r.period));
  const g1Av = portal.periods.gstr1, tbAv = portal.periods.gstr3b;
  const tbRows = periods.filter((p) => tbAv.has(p)).map((p) => { const t = figureTotals(portal, p); return { period: p, type: "inv", gstin: "", party: "", inv_no: p, rate: 0, taxable: t.taxable_all, igst: t.igst, cgst: t.cgst, sgst: t.sgst, cess: t.cess }; });
  const all = new Set(periods);

  const reports = {
    books: booksReport(periods, ledRows, invRows),
    g1working: workingReport(periods, invRows),
    g1_3b: compare({ title: "GSTR-1 (portal) vs GSTR-3B compiled from PDF", area: "GSTR-1 portal vs GSTR-3B", periods, A: g1P, B: tbRows, la: "GSTR-1 portal", lb: "GSTR-3B", availA: g1Av, availB: tbAv, docs: false }),
    working_g1: compare({ title: "GSTR-1 working compiled vs GSTR-1 portal", area: "GSTR-1 working vs portal", periods, A: invP, B: g1P, la: "GSTR-1 working", lb: "GSTR-1 portal", availA: has(invRows).size ? all : new Set(), availB: g1Av }),
    books_working: compare({ title: "Books vs GSTR-1 working", area: "Books vs GSTR-1 working", periods, A: ledP, B: invP, la: "Books", lb: "GSTR-1 working", availA: has(ledRows).size ? all : new Set(), availB: has(invRows).size ? all : new Set() }),
    books_3b: compare({ title: "Books vs GSTR-3B", area: "Books vs GSTR-3B", periods, A: ledP, B: tbRows, la: "Books", lb: "GSTR-3B", availA: has(ledRows).size ? all : new Set(), availB: tbAv, docs: false }),
  };
  const out = {};
  for (const [key, r] of Object.entries(reports)) {
    const d = r.discrepancies;
    const sev = { high: 0, medium: 1, low: 2 };
    d.sort((a, b) => sev[a.severity] - sev[b.severity] || b.amount - a.amount);
    out[key] = { title: r.title, client: { id: client.id, name: client.name, gstin: client.gstin }, from, to, periods, pending_approval: books.pending_approval, ledgers: books.ledgerInfo, missing: r.missing || [],
      summary: { total: d.length, high: d.filter((x) => x.severity === "high").length, medium: d.filter((x) => x.severity === "medium").length, low: d.filter((x) => x.severity === "low").length },
      sections: r.sections, discrepancies: d.slice(0, 1000) };
  }
  const month = (p) => ({
    period: p, ledger: ledRows.some((r) => r.period === p), invoices: invRows.some((r) => r.period === p), gstr1: g1Av.has(p), gstr3b: tbAv.has(p),
  });
  return { reports: out, status: { periods: periods.map(month), pending_approval: books.pending_approval, ledger_entries: ledRows.length, invoice_rows: invRows.length } };
}
