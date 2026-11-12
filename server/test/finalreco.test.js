import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-finalreco-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { generatePurchaseExcel } = await import("../src/services/registerExporter.js");

let server, base, clientId;
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
  clientId = (await api("GET", "/api/clients", { token: tokens.client1 })).body[0].id;
});
after(async () => { server.close(); await db.close(); });

const up = (kind, name, content, token = tokens.staff) => {
  const fd = new FormData();
  fd.append("client_id", clientId); fd.append("fy", "2025-26"); fd.append("kind", kind);
  fd.append("files", new Blob([content]), name);
  return api("POST", "/api/input-recon/upload", { token, form: fd });
};
const q = (what) => `${what}?client_id=${clientId}&fy=2025-26`;
const sheetText = (wb, name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
async function download(url) {
  const r = await api("GET", url, { token: tokens.staff });
  const wb = new ExcelJS.Workbook();
  if (r.status === 200) await wb.xlsx.load(r.body);
  return { r, wb };
}

const ME = "27AAACA1234A1ZK";
const SPEEDY = "27SPEED1234R1Z5", ALPHA = "27AABCU9603R1ZM", ONLYB = "27ONLYB1234O1Z5", PLAIN = "27PLAIN1234P1Z5", GHOST = "27GHOST1234G1Z5";
const purchase = (no, gstin, name, taxable, cgst, sgst, date = "2025-08-10") => ({
  invoice_type: "purchase", invoice_number: no, invoice_date: date, supplier_name: name, supplier_gstin: gstin, buyer_gstin: ME, reverse_charge: false,
  total_taxable_value: taxable, cgst_total: cgst, sgst_total: sgst, igst_total: 0, invoice_total: taxable + cgst + sgst, place_of_supply: "27",
  line_items: [{ description: "Supplies", hsn_sac: "9988", taxable_value: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }],
});

// Books: Speedy (agrees everywhere), Alpha (the working claims less), Only Books Co (in no other)
const REGISTER = await generatePurchaseExcel({
  purchase: [purchase("G-2", SPEEDY, "Speedy Roadways", 20000, 1800, 1800), purchase("A-1", ALPHA, "Alpha Traders", 1000, 90, 90), purchase("X-1", ONLYB, "Only Books Co", 500, 45, 45)],
  credit_note: [], debit_note: [],
}, { clientName: "Apex", clientGstin: ME, taxPeriod: "2025-08" });

const GSTR2B = [
  ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "GSTR-1/IFF/GSTR-5 Period", "ITC Availability"],
  [SPEEDY, "Speedy Roadways", "G-2", "Regular", "06-08-2025", 23600, "27-Maharashtra", "No", 20000, 0, 1800, 1800, 0, "082025", "Yes"],
  [ALPHA, "Alpha Traders", "A-1", "Regular", "10-08-2025", 1180, "27-Maharashtra", "No", 1000, 0, 90, 90, 0, "082025", "Yes"],
  [PLAIN, "Plain Trader", "P-6", "Regular", "10-08-2025", 1180, "27-Maharashtra", "No", 1000, 0, 90, 90, 0, "082025", "Yes"],
];

const TDSTCS = [
  ["TCS receivable under section 52"], ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  ["20-08-2025", "TCS credit - e-commerce operator", "Journal", "J-4", 300, ""],
];

