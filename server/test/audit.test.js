import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-audit-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { readRequirements, readWorkbook, classify } = await import("../src/services/audit/requirementReader.js");
const { monthRanges } = await import("../src/services/audit/auditStatus.js");

let server, base, clientId, client2Id, firmId;
const tokens = {};
async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const login = async (email, password) => (await api("POST", "/api/auth/login", { json: { email, password } })).body.access_token;
before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.staff = await login("staff@example.com", "staff123");
  tokens.client1 = await login("client1@example.com", "client123");
  tokens.client2 = await login("client2@example.com", "client123");
  const mine = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0];
  clientId = mine.id;
  client2Id = (await api("GET", "/api/clients", { token: tokens.client2 })).body[0].id;
  firmId = (await db.one("select firm_id from clients where id=$1", [clientId])).firm_id;
});
after(async () => { server.close(); await db.close(); });

async function xlsxOf(rows, sheet = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const form = (fields, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [field, name, content] of files) fd.append(field, new Blob([content]), name);
  return fd;
};
const get = (q = `client_id=${clientId}&fy=2025-26`, token = tokens.staff) => api("GET", `/api/audit?${q}`, { token });
const sheetUp = (content, name = "documents-required.xlsx", token = tokens.staff) => api("POST", "/api/audit/sheet", { token, form: form({ client_id: clientId, fy: "2025-26" }, [["file", name, content]]) });
const bank = (over, token = tokens.client1) => api("POST", "/api/banking/upload", { token, form: form({ section: "statement", fy: "2025-26", ...over }, [["statement", "statement.pdf", "%PDF-1.4 statement"]]) });
const sheetText = (wb, name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };

const REQUIRED = [
  ["DOCUMENTS REQUIRED FOR STATUTORY AUDIT, FY 2025-26"], [],
  ["Sr No", "Particulars", "Frequency", "Remarks"],
  ["A. BANKING"],
  [1, "Bank statements for all bank accounts", "Monthly", "Apr-25 to Mar-26"],
  [2, "Loan sanction letter - State Bank of India", "Annual", ""],
  ["B. STATUTORY COMPLIANCE"],
  [3, "ESIC challans", "Monthly", ""],
  [4, "TDS returns (Form 24Q / 26Q)", "Quarterly", ""],
  [5, "GST returns - GSTR-3B", "Monthly", ""],
  [6, "GSTR-9 and 9C", "Annual", ""],
  [7, "Sales invoices", "Monthly", ""],
  [8, "Form 26AS", "Annual", ""],
  ["C. OTHERS"],
  [9, "Fixed asset register", "", ""],
];

