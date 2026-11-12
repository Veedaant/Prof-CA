import path from "node:path";
import { readSheets, toNum, toDate, SHEET_EXTS } from "../recon/sheetParser.js";
import { emptyRow, findHeader } from "../itc/readers.js";
import { pdfText } from "../recon/gstr3bParser.js";
import { config } from "../../config.js";
import { geminiJson } from "../extractor.js";
import { r2 } from "./common.js";

/**
 * A bank statement as a list of dated transactions, from an Excel / CSV download or from the PDF.
 * Every transaction has a debit (money out) or a credit (money in), never both, and the running balance when the file shows one.
 */

const COLS = {
  date: [/^(txn|transaction|tran|trans|posting|post)\.? ?date$/, /^date$/, /^value date$/, /\bdate\b/],
  narration: [/narration/, /description/, /particulars/, /transaction (details|remarks)/, /^details$/, /remarks/],
  ref: [/(chq|cheque|check)\.? ?(\/|no|number|\.)/, /ref(erence)?\.? ?(no|number)?$/, /instrument/, /utr/],
  debit: [/withdrawal/, /^debit/, /\bdebit\b/, /^dr\.?$/, /paid out/, /outflow/],
  credit: [/deposit/, /^credit/, /\bcredit\b/, /^cr\.?$/, /paid in/, /inflow/],
  balance: [/^(running |closing |available |ledger )?balance/, /balance/],
  amount: [/^amount/, /transaction amount/],
  drcr: [/dr ?\/ ?cr/, /cr ?\/ ?dr/, /^type$/, /transaction type/, /^dr ?cr$/],
};

const hasNum = (v) => v !== "" && v != null && !Number.isNaN(Number(String(v).replace(/[,₹\s]|cr$|dr$/gi, "")));
/** A statement balance: "Dr" means overdrawn, "Cr" (or no suffix) is money in the account. */
const balanceOf = (v) => (/\bdr\.?$/i.test(String(v ?? "").trim()) ? -Math.abs(toNum(v)) : toNum(v));
const OPENING = /opening balance|balance b\/?f|brought forward|b\/f/i;

function finish(txns, opening, warnings, source) {
  let list = txns;
  if (list.length > 1 && list[0].date > list[list.length - 1].date) {
    list = [...list].reverse();
    warnings.push("The statement lists the latest transaction first; it was put in date order.");
  }
  list = list.map((t, i) => ({ ...t, seq: i }));
  if (opening == null && list.length && list[0].balance != null) opening = r2(list[0].balance - list[0].credit + list[0].debit);
  let run = opening;
  let breaks = 0, firstBreak = null;
  if (run != null) {
    for (const t of list) {
      run = r2(run + t.credit - t.debit);
      if (t.balance != null) {
        if (Math.abs(run - t.balance) > 1) { breaks++; firstBreak ||= t; }
        run = t.balance;
      }
    }
  }
  if (breaks) warnings.push(`The running balance does not follow the transactions on ${breaks} line(s), first on ${firstBreak.date}. Check that the debit and credit columns were read correctly.`);
  const last = list[list.length - 1];
  const closing = last?.balance != null ? last.balance : run != null ? r2(run) : null;
  return { txns: list, opening: opening == null ? null : r2(opening), closing, from: list[0]?.date || null, to: last?.date || null, warnings, source };
}

/* ------------------------------------------------------------------ Excel / CSV */

