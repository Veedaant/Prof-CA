import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-out-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const ExcelJS = (await import("exceljs")).default;
const { periodFromName, monthsOfFy, fyOfPeriod } = await import("../src/services/output/readers.js");

let server, base, staff;
async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (json) headers["content-type"] = "application/json";
  const res = await fetch(base + url, { method, headers, body: json ? JSON.stringify(json) : form });
  const ct = res.headers.get("content-type") || "";
  return { status: res.status, body: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
}
before(async () => {
  await initDb({ memory: true });
  await seedDatabase({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  staff = (await api("POST", "/api/auth/login", { json: { email: "staff@example.com", password: "staff123" } })).body.access_token;
});
after(async () => { server.close(); await db.close(); });

const ME = "27AAACA1234A1ZK";
const buf = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());
const fill = (ws, r0, rows) => rows.forEach((row, k) => row.forEach((v, i) => { if (v !== "" && v != null) ws.getCell(r0 + k, i + 1).value = v; }));

async function salesRegister() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales Register");
  ws.getCell(1, 1).value = "Sales register 2026-27";
  fill(ws, 3, [
    ["Date", "Invoice No", "Party Name", "GSTIN", "Description", "Taxable Value", "Rate", "IGST", "CGST", "SGST", "Invoice Value"],
    ["05-04-2026", "INV-1", "Beta Traders", "27BBBBB1111B1Z5", "Goods", 1000, 18, 0, 90, 90, 1180],
    ["10-04-2026", "INV-2", "Gamma Karnataka", "29CCCCC2222C1Z5", "Goods", 2000, 18, 360, 0, 0, 2360],
    ["12-04-2026", "INV-3", "SEZ Unit", "27SEZZZ1111S1Z5", "Goods", 500, 18, 90, 0, 0, 590],
    ["14-04-2026", "CASH-4", "Cash sales", "", "Goods", 400, 18, 0, 36, 36, 472],
    ["16-04-2026", "INV-5", "Overseas Buyer", "", "Export", 700, 18, 0, 0, 0, 700],
    ["18-04-2026", "FA-1", "Delta Industries", "27DDDDD3333D1Z5", "Sale of fixed asset - old machinery", 5000, 18, 0, 450, 450, 5900],
    ["06-05-2026", "INV-6", "Beta Traders", "27BBBBB1111B1Z5", "Goods", 1000, 18, 0, 90, 90, 1180],
  ]);
  const cn = wb.addWorksheet("Credit Notes");
  fill(cn, 1, [
    ["Date", "Credit Note No", "Party Name", "GSTIN", "Taxable Value", "Rate", "IGST", "CGST", "SGST", "Invoice Value"],
    ["20-04-2026", "CN-1", "Beta Traders", "27BBBBB1111B1Z5", 100, 18, 0, 9, 9, 118],
  ]);
  return buf(wb);
}

async function cgstLedger() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Output CGST");
  ws.getCell(1, 1).value = "Ledger: Output CGST";
  ws.getCell(2, 1).value = "1-Apr-2026 to 31-Mar-2027";
  fill(ws, 4, [
    ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
    ["1-Apr-2026", "Opening Balance", "", "", "", 0],
    ["5-Apr-2026", "Beta Traders", "Sales", "INV-1", "", 90],
    ["14-Apr-2026", "Cash sales", "Sales", "CASH-4", "", 36],
    ["18-Apr-2026", "Delta Industries", "Sales", "FA-1", "", 450],
    ["20-Apr-2026", "Beta Traders", "Credit Note", "CN-1", 9, ""],
    ["6-May-2026", "Beta Traders", "Sales", "INV-6", "", 90],
    ["30-May-2026", "Journal - interest", "Journal", "J-1", "", 20],
    ["", "Total", "", "", 9, 686],
  ]);
  return buf(wb);
}

