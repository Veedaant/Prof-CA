import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ExcelJS from "exceljs";

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gst-inreco-"));
delete process.env.DATABASE_URL;
process.env.GEMINI_API_KEY = "";
process.env.GOOGLE_API_KEY = "";
delete process.env.SUPABASE_URL;

const { initDb, db } = await import("../src/db/index.js");
const { seedDatabase } = await import("../src/seeds/seed.js");
const { createApp } = await import("../src/index.js");
const { read3bWorking } = await import("../src/services/inputRecon/work3b.js");

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

async function xlsx(rows, sheet = "GSTR-3B Summary") {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const up = (kind, name, content, token = tokens.staff) => {
  const fd = new FormData();
  fd.append("client_id", clientId); fd.append("fy", "2025-26"); fd.append("kind", kind);
  fd.append("files", new Blob([content]), name);
  return api("POST", "/api/input-recon/upload", { token, form: fd });
};
const reco = async () => (await api("GET", `/api/input-recon/reco?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).body;

/** The layout of this app's own GSTR-3B working: Table 3.1, Table 4, Table 6.1, each line with its figures. */
const working = (period, { a3 = [0, 0, 0, 0], a5 = [0, 0, 0, 0], b1 = [0, 0, 0, 0], title = true } = {}) => {
  const net = a5.map((v, i) => v + a3[i] - b1[i]);
  return [
    [title ? `GSTR-3B working - Apex Retailers (27AAACA1234A1ZK) - ${period}` : "GSTR-3B working"], [],
    ["Table 3.1 - Outward supplies and inward supplies liable to reverse charge"],
    ["Nature of supplies", "Taxable value", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", 100000, 0, 9000, 9000, 0],
    ["(d) Inward supplies (liable to reverse charge) - tax worked out by the recipient", 5000, 0, 450, 450, 0],
    [],
    ["Table 4 - Eligible ITC"],
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    ["(A)(1) Import of goods - not captured (needs bill of entry)", 0, 0, 0, 0],
    ["(A)(2) Import of services", 0, 0, 0, 0],
    ["(A)(3) Inward supplies liable to reverse charge (other than 1 and 2 above)", ...a3],
    ["(A)(4) Inward supplies from ISD - not captured", 0, 0, 0, 0],
    ["(A)(5) All other ITC (purchase invoices and debit notes)", ...a5],
    ["(B)(1) ITC reversed - rules 38, 42, 43 and section 17(5) (blocked credits found in the documents)", ...b1],
    ["(B)(2) ITC reversed - others (credit notes on purchases)", 0, 0, 0, 0],
    ["(C) Net ITC available (A - B)", ...net],
    ["(D)(2) Ineligible ITC under section 16(4) - not claimed above", 0, 0, 0, 0],
    [],
    ["Table 6.1 - Payment of tax (after set-off of ITC in the statutory order)"],
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    ["Tax payable (outward tax + reverse charge)", 0, 9450, 9450, 0],
    ["Paid through ITC (ITC already in the ledger)", 0, 1890, 1890, 0],
    ["Paid in cash (includes reverse-charge tax)", 0, 7560, 7560, 0],
  ];
};

/** The GSTR-3B as filed, in the layout the portal's PDF has (read here from an Excel of the same lines). */
const filed = (a5, a3 = [0, 0, 0, 0], b = [0, 0, 0, 0]) => [
  ["Form GSTR-3B"], ["3.1 Details of Outward Supplies and inward supplies liable to reverse charge"],
  ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", 100000, 0, 9000, 9000, 0],
  ["(b) Outward taxable supplies (zero rated)", 0, 0, 0, 0, 0], ["(c) Other outward supplies (Nil rated, exempted)", 0, 0, 0, 0, 0],
  ["(d) Inward supplies (liable to reverse charge)", 0, 0, 0, 0, 0], ["(e) Non-GST outward supplies", 0, 0, 0, 0, 0],
  ["4. Eligible ITC"],
  ["(3) Inward supplies liable to reverse charge (other than 1 & 2 above)", ...a3],
  ["(5) All other ITC", ...a5],
  ["(1) As per rules 38,42 & 43 of CGST Rules and sub-section (5) of section 17", ...b],
];

test("a monthly working is read by its labels: Table 4 lines, the month, and the other tables", async () => {
  const w = await read3bWorking(await xlsx(working("2025-08", { a5: [0, 1890, 1890, 0] })), "aug.xlsx");
  assert.equal(w.period, "2025-08");
  assert.deepEqual(w.t4.a5, { igst: 0, cgst: 1890, sgst: 1890, cess: 0 });
  assert.deepEqual(w.claimed, { igst: 0, cgst: 1890, sgst: 1890, cess: 0 });
  assert.equal(w.t4.net.cgst, 1890);
  assert.deepEqual(w.warnings, []);
  assert.deepEqual(w.t31.a, { taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0 });
  assert.equal(w.t31.d.cgst, 450, "the 3.1(d) line is not mistaken for 4(A)(3)");
  assert.equal(w.t4.a3.cgst, 0);
  assert.deepEqual(w.t61.cash, { igst: 0, cgst: 7560, sgst: 7560, cess: 0 });

  // reverse-charge credit and a reversal: net = A less B
  const rcm = await read3bWorking(await xlsx(working("2025-09", { a5: [0, 900, 900, 0], a3: [0, 450, 450, 0], b1: [0, 100, 100, 0] })), "sep.xlsx");
  assert.deepEqual(rcm.claimed, { igst: 0, cgst: 1250, sgst: 1250, cess: 0 });

  // a working whose own Net line disagrees with its lines is read by the lines, with a warning
  const bad = working("2025-09", { a5: [0, 900, 900, 0] });
  bad[bad.findIndex((r) => /^\(C\)/.test(r[0]))] = ["(C) Net ITC available (A - B)", 0, 5000, 5000, 0];
  const odd = await read3bWorking(await xlsx(bad), "sep.xlsx");
  assert.equal(odd.claimed.cgst, 900);
  assert.match(odd.warnings[0], /own Net ITC line/);

  // only a Net line
  const lean = await read3bWorking(await xlsx([["GSTR-3B Aug-2025"], ["Table 4"], ["Net ITC available", 0, 100, 100, 0]]), "x.xlsx");
  assert.deepEqual(lean.claimed, { igst: 0, cgst: 100, sgst: 100, cess: 0 });
  assert.match(lean.warnings.join(" "), /Only a Net ITC line/);

  await assert.rejects(read3bWorking(await xlsx([["nothing", "here"]]), "x.xlsx"), /No Table 4/);
});

test("the workings are uploaded month by month, and the ITC each claims is shown on the list", async () => {
  assert.equal((await up("work3b", "aug.xlsx", await xlsx(working("2025-08", { a5: [0, 1890, 1890, 0] })), tokens.client1)).status, 403);
  const aug = (await up("work3b", "aug-working.xlsx", await xlsx(working("2025-08", { a5: [0, 1890, 1890, 0] })))).body.results[0];
  assert.deepEqual([aug.ok, aug.read], [true, true]);
  const files = (await api("GET", `/api/input-recon?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).body.files;
  const f = files.find((x) => x.kind === "work3b");
  assert.equal(f.period, "2025-08");
  assert.deepEqual(f.info.claimed, { igst: 0, cgst: 1890, sgst: 1890, cess: 0 });

  const none = (await up("work3b", "no-month.xlsx", await xlsx(working("", { a5: [0, 1, 1, 0], title: false })))).body.results[0];
  assert.match(none.warnings.join(" "), /return month could not be found/);
  const id = (await api("GET", `/api/input-recon?client_id=${clientId}&fy=2025-26`, { token: tokens.staff })).body.files.find((x) => x.name === "no-month.xlsx").id;
  assert.equal((await api("DELETE", `/api/input-recon/file/${id}`, { token: tokens.staff })).status, 200);
});

