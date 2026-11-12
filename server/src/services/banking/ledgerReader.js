import path from "node:path";
import { readSheets, toNum, toDate, SHEET_EXTS } from "../recon/sheetParser.js";
import { emptyRow, findHeader } from "../itc/readers.js";
import { r2 } from "./common.js";

/**
 * A ledger account from the books (Tally "Ledger Vouchers", or any register with Date / Particulars / Debit / Credit).
 * Debit and credit are kept as the books show them: for a bank account a debit is money in, for a loan account a credit is money owed.
 */

const COLS = {
  date: [/^date$/, /\bdate\b/],
  particulars: [/^particulars$/, /^ledger( name)?$/, /^party( name)?$/, /^account( name)?$/, /^name$/, /^to ?\/ ?by$/],
  vchType: [/vch\.? ?type/, /voucher type/, /^type$/],
  vchNo: [/vch\.? ?no/, /voucher (no|number)/, /^no\.?$/, /^number$/, /ref/],
  narration: [/narration/, /remarks?/, /description/],
  debit: [/^debit/, /^receipts?/, /^dr\.?$/, /\bdebit\b/],
  credit: [/^credit/, /^payments?/, /^cr\.?$/, /\bcredit\b/],
  balance: [/balance/],
};

const OPENING = /^\s*(opening balance|balance b\/?f|brought forward|op\.? ?bal)/i;
const CLOSING = /^\s*(closing balance|balance c\/?f|carried forward)/i;
const hasNum = (v) => v !== "" && v != null && !Number.isNaN(Number(String(v).replace(/[,₹\s]|cr\.?$|dr\.?$/gi, "")));
/** Dr is positive, Cr is negative, as in a ledger. */
const signed = (v) => (/\bcr\.?$/i.test(String(v ?? "").trim()) ? -Math.abs(toNum(v)) : toNum(v));
const cleanParty = (s) => String(s ?? "").replace(/^\s*(to|by)\s+/i, "").replace(/\s+/g, " ").trim();

export async function readLedger(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SHEET_EXTS.includes(ext)) throw new Error("Upload the ledger as an Excel file (any version) or a CSV file.");
  const sheets = await readSheets(buffer, filename);
  let best = null;
  for (const sh of sheets) {
    const h = findHeader(sh.rows, COLS, (have) => have.includes("date") && have.includes("debit") && have.includes("credit"));
    if (h && (!best || h.score > best.h.score)) best = { sh, h };
  }
  if (!best) {
    const first = sheets.flatMap((s) => s.rows).slice(0, 6).map((r) => r.filter((c) => c !== "" && c != null).join(" | ")).filter(Boolean).join(" // ");
    throw new Error(`No ledger table found. A ledger needs Date, Debit and Credit columns (Particulars, Vch Type and Vch No help). The file starts with: ${first.slice(0, 220)}`);
  }
  const { sh, h } = best;
  const m = h.map;
  const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
  const warnings = [];
  const entries = [];
  let opening = null, closing = null;
  for (let i = h.row + h.span; i < sh.rows.length; i++) {
    const r = sh.rows[i];
    if (emptyRow(r)) continue;
    const date = toDate(get(r, "date"));
    const particulars = String(get(r, "particulars") ?? "");
    const rowText = r.map((c) => (typeof c === "string" ? c : "")).join(" ");
    const debit = hasNum(get(r, "debit")) ? Math.abs(toNum(get(r, "debit"))) : 0;
    const credit = hasNum(get(r, "credit")) ? Math.abs(toNum(get(r, "credit"))) : 0;
    if (OPENING.test(particulars) || (!date && OPENING.test(rowText))) {
      if (opening == null) opening = r2(debit - credit || (m.balance != null && hasNum(get(r, "balance")) ? signed(get(r, "balance")) : 0));
      continue;
    }
    if (CLOSING.test(particulars) || (!date && CLOSING.test(rowText))) { closing = r2(debit - credit || (m.balance != null && hasNum(get(r, "balance")) ? signed(get(r, "balance")) : 0)); continue; }
    if (!date) {
      // a narration printed under the entry, or a total line
      const text = (particulars || String(get(r, "narration") ?? "")).trim();
      if (text && !debit && !credit && entries.length && !/^(total|grand total|sub total)/i.test(text)) entries[entries.length - 1].narration = `${entries[entries.length - 1].narration} ${text}`.trim();
      continue;
    }
    if (!debit && !credit) continue;
    entries.push({
      date, party: cleanParty(particulars), vchType: String(get(r, "vchType") ?? "").trim(), vchNo: String(get(r, "vchNo") ?? "").trim(),
      narration: String(get(r, "narration") ?? "").replace(/\s+/g, " ").trim(),
      debit: r2(debit), credit: r2(credit), balance: m.balance != null && hasNum(get(r, "balance")) ? r2(signed(get(r, "balance"))) : null,
    });
  }
  if (!entries.length) throw new Error("The ledger table was found but it has no dated entries.");
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  entries.forEach((e, i) => { e.seq = i; });
  if (opening == null) {
    opening = 0;
    warnings.push("No opening balance line was found in the ledger, so the opening balance is taken as nil. Add the opening balance line if the ledger has one.");
  }
  return { entries, opening: r2(opening), closing: closing == null ? null : r2(closing), from: entries[0].date, to: entries[entries.length - 1].date, warnings, sheet: sh.name };
}
