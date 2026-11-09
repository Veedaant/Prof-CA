import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-itc-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const ExcelJS = (await import("exceljs")).default;
const { generatePurchaseExcel } = await import("../src/services/registerExporter.js");
const { liabilityFrom } = await import("../src/services/itc/gstr1Reader.js");

let server, base;
const tokens = {};
async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const ct = res.headers.get("content-type") || "";
  const body = ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer());
  return { status: res.status, body };
}
async function login(email, password) { return (await api("POST", "/api/auth/login", { json: { email, password } })).body.access_token; }

before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  tokens.staff = await login("staff@example.com", "staff123");
  tokens.client1 = await login("client1@example.com", "client123");
});
after(async () => { server.close(); await db.close(); });

const ME = "27AAACA1234A1ZK";
const SUP = { alpha: "27AABCU9603R1ZM", beta: "27BBBBB1111B1Z5", gamma: "27CCCCC2222C1Z5", delta: "27DDDDD3333D1Z5" };

const purchase = (no, gstin, name, taxable, cgst, sgst, over = {}, desc = "Supplies") => ({
  invoice_type: "purchase", invoice_number: no, invoice_date: "2041-07-10", supplier_name: name, supplier_gstin: gstin, buyer_gstin: ME, reverse_charge: false,
  total_taxable_value: taxable, cgst_total: cgst, sgst_total: sgst, igst_total: 0, invoice_total: taxable + cgst + sgst, place_of_supply: "27",
  line_items: [{ description: desc, hsn_sac: "9988", taxable_value: taxable, cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, cgst_rate: 9, sgst_rate: 9 }], ...over,
});

async function booksFile() {
  const docs = {
    purchase: [
      purchase("A-1", SUP.alpha, "Alpha Traders", 1000, 90, 90),
      purchase("B-2", SUP.beta, "Beta Services", 2000, 180, 180),
      purchase("C-3", SUP.gamma, "Gamma Caterers", 5000, 450, 450, {}, "Outdoor catering for staff"),
      purchase("D-4", SUP.delta, "Delta Supplies", 800, 72, 72),
      // reverse charge: a goods transport bill with no tax on it
      purchase("T-5", "", "Local Transport Co", 10000, 0, 0, { line_items: [{ description: "Goods transport freight charges", hsn_sac: "9965", taxable_value: 10000, cgst_amount: 0, sgst_amount: 0, igst_amount: 0 }] }),
    ],
    credit_note: [{ ...purchase("CN-1", SUP.alpha, "Alpha Traders", 100, 9, 9), invoice_type: "credit_note" }],
    debit_note: [],
  };
  return generatePurchaseExcel(docs, { clientName: "Apex", clientGstin: ME, taxPeriod: "2041-07" });
}

