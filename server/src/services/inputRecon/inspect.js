import path from "node:path";
import { readSheets, toDate, SHEET_EXTS } from "../recon/sheetParser.js";
import { pdfText } from "../recon/gstr3bParser.js";
import { readBooksItc, readGstr2b } from "../itc/readers.js";
import { readGstr3bFile, periodFromName, fyOfPeriod } from "../output/readers.js";
import { readLedger } from "../banking/ledgerReader.js";
import { read3bWorking, readFinal3b } from "./work3b.js";
import { readExpenses } from "./expenseReader.js";
import { fyFrom, fyTo } from "../banking/common.js";

/**
 * The files of the Input Reconciliation section. Each kind says which sub-section it belongs to and which files it takes.
 * Uploading reads a file to tell the CA staff what it holds (lines, period) and keeps what was read for the combined Excel.
 * Nothing is refused for being unreadable: the file is kept with the reason.
 */

/** Bumped when a reader changes, so files read by an older reader are read again. */
export const DATA_VER = 4;

const SHEETS = SHEET_EXTS;
export const KINDS = {
  books_itc: { group: "books", label: "Input ITC ledger", exts: SHEETS },
  books_cash: { group: "books", label: "Cash ledger", exts: SHEETS },
  books_tdstcs: { group: "books", label: "TDS and TCS as per GST Act", exts: SHEETS },
  books_rcm: { group: "books", label: "RCM expense ledgers", exts: SHEETS },
  gstr2b: { group: "portal", label: "GSTR-2B", exts: SHEETS, monthly: true },
  gstr3b: { group: "portal", label: "GSTR-3B", exts: [".pdf", ...SHEETS], monthly: true },
  portal_cash: { group: "portal", label: "Electronic cash ledger", exts: [".pdf", ...SHEETS] },
  portal_credit: { group: "portal", label: "Electronic credit ledger", exts: [".pdf", ...SHEETS] },
  work3b: { group: "reco", label: "GSTR-3B working", exts: SHEETS, monthly: true },
  final3b: { group: "final", label: "Finalised GSTR-3B working (combined)", exts: SHEETS },
};

const DATE_LINE = /^\s*(\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}|\d{1,2}[-/. ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/. ,]*\d{2,4})/i;

/** The portal's electronic cash and credit ledgers: dated lines, from a PDF or a spreadsheet. */
async function portalLedger(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  const dates = [];
  if (ext === ".pdf") {
    const text = await pdfText(buffer);
    for (const line of text.split(/\r?\n/)) { const m = DATE_LINE.exec(line); const d = m && toDate(m[1].replace(/\s+/g, "-")); if (d) dates.push(d); }
  } else {
    const isAmount = (c) => typeof c === "number" || (typeof c === "string" && /^-?[\d,]+(\.\d+)?$/.test(c.trim()));
    for (const sh of await readSheets(buffer, filename)) for (const r of sh.rows) { const d = toDate(r[0]) || toDate(r[1]); if (d && r.some(isAmount)) dates.push(d); }
  }
  if (!dates.length) throw new Error("No dated lines were found in this ledger.");
  dates.sort();
  return { rows: dates.length, from: dates[0], to: dates[dates.length - 1] };
}

/** The ITC ledger of the books: an ITC register (party, GSTIN, invoice, taxable value, tax) or a plain ledger (date, particulars, debit, credit). */
async function booksItc(buffer, filename) {
  let registerError = "";
  try {
    const r = await readBooksItc(buffer, filename);
    const dates = r.rows.map((x) => x.date).filter(Boolean).sort();
    return { format: "register", rows: r.rows, count: r.rows.length, from: dates[0] || null, to: dates[dates.length - 1] || null, warnings: r.warnings || [] };
  } catch (e) { registerError = String(e.message || e); }
  try {
    const l = await readLedger(buffer, filename);
    return { format: "ledger", entries: l.entries, count: l.entries.length, from: l.from, to: l.to, warnings: l.warnings || [] };
  } catch (e) {
    throw new Error(`${String(e.message || e)} An ITC register with Party, GSTIN, Invoice No, Taxable Value and tax columns is also accepted (${registerError.slice(0, 80)}).`);
  }
}

/**
 * What a file holds, for the list on the screen, and the data read from it for the combined Excel.
 * Never throws: a file that cannot be read is kept with the reason.
 */
export async function readInput(kind, buffer, filename, { clientGstin, fy }) {
  const spec = KINDS[kind];
  const warnings = [];
  const info = { read: false, rows: 0, from: null, to: null, period: null, format: null, warnings };
  let data = null;
  try {
    if (kind === "books_itc") {
      const b = await booksItc(buffer, filename);
      Object.assign(info, { read: true, rows: b.count, from: b.from, to: b.to, format: b.format });
      warnings.push(...b.warnings);
      data = b.format === "register" ? { format: "register", rows: b.rows } : { format: "ledger", entries: b.entries };
    } else if (kind === "books_rcm") {
      const x = await readExpenses(buffer, filename);
      Object.assign(info, { read: true, rows: x.entries.length, from: x.from, to: x.to, format: "expenses", ledgers: x.ledgers.slice(0, 30) });
      warnings.push(...x.warnings);
      data = { format: "expenses", entries: x.entries };
    } else if (kind.startsWith("books_")) {
      const l = await readLedger(buffer, filename);
      Object.assign(info, { read: true, rows: l.entries.length, from: l.from, to: l.to, format: "ledger" });
      warnings.push(...(l.warnings || []));
      if (kind === "books_tdstcs") data = { format: "ledger", entries: l.entries };
    } else if (kind === "gstr2b") {
      const r = await readGstr2b(buffer, filename, { clientGstin });
      Object.assign(info, { read: true, rows: r.rows.length, period: periodFromName(filename) });
      warnings.push(...(r.warnings || []));
      data = { rows: r.rows };
    } else if (kind === "gstr3b") {
      const r = await readGstr3bFile(buffer, filename);
      Object.assign(info, { read: true, rows: r.found || 0, period: r.period || periodFromName(filename) });
      warnings.push(...(r.warnings || []));
      data = { period: r.period || null, figures: r.figures };
    } else if (kind === "final3b") {
      const r = await readFinal3b(buffer, filename);
      const dates = r.docs.map((d) => d.date).filter(Boolean).sort();
      Object.assign(info, { read: true, rows: r.rows, from: dates[0] || null, to: dates[dates.length - 1] || null });
      warnings.push(...r.warnings);
      data = r;
    } else if (kind === "work3b") {
      const r = await read3bWorking(buffer, filename);
      Object.assign(info, { read: true, rows: r.found, period: r.period || periodFromName(filename), claimed: r.claimed });
      warnings.push(...r.warnings);
      data = r;
    } else {
      const r = await portalLedger(buffer, filename);
      Object.assign(info, { read: true, ...r });
    }
  } catch (e) {
    info.period = spec.monthly ? periodFromName(filename) : null;
    warnings.push(`Not read yet: ${String(e.message || e).slice(0, 420)}`);
  }
  if (spec.monthly) {
    if (!info.period) warnings.push("The return month could not be found. Choose it on the list.");
    else if (fyOfPeriod(info.period) !== fy) warnings.push(`This file is for ${info.period}, which is outside ${fy}. Change the month or the financial year.`);
  } else if (info.from && (info.to < fyFrom(fy) || info.from > fyTo(fy))) {
    warnings.push(`The dates in this file (${info.from} to ${info.to}) are outside ${fy}.`);
  }
  return { info, data };
}