test("the documents-required sheet is read whatever its layout, and recurring documents are listed period by period", async () => {
  const r = await readRequirements(await xlsxOf(REQUIRED), "x.xlsx", { fy: "2025-26", accounts: [{ account_number: "50100123456789", bank_name: "HDFC Bank" }, { account_number: "123400009876", bank_name: "ICICI Bank" }] });
  assert.equal(r.requirements, 9);
  const by = (name) => r.items.filter((i) => i.name === name);
  assert.equal(by("Bank statements for all bank accounts").length, 24, "12 months for each of the 2 accounts the client has in the system");
  assert.equal(by("ESIC challans").length, 12);
  assert.deepEqual(by("TDS returns (Form 24Q / 26Q)").map((i) => i.period_label), ["Q1 (Apr-Jun 2025)", "Q2 (Jul-Sep 2025)", "Q3 (Oct-Dec 2025)", "Q4 (Jan-Mar 2026)"]);
  assert.equal(by("GSTR-9 and 9C").length, 1, "an annual return is asked for once");
  assert.equal(by("Fixed asset register")[0].period_kind, "year");
  assert.equal(by("ESIC challans")[0].section, "B. STATUTORY COMPLIANCE");
  assert.equal(by("Loan sanction letter - State Bank of India")[0].bank_name, "State Bank of India");
  assert.deepEqual([...new Set(r.items.map((i) => i.category))].sort(), ["bank_statement", "esic", "books", "form26as", "gst_return", "invoices", "loan", "tds_return"].map((c) => (c === "books" ? "fixed_assets" : c)).sort());

  // a bank account named in the line, and a period given in the line
  const named = await readRequirements(await xlsxOf([["Documents"], ["HDFC Bank current account 50100123456789 statement for Apr-25 to Jun-25"], ["PF challans for Oct 2025 to Dec 2025"]]), "y.csv".replace("csv", "xlsx"), { fy: "2025-26" });
  const stmts = named.items.filter((i) => i.category === "bank_statement");
  assert.deepEqual([stmts.length, stmts[0].account_number, stmts[0].bank_name, stmts.map((i) => i.period_label).join()], [3, "50100123456789", "HDFC Bank", "Apr-25,May-25,Jun-25"]);
  assert.deepEqual(named.items.filter((i) => i.category === "pf").map((i) => i.period_label), ["Oct-25", "Nov-25", "Dec-25"]);

  // no heading row: the column with the text is the list
  const bare = await readRequirements(await xlsxOf([["ESIC challans - monthly"], ["TDS returns quarterly"], ["Audited financial statements of the last year"]]), "z.xlsx", { fy: "2025-26" });
  assert.deepEqual([bare.requirements, bare.items.length], [3, 12 + 4 + 1]);
  await assert.rejects(readRequirements(await xlsxOf([[], []]), "w.xlsx", { fy: "2025-26" }), /No audit checklist or documents were found/);
  await assert.rejects(readRequirements(Buffer.from("x"), "w.pdf", { fy: "2025-26" }), /Excel file/);
  assert.equal(classify("TDS returns").category, "tds_return");
  assert.equal(classify("Loan account statement").category, "loan");
  assert.deepEqual(monthRanges(["2025-04", "2025-05", "2025-06", "2025-08", "2026-01", "2026-02", "2026-03"]), ["Apr-25 to Jun-25", "Aug-25", "Jan-26 to Mar-26"]);
});

