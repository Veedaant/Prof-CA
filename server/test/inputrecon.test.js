import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-inrecon-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { readFile } = await import("../src/services/storage.js");
const { generatePurchaseExcel } = await import("../src/services/registerExporter.js");

let server, base, clientId;
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
  clientId = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
});
after(async () => { server.close(); await db.close(); });

async function xlsx(rows, sheet = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const up = (kind, files, fields = {}, token = tokens.staff) => {
  const fd = new FormData();
  fd.append("client_id", clientId); fd.append("fy", "2025-26"); fd.append("kind", kind);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [name, content] of files) fd.append("files", new Blob([content]), name);
  return api("POST", "/api/input-recon/upload", { token, form: fd });
};
const list = async () => (await api("GET", `/api/input-recon?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).body;

const LEDGER = (name) => [
  [name], ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  ["01-04-2025", "Opening Balance", "", "", 50000, ""],
  ["10-08-2025", "By ABC Traders", "Purchase", "7", 18000, ""],
  ["20-09-2025", "To GST Payment", "Payment", "9", "", 12000],
];
const CASH_FILE = await xlsx(LEDGER("Cash ledger")); // one file, so a repeat upload is byte for byte the same
const GSTR2B = [
  ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "GSTR-1/IFF/GSTR-5 Period", "ITC Availability"],
  ["27SPEED1234R1Z5", "Speedy Roadways", "G-2", "Regular", "06-08-2025", 23600, "27-Maharashtra", "No", 20000, 0, 1800, 1800, 0, "082025", "Yes"],
  ["27PLAIN1234P1Z5", "Plain Trader", "P-6", "Regular", "10-08-2025", 1180, "27-Maharashtra", "No", 1000, 0, 90, 90, 0, "082025", "Yes"],
];
const GSTR3B = [
  ["Form GSTR-3B"], ["3.1 Details of Outward Supplies and inward supplies liable to reverse charge"],
  ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", 100000, 0, 9000, 9000, 0],
  ["(b) Outward taxable supplies (zero rated)", 0, 0, 0, 0, 0], ["(c) Other outward supplies (Nil rated, exempted)", 0, 0, 0, 0, 0],
  ["(d) Inward supplies (liable to reverse charge)", 0, 0, 0, 0, 0], ["(e) Non-GST outward supplies", 0, 0, 0, 0, 0],
  ["4. Eligible ITC"], ["(5) All other ITC", 0, 1890, 1890, 0],
];
const PORTAL_LEDGER = [
  ["Electronic Credit Ledger"], ["Date", "Reference No", "Tax Period", "Description", "Transaction Type", "IGST", "CGST", "SGST", "Cess", "Total", "Balance"],
  ["05-08-2025", "ABCD1234", "Aug-25", "ITC credited", "Cr", 0, 1800, 1800, 0, 3600, 3600],
  ["20-09-2025", "DEF567", "Sep-25", "Tax paid", "Dr", 0, 900, 900, 0, 1800, 1800],
];

test("only the CA firm can use the section", async () => {
  assert.equal((await api("GET", `/api/input-recon?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("GET", `/api/input-recon?client_id=${clientId}&fy=2025-26`)).status, 401);
  assert.equal((await up("books_itc", [["l.xlsx", await xlsx(LEDGER("x"))]], {}, tokens.client1)).status, 403);
});

test("every sub-section takes its files and says what each holds", async () => {
  const one = async (kind, name, content) => { const r = await up(kind, [[name, content]]); assert.equal(r.status, 200, kind); assert.equal(r.body.results[0].ok, true, `${kind}: ${JSON.stringify(r.body.results[0])}`); return r.body.results[0]; };
  const itc = await one("books_itc", "input-itc-ledger.xlsx", await xlsx(LEDGER("Input CGST")));
  assert.deepEqual([itc.read, itc.rows], [true, 2]);
  await one("books_cash", "cash-ledger.xlsx", CASH_FILE);
  await one("books_tdstcs", "tds-tcs.xlsx", await xlsx(LEDGER("TDS receivable under GST")));
  const b2 = await one("gstr2b", "GSTR2B_082025.xlsx", await xlsx(GSTR2B, "B2B"));
  assert.deepEqual([b2.read, b2.rows], [true, 2]);
  const b3 = await one("gstr3b", "GSTR3B_Aug-2025.xlsx", await xlsx(GSTR3B, "GSTR-3B"));
  assert.equal(b3.read, true);
  const pl = await one("portal_credit", "credit-ledger.xlsx", await xlsx(PORTAL_LEDGER));
  assert.deepEqual([pl.read, pl.rows], [true, 2]);
  await one("portal_cash", "cash-ledger-portal.xlsx", await xlsx(PORTAL_LEDGER));

  const l = await list();
  assert.deepEqual(l.files.map((f) => f.kind).sort(), ["books_cash", "books_itc", "books_tdstcs", "gstr2b", "gstr3b", "portal_cash", "portal_credit"]);
  const f = Object.fromEntries(l.files.map((x) => [x.kind, x]));
  assert.deepEqual([f.books_itc.info.from, f.books_itc.info.to], ["2025-08-10", "2025-09-20"]);
  assert.equal(f.gstr2b.period, "2025-08");
  assert.equal(f.gstr3b.period, "2025-08");
  assert.equal(f.books_itc.period, null, "ledgers are not tied to a month");
  assert.deepEqual([f.portal_credit.info.from, f.portal_credit.info.to], ["2025-08-05", "2025-09-20"]);
});

