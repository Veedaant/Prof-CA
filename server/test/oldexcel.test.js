import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as XLSX from "xlsx";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-oldxls-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { readSheets, isSheetFile } = await import("../src/services/recon/sheetParser.js");
const { readStatement } = await import("../src/services/banking/statementReader.js");
const { readLedger } = await import("../src/services/banking/ledgerReader.js");
const { readSchedule } = await import("../src/services/banking/scheduleReader.js");
const { readGstr2b, readBooksItc } = await import("../src/services/itc/readers.js");

/** A real Excel file: date cells are numbers with a date format, as Excel stores them. D("2025-04-03") makes one. */
const D = (iso) => ({ __date: iso });
function makeExcel(rows, { bookType = "biff8", sheet = "Sheet1" } = {}) {
  const ws = {};
  rows.forEach((r, ri) => r.forEach((v, ci) => {
    if (v === "" || v == null) return;
    const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
    if (v.__date) { const [y, m, d] = v.__date.split("-").map(Number); ws[ref] = { t: "n", v: (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000, z: "dd/mm/yyyy" }; }
    else if (typeof v === "number") ws[ref] = { t: "n", v };
    else ws[ref] = { t: "s", v: String(v) };
  }));
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: Math.max(...rows.map((r) => r.length)) - 1 } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet);
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType }));
}

const STATEMENT = [
  ["HDFC BANK LTD"], [],
  ["Date", "Narration", "Chq./Ref.No.", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  [D("2025-04-01"), "OPENING BALANCE", "", "", "", 100000],
  [D("2025-04-03"), "NEFT CR-ABC TRADERS PVT LTD", "000123456", "", 118000, 218000],
  [D("2025-04-30"), "SMS CHARGES Q1", "", 17.7, "", 217982.3],
];
const LEDGER = [
  ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  [D("2025-04-01"), "Opening Balance", "", "", 100000, ""],
  [D("2025-04-03"), "By ABC Traders", "Receipt", "11", 118000, ""],
  [D("2025-04-06"), "To XYZ Services", "Payment", "21", "", 25000],
];

test("an Excel 97-2003 (.xls) file is read like an .xlsx: dates, numbers and text", async () => {
  const xls = makeExcel(STATEMENT);
  assert.equal(xls.subarray(0, 4).toString("hex"), "d0cf11e0", "it is a real old-format file");
  const sheets = await readSheets(xls, "statement.xls");
  assert.equal(sheets[0].rows[2][0] instanceof Date, true);
  assert.equal(sheets[0].rows[2][0].toISOString().slice(0, 10), "2025-04-01");

  const s = await readStatement(xls, "statement.xls");
  assert.equal(s.opening, 100000);
  assert.deepEqual(s.txns.map((t) => [t.date, t.debit, t.credit, t.balance]), [["2025-04-03", 0, 118000, 218000], ["2025-04-30", 17.7, 0, 217982.3]]);
  assert.deepEqual(s.warnings, []);
});

test("ledgers, repayment schedules, GSTR-2B and the ITC register are read from .xls", async () => {
  const l = await readLedger(makeExcel(LEDGER), "ledger.xls");
  assert.equal(l.opening, 100000);
  assert.deepEqual(l.entries.map((e) => [e.date, e.party, e.debit, e.credit]), [["2025-04-03", "ABC Traders", 118000, 0], ["2025-04-06", "XYZ Services", 0, 25000]]);

  const sch = await readSchedule(makeExcel([["Inst No", "Due Date", "Opening Balance", "Interest", "Principal", "EMI", "Closing Balance"], [1, D("2025-05-05"), 120000, 1200, 10000, 11200, 110000]]), "schedule.xls");
  assert.deepEqual([sch.rows[0].date, sch.rows[0].installment, sch.rows[0].closing], ["2025-05-05", 11200, 110000]);

  const g2b = await readGstr2b(makeExcel([
    ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    ["27SPEED1234R1Z5", "Speedy Roadways", "G-2", "Regular", D("2025-08-06"), 23600, "27-Maharashtra", "No", 20000, 0, 1800, 1800, 0],
  ], { sheet: "B2B" }), "GSTR2B_082025.xls", { clientGstin: "27AAACA1234A1ZK" });
  assert.deepEqual([g2b.rows.length, g2b.rows[0].date, g2b.rows[0].cgst], [1, "2025-08-06", 1800]);

  const reg = await readBooksItc(makeExcel([
    ["Party Name", "GSTIN", "Invoice No", "Invoice Date", "Nature of services", "Type of charge", "Taxable Value", "GST Rate", "IGST", "CGST", "SGST", "Invoice Value"],
    ["Alpha Traders", "27AABCU9603R1ZM", "A-1", D("2025-07-10"), "Office supplies", "FCM", 1000, 18, 0, 90, 90, 1180],
  ]), "itc-register.xls");
  assert.deepEqual([reg.rows[0].party, reg.rows[0].date, reg.rows[0].cgst, reg.rows[0].charge], ["Alpha Traders", "2025-07-10", 90, "FCM"]);
});

test("the other kinds of Excel file are read too: xlsb, an old file renamed .xlsx, and an HTML or XML .xls", async () => {
  const xlsb = await readLedger(makeExcel(LEDGER, { bookType: "xlsb" }), "ledger.xlsb");
  assert.equal(xlsb.entries.length, 2);

  const renamed = await readLedger(makeExcel(LEDGER), "ledger.xlsx");
  assert.equal(renamed.entries.length, 2, "an .xls renamed to .xlsx still opens");

  // accounting and portal downloads often save an HTML table as .xls; its dates are day first and must not be guessed as month first
  const html = Buffer.from(`<html><body><table>
    <tr><th>Date</th><th>Narration</th><th>Chq./Ref.No.</th><th>Withdrawal Amt.</th><th>Deposit Amt.</th><th>Closing Balance</th></tr>
    <tr><td>01/04/2025</td><td>OPENING BALANCE</td><td></td><td></td><td></td><td>1,00,000.00</td></tr>
    <tr><td>03/04/2025</td><td>NEFT CR-ABC TRADERS</td><td>0001234</td><td></td><td>1,18,000.00</td><td>2,18,000.00</td></tr>
    <tr><td>25/04/2025</td><td>CHQ PAID</td><td>000555</td><td>(500.00)</td><td></td><td>2,17,500.00</td></tr>
  </table></body></html>`);
  const s = await readStatement(html, "tally-export.xls");
  assert.equal(s.opening, 100000);
  assert.deepEqual(s.txns.map((t) => [t.date, t.ref, t.debit, t.credit]), [["2025-04-03", "0001234", 0, 118000], ["2025-04-25", "000555", 500, 0]], "3 April is 3 April, and the leading zeros of a cheque number are kept");

  const xml = Buffer.from(`<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="S"><Table>
    <Row><Cell><Data ss:Type="String">Date</Data></Cell><Cell><Data ss:Type="String">Particulars</Data></Cell><Cell><Data ss:Type="String">Debit</Data></Cell><Cell><Data ss:Type="String">Credit</Data></Cell></Row>
    <Row><Cell><Data ss:Type="String">03/04/2025</Data></Cell><Cell><Data ss:Type="String">By ABC Traders</Data></Cell><Cell><Data ss:Type="Number">118000</Data></Cell><Cell/></Row></Table></Worksheet></Workbook>`);
  const x = await readLedger(xml, "tally.xls");
  assert.deepEqual(x.entries.map((e) => [e.date, e.party, e.debit]), [["2025-04-03", "ABC Traders", 118000]]);

  assert.ok(["a.xls", "a.XLSX", "a.xlsb", "a.xlsm", "a.csv"].every(isSheetFile));
  assert.ok(!["a.pdf", "a.docx", "a"].some(isSheetFile));
});

/* ------------------------------------------------------------------ the upload screens accept them */

let server, base, clientId;
const tokens = {};
async function api(method, url, { token, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: form });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })).json()).access_token;
  tokens.staff = await login("staff@example.com", "staff123");
  tokens.client1 = await login("client1@example.com", "client123");
  clientId = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
});
after(async () => { server.close(); await db.close(); });
const form = (fields, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [field, name, content] of files) fd.append(field, new Blob([content]), name);
  return fd;
};

