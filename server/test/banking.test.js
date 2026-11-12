import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-bank-"));
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

/** fields: plain form values; files: [[fieldName, filename, content]] */
function form(fields, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [field, name, content] of files) fd.append(field, new Blob([content]), name);
  return fd;
}
const stmt = (over = {}, files = [["statement", "hdfc-apr.pdf", "%PDF-1.4 statement bytes"]]) =>
  form({ section: "statement", account_number: "50100123456789", bank: "HDFC Bank", fy: "2025-26", period_from: "2025-04", period_to: "2025-06", ...over }, files);
const loan = (over = {}, files = [["sanction_letter", "sanction.pdf", "sanction"], ["repayment_schedule", "schedule.xlsx", "schedule"]]) =>
  form({ section: "loan", account_number: "LN-778899", bank: "State Bank of India", fy: "2025-26", ...over }, files);

test("the bank list ends with Other and the client's own list starts empty", async () => {
  const r = await api("GET", "/api/banking", { token: tokens.client1 });
  assert.equal(r.status, 200);
  assert.ok(r.body.banks.includes("HDFC Bank"));
  assert.equal(r.body.banks.at(-1), "Other");
  assert.deepEqual([r.body.statements, r.body.loans], [[], []]);
  assert.equal((await api("GET", "/api/banking")).status, 401);
});

test("a client uploads a bank statement; staff see it and can download the file; another client cannot", async () => {
  const up = await api("POST", "/api/banking/upload", { token: tokens.client1, form: stmt({}, [["statement", "hdfc-apr.pdf", "%PDF-1.4 statement bytes"], ["other", "note.docx", "covering note"]]) });
  assert.equal(up.status, 201);
  assert.equal(up.body.files, 2);

  const mine = (await api("GET", "/api/banking", { token: tokens.client1 })).body;
  assert.equal(mine.statements.length, 1);
  const s = mine.statements[0];
  assert.deepEqual([s.bank_name, s.account_number, s.is_other_bank, s.uploaded_by_role], ["HDFC Bank", "50100123456789", false, "client"]);
  assert.deepEqual([s.fy, s.period_from, s.period_to], ["2025-26", "2025-04", "2025-06"]);
  assert.deepEqual(s.files.map((f) => f.kind).sort(), ["other", "statement"]);

  const staffView = await api("GET", `/api/banking?client_id=${mine.client.id}`, { token: tokens.staff });
  assert.equal(staffView.body.statements.length, 1);
  assert.equal((await api("GET", "/api/banking", { token: tokens.staff })).status, 422);

  const file = s.files.find((f) => f.kind === "statement");
  for (const token of [tokens.client1, tokens.staff]) {
    const dl = await api("GET", `/api/banking/files/${file.id}/download`, { token });
    assert.equal(dl.status, 200);
    assert.equal(dl.body.toString(), "%PDF-1.4 statement bytes");
    assert.match(dl.headers.get("content-disposition"), /^attachment; filename="hdfc-apr\.pdf"/);
  }

  assert.equal((await api("GET", `/api/banking?client_id=${mine.client.id}`, { token: tokens.client2 })).status, 403);
  assert.equal((await api("GET", `/api/banking/files/${file.id}/download`, { token: tokens.client2 })).status, 404);
  assert.equal((await api("DELETE", `/api/banking/${s.id}`, { token: tokens.client2 })).status, 404);

  const note = await db.one("select * from notifications where kind='banking_upload' and audience='staff' order by created_at desc limit 1");
  assert.match(note.title, /^Apex Retailers.* uploaded a bank statement$/);
  assert.match(note.body, /HDFC Bank, account xxxx6789/);
});

