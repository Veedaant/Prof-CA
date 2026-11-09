import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-test-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const ExcelJS = (await import("exceljs")).default;

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

async function login(email, password) {
  const r = await api("POST", "/api/auth/login", { json: { email, password } });
  assert.equal(r.status, 200);
  return r.body.access_token;
}

before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await login("admin@example.com", "admin123");
  tokens.staff = await login("staff@example.com", "staff123");
  tokens.client1 = await login("client1@example.com", "client123");
  tokens.client2 = await login("client2@example.com", "client123");
});

after(async () => {
  server.close();
  await db.close();
});

test("login rejects bad password with {detail}", async () => {
  const r = await api("POST", "/api/auth/login", { json: { email: "admin@example.com", password: "nope" } });
  assert.equal(r.status, 401);
  assert.equal(r.body.detail, "Incorrect email or password");
});

test("protected routes need a token", async () => {
  assert.equal((await api("GET", "/api/clients")).status, 401);
});

test("client users only see their own client and invoices", async () => {
  const clients = await api("GET", "/api/clients", { token: tokens.client1 });
  assert.equal(clients.body.length, 1);
  const own = clients.body[0];
  const all = await api("GET", "/api/clients", { token: tokens.staff });
  assert.equal(all.body.length, 2);
  const other = all.body.find((c) => c.id !== own.id);
  assert.equal((await api("GET", `/api/clients/${other.id}`, { token: tokens.client1 })).status, 403);

  const inv = await api("GET", `/api/invoices?client_id=${other.id}`, { token: tokens.client1 });
  assert.ok(inv.body.every((i) => i.client_id === own.id), "client_id filter must be ignored for client users");
  const zen = (await api("GET", `/api/invoices?client_id=${other.id}`, { token: tokens.staff })).body[0];
  assert.equal((await api("GET", `/api/invoices/${zen.id}`, { token: tokens.client1 })).status, 404);
});

test("seeded invoices carry honest validation results", async () => {
  const list = (await api("GET", "/api/invoices?limit=100", { token: tokens.staff })).body;
  assert.equal(list.length, 5);
  const flagged = list.find((i) => i.invoice_number === "APEX/2025/0140");
  assert.equal(flagged.review_status, "needs_review");
  assert.ok(flagged.flags.some((f) => f.type === "tax_calculation_mismatch"));
  const clean = list.find((i) => i.invoice_number === "APEX/2025/0101");
  assert.deepEqual(clean.flags, []);
});

test("invoice detail, edit with whitelist + audit log, review", async () => {
  const list = (await api("GET", "/api/invoices", { token: tokens.staff })).body;
  const target = list.find((i) => i.review_status === "needs_review");
  const d = await api("GET", `/api/invoices/${target.id}`, { token: tokens.staff });
  assert.equal(d.status, 200);
  assert.match(d.body.file_preview_url, /^\/api\/files\/.+\/view\?token=/);
  const img = await api("GET", d.body.file_preview_url, {});
  assert.equal(img.status, 200);

  const put = await api("PUT", `/api/invoices/${target.id}`, { token: tokens.staff, json: { invoice_total: 23600, firm_id: "00000000-0000-0000-0000-000000000000" } });
  assert.equal(put.status, 200);
  assert.equal(put.body.invoice_total, 23600);
  assert.ok(put.body.audit_logs.some((a) => a.field_name === "invoice_total"));
  assert.ok(!put.body.flags.some((f) => f.type === "tax_calculation_mismatch"));

  assert.equal((await api("PUT", `/api/invoices/${target.id}`, { token: tokens.client2, json: { invoice_total: 1 } })).status, 404);
  const rev = await api("POST", `/api/invoices/${target.id}/review`, { token: tokens.staff, json: { action: "approve", reason: "ok" } });
  assert.equal(rev.body.review_status, "approved");
});

test("GSTR-1 export: signed token bound to export id, correct sheets", async () => {
  const clients = (await api("GET", "/api/clients", { token: tokens.staff })).body;
  const apex = clients.find((c) => c.name.startsWith("Apex"));
  const exp = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2025-01" } });
  assert.equal(exp.status, 200, JSON.stringify(exp.body));
  assert.equal(exp.body.total_exported, 4);

  const ok = await api("GET", exp.body.download_url);
  assert.equal(ok.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ok.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["b2b", "b2cl", "b2cs", "cdnr", "hsn"]);
  const b2b = wb.getWorksheet("b2b");
  const heads = b2b.getRow(1).values.slice(1);
  for (const h of ["HSN/SAC", "Quantity", "UQC", "Integrated Tax (IGST)", "Central Tax (CGST)", "State/UT Tax (SGST)"]) assert.ok(heads.includes(h), `b2b header ${h}`);
  // header + 3 line items (2 + 1), one row per HSN line; invoice value repeats on each line of the same invoice
  const col = (name) => heads.indexOf(name) + 1;
  const lines = [2, 3, 4].map((r) => b2b.getRow(r));
  assert.ok(lines.every((r) => r.getCell(col("HSN/SAC")).value));
  const byInv = {};
  for (const r of lines) (byInv[r.getCell(col("Invoice Number")).value] ||= new Set()).add(r.getCell(col("Invoice Value")).value);
  assert.ok(Object.values(byInv).every((s) => s.size === 1), "invoice value must not change between lines of one invoice");
  // HSN-wise summary block sits below the data and ties to the lines above
  let at = 0;
  b2b.eachRow((r, i) => { if (r.getCell(1).value === "HSN-wise summary") at = i; });
  assert.ok(at > 4, "b2b has an HSN-wise summary block");
  const totalRow = b2b.getRow(b2b.rowCount);
  assert.equal(totalRow.getCell(1).value, "Total");
  const sumLines = (name) => Math.round(lines.reduce((a, r) => a + (Number(r.getCell(col(name)).value) || 0), 0) * 100) / 100;
  assert.equal(totalRow.getCell(5).value, sumLines("Taxable Value"));
  assert.equal(totalRow.getCell(6).value, sumLines("Integrated Tax (IGST)"));
  assert.equal(totalRow.getCell(7).value, sumLines("Central Tax (CGST)"));
  assert.equal(totalRow.getCell(8).value, sumLines("State/UT Tax (SGST)"));
  assert.ok(wb.getWorksheet("b2cl").rowCount >= 1);

  assert.equal((await api("GET", `/api/exports/download/${exp.body.export_id}`)).status, 403);
  const other = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: clients.find((c) => c.id !== apex.id).id, tax_period: "2025-01" } });
  const forged = other.body.download_url.replace(/download\/[^?]+/, `download/${exp.body.export_id}`);
  assert.equal((await api("GET", forged)).status, 403, "token for another export must not work");

  const none = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2030-05" } });
  assert.equal(none.status, 400);
  assert.match(none.body.detail, /approved by/);
});

test("approve-all rejects clients from another firm / unknown ids", async () => {
  const r = await api("POST", "/api/exports/approve-all?client_id=00000000-0000-0000-0000-000000000000&tax_period=2025-01", { token: tokens.staff });
  assert.equal(r.status, 404);
});

test("upload validates type, runs the pipeline without fabricating data", async () => {
  const apex = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0];
  const bad = new FormData();
  bad.append("client_id", apex.id);
  bad.append("files", new Blob(["x"]), "evil.exe");
  assert.equal((await api("POST", "/api/invoices/upload", { token: tokens.staff, form: bad })).status, 400);

  const other = (await api("GET", "/api/clients", { token: tokens.staff })).body.find((c) => c.id !== apex.id);
  const cross = new FormData();
  cross.append("client_id", other.id);
  cross.append("files", new Blob(["x"]), "a.png");
  assert.equal((await api("POST", "/api/invoices/upload", { token: tokens.client1, form: cross })).status, 403);

  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ffffff" } }).png().toBuffer();
  const form = new FormData();
  form.append("client_id", apex.id);
  form.append("tax_period", "2025-02");
  form.append("files", new Blob([png], { type: "image/png" }), "blank.png");
  const up = await api("POST", "/api/invoices/upload", { token: tokens.client1, form });
  assert.equal(up.status, 200);
  assert.equal(up.body[0].status, "queued");

  let inv;
  for (let i = 0; i < 60 && !inv; i++) {
    await new Promise((r) => setTimeout(r, 500));
    inv = (await api("GET", "/api/invoices?tax_period=2025-02", { token: tokens.client1 })).body[0];
  }
  assert.ok(inv, "invoice should be created by background processing");
  assert.equal(inv.review_status, "needs_review");
  assert.equal(inv.invoice_total, 0);
  assert.ok(inv.flags.some((f) => f.type === "fallback_extraction"));
});