test("a client uploads an .xls statement; staff upload an .xls ledger and reconcile it", async () => {
  const up = await api("POST", "/api/banking/upload", { token: tokens.client1, form: form({ section: "statement", account_number: "50100123456789", bank: "HDFC Bank", fy: "2025-26", period_from: "2025-04", period_to: "2025-06" }, [["statement", "statement.xls", makeExcel(STATEMENT)]]) });
  assert.equal(up.status, 201);
  const led = await api("POST", "/api/banking/staff/files", { token: tokens.staff, form: form({ client_id: clientId, fy: "2025-26", kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger.xls", makeExcel(LEDGER)]]) });
  assert.equal(led.status, 201, JSON.stringify(led.body));
  assert.equal(led.body.rows, 2);
  const w = await api("GET", `/api/banking/staff/working/bank?client_id=${clientId}&fy=2025-26&account=50100123456789`, { token: tokens.staff });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.deepEqual([w.body.summary.stmtLines, w.body.summary.bookLines, w.body.summary.matched], [2, 2, 1]);
});

test("the Input Reconciliation section takes .xls and .xlsb files", async () => {
  const send = (kind, name, content) => api("POST", "/api/input-recon/upload", { token: tokens.staff, form: form({ client_id: clientId, fy: "2025-26", kind }, [["files", name, content]]) });
  const a = await send("books_itc", "input-itc-ledger.xls", makeExcel(LEDGER));
  assert.deepEqual([a.body.results[0].ok, a.body.results[0].read, a.body.results[0].rows], [true, true, 2]);
  const b = await send("books_cash", "cash-ledger.xlsb", makeExcel(LEDGER, { bookType: "xlsb" }));
  assert.deepEqual([b.body.results[0].ok, b.body.results[0].read], [true, true]);
  const c = await send("gstr2b", "GSTR2B_082025.xls", makeExcel([
    ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)"],
    ["27SPEED1234R1Z5", "Speedy Roadways", "G-2", "Regular", D("2025-08-06"), 23600, "27-Maharashtra", "No", 20000, 0, 1800, 1800, 0],
  ], { sheet: "B2B" }));
  assert.deepEqual([c.body.results[0].read, c.body.results[0].rows], [true, 1]);
  const bad = await send("books_itc", "notes.docx", "x");
  assert.equal(bad.body.results[0].ok, false);
});
