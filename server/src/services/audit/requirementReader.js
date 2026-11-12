import path from "node:path";
import crypto from "node:crypto";
import { readSheets, SHEET_EXTS } from "../recon/sheetParser.js";
import { emptyRow, mapColumns } from "../itc/readers.js";
import { fyStartYear, monthsOfFy, monthLabel } from "../banking/common.js";
import { BANKS } from "../banks.js";

/**
 * The audit checklist workbook. Its first sheet is the audit programme: the points the auditor has to check (opening balances, fixed assets...).
 * Its second sheet is the documents required: one line for each document the audit needs, laid out any way the firm keeps it (a serial number,
 * the document, its details, how often, remarks; section headings between the lines; a month in each column; several documents in one cell).
 * Each document line is classified, and a line that recurs (a challan every month, a return every quarter, a bank statement for every account)
 * is expanded into one item for each period of the financial year, so what is pending can be said month by month.
 * A workbook with only one sheet is read as the documents required, unless its lines are the auditor's own instructions (verify, check, vouch...).
 */

export const CATEGORIES = {
  bank_statement: "Bank statements",
  loan: "Loan documents",
  gst_return: "GST returns",
  tds_return: "TDS returns",
  tds_challan: "TDS challans and certificates",
  esic: "ESIC",
  pf: "Provident fund",
  prof_tax: "Professional tax",
  payroll: "Salary and payroll",
  form26as: "Form 26AS, AIS and TIS",
  invoices: "Sales and purchase documents",
  income_tax: "Income tax",
  fixed_assets: "Fixed assets",
  stock: "Stock",
  books: "Books of account and financial statements",
  other: "Other documents",
};

// the first that matches names the kind of document; the period a kind recurs in, when the sheet does not say
const KINDS = [
  { key: "bank_statement", re: /bank (statement|stmt|a\/c statement|account statement)|statement of bank account|\b(current|savings|cc|od) (a\/c|account) statement|passbook|pass book|bank book/, every: "month", fixed: true },
  { key: "loan", re: /\bloans?\b|sanction letter|repayment schedule|emi schedule|\bod\b|cash credit|overdraft|term loan|loan statement/, every: "year" },
  { key: "tds_return", re: /tds (return|statement|filing)|\b(form )?2[467]q\b|\b2[467]q\b|tds and tcs return|quarterly tds/, every: "quarter" },
  { key: "tds_challan", re: /tds (challan|payment|deposit)|challan.*tds|itns ?281|form ?16a?\b|tds certificate|tds (receipt|credit)/, every: "month" },
  { key: "gst_return", re: /gstr|gst return|gst[- ]?3b|gst[- ]?1\b|gst (challan|payment|filing)|gst reconciliation|gst working/, every: "month" },
  { key: "esic", re: /\besi\b|\besic\b|employees'? state insurance/, every: "month" },
  { key: "pf", re: /\bpf\b|provident fund|\bepf\b|\bepfo\b|\becr\b/, every: "month" },
  { key: "prof_tax", re: /professional tax|\bpt (challan|return|payment)\b/, every: "month" },
  { key: "payroll", re: /salary|payroll|wages?|pay ?slips?|muster/, every: "month" },
  { key: "form26as", re: /\b26as\b|\bais\b|\btis\b|annual information statement|taxpayer information summary/, every: "year" },
  { key: "invoices", re: /invoice|sales (register|bills?|summary)|purchase (register|bills?|summary)|vouchers?|e-?way ?bills?/, every: "month" },
  { key: "income_tax", re: /income tax|\bitr\b|advance tax|self[- ]assessment|computation of income|tax audit|3cd|3ca|3cb|form ?3c/, every: "year" },
  { key: "fixed_assets", re: /fixed assets?|depreciation|asset register|capital (goods|expenditure)|\bcapex\b/, every: "year" },
  { key: "stock", re: /\bstock\b|inventory|closing stock/, every: "year" },
  { key: "books", re: /trial balance|ledgers?|balance sheet|profit (and|&) loss|financial statements?|books of accounts?|day ?book|cash book|general ledger/, every: "year" },
];

const ANNUAL_GST = /gstr[- ]?9|annual return|\b9c\b|reconciliation statement/;
const SKIP_NAME = /^(notes?|n\.?b\.?|total|signature|prepared by|checked by|kindly|please|sr\.? ?no|s\.? ?no|particulars|documents? required|description|remarks?)\b/i;
// the auditor's own instructions: the lines of a programme, not the documents asked of a client
const VERB = /^(\d+[.)]\s*)?(verify|check|vouch|examine|ensure|confirm|review|reconcile|test|obtain|compare|ascertain|inspect|scrutini[sz]e|observe|trace|agree|perform|analy[sz]e|assess|evaluate|whether|see that|satisfy|determine|validate|cross[- ]check|match|ledger scrutiny)\s/i;