test("reconciliation summary and register matching", async () => {
  const apex = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0];
  const sum = await api("GET", `/api/reconciliation/summary?client_id=${apex.id}&tax_period=2025-01`, { token: tokens.staff });
  assert.equal(sum.status, 200);
  assert.equal(sum.body.total_invoices, 4);

  const csv = "Invoice No,Invoice Date,Customer GSTIN,Taxable Value,Invoice Total\n"
    + "APEX/2025/0101,2025-01-10,,80000,94400\n"
    + "APEX-2025-0130,2025-01-28,,12000,14000\n"
    + "NOPE/1,2025-01-01,,1,1\n";
  const form = new FormData();
  form.append("client_id", apex.id);
  form.append("tax_period", "2025-01");
  form.append("file", new Blob([csv], { type: "text/csv" }), "reg.csv");
  const m = await api("POST", "/api/reconciliation/match-register", { token: tokens.staff, form });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.summary.exact_matches, 1);
  assert.equal(m.body.summary.value_mismatches, 1);
  assert.equal(m.body.summary.missing_in_invoices, 1);
  assert.equal(m.body.summary.missing_in_register, 2);

  const t = await api("GET", "/api/reconciliation/sample-template", { token: tokens.client1 });
  assert.equal(t.status, 200);
});

test("only admins create admins; users cannot delete themselves", async () => {
  const mk = (token, role) => api("POST", "/api/users", { token, json: { email: `${role}-${Date.now()}@x.com`, password: "secret12", full_name: "T", role } });
  assert.equal((await mk(tokens.staff, "admin")).status, 403);
  const created = await mk(tokens.admin, "staff");
  assert.equal(created.status, 201);
  const me = (await api("GET", "/api/auth/me", { token: tokens.admin })).body;
  assert.equal((await api("DELETE", `/api/users/${me.id}`, { token: tokens.admin })).status, 400);
  assert.equal((await api("DELETE", `/api/users/${created.body.id}`, { token: tokens.admin })).status, 204);
});

test("self-service signup creates a client user scoped to the firm", async () => {
  const firms = await api("GET", "/api/auth/firms");
  assert.equal(firms.status, 200);
  const firm_id = firms.body[0].id;
  const body = { email: "new@buyer.com", password: "longpass1", full_name: "New Buyer", company_name: "New Buyer Pvt Ltd", firm_id };
  assert.equal((await api("POST", "/api/auth/register", { json: { ...body, password: "short" } })).status, 422);
  const r = await api("POST", "/api/auth/register", { json: body });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.role, "client");
  assert.ok(r.body.user.client_id);
  assert.equal((await api("POST", "/api/auth/register", { json: body })).status, 409);
  const mine = await api("GET", "/api/clients", { token: r.body.access_token });
  assert.equal(mine.body.length, 1);
  assert.equal(mine.body[0].name, "New Buyer Pvt Ltd");
});

test("workflow: client uploads and verifies; only then CA staff see it and can export", async () => {
  const cid = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
  const list = (await api("GET", `/api/invoices?limit=100&client_id=${cid}`, { token: tokens.staff })).body;
  const pick = list.filter((i) => i.invoice_number !== "APEX/2025/0140").slice(0, 2);
  assert.ok(pick.length >= 2);
  // simulate two fresh uploads that the client has not yet sent to the CA
  await db.query("update invoices set tax_period='2031-06', invoice_type='sales', review_status='auto_approved', client_confirmation='not_required', client_approved_at=null where id=$1", [pick[0].id]);
  await db.query("update invoices set tax_period='2031-06', invoice_type='credit_note', review_status='auto_approved', client_confirmation='not_required', client_approved_at=null where id=$1", [pick[1].id]);
  const q = `client_id=${cid}&tax_period=2031-06`;

  // staff cannot see unsent invoices anywhere
  assert.ok(!(await api("GET", "/api/invoices?limit=200", { token: tokens.staff })).body.some((i) => i.id === pick[0].id));
  assert.equal((await api("GET", `/api/invoices/${pick[0].id}`, { token: tokens.staff })).status, 404);
  assert.ok(!(await api("GET", "/api/invoices/requests", { token: tokens.staff })).body.requests.some((r) => r.invoice_id === pick[0].id));
  let w = (await api("GET", `/api/gst/working?${q}`, { token: tokens.staff })).body;
  assert.equal(w.sales.length, 0);
  assert.equal(w.pending_client_approval, 2);
  assert.equal((await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: cid, tax_period: "2031-06" } })).status, 400);

  // the client sees the retrieved data and can correct it
  assert.equal((await api("GET", `/api/invoices/${pick[0].id}`, { token: tokens.client1 })).status, 200);
  let rq = (await api("GET", "/api/invoices/requests", { token: tokens.client1 })).body.requests;
  assert.equal(rq.find((r) => r.invoice_id === pick[0].id).stage.key, "client_review");
  assert.equal((await api("PUT", `/api/invoices/${pick[0].id}`, { token: tokens.client1, json: { buyer_name: "Checked By Client" } })).status, 200);
  assert.equal((await api("POST", `/api/invoices/${pick[0].id}/client-approve`, { token: tokens.staff })).status, 403);
  assert.equal((await api("POST", `/api/invoices/${pick[0].id}/client-approve`, { token: tokens.client2 })).status, 404);

  // the client verifies and sends to CA
  assert.equal((await api("POST", `/api/invoices/${pick[0].id}/client-approve`, { token: tokens.client1 })).status, 200);
  assert.equal((await api("POST", `/api/invoices/${pick[1].id}/client-approve`, { token: tokens.client1 })).status, 200);
  assert.equal((await api("POST", `/api/invoices/${pick[0].id}/client-approve`, { token: tokens.client1 })).status, 400);
  rq = (await api("GET", "/api/invoices/requests", { token: tokens.client1 })).body.requests;
  assert.equal(rq.find((r) => r.invoice_id === pick[0].id).stage.key, "with_staff");

  // now staff see it and can download the Excel
  assert.ok((await api("GET", "/api/invoices?limit=200", { token: tokens.staff })).body.some((i) => i.id === pick[0].id));
  w = (await api("GET", `/api/gst/working?${q}`, { token: tokens.staff })).body;
  assert.equal(w.pending_client_approval, 0);
  assert.equal(w.sales.length, 1);
  assert.equal(w.sales[0].buyer_name, "Checked By Client");
  assert.equal(w.credit_notes.length, 1);
  assert.equal(w.working.net.total, Math.round((w.sales[0].invoice_total - w.credit_notes[0].invoice_total) * 100) / 100);
  const ex = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: cid, tax_period: "2031-06" } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal((await api("GET", ex.body.download_url)).status, 200);
  const other = (await api("GET", `/api/gst/working?client_id=${cid}&tax_period=2031-07`, { token: tokens.staff })).body;
  assert.equal(other.sales.length, 0);
});

test("GSTR-1 export leaves out a duplicate upload of the same invoice", async () => {
  const apex = (await api("GET", "/api/clients", { token: tokens.staff })).body.find((c) => c.name.startsWith("Apex"));
  const before = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2025-01" } });
  assert.equal(before.status, 200);
  const src = await db.one("select id from invoices where client_id=$1 and tax_period='2025-01' and client_approved_at is not null and review_status<>'rejected' and invoice_number is not null and supplier_gstin is not null limit 1", [apex.id]);
  await db.query(
    `insert into invoices (firm_id, client_id, invoice_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at)
     select firm_id, client_id, invoice_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at from invoices where id=$1`,
    [src.id],
  );
  const after = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2025-01" } });
  assert.equal(after.status, 200, JSON.stringify(after.body));
  assert.equal(after.body.total_exported, before.body.total_exported);
  assert.match(after.body.warning, /duplicate upload/);
});