export async function readStatementSheets(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  let best = null;
  for (const sh of sheets) {
    const h = findHeader(sh.rows, COLS, (have) => have.includes("date") && ((have.includes("debit") && have.includes("credit")) || have.includes("amount")));
    if (h && (!best || h.score > best.h.score)) best = { sh, h };
  }
  if (!best) {
    const first = sheets.flatMap((s) => s.rows).slice(0, 6).map((r) => r.filter((c) => c !== "" && c != null).join(" | ")).filter(Boolean).join(" // ");
    throw new Error(`No bank statement table found. A statement needs a Date column and Debit / Credit (or Amount) columns. The file starts with: ${first.slice(0, 220)}`);
  }
  const { sh, h } = best;
  const m = h.map;
  const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
  const txns = [];
  let opening = null;
  for (let i = h.row + h.span; i < sh.rows.length; i++) {
    const r = sh.rows[i];
    if (emptyRow(r)) continue;
    const text = r.map((c) => (typeof c === "string" ? c : "")).join(" ");
    const date = toDate(get(r, "date"));
    if (!date) {
      if (OPENING.test(text) && opening == null) {
        const nums = r.filter((c) => typeof c === "number" || (typeof c === "string" && hasNum(c) && /\d/.test(c)));
        const b = m.balance != null && hasNum(r[m.balance]) ? balanceOf(r[m.balance]) : nums.length ? balanceOf(nums[nums.length - 1]) : null;
        if (b != null) opening = b;
        continue;
      }
      const extra = String(get(r, "narration") ?? "").trim();
      const anyNumber = [get(r, "debit"), get(r, "credit"), get(r, "amount"), get(r, "balance")].some((v) => hasNum(v) && toNum(v) !== 0);
      if (extra && !anyNumber && txns.length && !/^(total|closing balance|grand total)/i.test(extra)) txns[txns.length - 1].narration += ` ${extra}`;
      continue;
    }
    let debit = 0, credit = 0;
    if (m.debit != null || m.credit != null) {
      debit = Math.abs(toNum(get(r, "debit")));
      credit = Math.abs(toNum(get(r, "credit")));
    } else if (m.amount != null) {
      const amt = toNum(get(r, "amount"));
      const side = String(get(r, "drcr") ?? "");
      if (/^\s*c/i.test(side) || /\bcr\b/i.test(String(get(r, "amount")))) credit = Math.abs(amt);
      else if (/^\s*d/i.test(side) || /\bdr\b/i.test(String(get(r, "amount"))) || amt < 0) debit = Math.abs(amt);
      else credit = Math.abs(amt);
    }
    if (!debit && !credit && OPENING.test(String(get(r, "narration") ?? ""))) {
      if (opening == null && m.balance != null && hasNum(get(r, "balance"))) opening = balanceOf(get(r, "balance"));
      continue;
    }
    if (!debit && !credit && !(m.balance != null && hasNum(get(r, "balance")))) continue;
    txns.push({
      date, narration: String(get(r, "narration") ?? "").replace(/\s+/g, " ").trim(), ref: String(get(r, "ref") ?? "").trim(),
      debit: r2(debit), credit: r2(credit), balance: m.balance != null && hasNum(get(r, "balance")) && String(get(r, "balance")).trim() !== "" ? r2(balanceOf(get(r, "balance"))) : null,
    });
  }
  if (!txns.length) throw new Error("The statement table was found but it has no dated transactions.");
  return finish(txns, opening, warnings, "excel");
}

/* ------------------------------------------------------------------ PDF text */

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DATE_AT_START = new RegExp(`^\\s*(\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[-/. ](?:${MONTHS})[a-z]*[-/. ,]*\\d{2,4})(?![\\d/])`, "i");
const DATE_ANY = new RegExp(`\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}|\\d{1,2}[-/. ](?:${MONTHS})[a-z]*[-/. ,]*\\d{2,4}`, "ig");
const AMOUNT = /(?<![\d.,])\(?-?(?:\d{1,3}(?:,\d{2,3})*|\d+)\.\d{2}\)?(?:\s?(?:Cr|Dr)\b\.?)?/gi;
const SKIP_LINE = /^\s*(page\s+\d+|statement of account|account (no|number|statement)|customer|branch|ifsc|micr|nominee|date\s+(narration|particulars|description|txn)|txn date|sl\.? no|s\.? no|particulars|narration|\*+|legend|registered office|this is a computer|call us|toll free)/i;
const TOTALS = /^\s*(total|closing balance|grand total|carried forward|c\/f|statement summary|opening balance\s+(total|debit))/i;
const CREDIT_WORDS = /\b(CR|CREDIT|DEPOSIT|DEP|BY|NEFT CR|RTGS CR|IMPS CR|UPI CR|INT\.?\s?PD|INTEREST|REFUND|REVERSAL|SALARY CREDIT)\b/i;

const num = (s) => balanceOf(String(s).replace(/[()]/g, (c) => (c === "(" ? "-" : "")));