const COMMON = {
  sr: [/^(sr|s|sl)\.?\s?(no\.?|number)?\.?$/, /^#$/, /^no\.?$/, /^(sr|sl)\.? ?no/],
  section: [/^(category|section|area|group|head|heading|class(ification)?|part)$/],
};
const TAIL = {
  freq: [/^(frequency|periodicity|periods?|duration|time ?line|months?|period required|period covered|period of document)$/, /frequency|periodicity|period|months?|time ?line/],
  applies: [/applicable|applies/],
};
const COLS = {
  documents: {
    ...COMMON,
    name: [/^(documents?|document name|name of (the )?documents?|particulars|items?)$/, /documents?|particulars|list of|information|requirement|item|description/],
    ...TAIL,
    detail: [/^(details?|description|specifications?|document details?|nature of (the )?document|format)$/, /details?|specification|description/],
    remark: [/remarks?|comments?|notes?|specific|instructions?/],
  },
  programme: {
    ...COMMON,
    name: [/^(audit )?(check ?list|check ?points?|procedures?|points?|particulars|areas?( of audit)?|audit (procedure|programme|program|point|step|area)s?)$/, /check ?list|check ?point|procedure|programme|program|particulars|point|description|area|audit|item/],
    ...TAIL,
    detail: [/^(details?|description|audit procedure|how|method|scope|requirement|nature)$/, /details?|description|procedure|method|scope/],
    remark: [/remarks?|comments?|notes?|instructions?/],
  },
};

const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const clean = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const text = (v) => (typeof v === "string" ? v : v == null ? "" : v instanceof Date ? "" : String(v));

// a bullet or a number in front of a line: "1.", "a)", "(iii)", "-", "•"
const BULLET = /^\s*(?:[-–—•·*▪●○◦■□✓✔►>]+|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,5}[.)]|\d{1,3}\.\d{1,2}[.)]?)\s+/i;
const unbullet = (s) => clean(s.replace(BULLET, ""));

