import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-rcm-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { generatePurchaseExcel } = await import("../src/services/registerExporter.js");
const { readExpenses } = await import("../src/services/inputRecon/expenseReader.js");
const { constitutionOf } = await import("../src/services/inputRecon/rcmWorking.js");

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
const q = (what) => `/api/input-recon/${what}?client_id=${clientId}&fy=2025-26`;
const get = (what) => api("GET", q(what), { token: tokens.staff });
const setBusiness = (nature) => api("PUT", "/api/input-recon/business", { token: tokens.staff, json: { client_id: clientId, business_nature: nature } });
const sheetText = (wb, name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
async function download(what) {
  const r = await get(what);
  const wb = new ExcelJS.Workbook();
  if (r.status === 200) await wb.xlsx.load(r.body);
  return { r, wb };
}
async function xlsxOf(rows, sheet = "Sheet1") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A workbook with one sheet for each expense ledger, laid out like Tally's ledger vouchers. */
async function expenseBook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of sheets) {
    const ws = wb.addWorksheet(name);
    [[name], ["Ledger Account"], ["1-Apr-2025 to 31-Mar-2026"], [], ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"], ...rows].forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const LEDGERS = await expenseBook([
  ["Freight Inward", [
    ["01-04-2025", "Opening Balance", "", "", 5000, ""],
    ["10-08-2025", "Speedy Roadways", "Journal", "G-2", 20000, ""],
    ["12-08-2025", "Local Transport Co", "Journal", "T-5", 10000, ""],
    ["31-03-2026", "By Profit & Loss A/c", "Journal", "", "", 35000],
  ]],
  ["Legal Fees", [["15-09-2025", "Kavita Mehta Advocate", "Journal", "L-1", 30000, ""]]],
  ["Commission", [["18-09-2025", "Rajesh Insurance Agent", "Journal", "C-1", 8000, ""]]],
  ["Advertisement", [["20-08-2025", "Google Ireland Limited", "Journal", "A-1", 10000, ""]]],
  ["Telephone", [["25-08-2025", "Airtel", "Journal", "P-1", 3000, ""]]],
]);

const ME = "27AAACA1234A1ZK", SPEEDY = "27SPEED1234R1Z5";
const purchase = (no, gstin, name, taxable, cgst, sgst, date) => ({
  invoice_type: "purchase", invoice_number: no, invoice_date: date, supplier_name: name, supplier_gstin: gstin, buyer_gstin: ME, reverse_charge: false,
  total_taxable_value: taxable, cgst_total: cgst, sgst_total: sgst, igst_total: 0, invoice_total: taxable + cgst + sgst, place_of_supply: "27",
  line_items: [{ description: "Supplies", hsn_sac: "9988", taxable_value: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }],
});
// the books register shows Speedy Roadways charging GST on its invoice G-2: that supply is under forward charge
const REGISTER = await generatePurchaseExcel({ purchase: [purchase("G-2", SPEEDY, "Speedy Roadways", 20000, 1800, 1800, "2025-08-10")], credit_note: [], debit_note: [] }, { clientName: "Apex", clientGstin: ME, taxPeriod: "2025-08" });

test("an expense workbook is read sheet by sheet, with the ledger of each entry", async () => {
  const r = await readExpenses(LEDGERS, "expenses.xlsx");
  assert.deepEqual(r.ledgers.sort(), ["Advertisement", "Commission", "Freight Inward", "Legal Fees", "Telephone"]);
  assert.equal(r.entries.length, 6, "the opening balance and the year-end transfer to profit and loss are not entries");
  assert.match(r.warnings.join(" "), /1 year-end transfer/);
  const t5 = r.entries.find((e) => e.vchNo === "T-5");
  assert.deepEqual([t5.date, t5.ledger, t5.party, t5.amount], ["2025-08-12", "Freight Inward", "Local Transport Co", 10000]);
  await assert.rejects(readExpenses(await xlsxOf([["nothing", "here"]]), "x.xlsx"), /No ledger table found/);
  assert.equal(constitutionOf("27AAACA1234A1ZK"), "company");
  assert.equal(constitutionOf("27AAAFA1234A1ZK"), "firm");
  assert.equal(constitutionOf(""), "");
});