test("the checklist shows what the system already holds from the client's other sections, and the rest as pending", async () => {
  assert.equal((await sheetUp(await xlsxOf(REQUIRED), "d.xlsx", tokens.client1)).status, 403);
  // given under Banking: HDFC for Apr to Jun, ICICI for the whole year, and a loan sanction letter
  assert.equal((await bank({ account_number: "50100123456789", bank: "HDFC Bank", period_from: "2025-04", period_to: "2025-06" })).status, 201);
  assert.equal((await bank({ account_number: "123400009876", bank: "ICICI Bank", period_from: "2025-04", period_to: "2026-03" })).status, 201);
  assert.equal((await api("POST", "/api/banking/upload", { token: tokens.client1, form: form({ section: "loan", account_number: "LN-778899", bank: "State Bank of India", fy: "2025-26" }, [["sanction_letter", "sanction.pdf", "sanction"], ["repayment_schedule", "schedule.xlsx", "schedule"]]) })).status, 201);
  // held by the CA firm: GSTR-3B of August, a sales invoice of May, Form 26AS
  const gstr3b = await xlsxOf([["Form GSTR-3B"], ["3.1 Details of Outward Supplies and inward supplies liable to reverse charge"], ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", 100000, 0, 9000, 9000, 0], ["(b) Outward taxable supplies (zero rated)", 0, 0, 0, 0, 0], ["(c) Other outward supplies (Nil rated, exempted)", 0, 0, 0, 0, 0], ["(d) Inward supplies (liable to reverse charge)", 0, 0, 0, 0, 0], ["(e) Non-GST outward supplies", 0, 0, 0, 0, 0], ["4. Eligible ITC"], ["(5) All other ITC", 0, 0, 0, 0]], "GSTR-3B");
  assert.equal((await api("POST", "/api/input-recon/upload", { token: tokens.staff, form: form({ client_id: clientId, fy: "2025-26", kind: "gstr3b" }, [["files", "GSTR3B_Aug-2025.xlsx", gstr3b]]) })).body.results[0].read, true);
  await db.query("insert into invoices (firm_id, client_id, invoice_type, tax_period, review_status) values ($1,$2,'sales','2025-05','confirmed')", [firmId, clientId]);
  await db.query("insert into banking_staff_files (firm_id, client_id, fy, kind, original_filename, storage_path, mime_type, file_hash) values ($1,$2,'2025-26','form_26as','26as.pdf','x/26as.pdf','application/pdf','abc')", [firmId, clientId]);

  const up = await sheetUp(await xlsxOf(REQUIRED));
  assert.equal(up.status, 201);
  assert.equal(up.body.items, 24 + 1 + 12 + 4 + 12 + 1 + 12 + 1 + 1, "bank statements for the 2 accounts, the loan, ESIC, TDS returns, GSTR-3B, GSTR-9, sales invoices, 26AS, fixed assets");
  const c = up.body.checklist;
  assert.equal(c.status, "draft");
  const t = c.summary.totals;
  assert.deepEqual([t.items, t.received, t.pending, t.documents], [68, 3 + 12 + 1 + 1 + 1 + 1, 68 - 19, 10]);
  assert.deepEqual(c.summary.bySource, { Banking: 3 + 12 + 1 + 1, "GST returns on file": 1, "Invoices uploaded": 1 });

  const g = Object.fromEntries(c.summary.groups.map((x) => [`${x.name}|${x.bank}`, x]));
  const hdfc = g["Bank statements for all bank accounts|HDFC Bank"], icici = g["Bank statements for all bank accounts|ICICI Bank"];
  assert.deepEqual([hdfc.received, hdfc.pending, hdfc.pendingText, hdfc.state], [3, 9, "Jul-25 to Mar-26", "partial"]);
  assert.deepEqual([icici.received, icici.pending, icici.state], [12, 0, "complete"]);
  assert.equal(g["ESIC challans|"].pendingText, "Apr-25 to Mar-26");
  assert.equal(g["ESIC challans|"].state, "pending");
  assert.equal(g["GST returns - GSTR-3B|"].pendingText, "Apr-25 to Jul-25, Sep-25 to Mar-26", "August is on file");
  assert.equal(g["Sales invoices|"].pendingText, "Apr-25, Jun-25 to Mar-26");
  assert.equal(g["Form 26AS|"].state, "complete");
  assert.equal(g["Loan sanction letter - State Bank of India|State Bank of India"].state, "complete");
  assert.equal(g["TDS returns (Form 24Q / 26Q)|"].pendingText, "Q1 (Apr-Jun 2025), Q2 (Jul-Sep 2025), Q3 (Oct-Dec 2025), Q4 (Jan-Mar 2026)");
  const aug = c.states.find((s) => s.name === "GST returns - GSTR-3B" && s.periodLabel === "Aug-25");
  assert.deepEqual([aug.status, aug.source], ["received", "GST returns on file"]);

  // the client sees nothing until the CA firm sends it
  const hidden = (await get(`client_id=${clientId}`, tokens.client1)).body;
  assert.deepEqual([hidden.checklist, hidden.years], [null, []]);
  assert.equal((await get(`client_id=${clientId}&fy=2025-26`, tokens.client2)).status, 403);
});

test("the CA firm sends the checklist, the client uploads against a pending document, and uploads elsewhere update the list", async () => {
  assert.equal((await api("POST", "/api/audit/send", { token: tokens.client1, json: { client_id: clientId, fy: "2025-26" } })).status, 403);
  const sent = await api("POST", "/api/audit/send", { token: tokens.staff, json: { client_id: clientId, fy: "2025-26" } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.checklist.status, "sent");
  const note = (await api("GET", "/api/notifications", { token: tokens.client1 })).body.notifications.find((n) => n.kind === "audit_checklist");
  assert.match(note.title, /Audit documents needed for FY 2025-26/);
  assert.match(note.body, /49 of 68 documents are pending/);
  assert.equal(note.link, "/audit-documents");

  // the client's own view
  const mine = (await get(`client_id=${clientId}`, tokens.client1)).body;
  assert.deepEqual([mine.fy, mine.years, mine.checklist.summary.totals.pending], ["2025-26", [{ fy: "2025-26", status: "sent" }], 49]);
  const esicApr = mine.checklist.states.find((s) => s.name === "ESIC challans" && s.periodLabel === "Apr-25");
  assert.equal(esicApr.status, "pending");

  // an upload beside the document
  assert.equal((await api("POST", `/api/audit/items/${esicApr.id}/upload`, { token: tokens.client1, form: form({}, [["files", "malware.exe", "x"]]) })).status, 400);
  assert.equal((await api("POST", `/api/audit/items/${esicApr.id}/upload`, { token: tokens.client2, form: form({}, [["files", "esic-apr.pdf", "%PDF esic"]]) })).status, 404, "another client cannot upload against this client's document");
  const up = await api("POST", `/api/audit/items/${esicApr.id}/upload`, { token: tokens.client1, form: form({}, [["files", "esic-apr.pdf", "%PDF esic apr"]]) });
  assert.deepEqual([up.status, up.body.uploaded], [201, 1]);
  assert.equal((await api("POST", `/api/audit/items/${esicApr.id}/upload`, { token: tokens.client1, form: form({}, [["files", "again.pdf", "%PDF esic apr"]]) })).body.skipped, 1, "the same file twice is kept once");

  let after = (await get(`client_id=${clientId}&fy=2025-26`, tokens.client1)).body.checklist;
  const apr = after.states.find((s) => s.id === esicApr.id);
  assert.deepEqual([apr.status, apr.source, apr.files.length, apr.files[0].name, apr.files[0].role], ["received", "Audit Documents", 1, "esic-apr.pdf", "client"]);
  assert.equal(after.summary.totals.pending, 48);
  assert.equal(after.summary.groups.find((x) => x.name === "ESIC challans").pendingText, "May-25 to Mar-26");
  const staffNote = (await api("GET", "/api/notifications", { token: tokens.staff })).body.notifications.find((n) => n.kind === "audit_upload");
  assert.match(staffNote.title, /uploaded 1 file\(s\) for the audit/);

  // the client downloads their file; another client cannot; the client takes it back
  const fid = apr.files[0].id;
  const dl = await api("GET", `/api/audit/files/${fid}/download`, { token: tokens.client1 });
  assert.equal(dl.status, 200);
  assert.equal(dl.body.toString(), "%PDF esic apr");
  assert.equal((await api("GET", `/api/audit/files/${fid}/download`, { token: tokens.client2 })).status, 404);
  assert.equal((await api("GET", `/api/audit/files/${fid}/download`, { token: tokens.staff })).status, 200);
  after = (await get(`client_id=${clientId}&fy=2025-26`, tokens.client1)).body.checklist;
  assert.equal((await api("DELETE", `/api/audit/files/${after.states.find((s) => s.id === esicApr.id).files[0].id}`, { token: tokens.client1 })).status, 200);

  // the client now gives the HDFC statement for July to September under Banking: the checklist is updated without touching it
  assert.equal((await bank({ account_number: "50100123456789", bank: "HDFC Bank", period_from: "2025-07", period_to: "2025-09" })).status, 201);
  after = (await get(`client_id=${clientId}&fy=2025-26`, tokens.client1)).body.checklist;
  const hdfc = after.summary.groups.find((x) => x.bank === "HDFC Bank");
  assert.deepEqual([hdfc.received, hdfc.pendingText], [6, "Oct-25 to Mar-26"]);
  assert.equal(after.summary.totals.pending, 49 - 3, "ESIC April was taken back, so only the three HDFC months are new");
  assert.equal(after.states.find((s) => s.name === "Bank statements for all bank accounts" && s.bank === "HDFC Bank" && s.periodLabel === "Jul-25").source, "Banking");
});

test("the CA firm marks documents, replaces the sheet without losing the client's files, and downloads the pending list", async () => {
  const state = (await get()).body.checklist;
  const fixed = state.states.find((s) => s.name === "Fixed asset register");
  assert.equal((await api("PUT", `/api/audit/items/${fixed.id}`, { token: tokens.client1, json: { manual: "na" } })).status, 403);
  assert.equal((await api("PUT", `/api/audit/items/${fixed.id}`, { token: tokens.staff, json: { manual: "maybe" } })).status, 422);
  assert.equal((await api("PUT", `/api/audit/items/${fixed.id}`, { token: tokens.staff, json: { manual: "na" } })).status, 200);
  assert.equal((await api("PUT", "/api/audit/documents", { token: tokens.staff, json: { client_id: clientId, fy: "2025-26", req_no: 3, manual: "received" } })).status, 200);
  let c = (await get()).body.checklist;
  assert.equal(c.states.find((s) => s.id === fixed.id).status, "na");
  assert.deepEqual([c.summary.groups.find((x) => x.name === "ESIC challans").state, c.summary.groups.find((x) => x.name === "ESIC challans").pending], ["complete", 0]);
  assert.equal((await api("POST", `/api/audit/items/${fixed.id}/upload`, { token: tokens.client1, form: form({}, [["files", "assets.xlsx", "x"]]) })).status, 409);

  // a client's file on a TDS return stays with it when the sheet is replaced by a longer one
  const q1 = c.states.find((s) => s.name.startsWith("TDS returns") && s.periodLabel.startsWith("Q1"));
  assert.equal((await api("POST", `/api/audit/items/${q1.id}/upload`, { token: tokens.client1, form: form({}, [["files", "24q-q1.pdf", "%PDF 24q"]]) })).status, 201);
  const longer = await sheetUp(await xlsxOf([...REQUIRED, [10, "Professional tax challans", "Monthly", ""]]));
  assert.equal(longer.status, 201);
  assert.equal(longer.body.checklist.status, "sent", "a replaced sheet does not make the checklist a draft again");
  c = longer.body.checklist;
  assert.equal(c.summary.totals.items, 68 + 12);
  assert.equal(c.states.find((s) => s.name.startsWith("TDS returns") && s.periodLabel.startsWith("Q1")).files[0].name, "24q-q1.pdf");
  assert.equal(c.states.find((s) => s.name === "Fixed asset register").status, "na", "the CA firm's mark stays");
  assert.equal(c.summary.groups.find((x) => x.name === "ESIC challans").state, "complete");

  const x = await api("GET", `/api/audit/export?client_id=${clientId}&fy=2025-26`, { token: tokens.staff });
  assert.equal(x.status, 200);
  assert.equal((await api("GET", `/api/audit/export?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Pending Documents", "2 Checklist Status", "3 All Items"]);
  const s1 = sheetText(wb, "1 Pending Documents");
  assert.match(s1, /Section \| Document \| Kind \| Asked for \| Uploaded \| Pending \| Pending for/);
  assert.match(s1, /Bank statements for all bank accounts \(HDFC Bank xxxx6789\) \| Bank statements \| 12 \| 6 \| 6 \| Oct-25 to Mar-26/);
  assert.match(s1, /Professional tax challans \| Professional tax \| 12 \| 0 \| 12 \| Apr-25 to Mar-26/);
  assert.doesNotMatch(s1, /ICICI/, "a complete document is not listed as pending");
  assert.match(sheetText(wb, "3 All Items"), /ESIC challans \| Apr-25 \|.* \| Uploaded \| CA firm/);

  // the sheet and its client files go when the checklist is deleted
  assert.equal((await api("DELETE", `/api/audit?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).status, 200);
  assert.equal((await get()).body.checklist, null);
  assert.equal((await db.query("select id from audit_files")).length, 0);
  assert.equal((await get(`client_id=${clientId}`, tokens.client1)).body.years.length, 0);
  assert.equal((await api("POST", "/api/audit/sheet", { token: tokens.staff, form: form({ client_id: clientId, fy: "2025-26" }, [["file", "bad.pdf", "%PDF"]]) })).status, 422);
  void client2Id;
});

// ---------------------------------------------------------------------------------------------- the audit checklist workbook

/** A workbook of several sheets: { "Sheet name": rows | { rows, merges: ["A1:E1"] } }. */
async function bookOf(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, def] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    (Array.isArray(def) ? def : def.rows).forEach((r) => ws.addRow(r));
    for (const m of def.merges || []) ws.mergeCells(m);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PROGRAMME = [
  ["AUDIT CHECKLIST FY 2025-26"], [],
  ["Sr No", "Audit point", "Procedure", "Remarks"],
  ["A. OPENING BALANCES"],
  [1, "Verify that the opening balances agree with the audited balance sheet of the previous year", "Compare every ledger with the closing balance of last year", ""],
  [2, "Check the opening balances of debtors and creditors", "", ""],
  ["B. BANK"],
  [3, "Reconcile the bank balances with the bank statements", "", ""],
  [4, "Confirm that a bank reconciliation statement is prepared for every account", "", ""],
  ["C. FIXED ASSETS"],
  [5, "Vouch the additions to fixed assets", "", "Above Rs 50,000"],
];

test("the documents required are read from harder layouts: details, merged headings, several documents in a cell, a column for each month", async () => {
  const docs = {
    rows: [
      ["List of documents required for audit FY 2025-26"],
      ["S.No", "Particulars", "Details", "Period", "Remarks"],
      ["Statutory dues"],
      [1, "ESIC challans", "Challan with the payment receipt", "Monthly", ""],
      [2, "TDS returns\n24Q\n26Q", "Acknowledgement of each return", "Quarterly", ""],
      [3, "1. Sales register\n2. Purchase register", "", "Monthly", "Tally export"],
      [4, "Bank statements:\n- HDFC Bank 50100123456789\n- ICICI Bank 123400009876", "", "Apr-25 to Mar-26", ""],
      ["Others"],
      [5, "Fixed asset register", "With the additions during the year", "", ""],
    ],
    merges: ["A1:E1", "A3:E3"],
  };
  const r = await readWorkbook(await bookOf({ "Documents Required": docs }), "docs.xlsx", { fy: "2025-26" });
  assert.equal(r.requirements, 7);
  const by = (name) => r.items.filter((i) => i.name === name);
  assert.equal(by("ESIC challans").length, 12);
  assert.equal(by("ESIC challans")[0].section, "Statutory dues", "a heading merged across the sheet is a heading, not a document");
  assert.equal(by("ESIC challans")[0].note, "Challan with the payment receipt", "the details column is kept with the document");
  assert.equal(r.items.filter((i) => i.category === "tds_return").length, 4, "the lines of a cell that are only parts of one name are not split");
  assert.equal(by("Sales register").length, 12);
  assert.equal(by("Purchase register").length, 12);
  assert.equal(by("Purchase register")[0].note, "Tally export");
  const hdfc = r.items.filter((i) => i.bank_name === "HDFC Bank");
  assert.deepEqual([hdfc.length, hdfc[0].account_number], [12, "50100123456789"], "bulleted lines under a lead-in are separate bank statements");
  assert.equal(r.items.filter((i) => i.bank_name === "ICICI Bank").length, 12);
  assert.deepEqual([by("Fixed asset register").length, by("Fixed asset register")[0].section], [1, "Others"]);
  assert.deepEqual(r.sheets.map((s) => [s.name, s.role, s.lines, s.column]), [["Documents Required", "documents", 7, "Particulars"]]);

  // a column for every month: NA drops a month, and a yearly document stays yearly
  const months = ["Apr-25", "May-25", "Jun-25", "Jul-25", "Aug-25", "Sep-25", "Oct-25", "Nov-25", "Dec-25", "Jan-26", "Feb-26", "Mar-26"];
  const blank = months.map(() => "");
  const grid = await bookOf({ Documents: [["Documents", ...months], ["PF challans", ...blank], ["ESIC challans", ...blank.slice(0, 10), "NA", "NA"], ["Fixed asset register", ...blank]] });
  const m = await readWorkbook(grid, "grid.xlsx", { fy: "2025-26" });
  assert.deepEqual(["PF challans", "ESIC challans", "Fixed asset register"].map((n) => m.items.filter((i) => i.name === n).length), [12, 10, 1]);

  // headings only in a different column, no heading row, a requirement written with a bullet
  const plain = await readWorkbook(await bookOf({ Sheet1: [["a) Provident fund challans - monthly"], ["b) Audited financial statements of the last year"]] }), "plain.xlsx", { fy: "2025-26" });
  assert.deepEqual([plain.requirements, plain.items.length, plain.items[0].name], [2, 13, "Provident fund challans - monthly"]);
});

test("the first sheet is the audit programme and the second the documents required, found by name or by position", async () => {
  const docs = [["Particulars", "Frequency"], ["ESIC challans", "Monthly"], ["Fixed asset register", "Annual"]];
  for (const names of [["Audit Checklist", "Documents Required"], ["Sheet1", "Sheet2"], ["Documents Required", "Audit Checklist"]]) {
    const sheets = names[0] === "Documents Required" ? { [names[0]]: docs, [names[1]]: PROGRAMME } : { [names[0]]: PROGRAMME, [names[1]]: docs };
    const r = await readWorkbook(await bookOf(sheets), "audit.xlsx", { fy: "2025-26" });
    assert.deepEqual([r.points.length, r.requirements, r.items.length], [5, 2, 13], names.join(" / "));
    assert.deepEqual(r.sheets.map((s) => s.role).sort(), ["documents", "programme"]);
  }
  const r = await readWorkbook(await bookOf({ "Audit Checklist": PROGRAMME, "Documents Required": docs }), "audit.xlsx", { fy: "2025-26" });
  assert.deepEqual(r.points.map((p) => [p.ref, p.section, p.name.slice(0, 30)]).slice(0, 3), [["1", "A. OPENING BALANCES", "Verify that the opening balanc"], ["2", "A. OPENING BALANCES", "Check the opening balances of "], ["3", "B. BANK", "Reconcile the bank balances wi"]]);
  assert.equal(r.points[0].detail, "Compare every ledger with the closing balance of last year");
  assert.equal(r.points[4].detail, "Above Rs 50,000");
  // a workbook with one sheet: instructions to the auditor are the programme, a list of documents is the documents
  const only = await readWorkbook(await bookOf({ Sheet1: PROGRAMME }), "p.xlsx", { fy: "2025-26" });
  assert.deepEqual([only.points.length, only.items.length], [5, 0]);
  assert.match(only.warnings.join(" "), /no list of documents required/);
  const onlyDocs = await readWorkbook(await bookOf({ Sheet1: docs }), "d.xlsx", { fy: "2025-26" });
  assert.deepEqual([onlyDocs.points.length, onlyDocs.items.length], [0, 13]);
});

test("the audit programme: the CA firm checks points and raises queries, the client replies, and the thread is kept", async () => {
  const book = await bookOf({ "Audit Checklist": PROGRAMME, "Documents Required": [["Particulars", "Frequency"], ["ESIC challans", "Monthly"], ["Fixed asset register", "Annual"]] });
  const up = await sheetUp(book, "audit-checklist.xlsx");
  assert.equal(up.status, 201);
  assert.deepEqual([up.body.points, up.body.items], [5, 13]);
  let c = up.body.checklist;
  assert.equal(c.status, "draft");
  assert.deepEqual(c.programme, { points: 5, checked: 0, pending: 5, query: 0, awaitingClient: 0, awaitingStaff: 0 });
  assert.deepEqual(c.readInfo.map((s) => [s.name, s.role, s.lines]), [["Audit Checklist", "programme", 5], ["Documents Required", "documents", 2]]);
  const [p1, p2, p3] = c.points;

  // the client sees nothing before the checklist is sent, and a query cannot be raised until the client can see it
  assert.deepEqual((await get(`client_id=${clientId}`, tokens.client1)).body.checklist, null);
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.staff, json: { body: "Please explain" } })).status, 409);
  assert.equal((await api("PUT", `/api/audit/points/${p1.id}`, { token: tokens.client1, json: { status: "checked" } })).status, 403);
  assert.equal((await api("PUT", `/api/audit/points/${p1.id}`, { token: tokens.staff, json: { status: "done" } })).status, 422);
  assert.equal((await api("PUT", `/api/audit/points/${p2.id}`, { token: tokens.staff, json: { status: "checked" } })).status, 200);
  assert.equal((await api("POST", "/api/audit/send", { token: tokens.staff, json: { client_id: clientId, fy: "2025-26" } })).status, 200);

  // a query on the opening balances: the point goes to query and waits for the client
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.staff, json: { body: "  " } })).status, 422);
  const asked = await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.staff, json: { body: "The opening balance of Sundry Debtors differs by Rs 12,000 from last year's balance sheet. Please explain." } });
  assert.equal(asked.status, 201);
  c = (await get()).body.checklist;
  assert.deepEqual(c.programme, { points: 5, checked: 1, pending: 3, query: 1, awaitingClient: 1, awaitingStaff: 0 });
  assert.deepEqual([c.points[0].status, c.points[0].awaiting, c.points[0].queries.length, c.points[0].queries[0].role], ["query", "client", 1, "staff"]);
  const queryNote = (await api("GET", "/api/notifications", { token: tokens.client1 })).body.notifications.find((n) => n.kind === "audit_query");
  assert.match(queryNote.title, /Query from your CA firm on the audit: Verify that the opening balances/);
  assert.equal(queryNote.link, "/audit-documents");

  // the client sees only the point that has a query, and replies against it
  const mine = (await get(`client_id=${clientId}&fy=2025-26`, tokens.client1)).body.checklist;
  assert.deepEqual([mine.points.length, mine.points[0].name.slice(0, 20), mine.points[0].queries[0].body.slice(0, 26), mine.programme], [1, "Verify that the open", "The opening balance of Sun", null]);
  assert.equal((await api("POST", `/api/audit/points/${p3.id}/queries`, { token: tokens.client1, json: { body: "hello" } })).status, 404, "no reply on a point with no query");
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.client2, json: { body: "x" } })).status, 404, "another client cannot reply");
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.client1, json: { body: "x".repeat(2001) } })).status, 422);
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.client1, json: { body: "The difference is the reversal of an old provision. The journal voucher is attached under Fixed asset register." } })).status, 201);
  c = (await get()).body.checklist;
  assert.deepEqual([c.points[0].awaiting, c.points[0].queries.map((q) => q.role)], ["staff", ["staff", "client"]]);
  assert.deepEqual([c.programme.awaitingClient, c.programme.awaitingStaff], [0, 1]);
  const replyNote = (await api("GET", "/api/notifications", { token: tokens.staff })).body.notifications.find((n) => n.kind === "audit_reply");
  assert.match(replyNote.title, /replied to a query on the audit/);

  // the CA firm asks again, then marks the point checked: the client can no longer reply
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.staff, json: { body: "Please send the journal voucher." } })).status, 201);
  assert.equal((await api("PUT", `/api/audit/points/${p1.id}`, { token: tokens.staff, json: { status: "checked" } })).status, 200);
  assert.equal((await api("POST", `/api/audit/points/${p1.id}/queries`, { token: tokens.client1, json: { body: "Sent" } })).status, 409);
  c = (await get(`client_id=${clientId}&fy=2025-26`, tokens.client1)).body.checklist;
  assert.deepEqual([c.points[0].status, c.points[0].queries.length], ["checked", 3], "the whole thread stays visible to the client");

  // a query written by mistake is taken back; a point left with no query goes back to pending
  const [p4] = (await get()).body.checklist.points.filter((p) => p.seq === 4);
  const q4 = await api("POST", `/api/audit/points/${p4.id}/queries`, { token: tokens.staff, json: { body: "Wrong point" } });
  assert.equal((await api("DELETE", `/api/audit/queries/${q4.body.id}`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("DELETE", `/api/audit/queries/${q4.body.id}`, { token: tokens.staff })).status, 200);
  assert.equal((await get()).body.checklist.points.find((p) => p.seq === 4).status, "pending");

  // replacing the workbook keeps the status of each point and the thread on it
  const again = await sheetUp(book, "audit-checklist-v2.xlsx");
  assert.equal(again.status, 201);
  const kept = again.body.checklist;
  assert.deepEqual(kept.points.map((p) => [p.status, p.queries.length]), [["checked", 3], ["checked", 0], ["pending", 0], ["pending", 0], ["pending", 0]]);
  assert.equal(kept.status, "sent");

  // the Excel carries the programme and every query and reply
  const x = await api("GET", `/api/audit/export?client_id=${clientId}&fy=2025-26`, { token: tokens.staff });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Pending Documents", "2 Checklist Status", "3 All Items", "4 Audit Programme", "5 Queries and Replies"]);
  const prog = sheetText(wb, "4 Audit Programme");
  assert.match(prog, /5 points: 2 checked, 3 pending, 0 with a query/);
  assert.match(prog, /A\. OPENING BALANCES \| Verify that the opening balances.* \| Checked \|/);
  const thread = sheetText(wb, "5 Queries and Replies");
  assert.match(thread, /Client \| .* \| The difference is the reversal of an old provision/);
  assert.match(thread, /CA firm \| .* \| Please send the journal voucher\./);

  assert.equal((await api("DELETE", `/api/audit?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).status, 200);
  assert.deepEqual([(await db.query("select id from audit_points")).length, (await db.query("select id from audit_queries")).length], [0, 0]);
});