/** One cell that holds several lines of the list (bulleted, numbered, or each on its own line) is read as several lines. */
function splitCell(raw) {
  const parts = String(raw).split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return [clean(raw)];
  const bullets = parts.filter((p) => BULLET.test(p)).length;
  const head = /:$/.test(parts[0]) && parts.length > 1 ? parts[0].replace(/:$/, "") : "";
  const rest = head ? parts.slice(1) : parts;
  const bulleted = rest.filter((p) => BULLET.test(p)).length;
  const own = rest.every((p) => /^[A-Z0-9(]/.test(p) && p.length >= 8 && p.length <= 90 && /\s/.test(p));
  if (!(bullets >= 2 || bulleted >= 1 || own)) return [clean(raw)];
  return rest.map((p) => (head ? `${head} - ${unbullet(p)}` : unbullet(p))).filter((p) => p.length > 2);
}

/** How often a line says it recurs, from its own words; null when it does not say. */
function frequencyIn(t0) {
  const t = t0.toLowerCase();
  if (/month[- ]?wise|monthly|each month|every month|per month|month to month|all (the )?months|12 months/.test(t)) return "month";
  if (/quarter[- ]?wise|quarterly|each quarter|every quarter|per quarter|all (the )?quarters/.test(t)) return "quarter";
  if (/half[- ]?year|six[- ]month/.test(t)) return "half";
  if (/annual|yearly|year[- ]end|once a year|one[- ]?time|once only/.test(t)) return "year";
  return null;
}

/** Months named in the text, as YYYY-MM inside the financial year: "Apr-25 to Sep-25", "April to September", or a single "Mar 2026". */
function monthsNamed(t0, fy) {
  const t = t0.toLowerCase();
  const inYear = monthsOfFy(fy);
  const tok = String.raw`(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/.',]*((?:20)?\d{2})`;
  const ym = (m) => `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${String(MON.indexOf(m[1]) + 1).padStart(2, "0")}`;
  // "Apr-25 to Sep-25": every month from the first to the last
  const span = new RegExp(String.raw`\b${tok}\s*(?:to|-|–|till|upto|up to|through)\s*${tok}\b`).exec(t);
  if (span) {
    const a = inYear.indexOf(ym([0, span[1], span[2]])), b = inYear.indexOf(ym([0, span[3], span[4]]));
    if (a >= 0 && b >= a) return inYear.slice(a, b + 1);
  }
  const withYear = [...t.matchAll(new RegExp(String.raw`\b${tok}\b`, "g"))].map(ym).filter((m) => inYear.includes(m));
  if (withYear.length) return [...new Set(withYear)].sort();
  const range = /\b(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|may)[a-z]*\s*(?:to|-|–|till|upto|up to|through)\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/.exec(t);
  if (range) {
    const a = inYear.findIndex((m) => Number(m.slice(5)) === MON.indexOf(range[1]) + 1), b = inYear.findIndex((m) => Number(m.slice(5)) === MON.indexOf(range[2]) + 1);
    if (a >= 0 && b >= a) return inYear.slice(a, b + 1);
  }
  return [];
}

const accountIn = (t) => {
  const m = /(?:a\/c|acct|account)\.?\s*(?:no\.?|number|#)?\s*[:-]?\s*([x*]{0,12}\d{3,18}|[A-Z0-9/-]{6,30})/i.exec(t) || /\b(\d{9,18})\b/.exec(t) || /\b([x*]{2,}\d{3,6})\b/i.exec(t);
  return m ? m[1].replace(/\s+/g, "").toUpperCase() : "";
};
const BANK_ALIASES = { sbi: "State Bank of India", hdfc: "HDFC Bank", icici: "ICICI Bank", axis: "Axis Bank", kotak: "Kotak Mahindra Bank", pnb: "Punjab National Bank", boi: "Bank of India", bob: "Bank of Baroda", idbi: "IDBI Bank", "yes bank": "Yes Bank", indusind: "IndusInd Bank", idfc: "IDFC FIRST Bank", rbl: "RBL Bank" };
function bankIn(t0) {
  const t = t0.toLowerCase();
  const full = BANKS.find((b) => t.includes(b.toLowerCase()));
  if (full) return full;
  const alias = Object.keys(BANK_ALIASES).find((a) => new RegExp(`\\b${a}\\b`).test(t));
  return alias ? BANK_ALIASES[alias] : "";
}

/** The periods of a financial year for a kind of recurrence: [{ period, kind, label }]. */
export function periodsOf(kind, fy, only = []) {
  const y = fyStartYear(fy);
  if (kind === "month") return monthsOfFy(fy).filter((m) => !only.length || only.includes(m)).map((m) => ({ period: m, kind, label: monthLabel(m) }));
  if (kind === "quarter") {
    const months = monthsOfFy(fy);
    const out = [["Q1", `Apr-Jun ${y}`], ["Q2", `Jul-Sep ${y}`], ["Q3", `Oct-Dec ${y}`], ["Q4", `Jan-Mar ${y + 1}`]].map(([n, l], i) => ({ period: months[i * 3 + 2], kind, label: `${n} (${l})`, months: months.slice(i * 3, i * 3 + 3) }));
    return (only.length ? out.filter((p) => p.months.some((m) => only.includes(m))) : out).map(({ months: _m, ...p }) => p);
  }
  if (kind === "half") return [{ period: `${y}-09`, kind, label: `H1 (Apr-Sep ${y})` }, { period: `${y + 1}-03`, kind, label: `H2 (Oct ${y}-Mar ${y + 1})` }];
  return [{ period: null, kind: "year", label: `FY ${fy}` }];
}

const keyOf = (parts) => crypto.createHash("sha1").update(parts.map((p) => String(p ?? "").toLowerCase().replace(/\s+/g, " ").trim()).join("|")).digest("hex").slice(0, 16);

export const classify = (t0) => {
  const t = t0.toLowerCase();
  // "HDFC Bank current account 5010... statement": a statement of an account at a bank, however it is worded
  if (/\bstatements?\b|\bstmt\b/.test(t) && (bankIn(t) || /\bbank\b|\bcurrent (a\/c|account)\b|\bsavings\b/.test(t)) && !/\bloan|gst|tds|26as|\bais\b|\btis\b|income|financial|profit|debtors|creditors/.test(t)) return { category: "bank_statement", every: "month", fixed: true };
  const hit = KINDS.find((k) => k.re.test(t));
  return hit ? { category: hit.key, every: hit.every, fixed: Boolean(hit.fixed) } : { category: "other", every: "year", fixed: false };
};

// ---------------------------------------------------------------------------------------------- reading the lines of a sheet

/** The heading row: the first-30-rows row that names the most columns we know, one that names the list itself being required. */
function findHeaderRow(rows, cols) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const r = rows[i];
    if (!r.some((c) => typeof c === "string" && clean(c))) continue;
    if (r.some((c) => typeof c === "number") || /^\d+$/.test(clean(r[0]))) continue; // a line of data
    const cands = r.map((c) => (typeof c === "string" && clean(c) ? [clean(c).toLowerCase()] : []));
    const map = mapColumns(cands, cols);
    if (map.name == null) continue;
    const filled = cands.filter((c) => c.length).length;
    // a title names the sheet in one cell; a heading row names the other columns too
    const score = Object.keys(map).length * 10 + Math.min(filled, 9);
    if (!best || score > best.score) best = { row: i, map, score, cands };
  }
  return best;
}