test("a file that cannot be read is kept with the reason; wrong types and repeats are refused", async () => {
  const csv = await up("portal_cash", [["cash-ledger.csv", "Date,Reference No,Description,IGST,CGST,SGST,Total\n05-08-2025,ABC,Deposit,0,1800,1800,3600"]]);
  assert.deepEqual([csv.body.results[0].read, csv.body.results[0].rows], [true, 1], "a CSV download is read too");
  const junk = await up("books_itc", [["odd-layout.xlsx", await xlsx([["nothing", "useful"]])]]);
  assert.equal(junk.body.results[0].ok, true);
  assert.equal(junk.body.results[0].read, false);
  assert.match(junk.body.results[0].warnings.join(" "), /Not read yet: No ledger table found/);

  const wrong = await up("gstr2b", [["gstr2b.pdf", "not a sheet"]]);
  assert.equal(wrong.body.results[0].ok, false);
  assert.match(wrong.body.results[0].error, /Unsupported file type/);
  const again = await up("books_cash", [["cash-ledger.xlsx", CASH_FILE]]);
  assert.equal(again.body.results[0].ok, false);
  assert.match(again.body.results[0].error, /already uploaded/);

  assert.equal((await up("nonsense", [["a.xlsx", "x"]])).status, 422);
  assert.equal((await up("books_itc", [["a.xlsx", "x"]], { fy: "2025-27" })).status, 422);
});

test("dates outside the year are pointed out; the month of a return can be changed", async () => {
  const old = LEDGER("Input ledger").map((r) => (typeof r[0] === "string" && /2025/.test(r[0]) ? [r[0].replace("2025", "2023"), ...r.slice(1)] : r));
  const r = await up("books_itc", [["old-year.xlsx", await xlsx(old)]]);
  assert.match(r.body.results[0].warnings.join(" "), /outside 2025-26/);

  const b3 = (await list()).files.find((f) => f.kind === "gstr3b");
  const other = GSTR3B.map((r, i) => (i === 2 ? [r[0], 100001, ...r.slice(2)] : r)); // not byte for byte the same as the August return
  const noMonth = await up("gstr3b", [["return.xlsx", await xlsx(other, "GSTR-3B")]]);
  assert.match(noMonth.body.results[0].warnings.join(" "), /return month could not be found/);
  const id = (await list()).files.find((f) => f.name === "return.xlsx").id;
  assert.equal((await api("PUT", `/api/input-recon/file/${id}`, { token: tokens.staff, json: { period: "2025-10" } })).body.outside, false);
  assert.equal((await api("PUT", `/api/input-recon/file/${id}`, { token: tokens.staff, json: { period: "2026-04" } })).body.outside, true);
  assert.equal((await api("PUT", `/api/input-recon/file/${id}`, { token: tokens.staff, json: { period: "April" } })).status, 422);
  assert.equal((await api("PUT", `/api/input-recon/file/${b3.id}`, { token: tokens.client1, json: { period: "2025-10" } })).status, 403);
  const ledger = (await list()).files.find((f) => f.kind === "books_cash");
  assert.equal((await api("PUT", `/api/input-recon/file/${ledger.id}`, { token: tokens.staff, json: { period: "2025-10" } })).status, 422, "a ledger has no month");
});