const B2B_HEAD = ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"];
async function gstr1File(month) {
  const wb = new ExcelJS.Workbook();
  const b2b = wb.addWorksheet("b2b");
  b2b.getCell(1, 1).value = "Summary For B2B(4)";
  const rows = month === "04"
    ? [
      ["27BBBBB1111B1Z5", "Beta Traders", "INV-1", "05-04-2026", 1180, "27-Maharashtra", "N", "", "Regular", "", 18, 1000, 0],
      ["29CCCCC2222C1Z5", "Gamma Karnataka", "INV-2", "10-04-2026", 2360, "29-Karnataka", "N", "", "Regular", "", 18, 2000, 0],
      ["27SEZZZ1111S1Z5", "SEZ Unit", "INV-3", "12-04-2026", 590, "27-Maharashtra", "N", "", "SEZ supplies with payment", "", 18, 500, 0],
      ["27RRRRR9999R1Z5", "RCM Customer", "INV-4", "13-04-2026", 300, "27-Maharashtra", "Y", "", "Regular", "", 0, 300, 0],
    ]
    : [["27BBBBB1111B1Z5", "Beta Traders", "INV-6", "06-05-2026", 1180, "27-Maharashtra", "N", "", "Regular", "", 18, 1000, 0]];
  fill(b2b, 4, [B2B_HEAD, ...rows]);
  if (month === "04") {
    const cs = wb.addWorksheet("b2cs");
    fill(cs, 4, [["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"], ["OE", "27-Maharashtra", "", 18, 400, 0, ""]]);
    const cdnr = wb.addWorksheet("cdnr");
    fill(cdnr, 4, [["GSTIN/UIN of Recipient", "Receiver Name", "Note Number", "Note Date", "Note Type", "Place Of Supply", "Reverse Charge", "Note Supply Type", "Note Value", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"],
      ["27BBBBB1111B1Z5", "Beta Traders", "CN-1", "20-04-2026", "C", "27-Maharashtra", "N", "Regular", 118, "", 18, 100, 0]]);
    const ex = wb.addWorksheet("exp");
    fill(ex, 4, [["Export Type", "Invoice Number", "Invoice date", "Invoice Value", "Port Code", "Shipping Bill Number", "Shipping Bill Date", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount"], ["WOPAY", "INV-5", "16-04-2026", 700, "INMAA1", "123", "16-04-2026", "", 18, 700, 0]]);
    const ev = wb.addWorksheet("exemp");
    fill(ev, 4, [["Description", "Nil Rated Supplies", "Exempted(other than nil rated/non GST supply)", "Non-GST supplies"], ["Intra-State supplies to registered persons", 50, 0, 0], ["Inter-State supplies to unregistered persons", 0, 30, 20]]);
  }
  const hs = wb.addWorksheet("hsn");
  fill(hs, 4, [["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
    month === "04" ? ["9988", "Services", "NOS", 10, 5000, 18, 4900, 450, 117, 117, 0] : ["9988", "Services", "NOS", 1, 1180, 18, 1000, 0, 90, 90, 0]]);
  return buf(wb);
}

async function gstr3bFile(a, d, extra = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("GSTR-3B");
  const row = (label, v) => [label, ...v];
  fill(ws, 1, [
    ["Form GSTR-3B"],
    ["3.1 Details of Outward Supplies and inward supplies liable to reverse charge"],
    row("(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", a),
    row("(b) Outward taxable supplies (zero rated)", extra.b || [0, 0, 0, 0, 0]),
    row("(c) Other outward supplies (Nil rated, exempted)", extra.c || [0, 0, 0, 0, 0]),
    row("(d) Inward supplies (liable to reverse charge)", d),
    row("(e) Non-GST outward supplies", [0, 0, 0, 0, 0]),
  ]);
  return buf(wb);
}

const form = (fields, files) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [name, b] of files) { f.append("files", new Blob([b]), name); if (process.env.KEEP_FIX) fs.writeFileSync(path.join(process.env.KEEP_FIX, name), b); }
  return f;
};

test("period and financial-year helpers", () => {
  assert.equal(periodFromName("GSTR1_042026.xlsx"), "2026-04");
  assert.equal(periodFromName("GSTR-3B Apr-2026.pdf"), "2026-04");
  assert.equal(periodFromName("returns_2026-05_R1.xlsx"), "2026-05");
  assert.equal(periodFromName("sales.xlsx"), null);
  assert.equal(fyOfPeriod("2027-02"), "2026-27");
  assert.deepEqual([monthsOfFy("2026-27")[0], monthsOfFy("2026-27")[11]], ["2026-04", "2027-03"]);
});

test("Output reconciliation: combine books, GSTR-1 and GSTR-3B and prepare the ten-sheet working for GSTR-9 and 9C", async () => {
  const apex = await db.one("select id from clients where name like 'Apex%'");
  await db.query("update clients set gstin=$1 where id=$2", [ME, apex.id]);
  const base0 = { client_id: apex.id, fy: "2026-27" };
  const q = `client_id=${apex.id}&fy=2026-27`;

  assert.equal((await api("GET", `/api/output?${q}`)).status, 401);
  assert.equal((await api("GET", `/api/output?client_id=${apex.id}&fy=2026`, { token: staff })).status, 422);
  assert.equal((await api("GET", `/api/output/working?${q}`, { token: staff })).status, 409, "nothing uploaded yet");

  // 1. books: a sales register and an output CGST ledger, in two files
  let r = await api("POST", "/api/output/upload", { token: staff, form: form({ ...base0, kind: "books" }, [["Sales Register.xlsx", await salesRegister()], ["Output CGST ledger.xlsx", await cgstLedger()]]) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  const regRows = r.body.results[0].rows, ledRows = r.body.results[1].rows;
  assert.equal(regRows, 8, "seven invoices and a credit note");
  assert.equal(ledRows, 6, "opening balance and total lines are not entries");

  // 2. GSTR-1 for two months; the month comes from the file name
  r = await api("POST", "/api/output/upload", { token: staff, form: form({ ...base0, kind: "gstr1" }, [["GSTR1_042026.xlsx", await gstr1File("04")], ["GSTR1_052026.xlsx", await gstr1File("05")]]) });
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.period), ["2026-04", "2026-05"]);

  // 3. GSTR-3B for two months, in Excel
  r = await api("POST", "/api/output/upload", { token: staff, form: form({ ...base0, kind: "gstr3b" }, [
    ["GSTR3B_042026.xlsx", await gstr3bFile([3800, 450, 117, 117, 0], [1000, 0, 90, 90, 0], { b: [700, 0, 0, 0, 0], c: [50, 0, 0, 0, 0] })],
    ["GSTR3B_052026.xlsx", await gstr3bFile([1100, 0, 99, 99, 0], [0, 0, 0, 0, 0])],
  ]) });
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map((x) => x.period), ["2026-04", "2026-05"]);
  assert.equal((await api("POST", "/api/output/upload", { token: staff, form: form({ ...base0, kind: "gstr1" }, [["notes.xlsx", await salesRegister()]]) })).body.results[0].ok, false, "a register is not a GSTR-1");

  const s = (await api("GET", `/api/output?${q}`, { token: staff })).body;
  assert.equal(s.files.books.length, 2);
  assert.equal(s.files.gstr1.length, 2);
  const apr = (set) => s.compare[set].rows.find((x) => x.month === "2026-04");
  const may = (set) => s.compare[set].rows.find((x) => x.month === "2026-05");

  // GSTR-1 April: taxable 1000+2000+500+400-100 = 3800 plus 700 exported without tax; IGST 360+90, CGST 90+36-9
  assert.deepEqual([apr("g1_vs_3b").a.taxable, apr("g1_vs_3b").a.igst, apr("g1_vs_3b").a.cgst, apr("g1_vs_3b").a.sgst], [4500, 450, 117, 117]);
  assert.deepEqual([apr("g1_vs_3b").b.taxable, apr("g1_vs_3b").d.taxable], [4500, 0], "GSTR-3B 3.1(a)+(b)");
  assert.deepEqual([may("g1_vs_3b").d.taxable, may("g1_vs_3b").d.cgst], [-100, -9], "GSTR-3B shows 100 more in May");
  // books April: 9500 taxable; CGST from the ledger (567)
  assert.equal(apr("g1_vs_books").b.taxable, 9500);
  assert.equal(apr("g1_vs_books").b.cgst, 567, "the ledger is used for the tax");
  assert.equal(apr("g1_vs_books").d.taxable, -5000);
  assert.equal(may("g1_vs_books").b.cgst, 110, "the journal entry in the ledger is in the books figure");

  // classification
  const cls = Object.fromEntries(s.classification.map((c) => [c.key, c]));
  assert.equal(cls.regular.taxable, 4000, "April B2B - regular registered persons|4000 and May 1000");
  assert.equal(cls.sez_pay.taxable, 500);
  assert.equal(cls.b2cs.taxable, 400);
  assert.equal(cls.export_nopay.taxable, 700);
  assert.equal(cls.rcm.taxable, 300);
  assert.equal(cls.cn.taxable, -100);
  assert.equal(s.capital, 1);

  // party-wise: Delta is only in the books
  const dl = await api("GET", `/api/output/working?${q}`, { token: staff });
  assert.equal(dl.status, 200);
  if (process.env.KEEP_OUT) fs.writeFileSync(process.env.KEEP_OUT, dl.body);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(dl.body);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["1 Books Combined", "2 GSTR-1 Combined", "3 GSTR-3B Combined", "4 Monthly Comparison", "5 Party Comparison", "6 Turnover Classification", "7 HSN Summary", "8 Rate-wise Summary", "9 GSTR-9 and 9C Workings", "10 Differences and Actions"]);
  const text = (name) => { const out = []; wb.getWorksheet(name).eachRow((row) => out.push(row.values.slice(1).map((v) => (v && typeof v === "object" && "result" in v ? v.result : v)).join("|"))); return out.join("\n"); };
  assert.match(text("5 Party Comparison"), /Delta Industries\|27DDDDD3333D1Z5.*Books only/);
  assert.match(text("5 Party Comparison"), /Beta Traders\|27BBBBB1111B1Z5/);
  assert.match(text("4 Monthly Comparison"), /A\. GSTR-1 against GSTR-3B/);
  assert.match(text("4 Monthly Comparison"), /C\. GSTR-3B against books/);
  assert.match(text("6 Turnover Classification"), /B2B - regular registered persons|4000\|3000/);
  assert.match(text("6 Turnover Classification"), /Sale of capital assets/);
  assert.match(text("6 Turnover Classification"), /old machinery/);
  assert.match(text("7 HSN Summary"), /9988\|Services\|NOS\|18/);
  assert.match(text("8 Rate-wise Summary"), /Regular supply/);
  assert.match(text("9 GSTR-9 and 9C Workings"), /4N\|Supplies and advances on which tax is payable/);
  assert.match(text("9 GSTR-9 and 9C Workings"), /5C\|Supplies on which tax is to be paid by the recipient on reverse charge basis\|300/);
  assert.match(text("9 GSTR-9 and 9C Workings"), /5N\|Total turnover/);
  const diffs = text("10 Differences and Actions");
  assert.match(diffs, /GSTR-1 vs GSTR-3B.*May-26.*GSTR-3B shows more than GSTR-1/);
  assert.match(diffs, /Delta Industries/);
  assert.match(diffs, /Sale of capital assets found in the books/);
  assert.match(diffs, /Recommended course of action/);

  // the combined downloads
  const cb = await api("GET", `/api/output/combined/books?${q}`, { token: staff });
  assert.equal(cb.status, 200);
  const b2 = new ExcelJS.Workbook(); await b2.xlsx.load(cb.body);
  assert.deepEqual(b2.worksheets.map((w) => w.name), ["Books combined", "Month-wise summary"]);
  const cg = await api("GET", `/api/output/combined/gstr1?${q}`, { token: staff });
  assert.equal(cg.status, 200);
  const g2 = new ExcelJS.Workbook(); await g2.xlsx.load(cg.body);
  assert.deepEqual(g2.worksheets.map((w) => w.name), ["Month-wise summary", "All sections", "HSN summary"]);
  const all1 = []; g2.getWorksheet("All sections").eachRow((row) => all1.push(row.values.slice(1).join("|")));
  const t1 = all1.join("\n");
  assert.match(t1, /Supply type/);
  assert.match(t1, /B2B\|Regular supply\|27BBBBB1111B1Z5/);
  assert.match(t1, /EXEMP\|Nil rated supply\|\|Intra-State supplies to registered persons/);
  assert.match(t1, /EXEMP\|Exempted supply/);
  assert.match(t1, /EXEMP\|Non-GST supply/);
  assert.match(t1, /CDNR\|Credit note - regular supply/);
  assert.match(t1, /EXP\|Export without payment of tax \(zero rated\)/);
  assert.doesNotMatch(t1, /Table 8/, "nil rated and exempt lines are in the main list, not in a block below");
  assert.match(t1, /Nil rated, exempted and non-GST supplies \(value only\)/);

  // change a file's month, delete a file, party classification
  const f = s.files.gstr3b.find((x) => x.period === "2026-05");
  assert.equal((await api("PUT", `/api/output/file/${f.id}`, { token: staff, json: { period: "2026-06" } })).status, 200);
  assert.equal((await api("PUT", `/api/output/file/${f.id}`, { token: staff, json: { period: "June" } })).status, 422);
  let s2 = (await api("GET", `/api/output?${q}`, { token: staff })).body;
  assert.equal(s2.coverage.find((c) => c.month === "2026-06").gstr3b, true);
  assert.ok(s2.differences.some((d) => d.area === "Missing month"), "June has a GSTR-3B but nothing else");
  assert.equal((await api("PUT", "/api/output/settings", { token: staff, json: { ...base0, party_types: "27BBBBB1111B1Z5 composition" } })).status, 200);
  s2 = (await api("GET", `/api/output?${q}`, { token: staff })).body;
  const c2 = Object.fromEntries(s2.classification.map((c) => [c.key, c]));
  assert.equal(c2.composition.taxable, 2000);
  assert.equal(c2.regular.taxable, 2000);
  assert.equal((await api("DELETE", `/api/output/file/${f.id}`, { token: staff })).status, 200);
});

test("Books: sales registers in other layouts (voucher no., basic amount, particulars) are read", async () => {
  const { readBooksOutput } = await import("../src/services/output/readers.js");
  const mk = async (hdr, rows) => {
    const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sales Register");
    ws.getCell(1, 1).value = "Sales Register FY 2025-26";
    hdr.forEach((h, i) => { ws.getCell(3, i + 1).value = h; });
    rows.forEach((row, k) => row.forEach((v, i) => { ws.getCell(4 + k, i + 1).value = v; }));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const a = await readBooksOutput(await mk(["Date", "Particulars", "Voucher Type", "Voucher No.", "Gross Total", "Sales", "Output CGST", "Output SGST"], [["05-Apr-2025", "Beta Traders", "Sales", "S/1", 1180, 1000, 90, 90]]), "Sales as per Books.xlsx");
  assert.deepEqual([a.rows[0].inv_no, a.rows[0].party, a.rows[0].taxable, a.rows[0].cgst], ["S/1", "Beta Traders", 1000, 90]);
  const b = await readBooksOutput(await mk(["Sr No", "Bill No.", "Bill Date", "Party", "GSTIN No.", "Basic Amount", "CGST Amt", "SGST Amt", "IGST Amt", "Bill Amount"], [[1, "B/1", "2025-04-05", "Beta", "27BBBBB1111B1Z5", 1000, 90, 90, 0, 1180]]), "Sales.xlsx");
  assert.deepEqual([b.rows[0].taxable, b.rows[0].sgst, b.rows[0].month], [1000, 90, "2025-04"]);
  // no document number column at all: the lines are still read (by the general reader)
  const c = await readBooksOutput(await mk(["Date", "Customer Name", "Taxable Value", "CGST", "SGST", "Invoice Value"], [["05-04-2025", "Beta", 1000, 90, 90, 1180]]), "Sales.xlsx").catch((e) => e);
  assert.ok(!(c instanceof Error) && c.rows.length === 1 && c.rows[0].taxable === 1000, "a register with no document number column is still read");
});

test("Books: taxable value is worked out from the invoice value when the register has none; an empty document-number column is skipped", async () => {
  const { readBooksOutput } = await import("../src/services/output/readers.js");
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Sales Register");
  ws.getCell(1, 1).value = "Sales Register";
  ["Date", "Particulars", "GSTIN/UIN", "Invoice No", "Vch No.", "Gross Total", "CGST", "SGST"].forEach((h, i) => { ws.getCell(3, i + 1).value = h; });
  [["01-04-2025", "Firmenich", "27AABCF1120G2Z8", "", "S/101", 273878, 20889, 20889], ["02-04-2025", "Small Co", "", "", "S/102", 11328, 864, 864]].forEach((r, k) => r.forEach((v, i) => { if (v !== "") ws.getCell(4 + k, i + 1).value = v; }));
  const r = await readBooksOutput(Buffer.from(await wb.xlsx.writeBuffer()), "Sales as per Books.xlsx");
  assert.equal(r.rows.length, 2);
  assert.deepEqual([r.rows[0].taxable, r.rows[0].rate, r.rows[0].inv_no], [232100, 9 * 2 === 18 ? 18 : 0, "S/101"], "taxable = value less tax; rate from the tax; number from the other column");
  assert.equal(r.rows[1].taxable, 9600);
});

test("GSTR-1 of a whole year in one file: each line goes to the month of its own date, undated lines to 'No month'", async () => {
  const { readGstr1Excel } = await import("../src/services/output/readers.js");
  const { analyseOutput } = await import("../src/services/output/analyse.js");
  const wb = new ExcelJS.Workbook();
  const b2b = wb.addWorksheet("B2B");
  fill(b2b, 1, [B2B_HEAD,
    ["27BBBBB1111B1Z5", "Beta", "A/1", "05-04-2025", 1180, "27-Maharashtra", "N", "", "Regular", "", 18, 1000, 0],
    ["27BBBBB1111B1Z5", "Beta", "A/2", "10-05-2025", 1180, "27-Maharashtra", "N", "", "Regular", "", 18, 2000, 0],
    ["27BBBBB1111B1Z5", "Beta", "A/3", "12-06-2025", 1180, "27-Maharashtra", "N", "", "Regular", "", 18, 3000, 0]]);
  const cs = wb.addWorksheet("B2CS");
  fill(cs, 1, [["Type", "Place Of Supply", "Rate", "Taxable Value", "Cess Amount"], ["OE", "27-Maharashtra", 18, 400, 0]]);
  const parsed = await readGstr1Excel(Buffer.from(await wb.xlsx.writeBuffer()), "GSTR1SectionWiseSummary_11828 PM.xlsx", { clientGstin: ME });
  assert.equal(parsed.multi, true);
  assert.equal(parsed.period, null);
  assert.ok(parsed.warnings.some((w) => /covers 3 months/.test(w)));
  const x = analyseOutput({ fy: "2025-26", gstr1: [{ name: "annual.xlsx", period: null, multi: true, rows: parsed.rows, hsn: [], exemp: [] }] });
  const m = (p) => x.g1[p].liab.taxable;
  assert.deepEqual([m("2025-04"), m("2025-05"), m("2025-06"), m("2025-07")], [1000, 2000, 3000, 0], "not all in one month");
  assert.deepEqual(x.coverage.filter((c) => c.gstr1).map((c) => c.month), ["2025-04", "2025-05", "2025-06"]);
  assert.equal(x.g1Undated.liab.taxable, 400);
  assert.equal(x.totals.g1.taxable, 6400, "the undated line is in the total");
  assert.equal(x.compare.g1_vs_3b.rows.at(-1).month, "undated");
  const months = [...new Set(x.g1Rows.map((r) => r.month))].sort();
  assert.deepEqual(months, ["", "2025-04", "2025-05", "2025-06"]);

  // a normal monthly file named for its month stays one month, even with a few older invoices
  const mon = await readGstr1Excel(Buffer.from(await wb.xlsx.writeBuffer()), "GSTR1_062025.xlsx", { clientGstin: ME });
  assert.equal(mon.multi, false);
  assert.equal(mon.period, "2025-06");
});