/** The columns that are months (Apr, May-25...), when the sheet has a column for every month: [{ col, month }]. */
function monthColumns(cands, fy) {
  const inYear = monthsOfFy(fy);
  const cols = [];
  cands.forEach((c, col) => {
    const m = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/.']*(\d{2,4})?$/.exec(c[0] || "");
    if (!m) return;
    const n = MON.indexOf(m[1]) + 1;
    const month = inYear.find((x) => Number(x.slice(5)) === n);
    if (month) cols.push({ col, month });
  });
  return new Set(cols.map((c) => c.month)).size >= 3 ? cols : [];
}

const NOT_APPLICABLE = /^(no|n|na|n\.?a\.?|nil|not applicable|not required|x)$/i;

/** Every line of a sheet as { ref, section, name, freq, detail, remark, months }, whatever the layout. */
function extractLines(sh, role, fy) {
  const rows = sh.rows;
  const header = findHeaderRow(rows, COLS[role]);
  const scan = (nameCol, start, map, monthCols) => {
    const out = [];
    const srCount = map.sr == null ? 0 : rows.slice(start).filter((r) => /^\d+(\.\d+)?$|^[a-z]\)?$/i.test(clean(r[map.sr]))).length;
    let section = "";
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (emptyRow(r)) continue;
      const raw = text(r[nameCol]);
      const name = clean(raw);
      if (!name) {
        // a heading written in another column of the line (often the first, spanning the width)
        const only = [...new Set(r.map(clean).filter(Boolean))];
        const t = only.length === 1 ? only[0] : "";
        if (t && !/^[\d.,\s-]+$/.test(t) && !SKIP_NAME.test(t) && t.length > 2) section = t.replace(/:$/, "");
        continue;
      }
      if (/^[\d.,\s-]+$/.test(name) || SKIP_NAME.test(name)) continue;
      const sr = map.sr == null ? "" : clean(r[map.sr]);
      const others = r.filter((c, k) => k !== nameCol && clean(c) && clean(c) !== name).length;
      // the same text in several cells of the line: a heading merged across the width of the sheet
      const merged = !others && r.filter((c) => clean(c) === name).length >= 2;
      if (merged) { section = name.replace(/:$/, ""); continue; }
      const caps = /^[A-Z0-9 &/,.()'-]{4,}$/.test(name);
      const headingLike = !others && !sr && (/^(part|section)\b/i.test(name) || /^(?:[A-Z]|[IVX]+)[.)]\s+[A-Z0-9 &/,.()'-]{3,}$/.test(name) || /:$/.test(name)
        || (caps && classify(name).category === "other") || (srCount >= 2 && !BULLET.test(name)));
      if (headingLike) { section = name.replace(/:$/, ""); continue; }
      const get = (k) => (map[k] == null ? "" : clean(r[map[k]]));
      if (NOT_APPLICABLE.test(get("applies"))) continue;
      let months = [];
      if (monthCols.length) {
        // a column for every month: the months not marked not applicable are the months asked for
        const live = monthCols.filter((m) => !NOT_APPLICABLE.test(clean(r[m.col])));
        if (!live.length) continue;
        months = live.length === monthCols.length ? [] : live.map((m) => m.month);
      }
      const sec = get("section") || section;
      const parts = splitCell(raw);
      for (const p of parts) {
        const nm = parts.length === 1 ? unbullet(p) : p;
        if (nm.length < 3 || SKIP_NAME.test(nm)) continue;
        out.push({ ref: parts.length === 1 ? sr || /^\s*\(?(\d{1,3}(?:\.\d{1,2})?|[a-z]|[ivx]{1,5})[.)]/i.exec(p)?.[1] || "" : "", section: sec, name: nm, freq: get("freq"), detail: get("detail"), remark: get("remark"), months, monthly: monthCols.length > 0 });
      }
    }
    return out;
  };
  if (header) {
    const lines = scan(header.map.name, header.row + 1, header.map, monthColumns(header.cands, fy));
    if (lines.length) return { lines, column: clean(rows[header.row][header.map.name]), headed: true };
  }
  // no heading row (or nothing below it): the column with the most text is the list
  const width = Math.max(0, ...rows.map((r) => r.length));
  const score = Array.from({ length: width }, (_, c) => rows.filter((r) => typeof r[c] === "string" && clean(r[c]).length > 4).length);
  const nameCol = score.indexOf(Math.max(0, ...score));
  if (nameCol < 0 || !score[nameCol]) return { lines: [], column: "", headed: false };
  return { lines: scan(nameCol, 0, {}, []), column: `column ${String.fromCharCode(65 + nameCol)}`, headed: false };
}