test("a file can be downloaded again, and deleting it removes it from storage", async () => {
  const f = (await list()).files.find((x) => x.kind === "books_tdstcs");
  const dl = await api("GET", `/api/input-recon/file/${f.id}/download`, { token: tokens.staff });
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get("content-disposition"), /^attachment; filename="tds-tcs\.xlsx"/);
  const stored = (await db.one("select storage_path from input_recon_files where id=$1", [f.id])).storage_path;
  assert.ok((await readFile(stored)).length > 0);
  assert.equal((await api("DELETE", `/api/input-recon/file/${f.id}`, { token: tokens.client1 })).status, 403);
  assert.equal((await api("DELETE", `/api/input-recon/file/${f.id}`, { token: tokens.staff })).status, 200);
  await assert.rejects(readFile(stored), /not found/);
  assert.equal((await api("DELETE", `/api/input-recon/file/${f.id}`, { token: tokens.staff })).status, 404);
  assert.ok(!(await list()).files.some((x) => x.id === f.id));
});

/* ------------------------------------------------------------------ combined Excel */

const ME = "27AAACA1234A1ZK";
const purchase = (no, gstin, name, taxable, cgst, sgst, over = {}, desc = "Supplies") => ({
  invoice_type: "purchase", invoice_number: no, invoice_date: "2025-07-10", supplier_name: name, supplier_gstin: gstin, buyer_gstin: ME, reverse_charge: false,
  total_taxable_value: taxable, cgst_total: cgst, sgst_total: sgst, igst_total: 0, invoice_total: taxable + cgst + sgst, place_of_supply: "27",
  line_items: [{ description: desc, hsn_sac: "9988", taxable_value: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }], ...over,
});
const register = (period, extra = {}) => generatePurchaseExcel({
  purchase: [
    purchase("A-1", "27AABCU9603R1ZM", "Alpha Traders", 1000, 90, 90),
    purchase("T-5", "", "Local Transport Co", 10000, 0, 0, { invoice_date: "2025-08-12", line_items: [{ description: "Goods transport freight charges", hsn_sac: "9965", taxable_value: 10000, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }] }),
  ],
  credit_note: [{ ...purchase("CN-1", "27AABCU9603R1ZM", "Alpha Traders", 100, 9, 9, { invoice_date: "2025-07-20" }), invoice_type: "credit_note" }],
  debit_note: [], ...extra,
}, { clientName: "Apex", clientGstin: ME, taxPeriod: period });