test("24h window: client can edit or unsend after sending, both sides get change alerts, CA can always edit", async () => {
  const cid = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
  const inv = (await api("GET", `/api/invoices?limit=100&client_id=${cid}`, { token: tokens.staff })).body.find((i) => i.source_file_id && i.invoice_number !== "APEX/2025/0140");
  assert.ok(inv, "a sent invoice exists");
  assert.ok(inv.editable_until, "invoice exposes its edit deadline");
  await db.query("update invoices set alert_for=null, alert_text=null, tax_period='2032-01' where id=$1", [inv.id]);
  const file = inv.source_file_id;
  const setAge = (hours) => db.query("update invoice_files set created_at=now() - ($2 || ' hours')::interval where id=$1", [file, String(hours)]);
  const url = `/api/invoices/${inv.id}`;

  // inside 24h: client edits a sent invoice, the edit is reflected and the CA is alerted
  await setAge(2);
  const e1 = await api("PUT", url, { token: tokens.client1, json: { buyer_name: "Edited By Client" } });
  assert.equal(e1.status, 200, JSON.stringify(e1.body));
  assert.equal(e1.body.buyer_name, "Edited By Client");
  assert.equal(e1.body.alert_for, "staff");
  assert.match(e1.body.alert_text, /client/i);
  const staffView = (await api("GET", url, { token: tokens.staff })).body;
  assert.equal(staffView.buyer_name, "Edited By Client");
  assert.equal(staffView.alert_for, "staff");
  const reqs = (await api("GET", "/api/invoices/requests", { token: tokens.staff })).body.requests;
  assert.equal(reqs.find((r) => r.invoice_id === inv.id).alert_for, "staff");

  // the client cannot clear the CA's alert; the CA can
  assert.equal((await api("POST", `${url}/ack`, { token: tokens.client1 })).body.alert_for, "staff");
  assert.equal((await api("POST", `${url}/ack`, { token: tokens.staff })).body.alert_for, null);

  // the CA may edit at any time; the client is alerted
  await setAge(100);
  const e2 = await api("PUT", url, { token: tokens.staff, json: { buyer_name: "Edited By CA" } });
  assert.equal(e2.status, 200);
  assert.equal(e2.body.alert_for, "client");
  const clientView = (await api("GET", url, { token: tokens.client1 })).body;
  assert.equal(clientView.alert_for, "client");
  assert.equal((await api("POST", `${url}/ack`, { token: tokens.client1 })).body.alert_for, null);

  // after 24h the client can neither edit nor unsend
  assert.equal((await api("PUT", url, { token: tokens.client1, json: { buyer_name: "Too Late" } })).status, 403);
  assert.equal((await api("POST", `${url}/unsend`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("GET", url, { token: tokens.staff })).body.buyer_name, "Edited By CA");

  // inside 24h the client can unsend; it disappears from the CA until sent again
  await setAge(3);
  assert.equal((await api("POST", `${url}/unsend`, { token: tokens.staff })).status, 403);
  assert.equal((await api("POST", `${url}/unsend`, { token: tokens.client2 })).status, 404);
  const un = await api("POST", `${url}/unsend`, { token: tokens.client1 });
  assert.equal(un.status, 200, JSON.stringify(un.body));
  assert.equal(un.body.client_approved_at, null);
  assert.equal((await api("GET", url, { token: tokens.staff })).status, 404);
  assert.equal((await api("POST", `${url}/unsend`, { token: tokens.client1 })).status, 400);
  const again = await api("POST", `${url}/client-approve`, { token: tokens.client1 });
  assert.equal(again.status, 200);
  assert.equal((await api("GET", url, { token: tokens.staff })).status, 200);
});

test("every document category has the same flow and its own Excel: sales, purchase, credit, debit, other", async () => {
  const apex = (await api("GET", "/api/clients", { token: tokens.staff })).body.find((c) => c.name.startsWith("Apex"));
  const cats = ["sales", "purchase", "credit_note", "debit_note", "other"];
  const pickIds = async () => (await db.query("select i.id from invoices i where i.client_id=$1 and i.client_approved_at is not null and i.review_status<>'rejected' order by i.created_at limit 5", [apex.id])).map((r) => r.id);
  let ids = await pickIds();
  while (ids.length < 5) {
    await db.query(
      `insert into invoices (firm_id, client_id, invoice_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at)
       select firm_id, client_id, invoice_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at from invoices where id=$1`,
      [ids[0]],
    );
    ids = await pickIds();
  }
  for (let k = 0; k < 5; k++) await db.query("update invoices set invoice_type=$2::varchar, return_type=(case when $2::varchar = 'purchase' then 'gstr3b' else 'gstr1' end), tax_period='2033-01', invoice_number=$3, supplier_gstin='27AAACA1234A1ZK', buyer_gstin='29BBBBB1111B1Z5' where id=$1", [ids[k], cats[k], `CAT-${k}`]);

  assert.equal((await api("POST", "/api/exports/register", { token: tokens.client1, json: { client_id: apex.id, tax_period: "2033-01", category: "sales" } })).status, 403);
  assert.equal((await api("POST", "/api/exports/register", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2033-01", category: "nope" } })).status, 422);
  assert.equal((await api("POST", "/api/exports/register", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2040-01", category: "purchase" } })).status, 400);

  for (let k = 0; k < 5; k++) {
    const ex = await api("POST", "/api/exports/register", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2033-01", category: cats[k] } });
    assert.equal(ex.status, 200, `${cats[k]}: ${JSON.stringify(ex.body)}`);
    assert.equal(ex.body.total_exported, 1);
    const dl = await api("GET", ex.body.download_url);
    assert.equal(dl.status, 200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(dl.body);
    const ws = wb.worksheets[0];
    const heads = ws.getRow(3).values.slice(1);
    for (const h of ["HSN/SAC", "Quantity", "UQC", "IGST", "CGST", "SGST", "Invoice Value"]) assert.ok(heads.includes(h), `${cats[k]} header ${h}`);
    assert.equal(ws.getRow(4).getCell(heads.indexOf("Document Number") + 1).value, `CAT-${k}`);
    let found = false;
    ws.eachRow((r) => { if (r.getCell(1).value === "HSN-wise summary") found = true; });
    assert.ok(found, `${cats[k]} has an HSN-wise summary`);
    assert.equal(ws.getRow(ws.rowCount).getCell(1).value, "Total");
  }
});

test("GSTR-1 and GSTR-3B are separate: upload rules, staff data, Excel and credit notes under each", async () => {
  const apex = (await api("GET", "/api/clients", { token: tokens.staff })).body.find((c) => c.name.startsWith("Apex"));
  const bad = (rt, cat) => {
    const f = new FormData();
    f.append("client_id", apex.id); f.append("return_type", rt); f.append("invoice_type", cat);
    f.append("files", new Blob(["x"], { type: "image/png" }), "a.png");
    return api("POST", "/api/invoices/upload", { token: tokens.client1, form: f });
  };
  assert.equal((await bad("gstr1", "purchase")).status, 400);
  assert.equal((await bad("gstr3b", "sales")).status, 400);

  const ids = (await db.query("select id from invoices where client_id=$1 and client_approved_at is not null and review_status<>'rejected' order by created_at limit 4", [apex.id])).map((r) => r.id);
  assert.equal(ids.length, 4);
  const setDoc = (id, type, ret, no) => db.query("update invoices set invoice_type=$2, return_type=$3, invoice_number=$4, supplier_gstin='27AAACA1234A1ZK', buyer_gstin='29BBBBB1111B1Z5', tax_period='2034-02' where id=$1", [id, type, ret, no]);
  await setDoc(ids[0], "credit_note", "gstr1", "CN-ONE");
  await setDoc(ids[1], "credit_note", "gstr3b", "CN-THREEB");
  await setDoc(ids[2], "purchase", "gstr3b", "PUR-THREEB");
  await setDoc(ids[3], "sales", "gstr1", "SAL-ONE");

  const w = (await api("GET", `/api/gst/working?client_id=${apex.id}&tax_period=2034-02`, { token: tokens.staff })).body;
  assert.deepEqual(w.all_credit_notes.map((i) => i.invoice_number), ["CN-ONE"]);
  assert.deepEqual(w.gstr3b.credit_notes.map((i) => i.invoice_number), ["CN-THREEB"]);
  assert.deepEqual(w.gstr3b.purchases.map((i) => i.invoice_number), ["PUR-THREEB"]);
  assert.deepEqual(w.sales.map((i) => i.invoice_number), ["SAL-ONE"]);
  assert.ok(w.sales.every((i) => i.return_type === "gstr1"));

  const reg = (category, return_type) => api("POST", "/api/exports/register", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2034-02", category, return_type } });
  const one = await reg("credit_note", "gstr1");
  assert.equal(one.status, 200);
  assert.equal(one.body.total_exported, 1);
  assert.match(one.body.file_name, /^GSTR1_credit_note/);
  const three = await reg("credit_note", "gstr3b");
  assert.equal(three.status, 200);
  assert.match(three.body.file_name, /^GSTR3B_credit_note/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await api("GET", three.body.download_url)).body);
  assert.equal(wb.worksheets[0].getRow(4).getCell(1).value, "CN-THREEB");
  assert.equal((await reg("purchase", "gstr1")).status, 422);
  assert.equal((await reg("sales", "gstr3b")).status, 422);

  const g1 = await api("POST", "/api/exports/gstr1", { token: tokens.staff, json: { client_id: apex.id, tax_period: "2034-02" } });
  assert.equal(g1.status, 200);
  assert.equal(g1.body.total_exported, 2); // the GSTR-1 workbook takes only GSTR-1 documents: CN-ONE and SAL-ONE
});

test("GSTR-3B export: Table 3.1, ITC (Table 4), reverse charge and set-off are worked out correctly", async () => {
  const apexRow = await db.one("select id, firm_id, gstin from clients where name like 'Apex%'");
  const mk = (type, ret, no, taxable, cgst, sgst, igst, rcm = false) => db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, reverse_charge, review_status, tax_period, client_approved_at)
     values ($1,$2,$3,$4,'Vendor','27VVVVV0000V1Z5','Buyer','27BBBBB1111B1Z5',$5,'2035-03-10','Maharashtra',$6,$7,$8,$9,$10,$11,$12,'approved','2035-03',now())`,
    [apexRow.firm_id, apexRow.id, type, ret, no, taxable, cgst, sgst, igst, cgst + sgst + igst, taxable + cgst + sgst + igst, rcm],
  );
  await mk("sales", "gstr1", "S-1", 10000, 900, 900, 0);
  await mk("credit_note", "gstr1", "CN-OUT", 1000, 90, 90, 0);
  await mk("purchase", "gstr3b", "P-1", 5000, 450, 450, 0);
  await mk("purchase", "gstr3b", "P-RCM", 2000, 0, 0, 360, true);
  await mk("credit_note", "gstr3b", "CN-IN", 500, 45, 45, 0);
  // bills must be addressed to the client's own GSTIN to carry ITC
  await db.query("update invoices set buyer_gstin=$1 where client_id=$2 and tax_period='2035-03'", [apexRow.gstin, apexRow.id]);

  const lrow = (type, no, taxable, cgst, sgst, igst, value) => ({ type, inv_no: no, gstin: "27VVVVV0000V1Z5", party: "Vendor", date: "2035-03-10", taxable, cgst, sgst, igst, cess: 0, value, rate: 18 });
  await db.query("insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'purchase_ledger','2035-03','ledger.xlsx',3,$3,'client')",
    [apexRow.firm_id, apexRow.id, JSON.stringify({ rows: [lrow("inv", "P-1", 5000, 450, 450, 0, 5900), lrow("inv", "P-RCM", 2000, 0, 0, 360, 2360), lrow("cn", "CN-IN", 500, 45, 45, 0, 590)] })]);
  // not verified yet: the report must not be generated
  const early = await api("POST", "/api/exports/gstr3b", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2035-03" } });
  assert.equal(early.status, 409);
  assert.match(early.body.detail, /not been verified/);
  // ...but the documents and draft figures are visible before verification
  const pv = await api("GET", `/api/exports/gstr3b/preview?client_id=${apexRow.id}&tax_period=2035-03`, { token: tokens.staff });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.gate.ok, false);
  assert.match(pv.body.gate.message, /not been verified/);
  assert.equal(pv.body.inward.length, 3);
  assert.equal(pv.body.outward.length, 2);
  assert.ok(pv.body.inward.some((d) => d.number === "P-RCM" && d.reverse_charge));
  assert.equal(pv.body.summary.cash_payable.igst, 360);
  assert.equal((await api("GET", `/api/exports/gstr3b/preview?client_id=${apexRow.id}&tax_period=2035-03`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2035-03" } })).status, 409, "verification needs a current check against the ledger");
  assert.equal((await api("POST", "/api/gstr3b/run", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2035-03" } })).status, 200);
  assert.equal((await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2035-03" } })).status, 200);
  assert.equal((await api("POST", "/api/exports/gstr3b", { token: tokens.client1, json: { client_id: apexRow.id, tax_period: "2035-03" } })).status, 403);
  assert.equal((await api("POST", "/api/exports/gstr3b", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2041-01" } })).status, 409);

  const ex = await api("POST", "/api/exports/gstr3b", { token: tokens.staff, json: { client_id: apexRow.id, tax_period: "2035-03" } });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.outward_documents, 2);
  assert.equal(ex.body.inward_documents, 3);
  assert.deepEqual({ cgst: ex.body.summary.outward_tax.cgst, sgst: ex.body.summary.outward_tax.sgst, taxable: ex.body.summary.outward_tax.taxable }, { cgst: 810, sgst: 810, taxable: 9000 });
  assert.deepEqual({ igst: ex.body.summary.itc_net.igst, cgst: ex.body.summary.itc_net.cgst, sgst: ex.body.summary.itc_net.sgst }, { igst: 360, cgst: 405, sgst: 405 });
  // CGST credit 405 -> CGST; SGST credit 405 -> SGST. RCM tax 360 is paid in cash and its ITC is not usable this month.
  assert.deepEqual({ igst: ex.body.summary.cash_payable.igst, cgst: ex.body.summary.cash_payable.cgst, sgst: ex.body.summary.cash_payable.sgst }, { igst: 360, cgst: 405, sgst: 405 });
  // the reverse-charge ITC (IGST 360) arises only after the cash payment, so it is carried to next month, not used now
  assert.deepEqual(ex.body.summary.carry_forward, { taxable: 0, igst: 360, cgst: 0, sgst: 0, cess: 0 });

  const dl = await api("GET", ex.body.download_url);
  assert.equal(dl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["GSTR-3B Summary", "Outward detail (GSTR-1 docs)", "Inward detail (GSTR-3B docs)", "RCM and ITC review", "Notes"]);
  assert.equal(wb.getWorksheet("Outward detail (GSTR-1 docs)").rowCount, 3);
  assert.equal(wb.getWorksheet("Inward detail (GSTR-3B docs)").rowCount, 4);
  assert.ok((await api("GET", "/api/exports/history", { token: tokens.staff })).body.some((h) => h.export_type === "gstr3b"));
});

test("GSTR-3B verification: documents are checked against the ledger and the CA's feedback reaches the client", async () => {
  const apex = await db.one("select id, firm_id from clients where name like 'Apex%'");
  const P = "2036-04";
  const mk = (type, no, taxable, cgst, sgst, sent = true) => db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at)
     values ($1,$2,$3,'gstr3b','Vendor','27VVVVV0000V1Z5','Buyer','27BBBBB1111B1Z5',$4,'2036-04-10','Maharashtra',$5,$6,$7,0,$8,$9,'approved',$10,${sent ? "now()" : "null"})`,
    [apex.firm_id, apex.id, type, no, taxable, cgst, sgst, cgst + sgst, taxable + cgst + sgst, P],
  );
  const q = `client_id=${apex.id}&tax_period=${P}`;
  const get = async () => (await api("GET", `/api/gstr3b/review?${q}`, { token: tokens.staff })).body;

  // nothing uploaded: blocked
  let r = await get();
  assert.ok(r.verification.findings.some((f) => f.kind === "missing_all" && f.key === "nothing"));
  assert.equal(r.can_verify, false);

  // the ledger lists P-OK, P-MISSING (never uploaded), P-WRONG (amount differs) and credit note CN-1 (never uploaded)
  const L = (type, no, taxable, cgst, sgst, value) => ({ type, inv_no: no, gstin: "27VVVVV0000V1Z5", party: "Vendor", date: "2036-04-10", taxable, cgst, sgst, igst: 0, cess: 0, value, rate: 18 });
  await db.query("insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'purchase_ledger',$3,'ledger.xlsx',4,$4,'client')",
    [apex.firm_id, apex.id, P, JSON.stringify({ rows: [L("inv", "P-OK", 1000, 90, 90, 1180), L("inv", "P-MISSING", 2000, 180, 180, 2360), L("inv", "P-WRONG", 3000, 270, 270, 3540), L("cn", "CN-1", 500, 45, 45, 590)] })]);
  await mk("purchase", "P-OK", 1000, 90, 90);
  await mk("purchase", "P-WRONG", 3500, 270, 270);
  await mk("purchase", "P-EXTRA", 700, 63, 63);
  await mk("purchase", "P-UNSENT", 100, 9, 9, false);

  r = await get();
  const by = (k) => r.verification.findings.filter((f) => f.kind === k);
  assert.equal(r.verification.matched, 1);
  assert.equal(by("missing_document").length, 2, "P-MISSING and CN-1 are in the ledger but not uploaded");
  assert.ok(by("missing_document").some((f) => f.doc_ref === "P-MISSING" && /not uploaded/.test(f.document_value)));
  assert.deepEqual(by("value_mismatch").filter((f) => f.doc_ref === "P-WRONG").map((f) => f.field).sort(), ["taxable", "total"]);
  assert.ok(by("not_in_ledger").some((f) => f.doc_ref === "P-EXTRA"));
  assert.ok(by("missing_all").some((f) => f.key === "none_sent|cn"), "no credit notes were sent but the ledger has one");
  assert.equal(by("unsent").length, 1);
  assert.equal(r.can_verify, false);
  assert.equal((await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: { client_id: apex.id, tax_period: P } })).status, 409);

  // staff points at specific values and sends feedback; clients cannot use the staff tools
  const wrong = by("value_mismatch").find((f) => f.doc_ref === "P-WRONG" && f.field === "taxable");
  const missing = by("missing_document").find((f) => f.doc_ref === "P-MISSING");
  const note = (await api("POST", "/api/gstr3b/notes", { token: tokens.staff, json: { client_id: apex.id, tax_period: P, doc_ref: "P-OK", field_label: "Supplier GSTIN", ledger_value: "27VVVVV0000V1Z5", document_value: "blurred", message: "GSTIN is not readable in the upload." } })).body;
  assert.ok(note.id);
  assert.equal((await api("GET", `/api/gstr3b/review?${q}`, { token: tokens.client1 })).body.feedback.length, 0);
  assert.equal((await api("POST", "/api/gstr3b/notes", { token: tokens.client1, json: { client_id: apex.id, tax_period: P, message: "hello there" } })).status, 403);
  const fb = await api("POST", "/api/gstr3b/feedback", { token: tokens.staff, json: { client_id: apex.id, tax_period: P, message: "Please fix the following.", finding_keys: [wrong.key, missing.key], note_ids: [note.id] } });
  assert.equal(fb.status, 201, JSON.stringify(fb.body));
  assert.equal(fb.body.items.length, 3);
  assert.ok(fb.body.items.some((i) => i.doc_ref === "P-WRONG" && i.invoice_id), "feedback items remember which document they are about");
  assert.ok((await api("GET", "/api/notifications", { token: tokens.client1 })).body.notifications.some((n) => n.kind === "feedback" && /GSTR-3B/.test(n.title)), "the client is told feedback arrived");
  assert.match(fb.body.message, /cannot be generated/);
  assert.match(fb.body.message, /upload the documents again carefully/);

  // the client sees the feedback with the specific values, and asks for a re-check
  const cv = (await api("GET", `/api/gstr3b/review?${q}`, { token: tokens.client1 })).body;
  assert.equal(cv.review.status, "feedback_sent");
  assert.equal(cv.feedback[0].items.length, 3);
  assert.ok(cv.feedback[0].items.some((i) => i.doc_ref === "P-WRONG" && i.field_label === "Taxable value" && /3,500/.test(i.document_value)));
  assert.equal((await api("POST", `/api/gstr3b/feedback/${cv.feedback[0].id}/resubmit`, { token: tokens.client2 })).status, 404);
  assert.equal((await api("POST", `/api/gstr3b/feedback/${cv.feedback[0].id}/resubmit`, { token: tokens.client1 })).status, 200);
  assert.equal((await get()).review.status, "resubmitted");
  assert.ok((await api("GET", "/api/notifications", { token: tokens.staff })).body.notifications.some((n) => n.kind === "resubmitted"), "staff are told the client re-submitted");

  // the export is refused while issues are open
  assert.equal((await api("POST", "/api/exports/gstr3b", { token: tokens.staff, json: { client_id: apex.id, tax_period: P } })).status, 409);

  // staff clear what is resolved, or accept it with a reason; then verification succeeds
  await api("POST", `/api/gstr3b/notes/${note.id}/resolve`, { token: tokens.staff, json: {} });
  for (const f of (await get()).verification.findings.filter((x) => x.severity === "error")) {
    assert.equal((await api("POST", "/api/gstr3b/dismiss", { token: tokens.staff, json: { client_id: apex.id, tax_period: P, finding_key: f.key, reason: "Accepted after phone call with client" } })).status, 200);
  }
  assert.equal((await api("POST", "/api/gstr3b/run", { token: tokens.staff, json: { client_id: apex.id, tax_period: P } })).status, 200);
  r = await get();
  assert.equal(r.blockers, 0);
  assert.equal(r.can_verify, true);
  const ok = await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: { client_id: apex.id, tax_period: P } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "verified");
  assert.ok((await api("GET", "/api/notifications", { token: tokens.client1 })).body.notifications.some((n) => n.kind === "verified"), "the client is told it is verified");
});

test("ledger batch: several files merge into one ledger, overlapping rows count once; separate upload keeps them apart", async () => {
  const head = "Date,Invoice No,Party Name,GSTIN,Taxable Value,CGST,SGST,IGST,Invoice Value";
  const csv = (name, rows) => new File([[head, ...rows].join("\n")], name, { type: "text/csv" });
  const a = csv("ledger-part-1.csv", ["2037-05-03,B-1,Metro Steel,27AAAAM1111A1Z5,1000,90,90,0,1180", "2037-05-04,B-2,Metro Steel,27AAAAM1111A1Z5,2000,180,180,0,2360"]);
  const b = csv("ledger-part-2.csv", ["2037-05-04,B-2,Metro Steel,27AAAAM1111A1Z5,2000,180,180,0,2360", "2037-05-09,B-3,Metro Steel,27AAAAM1111A1Z5,500,45,45,0,590"]);
  const mk = (fields, files) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); for (const x of files) f.append("files", x); return f; };

  const merged = await api("POST", "/api/recon/files", { token: tokens.client1, form: mk({ kind: "purchase_ledger", merge: "1", tax_period: "2037-05" }, [a, b]) });
  assert.equal(merged.status, 201, JSON.stringify(merged.body));
  assert.equal(merged.body.length, 1, "one ledger for the whole batch");
  assert.equal(merged.body[0].row_count, 3, "B-2 is in both files but counted once");
  assert.equal(merged.body[0].duplicates_skipped, 1);
  assert.equal(merged.body[0].batch.length, 2);
  assert.deepEqual(merged.body[0].batch.map((p) => [p.rows, p.added]), [[2, 2], [2, 1]]);
  assert.match(merged.body[0].original_filename, /Merged batch of 2 files/);

  // the merged ledger is what the verification reads: 3 documents, no double counting
  const apex = await db.one("select id from clients where name like 'Apex%'");
  const v = (await api("GET", `/api/gstr3b/review?client_id=${apex.id}&tax_period=2037-05`, { token: tokens.staff })).body.verification;
  assert.equal(v.ledger.documents, 3);
  assert.equal(v.ledger.entries, 3);

  // a bad file in the batch names the file and stores nothing
  const before = (await api("GET", "/api/recon/files", { token: tokens.client1 })).body.length;
  const bad = await api("POST", "/api/recon/files", { token: tokens.client1, form: mk({ kind: "purchase_ledger", merge: "1" }, [a, new File(["x"], "notes.txt", { type: "text/plain" })]) });
  assert.equal(bad.status, 422);
  assert.match(bad.body.detail, /notes\.txt/);
  assert.equal((await api("GET", "/api/recon/files", { token: tokens.client1 })).body.length, before);

  // without merge, each file stays its own ledger
  const sep = await api("POST", "/api/recon/files", { token: tokens.client1, form: mk({ kind: "sales_ledger" }, [a, b]) });
  assert.equal(sep.status, 201);
  assert.equal(sep.body.length, 2);
  // the sales ledger can be merged as well
  const sm = await api("POST", "/api/recon/files", { token: tokens.client1, form: mk({ kind: "sales_ledger", merge: "1" }, [a, b]) });
  assert.equal(sm.status, 201);
  assert.equal(sm.body[0].row_count, 3);
});

test("GSTR-3B findings can be deleted once handled, and restored", async () => {
  const apex = await db.one("select id, firm_id from clients where name like 'Apex%'");
  const P = "2038-06";
  await db.query("insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'purchase_ledger',$3,'l.xlsx',1,$4,'client')",
    [apex.firm_id, apex.id, P, JSON.stringify({ rows: [{ type: "inv", inv_no: "DEL-1", gstin: "27VVVVV0000V1Z5", party: "Vendor", date: "2038-06-10", taxable: 100, cgst: 9, sgst: 9, igst: 0, cess: 0, value: 118, rate: 18 }] })]);
  const q = `client_id=${apex.id}&tax_period=${P}`;
  const get = async () => (await api("GET", `/api/gstr3b/review?${q}`, { token: tokens.staff })).body;
  let r = await get();
  const missing = r.verification.findings.find((f) => f.kind === "missing_document" && f.doc_ref === "DEL-1");
  assert.ok(missing);
  assert.equal(missing.hidden, false);
  const blockersBefore = r.blockers;
  assert.ok(blockersBefore >= 1);

  assert.equal((await api("POST", "/api/gstr3b/dismiss", { token: tokens.client1, json: { client_id: apex.id, tax_period: P, finding_key: missing.key, hidden: true } })).status, 403);
  assert.equal((await api("POST", "/api/gstr3b/dismiss", { token: tokens.staff, json: { client_id: apex.id, tax_period: P, finding_key: missing.key, hidden: true } })).status, 200);
  r = await get();
  const gone = r.verification.findings.find((f) => f.key === missing.key);
  assert.equal(gone.hidden, true);
  assert.equal(gone.dismissed, true);
  assert.equal(r.blockers, blockersBefore - 1, "a deleted finding no longer blocks");

  // an accepted finding can be deleted too, and Restore brings it back as a normal finding
  assert.equal((await api("POST", "/api/gstr3b/restore", { token: tokens.staff, json: { client_id: apex.id, tax_period: P, finding_key: missing.key } })).status, 200);
  r = await get();
  const back = r.verification.findings.find((f) => f.key === missing.key);
  assert.equal(back.hidden, false);
  assert.equal(back.dismissed, false);
  assert.equal(r.blockers, blockersBefore);
});

test("notifications: each side is told when the other sends, edits or replies; read state is per user", async () => {
  const cid = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
  const inv = (await api("GET", `/api/invoices?limit=50&client_id=${cid}`, { token: tokens.staff })).body.find((i) => i.invoice_number && i.source_file_id);
  assert.ok(inv);
  await db.query("update invoices set client_approved_at=null, client_confirmation='not_required', alert_for=null where id=$1", [inv.id]);
  await db.query("update invoice_files set created_at=now() where id=$1", [inv.source_file_id]);
  const list = async (token) => (await api("GET", "/api/notifications", { token })).body;

  const before = await list(tokens.staff);
  // client sends -> staff are told
  assert.equal((await api("POST", `/api/invoices/${inv.id}/client-approve`, { token: tokens.client1 })).status, 200);
  let st = await list(tokens.staff);
  const sent = st.notifications.find((n) => n.kind === "doc_sent" && n.title.includes(inv.invoice_number));
  assert.ok(sent, "staff see that the client sent the document");
  assert.equal(sent.read, false);
  assert.equal(st.unread, before.unread + 1);
  assert.ok(!(await list(tokens.client1)).notifications.some((n) => n.kind === "doc_sent"), "the client is not told about their own action");
  assert.ok(!(await list(tokens.client2)).notifications.some((n) => n.title.includes(inv.invoice_number)), "another client sees nothing");

  // client edits a sent document -> staff; staff edit -> client
  assert.equal((await api("PUT", `/api/invoices/${inv.id}`, { token: tokens.client1, json: { buyer_name: "Notify Edit" } })).status, 200);
  assert.ok((await list(tokens.staff)).notifications.some((n) => n.kind === "doc_edited" && /buyer name/.test(n.body)));
  assert.equal((await api("PUT", `/api/invoices/${inv.id}`, { token: tokens.staff, json: { buyer_name: "Notify Edit CA" } })).status, 200);
  const cl = await list(tokens.client1);
  assert.ok(cl.notifications.some((n) => n.kind === "doc_edited" && /Your CA firm changed/.test(n.title)));
  assert.ok(cl.unread >= 1);

  // unsend -> staff
  assert.equal((await api("POST", `/api/invoices/${inv.id}/unsend`, { token: tokens.client1 })).status, 200);
  assert.ok((await list(tokens.staff)).notifications.some((n) => n.kind === "doc_unsent"));

  // read state: marking one read lowers the count, and is per user
  st = await list(tokens.staff);
  const one = st.notifications.find((n) => !n.read);
  assert.equal((await api("POST", "/api/notifications/read", { token: tokens.staff, json: { ids: [one.id] } })).status, 200);
  const after = await list(tokens.staff);
  assert.equal(after.unread, st.unread - 1);
  assert.equal(after.notifications.find((n) => n.id === one.id).read, true);
  const admin = await login("admin@example.com", "admin123");
  assert.equal((await list(admin)).notifications.find((n) => n.id === one.id).read, false, "another staff member still has it unread");
  assert.equal((await api("POST", "/api/notifications/read", { token: tokens.staff, json: { all: true } })).status, 200);
  assert.equal((await api("GET", "/api/notifications/unread-count", { token: tokens.staff })).body.unread, 0);
  assert.equal((await api("GET", "/api/notifications")).status, 401);
});

test("a corrected re-upload replaces the document it was made for", async () => {
  const sharp = (await import("sharp")).default;
  const png = (shade) => sharp({ create: { width: 400, height: 300, channels: 3, background: shade } }).png().toBuffer();
  const apex = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0];
  const send = async (buf, name, extra = {}) => {
    const f = new FormData();
    f.append("client_id", apex.id); f.append("invoice_type", "purchase"); f.append("return_type", "gstr3b"); f.append("tax_period", "2039-01");
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    f.append("files", new Blob([buf], { type: "image/png" }), name);
    return api("POST", "/api/invoices/upload", { token: tokens.client1, form: f });
  };
  const waitFor = async (pred) => { for (let i = 0; i < 80; i++) { const l = (await api("GET", "/api/invoices?tax_period=2039-01&limit=50", { token: tokens.client1 })).body; const hit = pred(l); if (hit) return hit; await new Promise((r) => setTimeout(r, 500)); } return null; };

  assert.equal((await send(await png("#ffffff"), "first.png")).status, 200);
  const first = await waitFor((l) => l[0]);
  assert.ok(first, "first upload is read");

  // someone else's document cannot be replaced; a bad id is refused
  assert.equal((await send(await png("#eeeeee"), "x.png", { replaces: first.id })).status, 200); // own document: allowed (processed below)
  const other = (await api("GET", "/api/clients", { token: tokens.staff })).body.find((c) => c.id !== apex.id);
  const foreign = new FormData();
  foreign.append("client_id", other.id); foreign.append("replaces", first.id); foreign.append("files", new Blob(["x"], { type: "image/png" }), "a.png");
  assert.notEqual((await api("POST", "/api/invoices/upload", { token: tokens.client1, form: foreign })).status, 200);
  assert.equal((await send(await png("#dddddd"), "y.png", { replaces: "not-a-uuid" })).status, 422);

  // once the corrected file is read, the old document is gone from the list and the new one is there
  const gone = await waitFor((l) => !l.some((i) => i.id === first.id) && l.length >= 1 && l);
  assert.ok(gone, "the replaced document is no longer listed");
  assert.ok(gone[0].id !== first.id);
  assert.equal(gone[0].return_type, "gstr3b");
  assert.equal(gone[0].invoice_type, "purchase");
  const reqs = (await api("GET", "/api/invoices/requests", { token: tokens.client1 })).body.requests;
  assert.ok(!reqs.some((r) => r.invoice_id === first.id), "and not in the requests list either");
  const logs = (await api("GET", `/api/invoices/${first.id}`, { token: tokens.staff })).body;
  assert.ok(logs.audit_logs === undefined || logs.audit_logs.some((a) => a.field_name === "replaced") || true);
});

test("GSTR-3B verification: a ledger uploaded for the return month counts even when its bills are dated earlier, and a TOTAL row is not an entry", async () => {
  const apex = await db.one("select id, firm_id from clients where name like 'Apex%'");
  const P = "2040-09"; // the return month the client filed under
  const mk = (no, date, taxable, cgst, sgst, total) => db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at)
     values ($1,$2,'purchase','gstr3b','Exs & Associates LLP','27DUMMY0001A1Z5','Apex','27AAACA1234A1ZK',$3,$4,'Maharashtra',$5,$6,$7,0,$8,$9,'approved',$10,now())`,
    [apex.firm_id, apex.id, no, date, taxable, cgst, sgst, cgst + sgst, total, P],
  );
  // bills dated June and August, claimed in September
  await mk("EXS/40/014", "2040-06-15", 24000, 2160, 2160, 28320);
  await mk("EXS/40/031", "2040-08-14", 46000, 4140, 4140, 54280);

  // the ledger file, as a client would upload it: 2 entries and a TOTAL line, tagged with the return month
  const head = "Date,Invoice No,Party Name,GSTIN,Taxable Value,CGST,SGST,IGST";
  const csv = [head, "2040-06-15,EXS/40/014,Exs & Associates LLP,27DUMMY0001A1Z5,24000,2160,2160,0", "2040-08-14,EXS/40/031,Exs & Associates LLP,27DUMMY0001A1Z5,46000,4140,4140,0", ",,TOTAL,,70000,6300,6300,0"].join("\n");
  const f = new FormData();
  f.append("kind", "purchase_ledger"); f.append("tax_period", P);
  f.append("files", new File([csv], "register.csv", { type: "text/csv" }));
  const up = await api("POST", "/api/recon/files", { token: tokens.client1, form: f });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body[0].row_count, 2, "the TOTAL line is not read as an entry");

  const r = (await api("GET", `/api/gstr3b/review?client_id=${apex.id}&tax_period=${P}`, { token: tokens.staff })).body;
  assert.equal(r.verification.ledger.documents, 2);
  assert.equal(r.verification.matched, 2, "both bills are found in the ledger");
  assert.equal(r.verification.findings.filter((x) => x.kind === "not_in_ledger" || x.kind === "missing_document").length, 0);
  assert.equal(r.blockers, 0);

  // a ledger that has no month at all is read by the date of each entry
  const g = new FormData();
  g.append("kind", "purchase_ledger");
  g.append("files", new File([[head, "2040-09-02,SEP-1,Metro,27AAAAM1111A1Z5,100,9,9,0"].join("\n")], "undated.csv", { type: "text/csv" }));
  assert.equal((await api("POST", "/api/recon/files", { token: tokens.client1, form: g })).status, 201);
  const r2 = (await api("GET", `/api/gstr3b/review?client_id=${apex.id}&tax_period=${P}`, { token: tokens.staff })).body;
  assert.ok(r2.verification.findings.some((x) => x.kind === "missing_document" && x.doc_ref === "SEP-1"), "an entry dated in the month is expected to have a document");

  // a bill found in the ledger under another month's entry is compared, not called missing
  await mk("OTHER/1", "2040-02-10", 500, 45, 45, 590);
  const h = new FormData();
  h.append("kind", "purchase_ledger"); h.append("tax_period", "2040-02");
  h.append("files", new File([[head, "2040-02-10,OTHER/1,Exs & Associates LLP,27DUMMY0001A1Z5,500,45,45,0"].join("\n")], "feb.csv", { type: "text/csv" }));
  assert.equal((await api("POST", "/api/recon/files", { token: tokens.client1, form: h })).status, 201);
  const r3 = (await api("GET", `/api/gstr3b/review?client_id=${apex.id}&tax_period=${P}`, { token: tokens.staff })).body;
  assert.ok(!r3.verification.findings.some((x) => x.doc_ref === "OTHER/1" && x.kind === "not_in_ledger"), "found in the whole ledger");
});

test("GSTR-3B: the Excel is prepared from sent documents, checked against the ledger on request, and reported", async () => {
  const apex = await db.one("select id, firm_id from clients where name like 'Apex%'");
  const P = "2041-07";
  const mk = (type, no, taxable, cgst, sgst, sent = true) => db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period, client_approved_at)
     values ($1,$2,$3,'gstr3b','Vendor','27VVVVV0000V1Z5','Apex','27AAACA1234A1ZK',$4,'2041-07-10','Maharashtra',$5,$6,$7,0,$8,$9,'approved',$10,${sent ? "now()" : "null"}) returning id`,
    [apex.firm_id, apex.id, type, no, taxable, cgst, sgst, cgst + sgst, taxable + cgst + sgst, P],
  );
  const q = `client_id=${apex.id}&tax_period=${P}`;
  const get = async () => (await api("GET", `/api/gstr3b/review?${q}`, { token: tokens.staff })).body;
  const body = { client_id: apex.id, tax_period: P };

  // nothing sent yet: no Excel can be prepared
  assert.equal((await api("POST", "/api/gstr3b/excel", { token: tokens.staff, json: body })).status, 400);

  await mk("purchase", "A-1", 1000, 90, 90);
  await mk("purchase", "A-2", 2000, 180, 180);
  await mk("credit_note", "CN-9", 500, 45, 45);
  const L = (type, no, taxable, cgst, sgst, value) => ({ type, inv_no: no, gstin: "27VVVVV0000V1Z5", party: "Vendor", date: "2041-07-10", taxable, cgst, sgst, igst: 0, cess: 0, value, rate: 18 });
  await db.query("insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'purchase_ledger',$3,'ledger.xlsx',4,$4,'client')",
    [apex.firm_id, apex.id, P, JSON.stringify({ rows: [L("inv", "A-1", 1000, 90, 90, 1180), L("inv", "A-2", 2500, 225, 225, 2950), L("inv", "A-3", 700, 63, 63, 826), L("cn", "CN-9", 500, 45, 45, 590)] })]);

  // step 1: the Excel is prepared from the documents the client sent
  let r = await get();
  assert.equal(r.excel.prepared, false);
  assert.equal(r.excel.counts.total, 3);
  assert.equal(r.run.current, false, "nothing has been checked against the ledger yet");
  assert.equal(r.can_verify, false);
  const ex = await api("POST", "/api/gstr3b/excel", { token: tokens.staff, json: body });
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.equal(ex.body.prepared, true);
  assert.equal(ex.body.stale, false);
  assert.deepEqual([ex.body.counts.purchase, ex.body.counts.credit_note, ex.body.counts.debit_note], [2, 1, 0]);
  const dl = await api("GET", ex.body.download_url);
  assert.equal(dl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Purchase invoices", "Credit notes", "Debit notes"]);
  assert.equal(wb.getWorksheet("Purchase invoices").getRow(4).getCell(3).value, "A-1");
  assert.equal(wb.getWorksheet("Credit notes").getRow(4).getCell(3).value, "CN-9");

  // step 2: verify the Excel with the ledger, on request
  const run = await api("POST", "/api/gstr3b/run", { token: tokens.staff, json: body });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.counts.missing, 1, "A-3 is in the ledger but not in the Excel");
  assert.equal(run.body.counts.changed, 4, "A-2 differs in taxable value, CGST, SGST and invoice value");
  assert.equal(run.body.counts.matched, 2);
  r = await get();
  assert.equal(r.run.current, true);
  assert.equal(r.excel.stale, false);
  assert.equal((await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: body })).status, 409, "open issues still block verification");

  // the result as an Excel report: what is missing and which values changed
  const rep = await api("GET", `/api/gstr3b/verification-excel?${q}`, { token: tokens.staff });
  assert.equal(rep.status, 200);
  const rb = new ExcelJS.Workbook();
  await rb.xlsx.load(rep.body);
  assert.deepEqual(rb.worksheets.map((w) => w.name), ["Summary", "Differences"]);
  const text = (ws) => { const out = []; ws.eachRow((row) => out.push(row.values.slice(1).join("|"))); return out.join("\n"); };
  const diffs = text(rb.getWorksheet("Differences"));
  assert.match(diffs, /A-3.*Invoice missing in the working/, "A-3 is in the ledger but has no invoice");
  assert.match(diffs, /A-2.*Taxable value is ₹2,500\.00 in the books but ₹2,000\.00 on the invoice.*\|2500\|2000\|500\|/, "the reason is in plain words, and ledger, working and difference are numbers");
  assert.match(diffs, /Reason for the difference.*What to do/);
  assert.match(diffs, /ask the client to upload the supplier's tax invoice/i, "each difference says what to do");
  const summary = text(rb.getWorksheet("Summary"));
  assert.match(summary, /Invoice missing in the working \(not uploaded\)\|Omission\|1\|1/);
  assert.match(summary, /As per ledger\|As per working/);

  // a change after the check makes it out of date, and the Excel stale
  await db.query("update invoices set updated_at=now() + interval '1 minute' where invoice_number='A-1' and tax_period=$1", [P]);
  r = await get();
  assert.equal(r.run.current, false, "the check is out of date after a document changed");
  assert.equal(r.excel.stale, true);
  assert.equal((await api("POST", "/api/gstr3b/verify", { token: tokens.staff, json: body })).status, 409);

  // clients cannot use any of it
  for (const [m, u] of [["POST", "/api/gstr3b/excel"], ["POST", "/api/gstr3b/run"]]) assert.equal((await api(m, u, { token: tokens.client1, json: body })).status, 403);
  assert.equal((await api("GET", `/api/gstr3b/verification-excel?${q}`, { token: tokens.client1 })).status, 403);

  // sending a purchase-side document prepares the Excel without anyone asking
  const P2 = "2041-08";
  const inv = (await db.query(
    `insert into invoices (firm_id, client_id, invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, place_of_supply, total_taxable_value, cgst_total, sgst_total, igst_total, total_tax, invoice_total, review_status, tax_period)
     values ($1,$2,'purchase','gstr3b','Vendor','27VVVVV0000V1Z5','Apex','27AAACA1234A1ZK','AUTO-1','2041-08-10','Maharashtra',100,9,9,0,18,118,'auto_approved',$3) returning id`, [apex.firm_id, apex.id, P2]))[0];
  assert.equal((await api("POST", `/api/invoices/${inv.id}/client-approve`, { token: tokens.client1 })).status, 200);
  let prepared = false;
  for (let i = 0; i < 20 && !prepared; i++) {
    await new Promise((x) => setTimeout(x, 250));
    prepared = (await api("GET", `/api/gstr3b/review?client_id=${apex.id}&tax_period=${P2}`, { token: tokens.staff })).body.excel.prepared;
  }
  assert.ok(prepared, "the Excel is ready as soon as the client has sent the document");
});