const NAME_ROLE = [
  ["skip", /^(notes?|read ?me|instructions?|help|summary|cover|index|contents|queries)$/i],
  ["documents", /document|required|requirement|pbc|prepared by client|data request|information|list of/i],
  ["programme", /check ?list|programme|program|procedure|audit|points?|steps?|scope/i],
];

/** Which sheet is the audit programme and which the documents required: by the name of the sheet, else the first is the programme and the second the documents, else by what its lines say. */
function assignRoles(sheets, fy) {
  const roles = sheets.map((sh) => { const r = (NAME_ROLE.find(([, re]) => re.test(sh.name)) || [null])[0]; return r === "skip" && sheets.length === 1 ? null : r; });
  const live = roles.map((r, i) => (r === "skip" && sheets.length > 1 ? null : i)).filter((i) => i !== null);
  const decide = (i) => {
    const { lines } = extractLines(sheets[i], "documents", fy);
    const verbs = lines.filter((l) => VERB.test(l.name)).length;
    return lines.length && verbs / lines.length >= 0.4 ? "programme" : "documents";
  };
  const have = (role) => roles.includes(role);
  const open = live.filter((i) => roles[i] === null);
  if (live.length === 1 && roles[live[0]] === null) roles[live[0]] = decide(live[0]);
  else {
    for (const i of open) {
      if (!have("programme") && !have("documents")) roles[i] = open.indexOf(i) === 0 ? "programme" : "documents";
      else if (!have("programme")) roles[i] = "programme";
      else if (!have("documents")) roles[i] = "documents";
      else roles[i] = decide(i);
    }
  }
  return roles.map((r, i) => (live.includes(i) ? r : "skip"));
}

/**
 * Reads the workbook: { items (the documents, period by period), requirements (document lines), points (the audit programme), sheets (how each sheet was read), warnings }.
 * accounts: the client's bank accounts known in the system, for a line that asks for bank statements without naming an account.
 */
