import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-recon-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { parseGstr3bText } = await import("../src/services/recon/gstr3bParser.js");
const ExcelJS = (await import("exceljs")).default;

let server, base, staff, client1, clientRow;

async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
}
const login = async (email, password) => (await api("POST", "/api/auth/login", { json: { email, password } })).body.access_token;

async function xlsxFile(name, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [sn, rows] of Object.entries(sheets)) { const ws = wb.addWorksheet(sn); rows.forEach((r) => ws.addRow(r)); }
  const buf = await wb.xlsx.writeBuffer();
  return new File([buf], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
function form(fields, file) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("files", file);
  return f;
}

before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  staff = await login("staff@example.com", "staff123");
  client1 = await login("client1@example.com", "client123");
  clientRow = (await api("GET", "/api/clients", { token: client1 })).body[0];
});
after(async () => { server.close(); await db.close(); });

test("GSTR-3B text parser reads single-line table rows", () => {
  const text = `GSTR-3B\nYear: 2025-26\nPeriod: June\n3.1 Details of Outward Supplies\n(a) Outward taxable supplies (other than zero rated, nil rated and exempted) 100,000.00 0.00 9,000.00 9,000.00 0.00\n(b) Outward taxable supplies (zero rated) 0.00 0.00 0.00 0.00 0.00\n(c) Other outward supplies (Nil rated, exempted) 5,000.00 0.00 0.00 0.00 0.00\n(d) Inward supplies (liable to reverse charge) 2,000.00 0.00 180.00 180.00 0.00\n(e) Non-GST outward supplies 0.00 0.00 0.00 0.00 0.00\n4. Eligible ITC\n(5) All other ITC 0.00 4,500.00 4,500.00 0.00\n`;
  const r = parseGstr3bText(text);
  assert.equal(r.period, "2025-06");
  assert.equal(r.figures.outward.a.taxable, 100000);
  assert.equal(r.figures.outward.a.cgst, 9000);
  assert.equal(r.figures.outward.c.taxable, 5000);
  assert.equal(r.figures.outward.d.sgst, 180);
  assert.equal(r.figures.itc.other.cgst, 4500);
});

test("clients may upload ledgers and GSTR-1 but not GSTR-2B / 3B", async () => {
  const f = await xlsxFile("g1.xlsx", { b2b: [["GSTIN/UIN of Recipient", "Invoice Number", "Invoice date", "Invoice Value", "Rate", "Taxable Value"], ["27AAAAA0000A1Z5", "A1", "05-06-2025", 118, 18, 100]] });
  const r = await api("POST", "/api/recon/files", { token: client1, form: form({ kind: "gstr2b", tax_period: "2025-06" }, f) });
  assert.equal(r.status, 403);
});