/** Reads statement text lines into transactions, working out debit or credit from the balance after each line. */
export function parseStatementText(text) {
  const warnings = [];
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\t/g, " ")).filter((l) => l.trim());
  let opening = null;
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const om = /(?:opening balance|balance b\/?f|brought forward)\D{0,40}?(-?[\d,]+\.\d{2})\s*(cr|dr)?/i.exec(line);
    if (om && opening == null && !DATE_AT_START.test(line)) { opening = num(om[1] + (om[2] ? om[2] : "")); continue; }
    if (DATE_AT_START.test(line) && (line.match(AMOUNT) || []).length) { cur = { head: line, rest: [] }; blocks.push(cur); continue; }
    if (DATE_AT_START.test(line) && !SKIP_LINE.test(line) && !TOTALS.test(line)) { cur = { head: line, rest: [] }; blocks.push(cur); continue; }
    if (!cur || SKIP_LINE.test(line)) continue;
    if (TOTALS.test(line)) { cur = null; continue; }
    cur.rest.push(line);
  }

  const txns = [];
  let prev = opening;
  for (const b of blocks) {
    const all = [b.head, ...b.rest].join("\n");
    const dm = DATE_AT_START.exec(b.head);
    const date = toDate(dm[1].replace(/\s+/g, "-"));
    if (!date) continue;
    const amounts = (all.replace(DATE_ANY, " ").match(AMOUNT) || []).map((a) => ({ raw: a, v: num(a) }));
    if (!amounts.length) continue;
    let amount, balance = null;
    if (amounts.length >= 2) { amount = Math.abs(amounts[amounts.length - 2].v); balance = amounts[amounts.length - 1].v; }
    else amount = Math.abs(amounts[0].v);
    let narr = all.replace(DATE_ANY, " ").replace(AMOUNT, " ").replace(/\s+/g, " ").trim();
    const refMatch = /\b(\d{6,16})\b/.exec(narr);
    let credit = 0, debit = 0;
    if (balance != null && prev != null) {
      if (Math.abs(r2(prev + amount) - balance) <= 0.011) credit = amount;
      else if (Math.abs(r2(prev - amount) - balance) <= 0.011) debit = amount;
      else if (CREDIT_WORDS.test(narr)) credit = amount;
      else debit = amount;
    } else if (/\bCr\b/i.test(amounts[amounts.length - 1].raw) && amounts.length === 1) credit = amount;
    else if (CREDIT_WORDS.test(narr)) credit = amount;
    else debit = amount;
    txns.push({ date, narration: narr, ref: refMatch ? refMatch[1] : "", debit: r2(debit), credit: r2(credit), balance: balance == null ? null : r2(balance) });
    prev = balance != null ? balance : prev != null ? r2(prev + credit - debit) : null;
  }
  if (opening == null && txns.length) warnings.push("No opening balance was found in the PDF, so the direction (debit or credit) of the first line is a guess. Check it.");
  return { txns, opening, warnings };
}

const AI_PROMPT = `Extract every transaction of this bank statement as JSON: {"opening_balance": number|null, "transactions": [{"date":"YYYY-MM-DD","narration":string,"reference":string,"debit":number,"credit":number,"balance":number|null}]}. debit is money leaving the account, credit is money coming in; use 0 for the other. Keep the original order. Return only JSON.`;

async function readStatementWithAi(bytes, text) {
  const parts = [{ text: AI_PROMPT }];
  if (text.replace(/\s+/g, "").length > 300) parts.push({ text: `Statement text:\n${text.slice(0, 80000)}` });
  else parts.push({ inlineData: { mimeType: "application/pdf", data: Buffer.from(bytes).toString("base64") } });
  const ai = await geminiJson(parts, { models: ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-lite-latest"], timeoutMs: 90000 });
  const txns = (ai.transactions || []).map((t) => ({
    date: toDate(t.date), narration: String(t.narration || "").trim(), ref: String(t.reference || ""),
    debit: r2(Math.abs(Number(t.debit) || 0)), credit: r2(Math.abs(Number(t.credit) || 0)), balance: t.balance == null ? null : r2(Number(t.balance)),
  })).filter((t) => t.date && (t.debit || t.credit));
  return { txns, opening: ai.opening_balance == null ? null : Number(ai.opening_balance) };
}

export async function readStatementPdf(bytes) {
  let text = "";
  try { text = await pdfText(bytes); } catch (e) { throw new Error(`The PDF could not be opened (${String(e.message || e).slice(0, 80)}). If it is password protected, remove the password or upload the Excel / CSV version.`); }
  let parsed = parseStatementText(text);
  const warnings = [...parsed.warnings];
  let source = "pdf";
  if (!parsed.txns.length && config.geminiApiKey) {
    try {
      const ai = await readStatementWithAi(bytes, text);
      if (ai.txns.length) { parsed = { txns: ai.txns, opening: ai.opening }; source = "ai"; warnings.push("This PDF was read with AI because its layout could not be read directly. Check the totals against the statement."); }
    } catch (e) { warnings.push(`AI reading failed: ${String(e.message || e).slice(0, 100)}`); }
  }
  if (!parsed.txns.length) throw new Error("No transactions could be read from this PDF. It may be a scanned image or an unusual layout. Upload the Excel / CSV version of the statement.");
  return finish(parsed.txns, parsed.opening, warnings, source);
}

export async function readStatement(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return readStatementPdf(buffer);
  if (SHEET_EXTS.includes(ext)) return readStatementSheets(buffer, filename);
  throw new Error(`A ${ext || "this"} file cannot be read as a bank statement. Upload PDF, Excel or CSV.`);
}
