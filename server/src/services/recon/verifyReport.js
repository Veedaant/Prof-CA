import ExcelJS from "exceljs";
import { CATS, CAT_ORDER, buildRows } from "./verifyExplain.js";

export const MISSING_KINDS = ["missing_document", "missing_all", "missing_ledger", "not_in_ledger", "unsent", "type_mismatch"];
export const isMissing = (f) => MISSING_KINDS.includes(f.kind);
export const isChanged = (f) => f.kind === "value_mismatch";

const border = { style: "thin", color: { argb: "FFD9D9D9" } };
const borders = { left: border, right: border, top: border, bottom: border };
const money = "#,##0.00";
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const head = (c) => {
  c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
  c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  c.border = borders;
};

function textCell(c, v, wrap = true) {
  c.value = v ?? "";
  c.border = borders;
  c.font = { name: "Calibri", size: 10 };
  c.alignment = { vertical: "top", wrapText: wrap };
  if (typeof v === "number") { c.numFmt = money; c.alignment = { vertical: "top", horizontal: "right" }; }
}

/**
 * The Excel prepared from the invoices, checked against the ledger, as two sheets:
 *  1) Summary - totals on each side and a count of every kind of difference (omission, commission, rounding...)
 *  2) Differences - each difference: what it is, what the ledger says, what the working says, and what to do about it.
 */
export async function generateVerificationWorkbook({ clientName, clientGstin, period, verification, runAt }) {
  const wb = new ExcelJS.Workbook();
  const live = verification.findings.filter((f) => !f.hidden);
  const rows = buildRows(live, verification.rounding || []);

  // ------------------------------------------------------------ sheet 1: summary
  const sum = wb.addWorksheet("Summary");
  [34, 22, 16, 18, 18, 60].forEach((w, i) => { sum.getColumn(i + 1).width = w; });
  let r = 1;
  const put = (row, col, v, o = {}) => {
    const c = sum.getCell(row, col);
    c.value = v;
    c.font = { name: "Calibri", size: o.size || 10, bold: Boolean(o.bold) };
    if (o.num) { c.numFmt = money; c.alignment = { horizontal: "right" }; }
    if (o.border) c.border = borders;
    if (o.wrap) c.alignment = { vertical: "top", wrapText: true };
    return c;
  };
  put(r++, 1, "GSTR-3B: ledger checked against the working prepared from the invoices", { bold: true, size: 13 });
  const info = [
    ["Client", `${clientName}${clientGstin ? ` (${clientGstin})` : ""}`],
    ["Month", period],
    ["Checked on", runAt ? new Date(runAt).toLocaleString() : "not yet checked"],
    ["Ledger files", verification.ledger.files.map((x) => x.filename).join(", ") || "none"],
    ["Documents in the ledger", `${verification.ledger.documents}  (invoices ${verification.ledger.by_type.inv || 0}, credit notes ${verification.ledger.by_type.cn || 0}, debit notes ${verification.ledger.by_type.dn || 0})`],
    ["Documents in the working", `${verification.documents.sent_total}  (invoices ${verification.documents.sent.inv || 0}, credit notes ${verification.documents.sent.cn || 0}, debit notes ${verification.documents.sent.dn || 0})`],
    ["Documents that agree", String(verification.matched)],
  ];
  for (const [k, v] of info) { put(r, 1, k, { bold: true }); put(r, 2, v); r++; }
  r++;

  put(r++, 1, "1. Totals on each side (credit notes deducted)", { bold: true, size: 11 });
  ["", "As per ledger", "As per working (invoices)", "Difference"].forEach((h, i) => { if (i) { const c = sum.getCell(r, i + 1); c.value = h; head(c); } });
  const hc = sum.getCell(r, 1); hc.value = "Head"; head(hc);
  r++;
  const T = verification.totals || { ledger: {}, working: {} };
  for (const [k, label] of [["taxable", "Taxable value"], ["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST"], ["cess", "Cess"], ["total", "Invoice value"]]) {
    const l = T.ledger[k] || 0, w = T.working[k] || 0;
    put(r, 1, label, { border: true });
    put(r, 2, l, { num: true, border: true });
    put(r, 3, w, { num: true, border: true });
    put(r, 4, r2(l - w), { num: true, border: true, bold: Math.abs(l - w) > 1 });
    r++;
  }
  r++;

  put(r++, 1, "2. What is wrong, by kind of difference", { bold: true, size: 11 });
  ["Kind of difference", "Type of error", "Number", "Open", "Amount involved", "Documents"].forEach((h, i) => { const c = sum.getCell(r, i + 1); c.value = h; head(c); });
  r++;
  let totalCount = 0, totalOpen = 0;
  for (const key of CAT_ORDER) {
    const list = rows.filter((x) => x.cat === key);
    const open = list.filter((x) => x.status === "Open").length;
    const amount = list.reduce((a, x) => a + (typeof x.amount === "number" ? x.amount : typeof x.diff === "number" ? Math.abs(x.diff) : 0), 0);
    const docs = [...new Set(list.map((x) => x.document))];
    totalCount += list.length; totalOpen += open;
    put(r, 1, CATS[key].label, { border: true, wrap: true });
    put(r, 2, CATS[key].kind, { border: true });
    put(r, 3, list.length, { border: true });
    put(r, 4, open, { border: true });
    put(r, 5, list.length ? r2(amount) : 0, { num: true, border: true });
    put(r, 6, docs.join(", "), { border: true, wrap: true });
    if (list.length) for (let c = 1; c <= 6; c++) sum.getCell(r, c).font = { name: "Calibri", size: 10, bold: c <= 2 };
    r++;
  }
  put(r, 1, "Total", { bold: true, border: true });
  put(r, 2, "", { border: true });
  put(r, 3, totalCount, { bold: true, border: true });
  put(r, 4, totalOpen, { bold: true, border: true });
  put(r, 5, "", { border: true });
  put(r, 6, "", { border: true });
  r += 2;
  const notes = [
    "Omission: something is on one side only (an invoice with no ledger entry, or a ledger entry with no invoice).",
    "Commission: it is on both sides but recorded wrongly (wrong amount, tax head, GSTIN or document type).",
    "Rounding: differences of up to ₹1 are not treated as errors. They are listed on the Differences sheet for information.",
    "The ledger is read from the file the client uploaded; the working is the data read from the invoices and verified by the client. The Differences sheet says what to do about each item.",
  ];
  for (const n of notes) { put(r, 1, n, { wrap: false }); r++; }
  sum.views = [{ state: "frozen", ySplit: 1 }];

  // ------------------------------------------------------------ sheet 2: differences
  const ws = wb.addWorksheet("Differences");
  const cols = [["No.", 6], ["Document", 24], ["Party", 22], ["Kind of difference", 28], ["Item", 14], ["Reason for the difference", 62], ["In the ledger (books)", 22], ["In the working (as per invoice)", 22], ["Difference (books - invoice)", 16], ["What to do", 62], ["Status", 20]];
  cols.forEach(([h, w], i) => { ws.getColumn(i + 1).width = w; const c = ws.getCell(1, i + 1); c.value = h; head(c); });
  ws.getRow(1).height = 32;
  rows.forEach((x, i) => {
    const vals = [i + 1, x.document, x.party, CATS[x.cat].label, x.item, x.reason, x.ledger, x.working, x.diff, x.action, x.status];
    vals.forEach((v, c) => textCell(ws.getCell(i + 2, c + 1), v));
  });
  if (!rows.length) textCell(ws.getCell(2, 2), "No differences: every document in the working agrees with the ledger.");
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
