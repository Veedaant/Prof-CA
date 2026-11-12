import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-bankstaff-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { readFile } = await import("../src/services/storage.js");

let server, base;
const tokens = {};
async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body, headers: res.headers };
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
});
after(async () => { server.close(); await db.close(); });

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const form = (fields, files = []) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [field, name, content] of files) fd.append(field, new Blob([content]), name);
  return fd;
};

const STATEMENT = [
  ["Date", "Narration", "Chq./Ref.No.", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["01/04/2025", "OPENING BALANCE", "", "", "", 100000],
  ["03/04/2025", "NEFT CR-ABC TRADERS PVT LTD", "000123456", "", 118000, 218000],
  ["30/04/2025", "SMS CHARGES Q1", "", 17.7, "", 217982.3],
];
const LEDGER = [
  ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  ["01-04-2025", "Opening Balance", "", "", 100000, ""],
  ["03-04-2025", "By ABC Traders Pvt Ltd", "Receipt", "11", 118000, ""],
];
const SCHEDULE = [
  ["Inst No", "Due Date", "Opening Balance", "Interest", "Principal", "EMI", "Closing Balance"],
  [1, "05-05-2025", 120000, 1200, 10000, 11200, 110000],
  [2, "05-06-2025", 110000, 1100, 10000, 11100, 100000],
];
const LOAN_LEDGER = [
  ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  ["01-04-2025", "Opening Balance", "", "", "", 120000],
  ["30-05-2025", "By Interest on Term Loan", "Journal", "1", "", 1200],
  ["30-05-2025", "To HDFC Bank", "Payment", "2", 11200, ""],
];

let client1Id, loanId;

test("the client uploads a statement, a loan and an invoice for the remarks", async () => {
  client1Id = (await api("GET", "/api/banking", { token: tokens.client1 })).body.client.id;
  const stmt = await api("POST", "/api/banking/upload", { token: tokens.client1, form: form({ section: "statement", account_number: "50100123456789", bank: "HDFC Bank", fy: "2025-26", period_from: "2025-04", period_to: "2025-06" }, [["statement", "stmt.xlsx", await xlsx(STATEMENT)]]) });
  assert.equal(stmt.status, 201);
  const loan = await api("POST", "/api/banking/upload", { token: tokens.client1, form: form({ section: "loan", account_number: "4455", bank: "HDFC Bank", fy: "2025-26" }, [["sanction_letter", "sanction.pdf", "not really a pdf"], ["repayment_schedule", "schedule.xlsx", await xlsx(SCHEDULE)]]) });
  assert.equal(loan.status, 201);
  await db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, buyer_name, invoice_number, invoice_date, invoice_total, total_taxable_value, review_status)
     select firm_id, id, 'sales', 'gstr1', 'ABC Traders Pvt Ltd', 'INV-101', '2025-04-01', 118000, 100000, 'approved' from clients where id=$1`, [client1Id]);
});

test("only the CA firm can use the staff endpoints", async () => {
  for (const [m, u] of [["GET", `/api/banking/staff/overview?client_id=${client1Id}`], ["GET", `/api/banking/staff/working/bank?client_id=${client1Id}&fy=2025-26&account=50100123456789`], ["GET", `/api/banking/staff/working/loan?client_id=${client1Id}&fy=2025-26`]]) {
    assert.equal((await api(m, u, { token: tokens.client1 })).status, 403, u);
    assert.equal((await api(m, u)).status, 401, u);
  }
});

test("staff see the account and the loan, then upload the ledgers, 26AS and TIS", async () => {
  const o = (await api("GET", `/api/banking/staff/overview?client_id=${client1Id}`, { token: tokens.staff })).body;
  assert.deepEqual(o.files, [], "no ledger, 26AS or TIS yet");
  assert.equal(o.statement_files.length, 1);
  assert.equal(o.statement_files[0].name, "stmt.xlsx");
  assert.deepEqual([o.loans.length, o.loans[0].fy, o.loans[0].account_number, o.loans[0].schedule_rows], [1, "2025-26", "4455", 2]);
  loanId = o.loans[0].id;
  assert.ok(o.loans[0].warnings.some((w) => /sanction letter/.test(w)), "an unreadable sanction letter is reported");

  const up = (fields, files, token = tokens.staff) => api("POST", "/api/banking/staff/files", { token, form: form({ client_id: client1Id, fy: "2025-26", ...fields }, files) });
  assert.equal((await up({ kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger.xlsx", await xlsx(LEDGER)]], tokens.client1)).status, 403);
  assert.equal((await up({ kind: "bank_ledger", account_number: "999999" }, [["file", "ledger.xlsx", await xlsx(LEDGER)]])).status, 422, "an account the client has not uploaded");
  assert.equal((await up({ kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger.pdf", "x"]])).status, 400);
  const bad = await up({ kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger.xlsx", await xlsx([["nothing"]])]]);
  assert.equal(bad.status, 422);
  assert.match(bad.body.detail, /No ledger table found/);
  assert.equal((await up({ kind: "nonsense" }, [["file", "a.xlsx", "x"]])).status, 422);

  const good = await up({ kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger.xlsx", await xlsx(LEDGER)]]);
  assert.equal(good.status, 201);
  assert.equal(good.body.rows, 1);
  const again = await up({ kind: "bank_ledger", account_number: "50100123456789" }, [["file", "ledger2.xlsx", await xlsx(LEDGER)]]);
  assert.equal(again.body.replaced, 1, "a new ledger for the same account replaces the old one");
  assert.equal((await db.one("select count(*)::int as n from banking_staff_files where kind='bank_ledger'")).n, 1);

  const a26 = await up({ kind: "form_26as" }, [["file", "26as.txt", "1 ABC TRADERS PRIVATE LIMITED MUMA12345B 236,000.00 4,720.00 4,720.00\n   1 194C 28-Feb-2025 F 15-Mar-2025 - 118,000.00 2,360.00 2,360.00"]]);
  assert.equal(a26.status, 201);
  assert.equal((await up({ kind: "tis" }, [["file", "tis.txt", "Interest from savings bank  HDFC BANK  1,250  1,250"]])).status, 201);
  assert.equal((await up({ kind: "tis" }, [["file", "tis.txt", "nothing useful"]])).status, 422);
  assert.equal((await up({ kind: "loan_ledger", account_number: "4455" }, [["file", "loan-ledger.xlsx", await xlsx(LOAN_LEDGER)]])).status, 201);
  assert.equal((await up({ kind: "loan_ledger", account_number: "50100123456789" }, [["file", "x.xlsx", await xlsx(LOAN_LEDGER)]])).status, 422, "a bank account is not a loan");

  const after = (await api("GET", `/api/banking/staff/overview?client_id=${client1Id}`, { token: tokens.staff })).body;
  const byKind = Object.fromEntries(after.files.map((f) => [f.kind, f]));
  assert.deepEqual([byKind.bank_ledger.name, byKind.bank_ledger.fy, byKind.bank_ledger.account_number], ["ledger2.xlsx", "2025-26", "50100123456789"]);
  assert.ok(byKind.form_26as && byKind.tis);
  assert.deepEqual([byKind.loan_ledger.name, byKind.loan_ledger.account_number], ["loan-ledger.xlsx", "4455"]);
});

test("the bank working is prepared and downloaded as Excel", async () => {
  const q = `client_id=${client1Id}&fy=2025-26&account=50100123456789`;
  const w = (await api("GET", `/api/banking/staff/working/bank?${q}`, { token: tokens.staff })).body;
  assert.equal(w.has_ledger, true);
  assert.deepEqual([w.summary.stmtLines, w.summary.bookLines, w.summary.matched, w.summary.stmtOnly], [2, 1, 1, 1]);
  assert.equal(w.months.find((m) => m.month === "2025-04").diff.close, -17.7);
  assert.equal(w.recons.length, 1);

  const x = await api("GET", `/api/banking/staff/working/bank/excel?${q}`, { token: tokens.staff });
  assert.equal(x.status, 200);
  assert.match(x.headers.get("content-disposition"), /^attachment; filename="Bank_working_50100123456789_2025-26_Apex/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Bank Statement", "2 Bank Ledger", "3 Bank Reconciliation", "Recon Apr-25", "Notes"]);
  let remark = "";
  wb.getWorksheet("1 Bank Statement").eachRow((r) => { const t = r.values.join(" "); if (/ABC TRADERS/.test(t)) remark = t; });
  assert.match(remark, /Receipt from ABC Traders Pvt Ltd.*sales invoice INV-101/);
  assert.match(remark, /26AS shows TDS of Rs 2,360.00/);

  assert.equal((await api("GET", `/api/banking/staff/working/bank?client_id=${client1Id}&fy=2025-26&account=000000`, { token: tokens.staff })).status, 409);
  assert.equal((await api("GET", `/api/banking/staff/working/bank?client_id=${client1Id}&fy=2024-25&account=50100123456789`, { token: tokens.staff })).status, 409);
});

test("the loan details are saved and the loan working is prepared and downloaded", async () => {
  const put = await api("PUT", `/api/banking/staff/loans/${loanId}/details`, { token: tokens.staff, json: { loan_type: "Term loan", interest_rate: "12", sanctioned_amount: "1,20,000", security: "Hypothecation of plant", guarantee: "", sanction_date: "2025-04-10" } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.details, { loan_type: "Term loan", interest_rate: 12, sanctioned_amount: 120000, security: "Hypothecation of plant", sanction_date: "2025-04-10" });
  assert.equal((await api("PUT", `/api/banking/staff/loans/${loanId}/details`, { token: tokens.staff, json: { interest_rate: "abc" } })).status, 422);
  assert.equal((await api("PUT", `/api/banking/staff/loans/${loanId}/details`, { token: tokens.client1, json: {} })).status, 403);

  const q = `client_id=${client1Id}&fy=2025-26`;
  const w = (await api("GET", `/api/banking/staff/working/loan?${q}`, { token: tokens.staff })).body;
  assert.equal(w.loans.length, 1);
  assert.equal(w.loans[0].label, "HDFC Bank - 4455");
  assert.ok(w.loans[0].points.some((p) => /Guarantee details are not available/.test(p)));
  assert.ok(!w.loans[0].points.some((p) => /Security \/ mortgage details are not available/.test(p)));
  const x = await api("GET", `/api/banking/staff/working/loan/excel?${q}`, { token: tokens.staff });
  assert.equal(x.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(x.body);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Repayment Schedule", "2 Loan Ledger", "3 Monthly Reconciliation", "4 Summary", "Notes"]);
  assert.equal((await api("GET", `/api/banking/staff/working/loan?client_id=${client1Id}&fy=2024-25`, { token: tokens.staff })).status, 409);

  // one loan on its own, for the Reconcile button under that loan
  const one = await api("GET", `/api/banking/staff/working/loan?${q}&account=4455`, { token: tokens.staff });
  assert.equal(one.body.loans.length, 1);
  assert.equal((await api("GET", `/api/banking/staff/working/loan?${q}&account=999999`, { token: tokens.staff })).status, 409);
  const xo = await api("GET", `/api/banking/staff/working/loan/excel?${q}&account=4455`, { token: tokens.staff });
  assert.match(xo.headers.get("content-disposition"), /^attachment; filename="Loan_working_4455_2025-26_/);
});

test("deleting a staff file removes it from storage", async () => {
  const f = await db.one("select id, storage_path from banking_staff_files where kind='tis'");
  assert.ok((await readFile(f.storage_path)).length > 0);
  assert.equal((await api("DELETE", `/api/banking/staff/files/${f.id}`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("DELETE", `/api/banking/staff/files/${f.id}`, { token: tokens.staff })).status, 200);
  await assert.rejects(readFile(f.storage_path), /not found/);
  assert.equal((await api("DELETE", `/api/banking/staff/files/${f.id}`, { token: tokens.staff })).status, 404);
});
