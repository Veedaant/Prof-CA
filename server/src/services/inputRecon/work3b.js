import { readSheets, toNum } from "../recon/sheetParser.js";
import { periodFromName } from "../output/readers.js";
import { r2 } from "../banking/common.js";
import { readWorkingDocs } from "./workDocs.js";

/**
 * A monthly GSTR-3B working prepared by the CA firm (from GSTR-2B, the books and GSTR-1): the ITC it claims for the month.
 * The working is read by its labels, not its position, so the firm's own layout and the layout of this app's GSTR-3B
 * working both read: Table 4 with the lines (A)(1) to (A)(5), (B)(1), (B)(2) and (C), each with IGST, CGST, SGST and cess.
 */

export const HEADS = ["igst", "cgst", "sgst", "cess"];
export const zero4 = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const add4 = (a, b) => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst, cess: a.cess + b.cess });
export const sub4 = (a, b) => ({ igst: r2(a.igst - b.igst), cgst: r2(a.cgst - b.cgst), sgst: r2(a.sgst - b.sgst), cess: r2(a.cess - b.cess) });
export const total4 = (a) => r2(a.igst + a.cgst + a.sgst + a.cess);
const round4 = (a) => ({ igst: r2(a.igst), cgst: r2(a.cgst), sgst: r2(a.sgst), cess: r2(a.cess) });

const clean = (s) => String(s ?? "").toLowerCase().replace(/[\r\n]+/g, " ").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const isNum = (c) => typeof c === "number" || (typeof c === "string" && /^\(?-?[\d,]+(\.\d+)?\)?$/.test(c.trim()) && /\d/.test(c));

// the lines of Table 4; the net lines are tested first because their words overlap the others
const T4 = [
  ["netIncl", /net itc including|including reverse.?charge credit/],
  ["net", /\(c\)\s*net itc|net itc available|^net itc/],
  ["a1", /\(a\)\s*\(1\)|import of goods/],
  ["a2", /\(a\)\s*\(2\)|import of services/],
  ["a3", /\(a\)\s*\(3\)|inward supplies \(?liable to reverse charge/],
  ["a4", /\(a\)\s*\(4\)|inward supplies from isd/],
  ["a5", /\(a\)\s*\(5\)|all other itc/],
  ["b1", /\(b\)\s*\(1\)|itc reversed.*(rule|17\(5\))|as per rules? 38/],
  ["b2", /\(b\)\s*\(2\)|itc reversed.*(credit note|other)|^\(?2\)?\s*others/],
];
const T31 = [["a", /^\(a\)\s*outward taxable/], ["b", /^\(b\)\s*outward taxable/], ["c", /^\(c\)\s*other outward/], ["d", /^\(d\)\s*inward supplies/], ["e", /^\(e\)\s*non-?gst/]];
const T61 = [["liability", /^(outward )?tax payable/], ["itcUsed", /^paid through itc/], ["cash", /^(paid in cash|net payment in cash)/]];

const T4_START = /^table\s*4\b|^4\.?\s*(eligible )?itc|^input tax credit|^table 4 /;
const T4_END = /^table\s*5\b|^table\s*6|^5\.\s|^6\.?1|^for review|^itc not claimed/;
const T31_START = /^table\s*3\.?1|^3\.?1\s/;

const rowParts = (r) => {
  const label = clean((r.find((c) => typeof c === "string" && c.trim() && !isNum(c)) ?? ""));
  const nums = r.filter(isNum).map((c) => (typeof c === "number" ? c : toNum(c)));
  return { label, nums };
};
const four = (nums) => (nums.length >= 4 ? { igst: nums[nums.length - 4], cgst: nums[nums.length - 3], sgst: nums[nums.length - 2], cess: nums[nums.length - 1] } : null);
const five = (nums) => (nums.length >= 5 ? nums.slice(-5) : nums.length === 4 ? [0, ...nums] : null);

function periodOf(rows, filename) {
  for (const r of rows.slice(0, 10)) {
    const text = r.map((c) => String(c ?? "")).join(" ");
    const iso = /\b(20\d{2})-(0[1-9]|1[0-2])\b/.exec(text);
    if (iso && !/20\d{2}-\d{2}-\d{2}/.test(text)) return `${iso[1]}-${iso[2]}`;
    const named = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s,.-]+(20\d{2})\b/i.exec(text);
    if (named) { const m = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(named[1].toLowerCase()) + 1; return `${named[2]}-${String(m).padStart(2, "0")}`; }
  }
  return periodFromName(filename);
}

