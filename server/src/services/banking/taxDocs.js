import path from "node:path";
import { readSheets, toDate, SHEET_EXTS } from "../recon/sheetParser.js";
import { pdfText } from "../recon/gstr3bParser.js";
import { r2 } from "./common.js";

/**
 * Form 26AS (tax credit statement) and the Taxpayer Information Summary, read from PDF, text, CSV or Excel text lines.
 * Both are only used to name the party behind a bank entry and to cross-check taxes and income, so they are read leniently
 * and the working goes on with whatever was found.
 */

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : "");
const AMT = /(?<![\d.,])(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2}(?![\d])/g;
const AMT_LOOSE = /(?<![\d.,/-])(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?(?![\d/-])/g;
const toN = (s) => Number(String(s).replace(/,/g, ""));
const DATE_DMY = /\b(\d{2}-[A-Za-z]{3}-\d{4})\b/;

async function textOf(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") {
    try { return await pdfText(buffer); }
    catch (e) { throw new Error(`The PDF could not be opened (${String(e.message || e).slice(0, 80)}). 26AS and TIS PDFs are usually password protected: save a copy without the password, or upload the text / CSV version.`); }
  }
  if (ext === ".txt") return Buffer.from(buffer).toString("utf8");
  if (SHEET_EXTS.includes(ext)) {
    const sheets = await readSheets(buffer, filename);
    const cell = (c) => {
      if (c instanceof Date) return dmy(toDate(c));
      if (typeof c === "number") return Number.isInteger(c) && (String(c).length === 5 || String(c).length === 7) && c > 0 ? String(c) : c.toFixed(2);
      return String(c ?? "").trim();
    };
    return sheets.flatMap((s) => s.rows.map((r) => r.map(cell).filter(Boolean).join("  "))).join("\n");
  }
  throw new Error(`A ${ext || "this"} file cannot be read here. Upload the PDF, text, CSV or Excel version.`);
}

/* ------------------------------------------------------------------ Form 26AS */

const SECTION = /\b(19[2-9][A-Z]{0,3}|206C[A-Z0-9()]*|195)\b/;
const HEADS = { 100: "Advance tax", 300: "Self-assessment tax", 400: "Tax on regular assessment", 200: "TDS / TCS paid by the taxpayer" };

export function parse26asText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const deductors = [];
  const taxPaid = [];
  let cur = null;
  for (const line of lines) {
    const d = /^\s*(\d{1,3})\s+(.+?)\s+([A-Z]{4}\d{5}[A-Z])\s+((?:[\d,]+\.\d{2}\s*){3})/.exec(line);
    if (d) {
      const [amount, tds] = d[4].match(AMT).map(toN);
      cur = { name: d[2].replace(/\s+/g, " ").trim(), tan: d[3], amount: r2(amount), tds: r2(tds), txns: [] };
      deductors.push(cur);
      continue;
    }
    const bsr = /\b(\d{7})\s+(\d{2}-[A-Za-z]{3}-\d{4})\s+(\d{5})\b/.exec(line);
    if (bsr) {
      const before = line.slice(0, bsr.index);
      const amounts = (before.match(AMT) || []).map(toN);
      if (amounts.length) {
        const head = /\b(100|200|300|400)\b/.exec(before.replace(AMT, " "));
        taxPaid.push({ kind: HEADS[head?.[1]] || "Tax paid", date: toDate(bsr[2]), amount: r2(amounts[amounts.length - 1]), bsr: bsr[1], serial: bsr[3] });
      }
      continue;
    }
    if (cur) {
      const sec = SECTION.exec(line);
      const date = DATE_DMY.exec(line);
      const amounts = (line.match(AMT) || []).map(toN);
      if (sec && date && amounts.length >= 2) {
        cur.txns.push({ section: sec[1], date: toDate(date[1]), amount: r2(amounts[amounts.length - 3 < 0 ? 0 : amounts.length - 3]), tds: r2(amounts[amounts.length - 2]) });
      }
    }
  }
  return { deductors, taxPaid };
}

export async function read26as(buffer, filename) {
  const text = await textOf(buffer, filename);
  const out = parse26asText(text);
  const warnings = [];
  if (!out.deductors.length && !out.taxPaid.length) throw new Error("Nothing could be read from this 26AS. Upload the PDF without a password, or the text / CSV version.");
  if (!out.deductors.length) warnings.push("No deductor (TDS) lines were found in this 26AS.");
  if (!out.taxPaid.length) warnings.push("No tax paid (challan) lines were found in this 26AS.");
  const withTxns = out.deductors.filter((d) => d.txns.length).length;
  if (out.deductors.length && !withTxns) warnings.push("The deductor totals were read but not the line-by-line transactions.");
  return { ...out, warnings, rows: out.deductors.length + out.taxPaid.length };
}

/* ------------------------------------------------------------------ TIS */

const TIS_CATEGORIES = [
  ["Salary", /\bsalary\b/i],
  ["Interest from savings bank", /interest from savings|savings (bank )?interest|\b(sb) interest/i],
  ["Interest from deposit", /interest from deposit|deposit interest|fixed deposit/i],
  ["Interest from others", /interest from others|interest income|interest from (post|income tax)/i],
  ["Dividend", /\bdividend\b/i],
  ["Rent received", /rent received|rent from/i],
  ["Business receipts", /business receipt|professional (fee|receipt)|commission|contract/i],
  ["Cash deposits", /cash deposit/i],
  ["Sale of securities and units of mutual funds", /sale of (securities|equity|mutual)|redemption/i],
  ["Purchase of securities and units of mutual funds", /purchase of (securities|equity|mutual)/i],
  ["Turnover as per GST returns", /gst (turnover|returns?)|turnover as per gst/i],
  ["TDS / TCS", /\btds\b|\btcs\b/i],
];
const withoutDates = (s) => s.replace(/\b\d{1,2}[-/][A-Za-z0-9]{2,3}[-/]\d{2,4}\b/g, " ").replace(/\b[A-Z]{4}\d{5}[A-Z]\b|\b[A-Z]{5}\d{4}[A-Z]\b/g, " ");

export function parseTisText(text) {
  const items = [];
  const parties = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const clean = line.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    const id = /^(.*?)\s*\(?\b([A-Z]{4}\d{5}[A-Z])\b/.exec(clean);
    if (id && id[1].replace(/[^A-Za-z]/g, "").length >= 4) parties.push({ name: id[1].replace(/^\d+\s+/, "").trim(), tan: id[2] });
    const cat = TIS_CATEGORIES.find(([, re]) => re.test(clean));
    if (!cat) continue;
    const nums = (withoutDates(clean).match(AMT_LOOSE) || []).map(toN).filter((n) => n > 0);
    if (!nums.length) continue;
    const reported = nums.length >= 2 ? nums[nums.length - 2] : nums[0];
    items.push({ category: cat[0], text: clean.slice(0, 160), reported: r2(reported), derived: r2(nums[nums.length - 1]) });
  }
  return { items, parties };
}

export async function readTis(buffer, filename) {
  const text = await textOf(buffer, filename);
  const out = parseTisText(text);
  if (!out.items.length && !out.parties.length) throw new Error("Nothing could be read from this TIS. Upload the PDF without a password, or the text / CSV version.");
  const warnings = [];
  if (!out.items.length) warnings.push("No income or transaction categories were recognised in this TIS.");
  return { ...out, warnings, rows: out.items.length };
}