test("each month's working is matched with the GSTR-3B filed", async () => {
  await up("work3b", "sep-working.xlsx", await xlsx(working("2025-09", { a5: [0, 900, 900, 0], a3: [0, 450, 450, 0] })));
  await up("work3b", "oct-working.xlsx", await xlsx(working("2025-10", { a5: [0, 1000, 1000, 0] })));
  await up("work3b", "nov-working.xlsx", await xlsx(working("2025-11", { a5: [0, 300, 300, 0] })));
  await up("gstr3b", "GSTR3B_Aug-2025.xlsx", await xlsx(filed([0, 1890, 1890, 0]), "GSTR-3B"));
  await up("gstr3b", "GSTR3B_Sep-2025.xlsx", await xlsx(filed([0, 900, 900, 0], [0, 450, 450, 0]), "GSTR-3B"));
  await up("gstr3b", "GSTR3B_Oct-2025.xlsx", await xlsx(filed([0, 900, 900, 0]), "GSTR-3B"));
  await up("gstr3b", "GSTR3B_Dec-2025.xlsx", await xlsx(filed([0, 50, 50, 0]), "GSTR-3B"));

  const r = await reco();
  const m = Object.fromEntries(r.rows.map((x) => [x.month, x]));
  assert.equal(m["2025-08"].status, "Matches");
  assert.equal(m["2025-09"].status, "Matches", "reverse-charge credit counts on both sides");
  assert.equal(m["2025-10"].status, "Does not match");
  assert.equal(m["2025-10"].diffTotal, 200);
  assert.deepEqual(m["2025-10"].diff, { igst: 0, cgst: 100, sgst: 100, cess: 0 });
  assert.match(m["2025-10"].remark, /claims more ITC than the GSTR-3B by Rs 200 \(CGST \+100, SGST \+100\)/);
  assert.match(m["2025-10"].remark, /4\(A\)\(5\) All other ITC \(working 2000, GSTR-3B 1800\)/);
  assert.equal(m["2025-11"].status, "No GSTR-3B");
  assert.equal(m["2025-12"].status, "No working");
  assert.equal(m["2025-04"].status, "Not uploaded");
  assert.deepEqual([r.summary.compared, r.summary.matching, r.summary.differing, r.summary.noWorking, r.summary.noPortal], [3, 2, 1, 1, 1]);
  assert.equal(r.summary.diffTotal, 200);
  assert.deepEqual(r.have, { working: true, portal: true });
  assert.equal(r.rows.length, 12);
});