test("output reconciliation: ledger vs portal GSTR-1 finds the planted differences", async () => {
  const ledger = await xlsxFile("sales.xlsx", { Sales: [
    ["Date", "Invoice No", "Party Name", "GSTIN", "Place of Supply", "Taxable Value", "Rate %", "IGST", "CGST", "SGST", "Invoice Value"],
    ["2025-06-03", "INV-1", "Alpha Ltd", "27AAAAA0000A1Z5", "Maharashtra", 10000, 18, 0, 900, 900, 11800],
    ["2025-06-10", "INV-2", "Beta Ltd", "29BBBBB1111B1Z5", "Karnataka", 20000, 18, 3600, 0, 0, 23600],
    ["2025-06-15", "INV-3", "Gamma Ltd", "27CCCCC2222C1Z5", "Maharashtra", 5000, 12, 0, 300, 300, 5600],
  ] });
  const up = await api("POST", "/api/recon/files", { token: client1, form: form({ kind: "sales_ledger" }, ledger) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body[0].row_count, 3);

  const portal = await xlsxFile("gstr1.xlsx", { b2b: [
    ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Rate", "Taxable Value", "Integrated Tax", "Central Tax", "State/UT Tax", "Cess"],
    ["27AAAAA0000A1Z5", "Alpha Ltd", "INV-1", "03-06-2025", 11800, "27-Maharashtra", 18, 10000, 0, 900, 900, 0],
    ["29BBBBB1111B1Z5", "Beta Ltd", "INV-2", "10-06-2025", 22000, "29-Karnataka", 18, 18000, 3240, 0, 0, 0],
  ] });
  const pr = await api("POST", "/api/recon/files", { token: staff, form: form({ kind: "gstr1_portal", tax_period: "2025-06", client_id: clientRow.id }, portal) });
  assert.equal(pr.status, 201, JSON.stringify(pr.body));
  assert.equal(pr.body[0].row_count, 2);

  const rep = await api("GET", `/api/recon/output?client_id=${clientRow.id}&from=2025-06&to=2025-06`, { token: staff });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  const month = rep.body.sections.find((s) => s.key === "books_g1_month").rows.find((r) => r.period === "2025-06");
  assert.equal(month.taxable_a, 35000);
  assert.equal(month.taxable_b, 28000);
  assert.equal(month.status, "Difference");
  assert.ok(month.reason);
  const docs = rep.body.sections.find((s) => s.key === "books_g1_docs").rows;
  assert.ok(docs.some((d) => d.kind === "only_a" && d.inv_no === "INV-3"));
  assert.ok(docs.some((d) => d.kind === "value_mismatch" && d.inv_no === "INV-2"));
  assert.ok(rep.body.discrepancies.every((d) => d.reason && d.action));
  assert.ok(rep.body.missing.some((m) => /GSTR-3B/.test(m)));

  const xl = await api("GET", `/api/recon/export/output?client_id=${clientRow.id}&from=2025-06&to=2025-06`, { token: staff });
  assert.equal(xl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xl.body);
  assert.ok(wb.worksheets.length >= 8);
  assert.ok(wb.worksheets.some((w) => /Discrepancy/.test(w.name)));
});

test("input, 3B, GSTR-9 and 9C reports build without data and with 3B figures", async () => {
  const f3b = await db.one("select 1 as x");
  void f3b;
  await db.query(
    "insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'gstr3b','2025-06','x.pdf',10,$3,'staff')",
    [(await db.one("select firm_id from clients where id=$1", [clientRow.id])).firm_id, clientRow.id, JSON.stringify({ figures: { outward: { a: { taxable: 28000, igst: 3240, cgst: 900, sgst: 900, cess: 0 } }, itc: { other: { igst: 10, cgst: 5, sgst: 5, cess: 0 } } }, meta: {} })],
  );
  for (const [p, q] of [["input", "from=2025-06&to=2025-06"], ["gstr3b", "from=2025-06&to=2025-06"], ["gstr9", "fy=2025"], ["gstr9c", "fy=2025&fin_turnover=40000"]]) {
    const r = await api("GET", `/api/recon/${p}?client_id=${clientRow.id}&${q}`, { token: staff });
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.sections.length > 0, p);
    const x = await api("GET", `/api/recon/export/${p}?client_id=${clientRow.id}&${q}`, { token: staff });
    assert.equal(x.status, 200, `${p} export`);
  }
  const out = await api("GET", `/api/recon/output?client_id=${clientRow.id}&from=2025-06&to=2025-06`, { token: staff });
  const row = out.body.sections.find((s) => s.key === "books_3b").rows.find((r) => r.period === "2025-06");
  assert.equal(row.taxable_b, 28000);
});

test("output pack: six Excel-only workbooks, books matched against system invoices", async () => {
  const q = `client_id=${clientRow.id}&from=2025-06&to=2025-06`;
  const st = await api("GET", `/api/recon/output-status?${q}`, { token: staff });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  assert.equal(st.body.ledger_entries, 3);
  for (const name of ["books", "g1working", "g1_3b", "working_g1", "books_working", "books_3b"]) {
    const x = await api("GET", `/api/recon/output-export/${name}?${q}`, { token: staff });
    assert.equal(x.status, 200, name);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    assert.ok(wb.worksheets.length >= 3, name);
    if (name === "books") assert.ok(wb.worksheets.some((w) => /Each ledger entry/.test(w.name)));
  }
  assert.equal((await api("GET", `/api/recon/output-export/books?${q}`, { token: client1 })).status, 403);
  assert.equal((await api("GET", `/api/recon/output-export/nope?${q}`, { token: staff })).status, 404);
});