export async function readWorkbook(buffer, filename, { fy, accounts = [] }) {
  const ext = path.extname(filename).toLowerCase();
  if (!SHEET_EXTS.includes(ext)) throw new Error("Upload the audit checklist as an Excel file (any version) or a CSV file.");
  const sheets = (await readSheets(buffer, filename)).filter((sh) => sh.rows.some((r) => !emptyRow(r)));
  const warnings = [];
  const roles = assignRoles(sheets, fy);
  const reqs = [];
  const points = [];
  const diag = [];
  const pointKeys = new Map();
  sheets.forEach((sh, i) => {
    const role = roles[i];
    if (role === "skip") { diag.push({ name: sh.name, role: "skipped", lines: 0, column: "" }); return; }
    const { lines, column, headed } = extractLines(sh, role, fy);
    diag.push({ name: sh.name, role, lines: lines.length, column, headed });
    if (!lines.length) warnings.push(`Nothing was read from the sheet "${sh.name}". It needs a list with one ${role === "programme" ? "audit point" : "document"} to a row and a heading such as ${role === "programme" ? "Checklist or Particulars" : "Particulars or Documents required"}.`);
    if (role === "programme") {
      for (const l of lines) {
        const base = keyOf([l.section, l.name]);
        const n = (pointKeys.get(base) || 0) + 1;
        pointKeys.set(base, n);
        points.push({ seq: points.length + 1, ref: l.ref, section: l.section, name: l.name, detail: [l.detail, l.remark].filter(Boolean).join(" · ") || null, item_key: n === 1 ? base : keyOf([base, n]) });
      }
    } else {
      for (const l of lines) reqs.push({ ...l, sheet: sh.name });
    }
  });
  if (!reqs.length && !points.length) throw new Error("No audit checklist or documents were found in this workbook. Put the audit checklist on the first sheet and the documents required on the second, one line to a row, with a heading such as Particulars.");

  const items = [];
  const seen = new Set();
  let dropped = 0;
  reqs.forEach((q, n) => {
    const said = `${q.name} ${q.freq} ${q.detail} ${q.remark}`;
    const cls = classify(`${q.name} ${q.detail}`.trim());
    const own = classify(q.name);
    const cat = own.category === "other" ? cls : own;
    let every = cat.fixed ? cat.every : q.monthly && (cat.every === "month" || q.months.length) ? "month" : frequencyIn(`${q.name} ${q.freq}`) || frequencyIn(`${q.detail} ${q.remark}`) || cat.every;
    if (cat.category === "gst_return" && ANNUAL_GST.test(said.toLowerCase())) every = "year";
    if (cat.category === "tds_challan" && /form ?16\b|tds certificate/.test(said.toLowerCase())) every = /16a/.test(said.toLowerCase()) ? "quarter" : "year";
    const named = every === "month" || every === "quarter" ? (q.months.length ? q.months : monthsNamed(said, fy)) : [];
    const note = [q.detail, q.remark].filter(Boolean).join(" · ");
    const bank = cat.category === "bank_statement" || cat.category === "loan" ? bankIn(`${q.name} ${q.detail} ${q.remark}`) : "";
    const acct = cat.category === "bank_statement" || cat.category === "loan" ? accountIn(`${q.name} ${q.detail} ${q.remark}`) : "";

    // a bank statement line that names no account is asked for every account the client has in the system
    let targets = [{ account: acct, bank }];
    if (cat.category === "bank_statement" && !acct && !bank && accounts.length) targets = accounts.map((a) => ({ account: a.account_number, bank: a.bank_name }));
    for (const t of targets) {
      periodsOf(every, fy, named).forEach((p, seq) => {
        const key = keyOf([q.section, q.name, t.account, t.bank, p.kind, p.period]);
        if (seen.has(key)) { dropped++; return; }
        seen.add(key);
        items.push({
          req_no: n + 1, seq, section: q.section, name: q.name, category: cat.category, period: p.period, period_kind: p.kind, period_label: p.label,
          account_number: t.account || null, bank_name: t.bank || null, note: note || null, item_key: key,
        });
      });
    }
  });
  if (dropped) warnings.push(`${dropped} repeated line(s) in the sheet were counted once.`);
  if (items.length > 5000) { items.length = 5000; warnings.push("The documents expand to more than 5,000 items; only the first 5,000 are kept."); }
  const generic = reqs.filter((q) => classify(q.name).category === "bank_statement" && !accountIn(q.name) && !bankIn(q.name)).length;
  if (generic && !accounts.length) warnings.push("Bank statements are asked for, but no bank account is known for this client yet, so they are listed once for all accounts. Add the accounts to the sheet (bank name and account number), or the client can give them under Banking.");
  if (points.length && !reqs.length) warnings.push("The workbook has an audit checklist but no list of documents required. Put the documents required on the second sheet.");
  if (reqs.length && !points.length) warnings.push("The workbook has the documents required but no audit checklist. Put the audit checklist on the first sheet to track what is checked.");
  return { items, requirements: reqs.length, points, sheets: diag, warnings };
}

export const readRequirements = readWorkbook;
