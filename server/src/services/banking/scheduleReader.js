import path from "node:path";
import { readSheets, toNum, toDate, SHEET_EXTS } from "../recon/sheetParser.js";
import { emptyRow, findHeader } from "../itc/readers.js";
import { pdfText } from "../recon/gstr3bParser.js";
import { r2 } from "./common.js";

/**
 * The lender's repayment schedule (Excel, CSV or PDF) as dated instalments, and the terms stated in the sanction letter.
 * A row is { no, date, opening, principal, interest, installment, closing }; whatever the schedule leaves out is worked out.
 */

const COLS = {
  no: [/^(sr\.? ?no\.?|s\.? ?no\.?|inst(a)?l+ment ?(no\.?|number)|emi ?(no\.?|number)|no\.?|#)$/],
  date: [/(due|emi|inst(a)?l+ment|payment|repayment) ?date/, /\bdate\b/, /^month$/, /^period$/],
  opening: [/opening|beginning|bal(ance)? ?b\/?f|(principal|loan) outstanding at (the )?(start|beginning)/],
  closing: [/closing|ending|outstanding|balance|remaining/],
  principal: [/principal/, /capital/],
  interest: [/interest/],
  installment: [/^(emi|inst(a)?l+ment)( amount)?$/, /\b(emi|inst(a)?l+ment)\b/, /total (payment|amount|inst(a)?l+ment|emi)/, /^amount$/, /payable/, /^total$/],
};
const hasNum = (v) => v !== "" && v != null && !Number.isNaN(Number(String(v).replace(/[,₹\s]/g, "")));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "05-04-2025", a date cell, or a bare "Apr-25" month. */
function dateOf(v) {
  const d = toDate(v);
  if (d) return d;
  const m = /^([A-Za-z]{3})[a-z]*[-\s/']*(\d{2,4})$/.exec(String(v ?? "").trim());
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}-01`;
  return null;
}

/** Fills in what a schedule leaves out: instalment = principal + interest, closing = opening less principal, opening = the earlier closing. */
export function completeSchedule(rows, warnings = []) {
  const list = rows.filter((r) => r.date).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).map((r) => ({ ...r }));
  for (const r of list) {
    if (r.installment == null && r.principal != null && r.interest != null) r.installment = r2(r.principal + r.interest);
    if (r.principal == null && r.installment != null && r.interest != null) r.principal = r2(r.installment - r.interest);
    if (r.interest == null && r.installment != null && r.principal != null) r.interest = r2(r.installment - r.principal);
  }
  list.forEach((r, i) => {
    if (r.opening == null && r.closing != null && r.principal != null) r.opening = r2(r.closing + r.principal);
    if (r.opening == null && i > 0 && list[i - 1].closing != null) r.opening = list[i - 1].closing;
    if (r.closing == null && r.opening != null && r.principal != null) r.closing = r2(r.opening - r.principal);
  });
  list.forEach((r, i) => { if (r.opening == null && i === 0 && r.closing != null && !r.principal) r.opening = 0; });
  const unknown = list.filter((r) => r.closing == null).length;
  if (unknown) warnings.push(`The balance could not be worked out for ${unknown} instalment(s). Check the columns of the schedule.`);
  list.forEach((r) => { for (const k of ["opening", "principal", "interest", "installment", "closing"]) if (r[k] == null) r[k] = 0; });
  let bad = 0;
  for (let i = 1; i < list.length; i++) if (Math.abs(list[i].opening - list[i - 1].closing) > 1) bad++;
  if (bad) warnings.push(`The opening balance does not follow the previous closing balance on ${bad} line(s) of the schedule.`);
  return list;
}

export async function readScheduleSheets(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  let best = null;
  for (const sh of sheets) {
    const h = findHeader(sh.rows, COLS, (have) => have.includes("date") && (have.includes("installment") || have.includes("principal") || have.includes("interest")));
    if (h && (!best || h.score > best.h.score)) best = { sh, h };
  }
  if (!best) {
    const first = sheets.flatMap((s) => s.rows).slice(0, 6).map((r) => r.filter((c) => c !== "" && c != null).join(" | ")).filter(Boolean).join(" // ");
    throw new Error(`No repayment schedule table found. It needs a Date column and Principal, Interest or Instalment columns. The file starts with: ${first.slice(0, 220)}`);
  }
  const { sh, h } = best;
  const m = h.map;
  const num = (r, f) => (m[f] != null && hasNum(r[m[f]]) && String(r[m[f]]).trim() !== "" ? r2(toNum(r[m[f]])) : null);
  const rows = [];
  for (let i = h.row + h.span; i < sh.rows.length; i++) {
    const r = sh.rows[i];
    if (emptyRow(r)) continue;
    const date = dateOf(r[m.date]);
    if (!date) continue;
    const row = { no: m.no != null && hasNum(r[m.no]) ? Number(r[m.no]) : null, date, opening: num(r, "opening"), principal: num(r, "principal"), interest: num(r, "interest"), installment: num(r, "installment"), closing: num(r, "closing") };
    if ([row.opening, row.principal, row.interest, row.installment, row.closing].every((v) => v == null)) continue;
    rows.push(row);
  }
  if (!rows.length) throw new Error("The schedule table was found but it has no dated instalments.");
  const warnings = [];
  return { rows: completeSchedule(rows, warnings), warnings, source: "excel" };
}

/* ------------------------------------------------------------------ PDF */

const DATE_TOKEN = /\b(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-/. ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/. ,]*\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/']\d{2,4})\b/i;
const NUM_TOKEN = /(?<![\d.,/-])\(?(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?\)?(?![\d/-])/g;
const ROLE_WORDS = [["opening", /opening|beginning|b\/f/i], ["principal", /principal|capital/i], ["interest", /interest/i], ["installment", /\b(emi|inst(a)?l+ment|total)\b/i], ["closing", /closing|outstanding|balance|ending/i]];

/** The order of the amount columns, read from the heading line of the PDF. */
function roleOrder(lines) {
  for (const line of lines.slice(0, 80)) {
    const at = (role, re) => {
      if (role !== "closing") return line.search(re);
      const all = [...line.matchAll(new RegExp(re.source, "gi"))];
      return all.length ? all[all.length - 1].index : -1;
    };
    const found = ROLE_WORDS.map(([role, re]) => [role, at(role, re)]).filter(([, p]) => p >= 0).sort((x, y) => x[1] - y[1]);
    if (found.length >= 3 && /date|due|month/i.test(line)) return found.map(([role]) => role);
  }
  return null;
}

const ROLE_SETS = { 5: ["opening", "principal", "interest", "installment", "closing"], 4: ["principal", "interest", "installment", "closing"], 3: ["principal", "interest", "closing"] };

/** Assign the numbers of one line to roles so that principal + interest = instalment and closing = opening less principal. */
function assign(nums, order) {
  if (order && order.length === nums.length) return Object.fromEntries(order.map((role, i) => [role, nums[i]]));
  const roles = ROLE_SETS[nums.length];
  if (!roles) return null;
  const perm = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perm([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
  const tryMap = (arr) => Object.fromEntries(roles.map((role, i) => [role, arr[i]]));
  const ok = (o) => (o.installment == null || Math.abs(o.principal + o.interest - o.installment) <= 1) && (o.opening == null || Math.abs(o.opening - o.principal - o.closing) <= 1);
  const identity = tryMap(nums);
  if (ok(identity)) return identity;
  for (const p of perm(nums)) { const o = tryMap(p); if (ok(o)) return o; }
  return null;
}

export function parseScheduleText(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const order = roleOrder(lines);
  const rows = [];
  for (const line of lines) {
    const d = DATE_TOKEN.exec(line);
    if (!d) continue;
    const date = dateOf(d[1].replace(/\s+/g, "-"));
    if (!date) continue;
    const rest = line.replace(d[0], " ");
    const lead = /^(\d{1,3})\s/.exec(line);
    const body = lead && line.indexOf(d[0]) > 0 ? rest.replace(/^\s*\d{1,3}\s/, " ") : rest;
    const nums = (body.match(NUM_TOKEN) || []).map((n) => toNum(n.replace(/[()]/g, "")));
    if (nums.length < 3) continue;
    const a = assign(nums.slice(-Math.min(nums.length, 5)), order);
    if (!a) continue;
    rows.push({ no: lead ? Number(lead[1]) : null, date, opening: a.opening ?? null, principal: a.principal ?? null, interest: a.interest ?? null, installment: a.installment ?? null, closing: a.closing ?? null, _loose: !order && a.opening == null });
  }
  // principal and interest add up the same either way round: the balance falling by the principal, line after line, shows which is which
  const chain = (list) => list.reduce((n, r, i) => n + (i > 0 && list[i - 1].closing != null && r.principal != null && r.closing != null && Math.abs(list[i - 1].closing - r.principal - r.closing) <= 1 ? 1 : 0), 0);
  if (rows.some((r) => r._loose)) {
    const swapped = rows.map((r) => (r._loose ? { ...r, principal: r.interest, interest: r.principal } : r));
    if (chain(swapped) > chain(rows)) return swapped.map(({ _loose, ...r }) => r);
  }
  return rows.map(({ _loose, ...r }) => r);
}

export async function readSchedulePdf(bytes) {
  let text = "";
  try { text = await pdfText(bytes); } catch (e) { throw new Error(`The PDF could not be opened (${String(e.message || e).slice(0, 80)}). Upload the Excel / CSV version of the schedule if you have it.`); }
  const rows = parseScheduleText(text);
  if (!rows.length) throw new Error("No instalments could be read from this PDF. It may be a scanned image or an unusual layout. Upload the Excel / CSV version of the schedule.");
  const warnings = [];
  return { rows: completeSchedule(rows, warnings), warnings, source: "pdf" };
}

export async function readSchedule(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return readSchedulePdf(buffer);
  if (SHEET_EXTS.includes(ext)) return readScheduleSheets(buffer, filename);
  throw new Error(`A ${ext || "this"} file cannot be read as a repayment schedule. Upload PDF, Excel or CSV.`);
}

/* ------------------------------------------------------------------ sanction letter */

const toRupees = (n, unit) => {
  const v = Number(String(n).replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  const u = String(unit || "").toLowerCase();
  return r2(/crore|^crs?$/.test(u) ? v * 1e7 : /lakh|lac/.test(u) ? v * 1e5 : /million/.test(u) ? v * 1e6 : v);
};
const LOAN_TYPES = [["Term loan", /term loan/i], ["Working capital / cash credit", /working capital|cash credit|\bcc limit|\bcc\b/i], ["Overdraft", /overdraft|\bod limit/i], ["Vehicle loan", /vehicle|car loan|auto loan/i], ["Home / property loan", /home loan|housing|property loan|lease rental|loan against property|\blap\b/i], ["Business loan", /business loan|msme|mudra/i], ["Equipment loan", /equipment|machinery/i]];
const linesWith = (lines, re, n, max = 220) => lines.filter((l) => re.test(l)).slice(0, n).map((l) => l.slice(0, max));

/** What the sanction letter says, as far as it can be read from the text. Everything is a suggestion to be confirmed. */
export function extractSanction(text) {
  const t = String(text || "");
  const lines = t.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const flat = lines.join("\n");
  const out = {};
  const money = (re) => { const m = re.exec(flat); return m ? toRupees(m[1], m[2]) : null; };
  const amt = money(/(?:sanction(?:ed)?(?: amount| limit)?|loan amount|facility amount|amount sanctioned|limit sanctioned|credit limit)[^\n\d]{0,60}?(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|crs?|million)?/i);
  if (amt) out.sanctioned_amount = amt;
  const rate = /(?:rate of interest|interest rate|\broi\b|interest)[^\n\d]{0,70}?(\d{1,2}(?:\.\d{1,2})?)\s*%/i.exec(flat) || /(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:p\.?\s?a\.?|per annum)/i.exec(flat);
  if (rate) out.interest_rate = Number(rate[1]);
  const mo = /(?:tenure|tenor|repayable|repayment period|period of)[^\n\d]{0,50}?(\d{1,3})\s*(?:equated |monthly )*(months?|years?|yrs?|instal+ments?|emis?)/i.exec(flat);
  if (mo) out.tenure_months = /year|yr/i.test(mo[2]) ? Number(mo[1]) * 12 : Number(mo[1]);
  const emi = money(/(?:\bemi\b|equated monthly instal+ment|instal+ment amount|monthly instal+ment)[^\n\d]{0,50}?(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d+)?)()/i);
  if (emi) out.emi_amount = emi;
  const dt = /(?:date of sanction|sanction date|sanctioned on|dated?)[^\n\d]{0,12}(\d{1,2}[-/. ][A-Za-z0-9]{2,9}[-/. ,]+\d{2,4})/i.exec(flat);
  if (dt) { const d = toDate(dt[1].replace(/[, ]+/g, "-")); if (d) out.sanction_date = d; }
  const fee = /processing fee[^\n\d]{0,40}?(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d+)?\s*%?)/i.exec(flat);
  if (fee) out.processing_fee = fee[1].trim();
  const mor = /moratorium[^\n\d]{0,50}?(\d{1,3})\s*(months?|years?)/i.exec(flat);
  if (mor) out.moratorium = `${mor[1]} ${mor[2]}`;
  const type = LOAN_TYPES.find(([, re]) => re.test(flat));
  if (type) out.loan_type = type[0];
  const sec = linesWith(lines, /mortgage|hypothecat|pledge|charge (over|on)|security|collateral|lien|equitable/i, 5);
  if (sec.length) out.security = sec.join("\n");
  const gua = linesWith(lines, /guarant/i, 4);
  if (gua.length) out.guarantee = gua.join("\n");
  return out;
}

export async function readSanction(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".pdf") return { details: {}, warning: `${filename}: only a PDF sanction letter is read automatically. Fill in the loan details by hand.` };
  try { return { details: extractSanction(await pdfText(buffer)) }; }
  catch { return { details: {}, warning: `${filename}: the sanction letter could not be opened. Fill in the loan details by hand.` }; }
}