/** A monthly working in two sheets: the Table 4 summary and the documents behind it. */
async function working(docs, a5) {
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet("GSTR-3B Summary");
  [["GSTR-3B working - Apex Retailers - 2025-08"], [], ["Table 4 - Eligible ITC"], ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    ["(A)(5) All other ITC (purchase invoices and debit notes)", ...a5], ["(C) Net ITC available (A - B)", ...a5]].forEach((r) => s.addRow(r));
  const d = wb.addWorksheet("Inward detail");
  d.addRow(["Supplier name", "Supplier GSTIN", "Invoice number", "Invoice date", "Document type", "Taxable value", "IGST", "CGST", "SGST", "Cess", "ITC treatment"]);
  docs.forEach((x) => d.addRow(x));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const WORKING = await working([
  ["Speedy Roadways", SPEEDY, "G-2", "06-08-2025", "Invoice", 20000, 0, 1800, 1800, 0, "Eligible"],
  ["Alpha Traders", ALPHA, "A-1", "10-08-2025", "Invoice", 1000, 0, 80, 80, 0, "Eligible"],
  ["Ghost Co", GHOST, "H-9", "11-08-2025", "Invoice", 1000, 0, 100, 100, 0, "Eligible"],
], [0, 1980, 1980, 0]);

test("the sections of the final reconciliation are read, and Step 2 can be prepared from the monthly workings alone", async () => {
  assert.equal((await api("GET", `/api/input-recon/final?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);
  const empty = (await api("GET", `/api/input-recon/${q("final")}`, { token: tokens.staff })).body;
  assert.deepEqual(empty.ready, { books: false, g2b: false, tb: false });
  assert.equal((await api("GET", `/api/input-recon/${q("combined/final")}`, { token: tokens.staff })).status, 409);

  for (const [kind, name, content] of [["books_itc", "itc-register-aug.xlsx", REGISTER], ["gstr2b", "GSTR2B_082025.xlsx", await xlsxOf(GSTR2B, "B2B")], ["books_tdstcs", "tcs.xlsx", await xlsxOf(TDSTCS)], ["work3b", "aug-working.xlsx", WORKING]]) {
    const r = (await up(kind, name, content)).body.results[0];
    assert.equal(r.ok, true, `${kind}: ${JSON.stringify(r)}`);
  }
  const f = (await api("GET", `/api/input-recon/${q("final")}`, { token: tokens.staff })).body;
  assert.deepEqual(f.ready, { books: true, g2b: true, tb: true });
  assert.equal(f.source.tb, "workings");
  assert.match(f.warnings.join(" "), /finalised 3B working is not uploaded/);
  assert.deepEqual(f.counts, { books: 1, tdsTcs: 1, g2b: 1, work3b: 1, final3b: 0, rcm: 0 });
  const p = Object.fromEntries(f.pairs.map((x) => [x.id, x]));
  // 3B against 2B: Speedy agrees, Alpha differs by Rs 20, Ghost only in 3B, Plain only in 2B
  assert.equal(p.tb_g2b.summary.documentsDiffering, 3);
  assert.deepEqual(p.tb_g2b.diffs.map((d) => [d.no, d.type]).sort(), [["A-1", "Amount differs"], ["H-9", "Only claimed in the 3B working"], ["P-6", "Only in GSTR-2B"]]);
  assert.match(p.tb_g2b.diffs.find((d) => d.no === "H-9").remark, /section 16\(2\)\(aa\)/);
  assert.equal(p.tb_g2b.diffs.find((d) => d.no === "A-1").diff, -20, "3B 160 less 2B 180");
  // books against 2B: Only Books Co is in the books only, Plain in 2B only
  assert.deepEqual(p.books_g2b.diffs.map((d) => [d.no, d.type]).sort(), [["P-6", "Only in GSTR-2B"], ["X-1", "Only in the books"]]);
  const aug = p.tb_g2b.months.find((m) => m.label === "Aug-25");
  assert.equal(aug.a.tot, 3960, "3B working: 3600 + 160 + 200 of tax claimed");
  assert.equal(aug.b.tot, 3960, "2B: 3600 + 180 + 180 of tax: the month agrees though three documents do not");
  assert.equal(p.books_g2b.months.find((m) => m.label === "Aug-25").diff.tot, -90, "books 3870 less 2B 3960");
});

async function xlsxOf(rows, sheet = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("the combined 3B workings, once finalised, are uploaded in Step 2 and used for the final workbook", async () => {
  const { r, wb: combinedWb } = await download(`/api/input-recon/${q("combined/work3b")}`);
  assert.equal(r.status, 200);
  assert.match(sheetText(combinedWb, "3 ITC Documents"), /Ghost Co \| 27GHOST1234G1Z5 \| H-9/);

  // a workbook with no document lines is refused with the reason
  const bad = (await up("final3b", "no-docs.xlsx", await xlsxOf([["nothing", "here"]]))).body.results[0];
  assert.deepEqual([bad.ok, bad.read], [true, false], "kept in the list, with the reason");
  assert.match(bad.warnings.join(" "), /No document lines were found/);

  // the CA finalises the working: the Alpha claim is corrected to 90 + 90 in the file uploaded
  const fixed = new ExcelJS.Workbook();
  await fixed.xlsx.load(r.body);
  const docs = fixed.getWorksheet("3 ITC Documents");
  let corrected = 0;
  docs.eachRow((row) => { if (String(row.getCell(6).value) === "A-1") { row.getCell(10).value = 90; row.getCell(11).value = 90; row.getCell(13).value = 180; corrected++; } });
  assert.equal(corrected, 1, "Invoice no is column 6 of the ITC Documents sheet");
  const finalBuf = Buffer.from(await fixed.xlsx.writeBuffer());
  const ok = (await up("final3b", "final-3b-working.xlsx", finalBuf)).body.results[0];
  assert.deepEqual([ok.ok, ok.read, ok.rows], [true, true, 3]);

  const f = (await api("GET", `/api/input-recon/${q("final")}`, { token: tokens.staff })).body;
  assert.deepEqual(f.source, { tb: "final", name: "final-3b-working.xlsx" });
  const p = Object.fromEntries(f.pairs.map((x) => [x.id, x]));
  assert.deepEqual(p.tb_g2b.diffs.map((d) => d.no).sort(), ["H-9", "P-6"], "the corrected Alpha claim now agrees with 2B");
  assert.equal(f.tdsTcs[0].category, "TCS");
  assert.equal(f.tdsTcs[0].books.tot, 300);
});

test("the final reconciliation workbook has all the sheets, with pivots, differences, and GSTR-9 and 9C", async () => {
  const { r, wb } = await download(`/api/input-recon/${q("combined/final")}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="Final_reconciliation_ITC_2025-26_/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), [
    "1 Books Combined ITC", "2 GSTR-2B Combined", "3 GSTR-3B Combined", "4 Monthwise Summary", "5 Party Pivot 3B vs 2B", "6 Differences 3B vs 2B",
    "7 Party Pivot Books vs 3B", "8 Differences Books vs 3B", "9 GSTR-9 and 9C", "10 Party Pivot Books vs 2B", "11 Differences Books vs 2B", "12 RCM Reconciliation", "Notes",
  ]);
  assert.match(sheetText(wb, "1 Books Combined ITC"), /Only Books Co \| 27ONLYB1234O1Z5 \| X-1/);
  assert.match(sheetText(wb, "2 GSTR-2B Combined"), /Plain Trader \| P-6/);
  assert.match(sheetText(wb, "3 GSTR-3B Combined"), /Aug-25 \| 2025-08-11 \| Invoice \| Ghost Co \| 27GHOST1234G1Z5 \| H-9 \| Normal ITC \| 1000 \| 0 \| 100 \| 100 \| 0 \| 200/);

  const m = sheetText(wb, "4 Monthwise Summary");
  assert.match(m, /GSTR-3B against GSTR-2B/);
  assert.match(m, /Books against GSTR-3B/);
  assert.match(m, /Books against GSTR-2B/);
  assert.match(m, /As per GSTR-3B \| As per GSTR-2B|IGST \| CGST \| SGST \/ UTGST \| Cess \| Total/);
  assert.match(m, /Aug-25 \| 0 \| 1990 \| 1990 \| 0 \| 3980 \| 0 \| 1980 \| 1980 \| 0 \| 3960 \| 0 \| 10 \| 10 \| 0 \| 20/, "3B claims Ghost's 200 where 2B has Plain's 180");
  assert.match(m, /Aug-25 \| 0 \| 1935 \| 1935 \| 0 \| 3870 \| 0 \| 1990 \| 1990 \| 0 \| 3980 \| 0 \| -55 \| -55 \| 0 \| -110/, "books against 3B");

  const pv = sheetText(wb, "5 Party Pivot 3B vs 2B");
  assert.match(pv, /Party name \| GSTIN \| Category/);
  assert.match(pv, /Speedy Roadways \| 27SPEED1234R1Z5 \| Normal ITC \| 1 \| 0 \| 1800 \| 1800 \| 3600 \| 1 \| 0 \| 1800 \| 1800 \| 3600 \| 0 \| 0 \| 0 \| 0 \| Matches/);
  assert.match(pv, /Ghost Co \| 27GHOST1234G1Z5 \| Normal ITC \| 1 .* \| Only in the first/);
  assert.match(pv, /Plain Trader \| 27PLAIN1234P1Z5 \| Normal ITC .* \| Only in the second/);

  const d = sheetText(wb, "6 Differences 3B vs 2B");
  assert.match(d, /Ghost Co \| 27GHOST1234G1Z5 \| Normal ITC \| H-9 \| 2025-08-11 \| Only claimed in the 3B working/);
  assert.match(d, /Plain Trader .* \| P-6 \| 2025-08-10 \| Only in GSTR-2B/);
  assert.doesNotMatch(d, /Speedy Roadways/);

  assert.match(sheetText(wb, "8 Differences Books vs 3B"), /Only Books Co .* X-1 .* Only in the books/);
  assert.match(sheetText(wb, "8 Differences Books vs 3B"), /Ghost Co .* H-9 .* Only claimed in the 3B working/);
  assert.match(sheetText(wb, "11 Differences Books vs 2B"), /Only Books Co .* X-1 .* Only in the books/);
  assert.match(sheetText(wb, "10 Party Pivot Books vs 2B"), /TCS .*For information/);
  assert.match(sheetText(wb, "7 Party Pivot Books vs 3B"), /Category/);

  const g9 = sheetText(wb, "9 GSTR-9 and 9C");
  assert.match(g9, /6A \| Total ITC availed through GSTR-3B \(Table 4\(A\)\) \| 0 \| 1980 \| 1980 \| 0 \| 3960/);
  assert.match(g9, /8A \| ITC as per GSTR-2B/);
  assert.match(g9, /12A \| ITC availed as per the books/);
  assert.match(g9, /TCS \| TDS \/ TCS ledgers in the books/);
  assert.match(sheetText(wb, "Notes"), /Books: \d+ line\(s\)\. GSTR-2B: 3 line\(s\)\. GSTR-3B working: 3 line\(s\) from final-3b-working\.xlsx/);

  // the pivot has a filter on its heading row, so the Category column can be filtered
  assert.ok(wb.getWorksheet("5 Party Pivot 3B vs 2B").autoFilter);
});

test("the schema, applied at every start, never narrows the file kinds below the ones that already have rows", async () => {
  const { KINDS } = await import("../src/services/inputRecon/inspect.js");
  const sql = fs.readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  const adds = [...sql.matchAll(/add constraint input_recon_files_kind_check check \(kind in \(([^)]*)\)\)/g)].map((m) => m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1)));
  assert.ok(adds.length >= 1, "the constraint is added");
  // a start-up that puts back a shorter list fails on a database that already holds a newer kind, and the server does not start
  for (const kinds of adds) assert.deepEqual([...kinds].sort(), Object.keys(KINDS).sort());
});