/** Reads one monthly working. Throws when no Table 4 line can be found. */
export async function read3bWorking(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  let best = null;
  for (const sh of sheets) {
    if (/notes?|review|read ?me/i.test(sh.name) && sheets.length > 1) continue;
    const rows = sh.rows;
    const parts = rows.map(rowParts);
    let from = parts.findIndex((p) => T4_START.test(p.label));
    let to = from >= 0 ? parts.findIndex((p, i) => i > from && T4_END.test(p.label)) : -1;
    if (from < 0) { from = 0; to = -1; }
    const t4 = {};
    for (const key of ["a1", "a2", "a3", "a4", "a5", "b1", "b2", "net", "netIncl"]) t4[key] = null;
    for (let i = from; i < (to < 0 ? parts.length : to); i++) {
      const { label, nums } = parts[i];
      if (!label || T31.some(([, re]) => re.test(label))) continue;
      const hit = T4.find(([, re]) => re.test(label));
      const v = four(nums);
      if (!hit || !v) continue;
      const key = hit[0];
      // two (B)(1) lines (section 17(5) and rule 42) add up
      t4[key] = key === "b1" && t4.b1 ? add4(t4.b1, v) : v;
    }
    const found = Object.values(t4).filter(Boolean).length;
    if (!best || found > best.found) best = { sh, parts, t4, found, from };
  }
  if (!best || !best.found) throw new Error("No Table 4 (ITC) lines were found in this working. It needs lines such as (A)(5) All other ITC, (B) ITC reversed and (C) Net ITC available, each with IGST, CGST, SGST and cess.");

  const { t4, parts, sh } = best;
  const used = ["a1", "a2", "a3", "a4", "a5", "b1", "b2"].filter((k) => t4[k]);
  let claimed;
  if (used.length) {
    const a = ["a1", "a2", "a3", "a4", "a5"].reduce((s, k) => (t4[k] ? add4(s, t4[k]) : s), zero4());
    const b = ["b1", "b2"].reduce((s, k) => (t4[k] ? add4(s, t4[k]) : s), zero4());
    claimed = round4(sub4(a, b));
    const stated = t4.netIncl || t4.net;
    if (stated && HEADS.some((h) => Math.abs(stated[h] - claimed[h]) > 1)) warnings.push(`The working's own Net ITC line (${total4(stated)}) is not the total of its (A) and (B) lines (${total4(claimed)}). The total of the lines is used.`);
  } else {
    claimed = round4(t4.netIncl || t4.net);
    warnings.push("Only a Net ITC line was found, not the (A) and (B) lines, so the lines cannot be compared one by one.");
  }
  if (!t4.a5) warnings.push("The (A)(5) All other ITC line was not found.");

  // Table 3.1 and 6.1, when the working has them
  const t31 = {}, t61 = {};
  const t31At = parts.findIndex((p) => T31_START.test(p.label));
  parts.forEach((p, i) => {
    if (!p.label) return;
    if (i < best.from || t31At >= 0) {
      const h = T31.find(([, re]) => re.test(p.label));
      const v = h && five(p.nums);
      if (v && !t31[h[0]]) t31[h[0]] = { taxable: v[0], igst: v[1], cgst: v[2], sgst: v[3], cess: v[4] };
    }
    const h6 = T61.find(([, re]) => re.test(p.label));
    const v6 = h6 && four(p.nums);
    if (v6 && !t61[h6[0]]) t61[h6[0]] = v6;
  });

  const period = periodOf(sh.rows, filename);
  // the documents behind the figures, when the working lists them (this app's "Inward detail" sheet, or a sheet of the firm's own)
  const { docs } = readWorkingDocs(sheets, period);
  return {
    period, sheet: sh.name,
    t4: Object.fromEntries(Object.entries(t4).map(([k, v]) => [k, v ? round4(v) : null])), claimed,
    t31: Object.keys(t31).length ? t31 : null, t61: Object.keys(t61).length ? t61 : null,
    docs, found: best.found, warnings,
  };
}

/**
 * The finalised, combined GSTR-3B working the CA uploads for the final reconciliation: the "ITC Documents" sheet of the combined
 * 3B workings (every month's documents, with the return month), or any workbook that lists the documents.
 */
export async function readFinal3b(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  const { docs, sheets: used } = readWorkingDocs(sheets, periodFromName(filename));
  if (!docs.length) throw new Error("No document lines were found. Upload the combined GSTR-3B workings Excel (from Step 1) with its ITC Documents sheet, or a workbook that lists each document with GSTIN, invoice no, taxable value and tax.");
  const warnings = [];
  const noMonth = docs.filter((d) => !d.month).length;
  if (noMonth) warnings.push(`${noMonth} line(s) have no month and no date, so they are left out of the monthly tables.`);
  return { docs, sheets: used, warnings, rows: docs.length };
}