const sheetText = (wb, name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
async function download(url) {
  const r = await api("GET", url, { token: tokens.staff });
  const wb = new ExcelJS.Workbook();
  if (r.status === 200) await wb.xlsx.load(r.body);
  return { r, wb };
}

test("the Input ITC ledger files are combined into one Excel with the details of every invoice", async () => {
  const empty = await api("GET", `/api/input-recon/combined/itc?client_id=${clientId}&fy=2024-25`, { token: tokens.staff });
  assert.equal(empty.status, 409);
  assert.match(empty.body.detail, /Upload the Input ITC ledger first/);
  assert.equal((await api("GET", `/api/input-recon/combined/itc?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);

  const a = await up("books_itc", [["itc-register-jul.xlsx", await register("2025-07")]]);
  assert.deepEqual([a.body.results[0].ok, a.body.results[0].read], [true, true]);
  const files = (await list()).files.filter((f) => f.kind === "books_itc");
  assert.equal(files.find((f) => f.name === "itc-register-jul.xlsx").info.format, "register");
  assert.equal(files.find((f) => f.name === "input-itc-ledger.xlsx").info.format, "ledger");

  const { r, wb } = await download(`/api/input-recon/combined/itc?client_id=${clientId}&fy=2025-26`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="Input_ITC_ledger_combined_2025-26_/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 ITC Register Combined", "2 Month-wise Summary", "3 Party-wise Summary", "4 Ledger Entries", "Notes"]);

  const s1 = sheetText(wb, "1 ITC Register Combined");
  assert.match(s1, /Period \| Invoice date \| Document type \| Party name \| GSTIN \| Invoice no/);
  assert.match(s1, /Jul-25 \| 2025-07-10 \| Invoice \| Alpha Traders \| 27AABCU9603R1ZM \| A-1 \|.*Normal supply \(forward charge\)/);
  assert.match(s1, /Jul-25 \| 2025-07-20 \| Credit note \| Alpha Traders/);
  assert.match(s1, /Aug-25 \| 2025-08-12 \| Invoice \| Local Transport Co.*Reverse charge \(RCM\)/);
  assert.match(s1, /Jul-25 \| 2025-07-10 \| Invoice \| Alpha Traders \| 27AABCU9603R1ZM \| A-1 \| Supplies \| As per the register \| Intra-state \| Normal supply \(forward charge\) \|  \| 1000 \| 18 \| 0 \| 90 \| 90 \| 0 \| 180 \| 0 \| 1180 \| itc-register-jul\.xlsx/);
  assert.match(s1, /Jul-25 \| 2025-07-20 \| Credit note \| Alpha Traders .* \| -100 \| 18 \| 0 \| -9 \| -9 \| 0 \| -18 \|/, "a credit note is negative");
  assert.match(s1, /Aug-25 \| 2025-08-12 \| Invoice \| Local Transport Co \|  \| T-5 \|.*Reverse charge \(RCM\) \| Section 9\(3\) CGST Act.*\| 10000 \| 5 \| 0 \| 250 \| 250 \| 0 \| 500 \| 500 \| 10000/);
  const s2 = sheetText(wb, "2 Month-wise Summary");
  assert.match(s2, /Jul-25 \| 2 \| 900 \| 0 \| 81 \| 81 \| 0 \| 162 \| 0 \| 0/);
  assert.match(s2, /Aug-25 \| 1 \| 10000 \| 0 \| 250 \| 250 \| 0 \| 500 \| 1 \| 500/);
  assert.match(sheetText(wb, "3 Party-wise Summary"), /Alpha Traders \| 27AABCU9603R1ZM \| 2 \| 900 \| 0 \| 81 \| 81 \| 0 \| 162/);
  assert.match(sheetText(wb, "4 Ledger Entries"), /ABC Traders/);
  const notes = sheetText(wb, "Notes");
  assert.match(notes, /itc-register-jul\.xlsx: 3 line\(s\) read as an ITC register/);
  assert.match(notes, /odd-layout\.xlsx: could not be read and is not included/);
  assert.match(notes, /old-year\.xlsx: 2 line\(s\) read as a ledger\. The dates in this file/);
});

test("GSTR-2B and GSTR-3B of every month are combined, with the ITC of 2B set against 3B", async () => {
  const empty = await api("GET", `/api/input-recon/combined/portal?client_id=${clientId}&fy=2024-25`, { token: tokens.staff });
  assert.equal(empty.status, 409);

  const sep2b = [GSTR2B[0],
    ["27BETAS1234B1Z5", "Beta Supplies", "B-1", "Regular", "05-09-2025", 11800, "27-Maharashtra", "No", 10000, 0, 900, 900, 0, "092025", "Yes"],
    ["27RENTX1234R1Z5", "Rent Co", "R-1", "Regular", "07-09-2025", 5900, "27-Maharashtra", "Yes", 5000, 0, 450, 450, 0, "092025", "No"]];
  const sep3b = [...GSTR3B.slice(0, GSTR3B.length - 1), ["(5) All other ITC", 0, 1000, 1000, 0]];
  assert.equal((await up("gstr2b", [["GSTR2B_092025.xlsx", await xlsx(sep2b, "B2B")]])).body.results[0].read, true);
  assert.equal((await up("gstr3b", [["GSTR3B_Sep-2025.xlsx", await xlsx(sep3b, "GSTR-3B")]])).body.results[0].read, true);

  const { r, wb } = await download(`/api/input-recon/combined/portal?client_id=${clientId}&fy=2025-26`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="GSTR-2B_and_3B_combined_2025-26_/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 GSTR-2B Combined", "2 GSTR-2B Month-wise", "3 GSTR-3B Combined", "4 ITC as per 2B and 3B", "Notes"]);

  const s1 = sheetText(wb, "1 GSTR-2B Combined");
  assert.match(s1, /Return period \| Table \| Document type \| Supplier GSTIN \| Party name \| Invoice \/ note no \| Invoice \/ note date \| Taxable value/);
  assert.match(s1, /Aug-25 \| B2B invoices \| Invoice \| 27SPEED1234R1Z5 \| Speedy Roadways \| G-2 \| 2025-08-06 \| 20000 \| 0 \| 1800 \| 1800 \| 0 \| 3600 \| 23600 \| 27-Maharashtra \| Normal supply \| Yes/);
  assert.match(s1, /Sep-25 \| B2B invoices \| Invoice \| 27RENTX1234R1Z5 \| Rent Co .*Reverse charge \(RCM\) \| No/);
  const s2 = sheetText(wb, "2 GSTR-2B Month-wise");
  assert.match(s2, /Aug-25 \| 2 \| 21000 \| 0 \| 1890 \| 1890 \| 0 \| 3780 \| 0 \| 0 \| 3780/);
  assert.match(s2, /Sep-25 \| 2 \| 15000 \| 0 \| 1350 \| 1350 \| 0 \| 2700 \| 900 \| 0 \| 1800/);
  const s3 = sheetText(wb, "3 GSTR-3B Combined");
  assert.match(s3, /Table 3\.1: outward supplies and inward supplies liable to reverse charge/);
  assert.match(s3, /Aug-25 \| 100000 \| 0 \| 9000 \| 9000 \| 0/);
  assert.match(s3, /Table 4: input tax credit/);
  assert.match(s3, /Aug-25 \| 0 \| 1890 \| 1890 \| 0 \| 0/);
  assert.match(s3, /Sep-25 \| 0 \| 1000 \| 1000 \| 0 \| 0/);
  const s4 = sheetText(wb, "4 ITC as per 2B and 3B");
  assert.match(s4, /Aug-25 \| 0 \| 1890 \| 1890 \| 0 \| 3780 \| 0 \| 1890 \| 1890 \| 0 \| 3780 \| 0 \| 0 \| 0 \| 0 \| 0 \| Agrees/);
  assert.match(s4, /Sep-25 \| 0 \| 900 \| 900 \| 0 \| 1800 \| 0 \| 1000 \| 1000 \| 0 \| 2000 \| 0 \| -100 \| -100 \| 0 \| -200 \| ITC claimed in 3B is more than 2B by Rs 200/);
  assert.match(s4, /Oct-25 \|[ |]*Neither GSTR-2B nor GSTR-3B uploaded/);
  assert.match(sheetText(wb, "Notes"), /GSTR-2B Aug-25, GSTR2B_082025\.xlsx: 2 line\(s\) read/);

  // only one of the two present: that part is combined, the rest is said to be missing
  await db.query("delete from input_recon_files where kind='gstr3b'");
  const only2b = await download(`/api/input-recon/combined/portal?client_id=${clientId}&fy=2025-26`);
  assert.deepEqual(only2b.wb.worksheets.map((s) => s.name), ["1 GSTR-2B Combined", "2 GSTR-2B Month-wise", "4 ITC as per 2B and 3B", "Notes"]);
  assert.match(sheetText(only2b.wb, "Notes"), /No GSTR-3B file could be read/);
});

/* ------------------------------------------------------------------ nature of services, from every document held for the party */

test("a Particulars column is the party, and the nature of services comes from the documents held for that party", async () => {
  const firm = await db.one("select firm_id from clients where id=$1", [clientId]);
  const firmId = firm.firm_id;

  // an invoice of Alpha Traders in the system, with its line items
  const inv = await db.one(
    `insert into invoices (firm_id, client_id, invoice_type, supplier_name, supplier_gstin, invoice_number, invoice_date, invoice_total, review_status)
     values ($1,$2,'purchase','Gamma Stationers Pvt Ltd','27GAMMA1234G1Z5','GS-100','2025-07-02',1180,'approved') returning id`, [firmId, clientId]);
  await db.query("insert into line_items (invoice_id, description, hsn_sac) values ($1,'Office stationery and printing paper','4820'), ($1,'Office stationery and printing paper','4820')", [inv.id]);

  // the bank ledger and a bank statement name two other parties
  await db.query(
    `insert into banking_staff_files (firm_id, client_id, fy, kind, account_number, original_filename, storage_path, file_size, mime_type, file_hash, parsed)
     values ($1,$2,'2025-26','bank_ledger','50100123456789','ledger.xlsx','x/ledger.xlsx',1,'application/octet-stream','h1',$3::jsonb)`,
    [firmId, clientId, JSON.stringify({ entries: [{ date: "2025-08-12", party: "Delta Carriers", narration: "Freight charges Mumbai to Pune", debit: 0, credit: 10000 }] })]);
  const sub = await db.one(
    `insert into banking_submissions (firm_id, client_id, section, account_number, bank_name, fy, period_from, period_to) values ($1,$2,'statement','50100123456789','HDFC Bank','2025-26','2025-04','2025-06') returning id`, [firmId, clientId]);
  await db.query(
    `insert into banking_files (submission_id, kind, storage_path, original_filename, file_size, mime_type, file_hash, parsed, parsed_ver) values ($1,'statement','x/s.csv','s.csv',1,'text/csv','h2',$2::jsonb,1)`,
    [sub.id, JSON.stringify({ txns: [{ date: "2025-08-05", narration: "NEFT-EPSILON PROPERTIES LTD-OFFICE RENT AUG", debit: 25000, credit: 0 }] })]);

  // a register whose party is in a Particulars column and which has no nature column
  const reg = await xlsx([
    ["Date", "Particulars", "GSTIN", "Invoice No", "Taxable Value", "IGST", "CGST", "SGST"],
    ["02-07-2025", "Gamma Stationers Pvt Ltd", "27GAMMA1234G1Z5", "GS-100", 1000, 0, 90, 90],
    ["12-08-2025", "Delta Carriers", "27DELTA1234D1Z5", "DC-7", 10000, 0, 0, 0],
    ["05-08-2025", "Epsilon Properties Ltd", "27EPSIL1234E1Z5", "EP-3", 25000, 0, 2250, 2250],
    ["06-08-2025", "Speedy Roadways", "27SPEED1234R1Z5", "SR-1", 5000, 0, 450, 450],
    ["07-08-2025", "Zeta Corp", "27ZETAC1234Z1Z5", "ZC-1", 2000, 0, 180, 180],
  ], "Register");
  const r = await up("books_itc", [["itc-particulars-register.xlsx", reg]]);
  assert.deepEqual([r.body.results[0].ok, r.body.results[0].read, r.body.results[0].rows], [true, true, 5]);

  const { r: dl, wb } = await download(`/api/input-recon/combined/itc?client_id=${clientId}&fy=2025-26`);
  assert.equal(dl.status, 200);
  const s1 = sheetText(wb, "1 ITC Register Combined");
  assert.match(s1, /Nature of supply \/ services \| Source of nature \| Inter \/ intra state/);
  const line = (party) => s1.split("\n").find((l) => l.includes(` | ${party} | `));
  const cells = (party) => line(party).split(" | ");
  // columns: Sr | Period | Invoice date | Document type | Party name | GSTIN | Invoice no | Nature | Source of nature
  assert.deepEqual(cells("Gamma Stationers Pvt Ltd").slice(4, 9), ["Gamma Stationers Pvt Ltd", "27GAMMA1234G1Z5", "GS-100", "Office stationery and printing paper", "Invoices in the system (GS-100)"], "from the party's invoices");
  assert.deepEqual(cells("Delta Carriers").slice(4, 9), ["Delta Carriers", "27DELTA1234D1Z5", "DC-7", "Goods transport / freight", "Entries naming this party in the bank ledger"], "from the bank ledger");
  assert.deepEqual(cells("Epsilon Properties Ltd").slice(7, 9), ["Rent", "Entries naming this party in the bank statements"], "from the bank statements");
  assert.deepEqual(cells("Speedy Roadways").slice(7, 9), ["Goods transport / freight", "Inferred from the party's name"]);
  assert.deepEqual(cells("Zeta Corp").slice(7, 9), ["", "Not available in the system"]);
  // the party's name is never in the nature column
  for (const p of ["Gamma Stationers Pvt Ltd", "Delta Carriers", "Epsilon Properties Ltd", "Speedy Roadways", "Zeta Corp"]) assert.notEqual(cells(p)[7], p);
  // a nature that tells of a reverse-charge supply is used for the RCM check: freight with no GST charged
  assert.match(cells("Delta Carriers").join(" | "), /RCM applicable|Reverse charge/);
  assert.match(sheetText(wb, "Notes"), /Source of nature column says which/);
});

test("a nature the register itself gives is kept, and a nature that is only the party's name is not used", async () => {
  const reg = await xlsx([
    ["Party Name", "GSTIN", "Invoice No", "Invoice Date", "Nature of services", "Taxable Value", "IGST", "CGST", "SGST"],
    ["Omega Associates", "27OMEGA1234O1Z5", "OA-1", "03-09-2025", "Statutory audit fees", 40000, 0, 3600, 3600],
    ["Sigma Works", "27SIGMA1234S1Z5", "SW-1", "04-09-2025", "Sigma Works", 1000, 0, 90, 90],
  ], "Register");
  assert.equal((await up("books_itc", [["itc-nature-register.xlsx", reg]])).body.results[0].read, true);
  const { wb } = await download(`/api/input-recon/combined/itc?client_id=${clientId}&fy=2025-26`);
  const s1 = sheetText(wb, "1 ITC Register Combined");
  const cells = (party) => s1.split("\n").find((l) => l.includes(` | ${party} | `)).split(" | ");
  assert.deepEqual(cells("Omega Associates").slice(7, 9), ["Statutory audit fees", "As per the register"]);
  assert.equal(cells("Sigma Works")[7], "", "a nature that repeats the party's name is dropped");
});