test("the RCM is worked out on the ledgers, the supplier's forward charge is respected, and the nature of business decides the categories", async () => {
  assert.equal((await up("books_rcm", "expenses.xlsx", LEDGERS, tokens.client1)).status, 403);
  const first = (await up("books_rcm", "expenses.xlsx", LEDGERS)).body.results[0];
  assert.deepEqual([first.ok, first.read, first.rows], [true, true, 6]);
  assert.equal((await up("books_itc", "itc-register-aug.xlsx", REGISTER)).body.results[0].read, true);
  assert.equal((await api("GET", `/api/input-recon/rcm?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);

  // the nature of business is not set: the working says so
  let r = (await get("rcm")).body;
  assert.equal(r.business.nature, "");
  assert.equal(r.business.constitution, "company");
  assert.match(r.warnings.join(" "), /nature of business is not set/);
  assert.equal(r.totals.rcmEntries, 3);
  assert.deepEqual([r.totals.taxable, r.totals.igst, r.totals.cgst, r.totals.sgst, r.totals.tot], [50000, 1800, 2950, 2950, 7700]);
  const aug = r.months.find((m) => m.month === "2025-08"), sep = r.months.find((m) => m.month === "2025-09");
  assert.deepEqual([aug.entries, aug.expense, aug.rcmEntries, aug.taxable, aug.igst, aug.cgst, aug.sgst, aug.tot], [4, 43000, 2, 20000, 1800, 250, 250, 2300]);
  assert.deepEqual([sep.entries, sep.expense, sep.rcmEntries, sep.taxable, sep.cgst, sep.sgst, sep.tot], [2, 38000, 1, 30000, 2700, 2700, 5400]);
  // Speedy Roadways is a transporter, but the register shows it charging GST: forward charge. The insurance agent's commission is not RCM for this client.
  assert.equal(r.held, 2);
  assert.match(JSON.stringify(r.heldSample), /Speedy Roadways.*forward charge|forward charge.*Speedy Roadways/);
  assert.match(JSON.stringify(r.heldSample), /insurance company/);

  // unknown nature of business is refused; setting it moves the insurance agent's commission into the RCM
  assert.equal((await setBusiness("moon_base")).status, 422);
  assert.equal((await api("PUT", "/api/input-recon/business", { token: tokens.client1, json: { client_id: clientId, business_nature: "trading" } })).status, 403);
  assert.equal((await setBusiness("insurance")).body.business.nature, "insurance");
  r = (await get("rcm")).body;
  assert.equal(r.totals.rcmEntries, 4);
  assert.equal(r.totals.tot, 7700 + 1440, "8,000 at 18%");
  assert.doesNotMatch(r.warnings.join(" "), /nature of business is not set/);
  assert.equal((await get("")).body.business.nature, "insurance");
  assert.equal((await setBusiness("trading")).status, 200);
  assert.equal((await get("rcm")).body.totals.tot, 7700);
});

test("the RCM working downloads as an Excel: all the details in sheet 1, the month-wise summary in sheet 2", async () => {
  assert.equal((await api("GET", q("combined/rcm"), { token: tokens.client1 })).status, 403);
  const { r, wb } = await download("combined/rcm");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="RCM_working_2025-26_/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 RCM Details", "2 Month-wise Summary", "3 Ledgers Reviewed", "Notes"]);

  const s1 = sheetText(wb, "1 RCM Details");
  assert.match(s1, /Sr \| Month \| Date \| Expense ledger \| Party name \| GSTIN \| Voucher \/ invoice no \| Narration \| RCM category \| Provision \| Taxable value \| Rate % \| IGST \| CGST \| SGST \/ UTGST \| Total RCM \| ITC on this RCM/);
  assert.match(s1, /Aug-25 \| 2025-08-12 \| Freight Inward \| Local Transport Co \|  \| T-5 \|.* \| Goods transport agency \(GTA\) service \|.* \| 10000 \| 5 \| 0 \| 250 \| 250 \| 500 \| Eligible/);
  assert.match(s1, /Sep-25 \| 2025-09-15 \| Legal Fees \| Kavita Mehta Advocate .*Legal service by an advocate.* \| 30000 \| 18 \| 0 \| 2700 \| 2700 \| 5400 \| Eligible/);
  assert.match(s1, /Aug-25 \| 2025-08-20 \| Advertisement \| Google Ireland Limited .*Import of service from outside India.* \| 10000 \| 18 \| 1800 \| 0 \| 0 \| 1800 \| Eligible/);
  assert.doesNotMatch(s1, /Speedy Roadways|Airtel|Insurance Agent/);
  assert.match(s1, /Total \|.* \| 50000 \| .* \| 1800 \| 2950 \| 2950 \| 7700/);

  const s2 = sheetText(wb, "2 Month-wise Summary");
  assert.match(s2, /Month \| Entries reviewed \| Expenses as per ledgers \| RCM entries \| Taxable value \(RCM\) \| IGST \| CGST \| SGST \/ UTGST \| Total RCM \| ITC available on RCM/);
  assert.match(s2, /Aug-25 \| 4 \| 43000 \| 2 \| 20000 \| 1800 \| 250 \| 250 \| 2300 \| 2300/);
  assert.match(s2, /Sep-25 \| 2 \| 38000 \| 1 \| 30000 \| 0 \| 2700 \| 2700 \| 5400 \| 5400/);
  assert.match(s2, /Apr-25 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| 0/, "every month of the year is shown");
  assert.match(s2, /Goods transport agency \(GTA\) service \| 1 \| 10000 \| 500/);

  const s3 = sheetText(wb, "3 Ledgers Reviewed");
  assert.match(s3, /Telephone \| 1 \| 3000 \| 0 \| 0 \| No reverse-charge supply found in this ledger/);
  assert.match(s3, /Speedy Roadways .*forward charge/);
  assert.match(s3, /Rajesh Insurance Agent .*insurance company/);
  assert.match(sheetText(wb, "Notes"), /expenses\.xlsx: 6 entries read/);
});

test("the nature of business changes the ITC on the RCM: a business making exempt supplies cannot claim it", async () => {
  assert.equal((await setBusiness("healthcare")).status, 200);
  const { wb } = await download("combined/rcm");
  assert.match(sheetText(wb, "1 RCM Details"), /Local Transport Co .* \| 500 \| Not available/);
  const r = (await get("rcm")).body;
  assert.equal(r.totals.itc, 0);
  assert.equal((await setBusiness("trading")).status, 200);
});

test("the final reconciliation carries the RCM reconciliation sheet, and the RCM goes into the GSTR-9 and 9C draft", async () => {
  const gstr3b = [
    ["Form GSTR-3B"], ["3.1 Details of Outward Supplies and inward supplies liable to reverse charge"],
    ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", 100000, 0, 9000, 9000, 0],
    ["(b) Outward taxable supplies (zero rated)", 0, 0, 0, 0, 0], ["(c) Other outward supplies (Nil rated, exempted)", 0, 0, 0, 0, 0],
    // RCM paid in August: 1,800 IGST (Google) and 200 + 200 (the transporter): the working says 250 + 250
    ["(d) Inward supplies (liable to reverse charge)", 20000, 1800, 200, 200, 0], ["(e) Non-GST outward supplies", 0, 0, 0, 0, 0],
    ["4. Eligible ITC"],
    ["(3) Inward supplies liable to reverse charge (other than 1 & 2 above)", 1800, 200, 200, 0],
    ["(5) All other ITC", 0, 0, 0, 0],
  ];
  assert.equal((await up("gstr3b", "GSTR3B_Aug-2025.xlsx", await xlsxOf(gstr3b, "GSTR-3B"))).body.results[0].read, true);

  const f = (await get("final")).body;
  assert.equal(f.counts.rcm, 1);
  assert.equal(f.rcm.have, true);
  const aug = f.rcm.months.find((m) => m.label === "Aug-25");
  assert.deepEqual([aug.ledger.tot, aug.paid.tot, aug.claimed.tot, aug.diffLedgerPaid, aug.diffPaidItc, aug.status], [2300, 2200, 2200, 100, 0, "Differs"]);
  assert.match(aug.remark, /RCM on the expense ledgers is more than the RCM paid in GSTR-3B 3\.1\(d\) by Rs 100\.00/);
  assert.equal(f.rcm.summary.filedMonths, 1);

  const { r, wb } = await download("combined/final");
  assert.equal(r.status, 200);
  assert.deepEqual(wb.worksheets.map((s) => s.name).slice(-3), ["11 Differences Books vs 2B", "12 RCM Reconciliation", "Notes"]);
  const s12 = sheetText(wb, "12 RCM Reconciliation");
  assert.match(s12, /RCM reconciliation month by month/);
  assert.match(s12, /RCM on the expense ledgers \(working\)/);
  assert.match(s12, /Aug-25 \| 20000 \| 1800 \| 250 \| 250 \| 2300 \| 2300 \| .* \| 20000 \| 1800 \| 200 \| 200 \| 2200 \| 1800 \| 200 \| 200 \| 2200 \| 100 \| 0 \| .*Filed GSTR-3B \| Differs \| RCM on the expense ledgers is more than/);
  assert.match(s12, /Sep-25 \| 30000 \| 0 \| 2700 \| 2700 \| 5400 \| 5400/, "a month with ledgers and no GSTR-3B is shown with the working only");

  const g9 = sheetText(wb, "9 GSTR-9 and 9C");
  assert.match(g9, /4G \| Inward supplies on which tax is payable on reverse charge: tax paid as per GSTR-3B Table 3\.1\(d\) \| 1800 \| 200 \| 200 \| 0 \| 2200/);
  assert.match(g9, /as per the RCM working on the expense ledgers \(Books, RCM\) \| 1800 \| 2950 \| 2950 \| 0 \| 7700/);
  assert.match(g9, /difference \(3B 3\.1\(d\) less RCM working\) \| 0 \| -2750 \| -2750 \| 0 \| -5500/);
  assert.match(g9, /6C\+6D \| ITC claimed on reverse charge: GSTR-3B Table 4\(A\)\(3\) \| 1800 \| 200 \| 200 \| 0 \| 2200/);
  assert.match(g9, /ITC on RCM available as per the RCM working \(eligible lines only\) \|.* \| 7700/);
  assert.match(g9, /RCM \| Reverse-charge tax as per the RCM working \(books\) \| 1800 \| 2950 \| 2950 \| 0 \| 7700/);
  assert.match(g9, /RCM \| Un-reconciled reverse-charge tax \(working less return\) \| 0 \| 2750 \| 2750 \| 0 \| 5500/);
  assert.match(sheetText(wb, "Notes"), /12 RCM Reconciliation: month by month/);

  // with no expense ledger the sheet and the draft still come, and ask for the ledgers
  await db.query("delete from input_recon_files where kind='books_rcm'");
  const none = await download("combined/final");
  assert.equal(none.r.status, 200);
  assert.match(sheetText(none.wb, "12 RCM Reconciliation"), /No expense ledger is uploaded under Books > RCM/);
  assert.match(sheetText(none.wb, "9 GSTR-9 and 9C"), /Upload the expense ledgers under Books > RCM to work this out/);
});