async function gstr2bFile() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Read me").getCell(1, 1).value = "Goods and Services Tax - GSTR-2B";
  wb.addWorksheet("ITC Summary").getCell(1, 1).value = "Summary";
  const ws = wb.addWorksheet("B2B");
  ws.getCell(1, 1).value = "Taxable inward supplies received from registered persons";
  // the portal's headings run over two rows: group labels ("Invoice details", "Tax Amount") above the real column names
  const upper = ["GSTIN of supplier", "Trade/Legal name", "Invoice details", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/IFF/GSTR-5 Period", "GSTR-1/IFF/GSTR-5 Filing Date", "ITC Availability", "Reason", "Applicable % of Tax Rate"];
  const lower = { 3: "Invoice number", 4: "Invoice type", 5: "Invoice Date", 6: "Invoice Value(₹)", 10: "Integrated Tax(₹)", 11: "Central Tax(₹)", 12: "State/UT Tax(₹)", 13: "Cess(₹)" };
  upper.forEach((h, i) => { if (h) ws.getCell(4, i + 1).value = h; });
  Object.entries(lower).forEach(([c, h]) => { ws.getCell(5, Number(c)).value = h; });
  ws.mergeCells("C4:F4");
  ws.mergeCells("J4:M4");
  const row = (i, g, name, no, date, value, taxable, cgst, sgst, avail = "Yes", reason = "") =>
    [g, name, no, "Regular", date, value, "27-Maharashtra", "No", taxable, 0, cgst, sgst, 0, "072041", "11-08-2041", avail, reason, 100].forEach((v, j) => { ws.getCell(i, j + 1).value = v; });
  row(6, SUP.alpha, "Alpha Traders", "A-1", "10-07-2041", 1180, 1000, 90, 90);
  row(7, SUP.beta, "Beta Services", "B-2", "10-07-2041", 2124, 1800, 162, 162); // supplier reported less
  row(8, SUP.gamma, "Gamma Caterers", "C-3", "10-07-2041", 5900, 5000, 450, 450);
  row(9, "27EEEEE4444E1Z5", "Epsilon Ltd", "E-9", "12-07-2041", 590, 500, 45, 45); // not in the books
  const cdn = wb.addWorksheet("B2B-CDNR");
  const C = ["GSTIN of supplier", "Trade/Legal name", "Note details", "", "", "", "", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Tax Amount", "", "", "", "GSTR-1/IFF/GSTR-5 Period", "ITC Availability"];
  C.forEach((h, i) => { if (h) cdn.getCell(4, i + 1).value = h; });
  Object.entries({ 3: "Note number", 4: "Note type", 5: "Note supply type", 6: "Note Date", 7: "Note Value (₹)", 11: "Integrated Tax(₹)", 12: "Central Tax(₹)", 13: "State/UT Tax(₹)", 14: "Cess(₹)" }).forEach(([c, h]) => { cdn.getCell(5, Number(c)).value = h; });
  cdn.mergeCells("C4:G4");
  cdn.mergeCells("K4:N4");
  [SUP.alpha, "Alpha Traders", "CN-1", "Credit note", "Regular", "15-07-2041", 118, "27-Maharashtra", "No", 100, 0, 9, 9, 0, "072041", "Yes"].forEach((v, j) => { cdn.getCell(6, j + 1).value = v; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const form = (fields, file, name) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append("file", new Blob([file]), name);
  return f;
};

test("GSTR-2B reconciliation: books vs 2B with remarks, eligibility by business, and the GSTR-3B summary", async () => {
  const apex = await db.one("select id, gstin from clients where name like 'Apex%'");
  await db.query("update clients set gstin=$1 where id=$2", [ME, apex.id]);
  const P = "2041-07";
  const q = `client_id=${apex.id}&tax_period=${P}`;
  const base0 = { client_id: apex.id, tax_period: P };

  // staff only
  assert.equal((await api("GET", `/api/itc2b?${q}`, { token: tokens.client1 })).status, 403);

  // nothing yet
  let s = (await api("GET", `/api/itc2b?${q}`, { token: tokens.staff })).body;
  assert.equal(s.result, null);
  assert.ok(s.natures.some((n) => n.value === "restaurant"));
  assert.equal((await api("GET", `/api/itc2b/excel?${q}`, { token: tokens.staff })).status, 409);

  // the books file is the prepared ITC register, the 2B is a portal-style workbook
  const bk = await api("POST", "/api/itc2b/upload", { token: tokens.staff, form: form({ ...base0, kind: "books" }, await booksFile(), "ITC_books.xlsx") });
  assert.equal(bk.status, 200, JSON.stringify(bk.body));
  assert.equal(bk.body.rows, 6, "five invoices and a credit note");
  const g2 = await api("POST", "/api/itc2b/upload", { token: tokens.staff, form: form({ ...base0, kind: "gstr2b" }, await gstr2bFile(), "GSTR2B.xlsx") });
  assert.equal(g2.status, 200, JSON.stringify(g2.body));
  assert.deepEqual(g2.body.sheets, ["B2B", "B2B-CDNR"]);
  assert.equal(g2.body.rows, 5);
  assert.equal((await api("POST", "/api/itc2b/upload", { token: tokens.staff, form: form({ ...base0, kind: "gstr1" }, Buffer.from("x"), "gstr1.xlsx") })).status, 400, "GSTR-1 must be a PDF");

  // the GSTR-1 PDF is read by the AI; here its result is put in directly
  const gstr1 = liabilityFrom({
    gstin: ME, return_period: "July 2041",
    printed_total_liability: { taxable_value: 100000, integrated_tax: 0, central_tax: 9000, state_ut_tax: 9000, cess: 0 },
    sections: [{ table: "4A", description: "B2B", effect: "add", taxable_value: 100000, integrated_tax: 0, central_tax: 9000, state_ut_tax: 9000, cess: 0 }, { table: "4B", description: "Reverse charge", effect: "ignore", taxable_value: 5000, central_tax: 450, state_ut_tax: 450 }],
    nil_exempt_non_gst: { nil_rated: 0, exempt: 0, non_gst: 0 },
  });
  assert.equal(gstr1.source, "printed");
  assert.equal(gstr1.liability.cgst, 9000);
  await db.query("update itc_recons set gstr1=$1, gstr1_status='ready', gstr1_name='gstr1.pdf' where client_id=$2 and tax_period=$3", [JSON.stringify(gstr1), apex.id, P]);

  // a trading business: the catering bill is a blocked credit
  s = (await api("PUT", "/api/itc2b/settings", { token: tokens.staff, json: { ...base0, business_nature: "trading" } })).body;
  assert.equal(s.client.business_nature, "trading");
  const by = (no) => s.result.lines.find((l) => l.inv_no === no);
  assert.equal(by("A-1").cat, "matched");
  assert.equal(by("A-1").code, "eligible");

  const b2 = by("B-2");
  assert.equal(b2.status, "different");
  assert.match(b2.remark, /Taxable value is ₹2,000\.00 in the books but ₹1,800\.00 in GSTR-2B/);
  assert.match(b2.action, /only up to the ₹324\.00 shown in GSTR-2B/, "the claim is limited to 2B");
  assert.deepEqual([b2.amounts.claim.cgst, b2.amounts.claim.sgst], [162, 162]);
  assert.deepEqual([b2.amounts.hold.cgst, b2.amounts.hold.sgst], [18, 18], "the excess over 2B is held");

  const c3 = by("C-3");
  assert.equal(c3.cat, "matched");
  assert.equal(c3.code, "ineligible", "outdoor catering is blocked for a trader");
  assert.match(c3.provision, /Section 17\(5\)\(b\)\(i\)/);
  assert.deepEqual([c3.amounts.blocked.cgst, c3.amounts.claim.cgst], [450, 0]);

  const d4 = by("D-4");
  assert.equal(d4.status, "books_only");
  assert.equal(d4.code, "hold");
  assert.match(d4.provision, /16\(2\)\(aa\)/);
  assert.match(d4.action, /Do not claim the ITC this month/);

  const e9 = by("E-9");
  assert.equal(e9.status, "g2b_only");
  assert.equal(e9.code, "not_booked");
  assert.match(e9.action, /book the invoice/i);

  const t5 = by("T-5");
  assert.equal(t5.code, "rcm", "a GTA bill with no tax is reverse charge");
  assert.deepEqual([t5.amounts.rcm.cgst, t5.amounts.rcm.sgst], [250, 250], "5% of 10,000 split in two");

  assert.equal(by("CN-1").code, "reversal");

  // GSTR-3B: output 9000+9000 from GSTR-1; ITC now: A-1 90/90 + B-2 162/162 - credit note 9/9; blocked catering is reversed
  const p = s.result.summary;
  assert.deepEqual([p.outward.cgst, p.outward.sgst], [9000, 9000]);
  assert.deepEqual([p.itc.b1.cgst, p.itc.b1.sgst], [450, 450]);
  assert.deepEqual([p.itc.net_now.cgst, p.itc.net_now.sgst], [243, 243]);
  assert.deepEqual([p.itc.a3.cgst, p.itc.a3.sgst], [250, 250]);
  assert.deepEqual([p.payment.itc_used.cgst, p.payment.itc_used.sgst], [243, 243]);
  assert.deepEqual([p.payment.cash_outward.cgst, p.payment.cash_outward.sgst], [8757, 8757]);
  assert.deepEqual([p.payment.rcm_cash.cgst, p.payment.rcm_cash.sgst], [250, 250], "reverse charge is paid in cash");
  assert.deepEqual([p.payment.cash.cgst, p.payment.cash.sgst], [9007, 9007]);
  assert.equal(p.payment.total_cash, 18014);
  assert.deepEqual([p.payment.carry_forward.cgst, p.payment.carry_forward.sgst], [250, 250], "reverse-charge credit is usable next month");
  assert.deepEqual([p.not_claimed.unbooked.cgst, p.not_claimed.hold.cgst], [45, 90], "E-9 is unbooked; D-4 (72) and the B-2 excess over 2B (18) are held");

  // the same purchases for a restaurant: the catering is claimable
  s = (await api("PUT", "/api/itc2b/settings", { token: tokens.staff, json: { ...base0, business_nature: "restaurant" } })).body;
  assert.equal(by("C-3").code, "eligible");
  assert.equal(s.result.summary.itc.b1.cgst, 0);

  // healthcare is exempt: nothing is eligible
  s = (await api("PUT", "/api/itc2b/settings", { token: tokens.staff, json: { ...base0, business_nature: "healthcare" } })).body;
  assert.equal(by("A-1").code, "ineligible");
  assert.match(by("A-1").provision, /Section 17\(2\)/);
  assert.equal((await api("PUT", "/api/itc2b/settings", { token: tokens.staff, json: { ...base0, business_nature: "nonsense" } })).status, 422);

  // opening ITC balance is used against outward tax
  s = (await api("PUT", "/api/itc2b/settings", { token: tokens.staff, json: { ...base0, business_nature: "trading", opening_itc: { cgst: 1000, sgst: 0, igst: 0, cess: 0 } } })).body;
  assert.equal(s.result.summary.payment.itc_used.cgst, 1243);

  // the Excel
  const dl = await api("GET", `/api/itc2b/excel?${q}`, { token: tokens.staff });
  assert.equal(dl.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["GSTR-3B Summary", "Reconciliation Summary", "RCM Check", "ITC Reconciliation", "Notes"]);
  const rec = wb.getWorksheet("ITC Reconciliation");
  const head = rec.getRow(1).values.slice(1);
  for (const h of ["Remark", "Recommended course of action", "ITC eligible / ineligible", "Relevant provision of the GST Act (ITC)"]) assert.ok(head.includes(h), h);
  const text = [];
  rec.eachRow((r) => text.push(r.values.slice(1).join("|")));
  assert.match(text.join("\n"), /C-3.*Ineligible/);
  assert.match(text.join("\n"), /E-9.*Eligible once booked/);

  // removing a file clears the result
  assert.equal((await api("DELETE", `/api/itc2b/upload?${q}&kind=gstr2b`, { token: tokens.staff })).status, 200);
  assert.equal((await api("GET", `/api/itc2b?${q}`, { token: tokens.staff })).body.result, null);
});

test("GSTR-1 PDF reading: the printed total is used, else the tables are added and credit notes subtracted", () => {
  const sec = (table, effect, t, c) => ({ table, description: table, effect, taxable_value: t, integrated_tax: 0, central_tax: c, state_ut_tax: c, cess: 0 });
  const noTotal = liabilityFrom({ printed_total_liability: null, sections: [sec("4A", "add", 1000, 90), sec("7", "add", 500, 45), sec("9B-credit", "subtract", 100, 9), sec("4B", "ignore", 999, 99)] });
  assert.equal(noTotal.source, "computed");
  assert.deepEqual([noTotal.liability.taxable, noTotal.liability.cgst, noTotal.liability.sgst], [1400, 126, 126]);
  const bad = liabilityFrom({ printed_total_liability: { taxable_value: 5, central_tax: 0, state_ut_tax: 0 }, sections: [sec("4A", "add", 1000, 90)] });
  assert.equal(bad.source, "printed");
  assert.ok(bad.warnings.length, "a printed total that disagrees with the tables is flagged");
  assert.ok(liabilityFrom({}).warnings.length);
});

test("Reverse charge: advocate and GTA services are identified, tax is worked out, and a forward-charge GTA gets a note", async () => {
  const apex = await db.one("select id, firm_id from clients where name like 'Apex%'");
  const P = "2041-08";
  const base0 = { client_id: apex.id, tax_period: P };
  const q = `client_id=${apex.id}&tax_period=${P}`;

  // the books register in the usual format, with the reverse-charge column left blank as it usually is
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ITC Register");
  ws.getCell(1, 1).value = "ITC as per books";
  ["Party's Name", "GSTIN", "Invoice No", "Invoice Date", "Nature of Services", "Type of Supply (Inter / Intra State)", "Type of Charge (FCM / RCM / Exempt)", "Nil Rated", "Taxable Value", "GST Rate %", "IGST", "CGST", "SGST", "UTGST", "RCM", "Invoice Value"]
    .forEach((h, i) => { ws.getCell(3, i + 1).value = h; });
  const put = (r, v) => v.forEach((x, i) => { ws.getCell(r, i + 1).value = x; });
  put(4, ["Adv. Ramesh Kulkarni", "", "L-1", "05-08-2041", "Legal fees for court matter", "Intra-state", "FCM", 0, 50000, 0, 0, 0, 0, 0, 0, 50000]);
  put(5, ["Speedy Roadways", "27SPEED1234R1Z5", "G-2", "06-08-2041", "Goods transport freight charges", "Intra-state", "FCM", 0, 20000, 18, 0, 1800, 1800, 0, 0, 23600]);
  put(6, ["Local Transport", "", "G-3", "07-08-2041", "Goods transport freight", "Intra-state", "FCM", 0, 20000, 0, 0, 0, 0, 0, 0, 20000]);
  put(7, ["Mr Sitting Director", "", "R-4", "08-08-2041", "Director's sitting fee", "Intra-state", "RCM", 0, 10000, 0, 0, 0, 0, 0, 0, 10000]);
  put(8, ["Google Ireland Ltd", "", "F-5", "09-08-2041", "Google Ireland advertising services", "Inter-state", "FCM", 0, 10000, 0, 0, 0, 0, 0, 0, 10000]);
  put(9, ["Plain Trader", "27PLAIN1234P1Z5", "P-6", "10-08-2041", "Office stationery", "Intra-state", "FCM", 0, 1000, 18, 0, 90, 90, 0, 0, 1180]);
  const booksBuf = Buffer.from(await wb.xlsx.writeBuffer());

  // GSTR-2B: only the transport company that opted for forward charge, and the trader
  const g = new ExcelJS.Workbook();
  const gs = g.addWorksheet("B2B");
  ["GSTIN of supplier", "Trade/Legal name", "Invoice number", "Invoice type", "Invoice Date", "Invoice Value(₹)", "Place of supply", "Supply Attract Reverse Charge", "Taxable Value (₹)", "Integrated Tax(₹)", "Central Tax(₹)", "State/UT Tax(₹)", "Cess(₹)", "GSTR-1/IFF/GSTR-5 Period", "ITC Availability"]
    .forEach((h, i) => { gs.getCell(1, i + 1).value = h; });
  [["27SPEED1234R1Z5", "Speedy Roadways", "G-2", "Regular", "06-08-2041", 23600, "27-Maharashtra", "No", 20000, 0, 1800, 1800, 0, "082041", "Yes"],
   ["27PLAIN1234P1Z5", "Plain Trader", "P-6", "Regular", "10-08-2041", 1180, "27-Maharashtra", "No", 1000, 0, 90, 90, 0, "082041", "Yes"]]
    .forEach((r, k) => r.forEach((v, i) => { gs.getCell(k + 2, i + 1).value = v; }));
  const g2bBuf = Buffer.from(await g.xlsx.writeBuffer());

  // the client's purchase ledger carries an advocate's fee that is in neither file
  await db.query("insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by_role) values ($1,$2,'purchase_ledger',$3,'ledger.xlsx',2,$4,'client')",
    [apex.firm_id, apex.id, P, JSON.stringify({ rows: [
      { type: "inv", inv_no: "AD-9", gstin: "", party: "Adv. Meera Shah - legal fees", date: "2041-08-12", taxable: 20000, cgst: 0, sgst: 0, igst: 0, cess: 0, value: 20000 },
      { type: "inv", inv_no: "L-1", gstin: "", party: "Adv. Ramesh Kulkarni", date: "2041-08-05", taxable: 50000, cgst: 0, sgst: 0, igst: 0, cess: 0, value: 50000 },
    ] })]);

  const f1 = (kind, buf, name) => { const f = new FormData(); for (const [k, v] of Object.entries({ ...base0, kind })) f.append(k, v); f.append("file", new Blob([buf]), name); return f; };
  assert.equal((await api("POST", "/api/itc2b/upload", { token: tokens.staff, form: f1("books", booksBuf, "books.xlsx") })).status, 200);
  const up = await api("POST", "/api/itc2b/upload", { token: tokens.staff, form: f1("gstr2b", g2bBuf, "2b.xlsx") });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.rows, 2);
  assert.deepEqual(up.body.warnings, [], "tax columns were read");

  const s = (await api("GET", `/api/itc2b?${q}`, { token: tokens.staff })).body;
  const line = (no) => s.result.lines.find((l) => l.inv_no === no);
  const tax = (no) => line(no).rcm.tax;

  // advocate: legal services are under reverse charge, nothing recorded, 18% worked out and split
  assert.equal(line("L-1").rcm.mode, "rcm");
  assert.equal(line("L-1").rcm.source, "detected");
  assert.match(line("L-1").rcm.ref, /entry 2/);
  assert.deepEqual([tax("L-1").cgst, tax("L-1").sgst], [4500, 4500]);
  assert.equal(line("L-1").code, "rcm");
  assert.match(line("L-1").remark, /Reverse charge applies and is not recorded in the books/);
  assert.match(line("L-1").provision, /Notification 13\/2017-CT\(R\), entry 2/);

  // GTA that has charged GST and appears in 2B: a note, no RCM
  assert.equal(line("G-2").rcm.mode, "fcm");
  assert.match(line("G-2").remark, /RCM note: This is a reverse-charge kind of supply \(Goods transport agency \(GTA\) service\), but the supplier has opted for forward charge \(FCM\)/);
  assert.equal(line("G-2").code, "eligible", "the ITC is taken from 2B");
  assert.equal(line("G-2").amounts.rcm.cgst, 0);

  // GTA without GST: 5%
  assert.equal(line("G-3").rcm.mode, "rcm");
  assert.deepEqual([tax("G-3").cgst, tax("G-3").sgst], [500, 500]);

  // books say RCM but give no tax: the amount is worked out
  assert.equal(line("R-4").rcm.source, "books");
  assert.deepEqual([tax("R-4").cgst, tax("R-4").sgst], [900, 900]);

  // import of service: IGST
  assert.equal(line("F-5").rcm.mode, "rcm");
  assert.equal(tax("F-5").igst, 1800);

  // an ordinary purchase is not a reverse-charge case
  assert.equal(line("P-6").rcm.mode, "none");

  // the ledger entry that is not in the books is picked up, the one that is, is not repeated
  const cases = s.result.rcm_cases;
  const led = cases.filter((c) => c.source === "ledger");
  assert.equal(led.length, 1);
  assert.equal(led[0].inv_no, "AD-9");
  assert.deepEqual([led[0].tax.cgst, led[0].tax.sgst], [1800, 1800]);
  assert.equal(s.result.ledger_rows, 2);

  // reverse charge goes to cash: 4500+500+900+1800 on each of CGST and SGST, 1800 IGST
  const p = s.result.summary;
  assert.deepEqual([p.rcm.cgst, p.rcm.sgst, p.rcm.igst], [7700, 7700, 1800]);
  assert.deepEqual([p.rcm_ledger.cgst, p.rcm_ledger.sgst], [1800, 1800]);
  assert.deepEqual([p.payment.rcm_cash.cgst, p.payment.cash.cgst], [7700, 7700]);

  // and it is all in the Excel
  const dl = await api("GET", `/api/itc2b/excel?${q}`, { token: tokens.staff });
  assert.equal(dl.status, 200);
  const x = new ExcelJS.Workbook();
  await x.xlsx.load(dl.body);
  assert.deepEqual(x.worksheets.map((w) => w.name), ["GSTR-3B Summary", "Reconciliation Summary", "RCM Check", "ITC Reconciliation", "Notes"]);
  const rows = [];
  x.getWorksheet("RCM Check").eachRow((r) => rows.push(r.values.slice(1).join("|")));
  const text = rows.join("\n");
  assert.match(text, /L-1.*Legal service by an advocate.*entry 2.*RCM payable - not recorded in the books/);
  assert.match(text, /G-2.*supplier charged GST \(FCM\)/);
  assert.match(text, /Client's purchase ledger.*AD-9/);
  const rec = [];
  x.getWorksheet("ITC Reconciliation").eachRow((r) => rec.push(r.values.slice(1).join("|")));
  assert.match(rec.join("\n"), /RCM applicability/);
  assert.match(rec.join("\n"), /RCM applicable - not in books/);
});

test("GSTR-2B reading: a 2B laid out like the books (IGST / CGST / SGST headings), or with only a rate and taxable value, still gets its tax", async () => {
  const { readGstr2b } = await import("../src/services/itc/readers.js");
  const build = async (headers, rows) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Invoice Register");
    headers.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    rows.forEach((r, k) => r.forEach((v, i) => { ws.getCell(k + 2, i + 1).value = v; }));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  // headings the portal does not use
  const a = await readGstr2b(await build(
    ["Party's Name", "GSTIN", "Invoice No.", "Invoice Date", "Taxable Value", "GST Rate %", "IGST", "CGST", "SGST", "Invoice Value"],
    [["Sample Events", "29DUMMY0004A1Z5", "SEM/1", "12-10-2026", 100000, 18, 18000, 0, 0, 118000], ["Sample Properties", "27DUMMY0003A1Z5", "SP/1", "13-10-2026", 250000, 18, 0, 22500, 22500, 295000]],
  ), "2B.xlsx");
  assert.equal(a.rows.length, 2);
  assert.deepEqual(a.rows.map((r) => [r.igst, r.cgst, r.sgst]), [[18000, 0, 0], [0, 22500, 22500]]);
  assert.deepEqual(a.warnings, []);

  // only a rate and a taxable value: the tax is worked out from them and the reader says so
  const b = await readGstr2b(await build(
    ["Supplier", "GSTIN", "Invoice No.", "Invoice Date", "Taxable Value", "Rate"],
    [["Sample Properties", "27DUMMY0003A1Z5", "SP/2", "13-10-2026", 1000, 18]],
  ), "2B.xlsx", { clientGstin: "27AAACA1234A1ZK" });
  assert.equal(b.rows.length, 1);
  assert.equal(b.rows[0].cgst + b.rows[0].sgst, 180);
  assert.ok(b.warnings.some((w) => /general reader/.test(w)));

  // a file with no tax at all and no rate is reported, not silently read as nil
  const c = await readGstr2b(await build(["Supplier", "GSTIN", "Invoice No.", "Invoice Date", "Taxable Value"], [["X", "27DUMMY0003A1Z5", "X/1", "13-10-2026", 1000]]), "2B.xlsx");
  assert.ok(c.warnings.some((w) => /No IGST, CGST or SGST column|Every tax amount/.test(w)));
});