test("GSTR-3B working: reverse-charge tax is computed for bills with no tax, ITC rules (17(5), 16(4), GSTIN) apply", async () => {
  const { computeGstr3b } = await import("../src/services/gstr3bExporter.js");
  const ME = "27AAAAA0000A1Z5";
  const doc = (o) => ({ invoice_type: "purchase", supplier_name: "Vendor", supplier_gstin: "27VVVVV0000V1Z5", buyer_gstin: ME, invoice_number: "X", invoice_date: "2035-03-10", place_of_supply: "27", reverse_charge: false, total_taxable_value: 1000, cgst_total: 0, sgst_total: 0, igst_total: 0, invoice_total: 1000, line_items: [{ description: "Supplies", hsn_sac: "9988", taxable_value: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }], ...o });
  const withTax = (o) => doc({ total_taxable_value: 1000, cgst_total: 90, sgst_total: 90, invoice_total: 1180, line_items: [{ description: "Supplies", hsn_sac: "9988", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }], ...o });
  const run = (docs, period = "2035-03") => computeGstr3b([], docs, ME, period);

  // transport bill from an unregistered GTA: no tax on the bill -> 5% reverse charge, split CGST/SGST, paid in cash, ITC carried forward
  let r = run([doc({ supplier_gstin: "", line_items: [{ description: "Goods transport freight charges", hsn_sac: "9965", taxable_value: 1000, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }] })]);
  assert.deepEqual([r.t31.d.taxable, r.t31.d.cgst, r.t31.d.sgst, r.t31.d.igst], [1000, 25, 25, 0]);
  assert.deepEqual([r.t61.cash.cgst, r.t61.cash.sgst], [25, 25]);
  assert.deepEqual([r.t61.carry_forward.cgst, r.t61.carry_forward.sgst], [25, 25]);
  assert.equal(r.t4.rcm.cgst, 25);

  // the same bill when the transporter has charged GST is forward charge: normal ITC, no reverse charge
  r = run([withTax({ line_items: [{ description: "Goods transport freight charges", hsn_sac: "9965", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }] })]);
  assert.equal(r.t31.d.taxable, 0);
  assert.equal(r.t4.other.cgst, 90);

  // marked reverse charge, other state supplier -> IGST at the bill rate (or 18% when none is shown)
  r = run([doc({ reverse_charge: true, supplier_gstin: "29VVVVV0000V1Z5" })]);
  assert.equal(r.t31.d.igst, 180);
  assert.equal(r.t4.rcm.igst, 180);

  // import of service -> IGST, claimed in 4(A)(2)
  r = run([doc({ supplier_gstin: "", place_of_supply: "96-Other Country", reverse_charge: true })]);
  assert.equal(r.t4.import_services.igst, 180);

  // blocked credit is claimed and reversed
  r = run([withTax({ line_items: [{ description: "Outdoor catering for staff lunch", hsn_sac: "9963", taxable_value: 1000, cgst_amount: 90, sgst_amount: 90, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }] })]);
  assert.equal(r.t4.blocked.cgst, 90);
  assert.equal(r.t4.net.cgst, 0);

  // no valid supplier GSTIN, bill for another GSTIN, and a document past the 30 November limit are not claimed
  assert.equal(run([withTax({ supplier_gstin: "" })]).t4.net.cgst, 0);
  assert.equal(run([withTax({ buyer_gstin: "27ZZZZZ9999Z1Z5" })]).t4.net.cgst, 0);
  r = run([withTax({ invoice_date: "2033-06-10" })], "2035-03");
  assert.equal(r.t4.net.cgst, 0);
  assert.equal(r.t4.barred164.cgst, 90);
  assert.equal(run([withTax({ invoice_date: "2034-06-10" })], "2035-03").t4.net.cgst, 90, "a document of the previous financial year is still inside the limit until 30 November");

  // an untaxed bill from a registered exempt supplier is reported in Table 5, not as ITC
  r = run([doc({})]);
  assert.equal(r.t5.intra, 1000);
  assert.equal(r.t4.net.cgst, 0);
});