test("a bank not in the list needs Other and a name; bad input is refused and nothing is saved", async () => {
  const onDisk = () => fs.readdirSync(process.env.STORAGE_DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
  const before = (await db.one("select count(*)::int as n from banking_submissions")).n;
  const filesBefore = onDisk();
  const bad = async (fd, status, re) => { const r = await api("POST", "/api/banking/upload", { token: tokens.client1, form: fd }); assert.equal(r.status, status); assert.match(JSON.stringify(r.body), re); };
  await bad(stmt({ bank: "Bank of Nowhere" }), 422, /Choose the bank from the list/);
  await bad(stmt({ bank: "Other", other_bank_name: " " }), 422, /name of the bank/);
  await bad(stmt({ account_number: "12" }), 422, /account number/);
  await bad(stmt({ account_number: "12 34 !!" }), 422, /account number/);
  await bad(stmt({}, []), 422, /bank statement/);
  await bad(stmt({}, [["statement", "virus.exe", "MZ"]]), 400, /Unsupported file type/);
  await bad(stmt({}, [["statement", "a.pdf", "x"], ["sanction_letter", "b.pdf", "y"]]), 400, /statement and other documents only/);
  await bad(stmt({ section: "deposit" }), 422, /section must be/);
  await bad(stmt({ fy: "" }), 422, /financial year/);
  await bad(stmt({ fy: "2025-27" }), 422, /financial year/);
  await bad(loan({ fy: "" }), 422, /financial year/);
  await bad(stmt({ period_from: "", period_to: "" }), 422, /period the statement covers/);
  await bad(stmt({ period_from: "2025-03" }), 422, /period the statement covers/);
  await bad(stmt({ period_to: "2026-04" }), 422, /period the statement covers/);
  await bad(stmt({ period_from: "2025-07", period_to: "2025-06" }), 422, /cannot be before/);
  await bad(loan({}, [["sanction_letter", "sanction.pdf", "x"]]), 422, /repayment schedule/);
  await bad(loan({}, [["repayment_schedule", "schedule.pdf", "x"]]), 422, /sanction letter/);
  await bad(loan({}, [["statement", "s.pdf", "x"], ["sanction_letter", "a.pdf", "x"], ["repayment_schedule", "b.pdf", "x"]]), 400, /sanction letter, the repayment schedule/);
  assert.equal((await db.one("select count(*)::int as n from banking_submissions")).n, before);
  assert.equal(onDisk(), filesBefore, "refused uploads leave no file on disk");

  const ok = await api("POST", "/api/banking/upload", { token: tokens.client1, form: stmt({ bank: "Other", other_bank_name: "  Jalgaon  Peoples  Co-op Bank " }) });
  assert.equal(ok.status, 201);
  const row = await db.one("select bank_name, is_other_bank from banking_submissions order by created_at desc limit 1");
  assert.deepEqual(row, { bank_name: "Jalgaon Peoples Co-op Bank", is_other_bank: true });
});

test("a loan needs the sanction letter and the repayment schedule; other documents are optional", async () => {
  const up = await api("POST", "/api/banking/upload", { token: tokens.client1, form: loan({}, [["sanction_letter", "sanction.pdf", "S"], ["repayment_schedule", "schedule.xlsx", "R"], ["other", "kyc.png", "K"]]) });
  assert.equal(up.status, 201);
  const mine = (await api("GET", "/api/banking", { token: tokens.client1 })).body;
  assert.equal(mine.loans.length, 1);
  assert.deepEqual(mine.loans[0].files.map((f) => f.kind).sort(), ["other", "repayment_schedule", "sanction_letter"]);
  assert.equal(mine.loans[0].bank_name, "State Bank of India");
  assert.ok(!mine.statements.some((s) => s.account_number === "LN-778899"), "a loan is not listed as a statement");
});

test("staff upload for a client; the client is told and sees it; deleting removes the files too", async () => {
  const mine = (await api("GET", "/api/banking", { token: tokens.client2 })).body;
  const up = await api("POST", "/api/banking/upload", { token: tokens.staff, form: stmt({ client_id: mine.client.id, account_number: "99887766" }) });
  assert.equal(up.status, 201);
  const noClient = await api("POST", "/api/banking/upload", { token: tokens.staff, form: stmt({ account_number: "99887766" }) });
  assert.equal(noClient.status, 422);
  const asOther = await api("POST", "/api/banking/upload", { token: tokens.client1, form: stmt({ client_id: mine.client.id }) });
  assert.equal(asOther.status, 403);

  const after = (await api("GET", "/api/banking", { token: tokens.client2 })).body;
  assert.equal(after.statements.length, 1);
  assert.equal(after.statements[0].uploaded_by_role, "staff");
  const note = await db.one("select title from notifications where kind='banking_upload' and audience='client' and client_id=$1", [mine.client.id]);
  assert.match(note.title, /Your CA firm added a bank statement/);

  const sub = after.statements[0];
  const stored = (await db.one("select storage_path from banking_files where submission_id=$1", [sub.id])).storage_path;
  assert.ok((await readFile(stored)).length > 0);
  assert.equal((await api("DELETE", `/api/banking/${sub.id}`, { token: tokens.client2 })).status, 200);
  await assert.rejects(readFile(stored), /not found/);
  assert.equal((await db.one("select count(*)::int as n from banking_files where submission_id=$1", [sub.id])).n, 0);
  assert.equal((await api("DELETE", `/api/banking/${sub.id}`, { token: tokens.staff })).status, 404);
  assert.equal((await api("GET", `/api/banking/files/${sub.files[0].id}/download`, { token: tokens.staff })).status, 404);
});
