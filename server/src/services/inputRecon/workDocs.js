import { toNum, toDate, normGstin } from "../recon/sheetParser.js";
import { emptyRow, findHeader, isTotalRow, norm } from "../itc/readers.js";
import { r2 } from "../banking/common.js";

/**
 * The document-level ITC lines of a GSTR-3B working: one line for each purchase invoice or note whose ITC the working claims,
 * with the party, GSTIN, invoice, taxable value and tax. They come from the "Inward detail" sheet of this app's GSTR-3B
 * working, from the "ITC Documents" sheet of the combined 3B workings, or from any sheet of the firm's own that lists
 * documents with a GSTIN, an invoice number and tax columns.
 */

const DOC = {
  party: [/^supplier name$/, /supplier name|party'?s? name|trade\/?legal|^supplier$|^party$|^name$|^particulars$/],
  gstin: [/supplier gstin/, /gstin of supplier/, /^gstin$/, /gstin/],
  invno: [/document number/, /invoice (no|number)/, /inv(oice)? ?no/, /bill (no|number)/, /note (no|number)/, /^invoice$/],
  date: [/document date/, /invoice date/, /inv(oice)? date/, /^date$/],
  type: [/^type$/, /document type/],
  rcm: [/^reverse charge$/, /reverse charge/, /^rcm$/],
  taxable: [/taxable/],
  igst: [/^igst$/, /\bigst\b/, /integrated/],
  cgst: [/^cgst$/, /\bcgst\b/, /central tax/],
  sgst: [/^sgst/, /\bsgst\b/, /state\/?ut tax/],
  cess: [/^cess$/, /\bcess\b/],
  treat: [/itc treatment/, /itc eligib/, /eligible \/ ineligible/, /^treatment$/],
  month: [/return month/, /^month$/, /return period/, /^period$/, /tax period/],
};
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "Aug-25", "August 2025", "2025-08" or a date: the month as YYYY-MM. */
export function monthOfText(v) {
  if (v == null || v === "") return null;
  const d = toDate(v);
  if (d) return d.slice(0, 7);
  const s = String(v).trim();
  let m = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^([A-Za-z]{3})[a-z]*[-\s/']*(\d{2}|\d{4})$/.exec(s);
  if (m && MON.includes(m[1].toLowerCase())) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${String(MON.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}`;
  return null;
}

/**
 * Reads the document lines of one workbook. `period` is the working's month, used for lines that carry no month of their own.
 * Returns { docs, sheets } (docs may be empty).
 */
export function readWorkingDocs(sheets, period = null) {
  const docs = [];
  const used = [];
  for (const sh of sheets) {
    if (/outward|summary|notes?|review|line-wise|^1 |eligible itc by month/i.test(sh.name)) continue;
    const h = findHeader(sh.rows, DOC, (have) => have.includes("invno") && (have.includes("gstin") || have.includes("party")) && (have.includes("igst") || have.includes("cgst") || have.includes("sgst") || have.includes("taxable")));
    if (!h) continue;
    const m = h.map;
    const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
    let n = 0;
    for (let i = h.row + h.span; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (emptyRow(r) || isTotalRow(r)) continue;
      const no = String(get(r, "invno") ?? "").trim();
      if (!no) continue;
      const typeText = norm(get(r, "type"));
      const type = /credit/.test(typeText) ? "cn" : /debit/.test(typeText) ? "dn" : "inv";
      const sign = type === "cn" ? -1 : 1;
      const num = (f) => r2(toNum(get(r, f)));
      const t = { igst: num("igst"), cgst: num("cgst"), sgst: num("sgst"), cess: num("cess") };
      const flip = (x) => (sign < 0 && x > 0 ? -x : x);
      const rcmText = norm(get(r, "rcm"));
      const treat = String(get(r, "treat") ?? "").trim();
      const month = monthOfText(get(r, "month")) || period || (toDate(get(r, "date")) || "").slice(0, 7) || null;
      docs.push({
        party: String(get(r, "party") ?? "").trim(), gstin: normGstin(get(r, "gstin")), inv_no: no, date: toDate(get(r, "date")), type, month,
        rcm: /^(yes|y|true|rcm)/.test(rcmText), treat,
        taxable: flip(num("taxable")), igst: flip(t.igst), cgst: flip(t.cgst), sgst: flip(t.sgst), cess: flip(t.cess),
      });
      n++;
    }
    if (n) used.push(sh.name);
  }
  return { docs, sheets: used };
}

/** What a 3B working line is: the ITC it claims, reverse-charge credit, or a line it leaves out. */
/** TDS (section 51) or TCS (section 52) credit, from the words on the line; null when it is neither. */
export function tdsTcsKind(text) {
  const t = String(text || "");
  if (/\btcs\b|tax collected at source|section 52|\bsec\.? ?52\b/i.test(t)) return "TCS";
  if (/\btds\b|tax deducted at source|section 51|\bsec\.? ?51\b/i.test(t)) return "TDS";
  return null;
}

export function categoryOf(d) {
  const tt = tdsTcsKind(`${d.treat || ""} ${d.party || ""} ${d.nature || ""}`);
  if (tt) return tt;
  if (d.type === "cn" || d.type === "dn") return "Credit / debit note";
  if (d.rcm) return "RCM";
  if (/not claimed|hold|barred|16\(4\)|ineligible/i.test(d.treat || "") && !/blocked/i.test(d.treat || "")) return "Not claimed";
  return "Normal ITC";
}