test("a later working for a month replaces the earlier one", async () => {
  await up("work3b", "aug-working-revised.xlsx", await xlsx(working("2025-08", { a5: [0, 1900, 1900, 0] })));
  const r = await reco();
  const aug = r.rows.find((x) => x.month === "2025-08");
  assert.equal(aug.status, "Does not match");
  assert.equal(aug.workingFile, "aug-working-revised.xlsx");
  assert.deepEqual(r.replaced, [{ name: "aug-working.xlsx", period: "2025-08", side: "working" }]);
});

const sheetText = (wb, name) => { const out = []; wb.getWorksheet(name).eachRow((row) => out.push(row.values.slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
async function download(url) {
  const r = await api("GET", url, { token: tokens.staff });
  const wb = new ExcelJS.Workbook();
  if (r.status === 200) await wb.xlsx.load(r.body);
  return { r, wb };
}

test("the combined workings download on their own, with the eligible ITC of every month", async () => {
  const empty = await api("GET", `/api/input-recon/combined/work3b?client_id=${clientId}&fy=2024-25`, { token: tokens.staff });
  assert.equal(empty.status, 409);
  assert.equal((await api("GET", `/api/input-recon/combined/work3b?client_id=${clientId}&fy=2025-26`, { token: tokens.client1 })).status, 403);

  const { r, wb } = await download(`/api/input-recon/combined/work3b?client_id=${clientId}&fy=2025-26`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="GSTR-3B_workings_combined_2025-26_Apex_Retailers_Pvt_Ltd\.xlsx"/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Eligible ITC by Month", "2 Table 4 Line-wise", "4 Outward and Tax Paid", "Notes"]);
  const s1 = sheetText(wb, "1 Eligible ITC by Month");
  assert.match(s1, /Month \| Working file \| 4\(A\)\(5\) All other ITC \| 4\(A\)\(3\) Reverse charge/);
  assert.match(s1, /Aug-25 \| aug-working-revised\.xlsx \| 3800 \| 0 \| 0 \| 0 \| 0 \| 1900 \| 1900 \| 0 \| 3800/);
  assert.match(s1, /Sep-25 \| sep-working\.xlsx \| 1800 \| 900 \| 0 \| 0 \| 0 \| 1350 \| 1350 \| 0 \| 2700/);
  assert.match(s1, /Apr-25 \| Working not uploaded/);
  assert.match(sheetText(wb, "2 Table 4 Line-wise"), /Table 4\(A\): ITC available/);
  assert.match(sheetText(wb, "4 Outward and Tax Paid"), /Table 6\.1: payment of tax/);
  assert.match(sheetText(wb, "Notes"), /aug-working\.xlsx \(Aug-25\) is not used: a later working for the same month was uploaded/);
});

test("the match report downloads with the months that do not match", async () => {
  const { r, wb } = await download(`/api/input-recon/combined/reco?client_id=${clientId}&fy=2025-26`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="Input_Reco_3B_workings_vs_GSTR-3B_2025-26_Apex_Retailers_Pvt_Ltd\.xlsx"/);
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Match Summary", "2 Head-wise", "3 Line-wise", "Notes"]);
  const s1 = sheetText(wb, "1 Match Summary");
  assert.match(s1, /Months compared \| 3 \| Match \| 1 \| Do not match \| 2/);
  assert.match(s1, /Sep-25 \| 2700 \| 2700 \| 0 \| Matches/);
  assert.match(s1, /Oct-25 \| 2000 \| 1800 \| 200 \| Does not match \| The working claims more ITC than the GSTR-3B by Rs 200/);
  assert.match(s1, /Nov-25 \| 600 \|[ |]*No GSTR-3B/);
  assert.match(s1, /Dec-25 \|[ |]*100 \|[ |]*No working/);
  assert.match(sheetText(wb, "3 Line-wise"), /Oct-25 \| 4\(A\)\(5\) All other ITC \| 2000 \| 1800 \| 200/);
});

test("figures are taken from the end of a GSTR-3B line, not from numbers inside its label", async () => {
  const { parseGstr3bText } = await import("../src/services/recon/gstr3bParser.js");
  const p = parseGstr3bText([
    "3.1 Details of Outward Supplies and inward supplies liable to reverse charge",
    "(a) Outward taxable supplies (other than zero rated, nil rated and exempted) 1,00,000.00 0.00 9,000.00 9,000.00 0.00",
    "(b) Outward taxable supplies (zero rated) 0.00 0.00 0.00 0.00 0.00",
    "4. Eligible ITC",
    "(3) Inward supplies liable to reverse charge (other than 1 & 2 above) 0.00 450.00 450.00 0.00",
    "(5) All other ITC 0.00 900.00 900.00 0.00",
    "(1) As per rules 38,42 & 43 of CGST Rules and sub-section (5) of section 17 0.00 100.00 100.00 0.00",
    "(2) Others 0.00 0.00 0.00 0.00",
  ].join("\n"));
  assert.deepEqual(p.figures.outward.a, { taxable: 100000, igst: 0, cgst: 9000, sgst: 9000, cess: 0 });
  assert.deepEqual(p.figures.itc.rcm, { igst: 0, cgst: 450, sgst: 450, cess: 0 });
  assert.deepEqual(p.figures.itc.other, { igst: 0, cgst: 900, sgst: 900, cess: 0 });
  assert.deepEqual(p.figures.itc.reversed_rules, { igst: 0, cgst: 100, sgst: 100, cess: 0 });
});
