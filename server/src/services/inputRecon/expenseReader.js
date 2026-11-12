import path from "node:path";
import { readSheets, toNum, toDate, normGstin, SHEET_EXTS } from "../recon/sheetParser.js";
import { emptyRow, findHeader, isTotalRow } from "../itc/readers.js";
import { r2 } from "../banking/common.js";
import { validGstin } from "../gstRules.js";

/**
 * The ledgers of the client's expenses (Tally "Ledger Vouchers" of an expense account, or an expense register), for the RCM working.
 * Every sheet with a ledger table is read, so one workbook with a sheet for each expense ledger reads in full. Each entry carries the
 * name of its ledger (the expense head), the party, the narration and the amount booked (debit less credit).
 */

const COLS = {
  date: [/^date$/, /\bdate\b/],
  head: [/^(expense|ledger|account)( head| name)?$/, /^nature( of (expense|payment|service))?$/, /^head$/],
  gstin: [/gstin/],
  vchNo: [/vch\.? ?no/, /voucher (no|number)/, /invoice (no|number)/, /bill (no|number)/, /^no\.?$/, /ref/],
  vchType: [/vch\.? ?type/, /voucher type/, /^type$/],
  narration: [/narration/, /remarks?/, /description/],
  party: [/^particulars$/, /^party( name)?$/, /^supplier( name)?$/, /^vendor( name)?$/, /^paid to$/, /^name$/, /^to ?\/ ?by$/],
  debit: [/^debit/, /^dr\.?$/, /\bdebit\b/, /^amount\b/, /^expense( amount)?$/, /^taxable (value|amount)$/],
  credit: [/^credit/, /^cr\.?$/, /\bcredit\b/],
  igst: [/^igst/], cgst: [/^cgst/], sgst: [/^sgst/, /^utgst/],
};

const OPENING = /^\s*(opening balance|balance b\/?f|brought forward|op\.? ?bal)/i;
const CLOSING = /^\s*(closing balance|balance c\/?f|carried forward)/i;
// year-end transfers of the ledger to the profit and loss account are not expenses
const TRANSFER = /profit\s*(&|and)\s*loss|\bp\s*[&/]\s*l\b|trading (a\/c|account)|transferred to|closing stock|^by\s+balance/i;
const hasNum = (v) => v !== "" && v != null && !Number.isNaN(Number(String(v).replace(/[,₹\s]|cr\.?$|dr\.?$/gi, "")));
const cleanParty = (s) => String(s ?? "").replace(/^\s*(to|by)\s+/i, "").replace(/\s+/g, " ").trim();
const DATE_RANGE = /\d{1,2}[-/ ](?:[a-z]{3,9}|\d{1,2})[-/ ,]*\d{2,4}\s*(?:to|-|–)\s*\d{1,2}/i;
const GENERIC_TITLE = /^(ledger( account| vouchers?)?|account|statement|page\b|\d+$|company|gstin|address)/i;

/** The name of the ledger: a "Ledger: ..." line above the table, or its last plain title line, else the sheet's or the file's name. */
function ledgerName(sh, headerRow, filename) {
  const above = sh.rows.slice(0, headerRow).map((r) => r.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim()).join(" ")).filter(Boolean);
  for (const t of above) {
    const m = /^(?:ledger(?: account)?|account(?: name)?)\s*[:-]\s*(.+)$/i.exec(t);
    if (m) return m[1].trim();
  }
  const plain = above.filter((t) => !DATE_RANGE.test(t) && !GENERIC_TITLE.test(t));
  if (plain.length) return plain[plain.length - 1];
  if (sh.name && !/^(sheet|worksheet|page)\s*\d*$/i.test(sh.name)) return sh.name.trim();
  return path.basename(filename, path.extname(filename));
}

export async function readExpenses(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (!SHEET_EXTS.includes(ext)) throw new Error("Upload the expense ledgers as an Excel file (any version) or a CSV file.");
  const sheets = await readSheets(buffer, filename);
  const entries = [];
  const ledgers = new Set();
  const warnings = [];
  let skipped = 0;
  let read = 0;
  for (const sh of sheets) {
    if (/^(notes?|summary|read ?me)$/i.test(sh.name) && sheets.length > 1) continue;
    const h = findHeader(sh.rows, COLS, (have) => have.includes("date") && (have.includes("debit") || have.includes("credit")));
    if (!h) continue;
    read++;
    const m = h.map;
    const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
    const own = ledgerName(sh, h.row, filename);
    for (let i = h.row + h.span; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (emptyRow(r) || isTotalRow(r)) continue;
      const date = toDate(get(r, "date"));
      const partyText = String(get(r, "party") ?? "");
      const rowText = r.map((c) => (typeof c === "string" ? c : "")).join(" ");
      const debit = hasNum(get(r, "debit")) ? toNum(get(r, "debit")) : 0;
      const credit = hasNum(get(r, "credit")) ? toNum(get(r, "credit")) : 0;
      if (OPENING.test(partyText) || OPENING.test(rowText) || CLOSING.test(partyText) || (!date && CLOSING.test(rowText))) continue;
      if (!date) {
        // a narration printed under the entry
        const text = (partyText || String(get(r, "narration") ?? "")).trim();
        if (text && !debit && !credit && entries.length && !/^(total|grand total|sub total)/i.test(text)) entries[entries.length - 1].narration = `${entries[entries.length - 1].narration} ${text}`.trim();
        continue;
      }
      if (!debit && !credit) continue;
      if (TRANSFER.test(partyText)) { skipped++; continue; }
      const head = String(get(r, "head") ?? "").replace(/\s+/g, " ").trim() || own;
      ledgers.add(head);
      const tax = (f) => (m[f] == null || !hasNum(get(r, f)) ? 0 : Math.abs(toNum(get(r, f))));
      entries.push({
        date, ledger: head, party: cleanParty(partyText), gstin: normGstin(get(r, "gstin")), vchType: String(get(r, "vchType") ?? "").trim(), vchNo: String(get(r, "vchNo") ?? "").trim(),
        narration: String(get(r, "narration") ?? "").replace(/\s+/g, " ").trim(), amount: r2(debit - credit), igst: r2(tax("igst")), cgst: r2(tax("cgst")), sgst: r2(tax("sgst")), sheet: sh.name,
      });
    }
  }
  if (!read) {
    const first = sheets.flatMap((s) => s.rows).slice(0, 6).map((r) => r.filter((c) => c !== "" && c != null).join(" | ")).filter(Boolean).join(" // ");
    throw new Error(`No ledger table found. An expense ledger needs Date and Debit (or Amount) columns; Particulars, Narration and Vch No help. The file starts with: ${first.slice(0, 220)}`);
  }
  if (!entries.length) throw new Error("The ledger table was found but it has no dated entries.");
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (skipped) warnings.push(`${skipped} year-end transfer(s) to the profit and loss account were left out.`);
  const noGstin = entries.filter((e) => e.gstin && !validGstin(e.gstin)).length;
  if (noGstin) warnings.push(`${noGstin} entr${noGstin === 1 ? "y has" : "ies have"} a GSTIN that is not valid; it is not used.`);
  return { entries, ledgers: [...ledgers], from: entries[0].date, to: entries[entries.length - 1].date, warnings };
}
