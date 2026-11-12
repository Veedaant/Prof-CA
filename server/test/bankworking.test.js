import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { readStatement, parseStatementText } from "../src/services/banking/statementReader.js";
import { readLedger } from "../src/services/banking/ledgerReader.js";
import { parse26asText, parseTisText } from "../src/services/banking/taxDocs.js";
import { buildBankWorking } from "../src/services/banking/bankWorking.js";
import { bankWorkbook } from "../src/services/banking/bankReport.js";

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const STATEMENT = [
  ["HDFC BANK LTD - Statement of account"], ["Account No: 50100123456789"], [],
  ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
  ["01/04/2025", "OPENING BALANCE", "", "", "", "", 100000],
  ["03/04/2025", "NEFT CR-HDFCN123-ABC TRADERS PVT LTD-INV 101", "000123456", "03/04/2025", "", 118000, 218000],
  ["05/04/2025", "CHQ PAID 000555 XYZ SERVICES", "000555", "05/04/2025", 25000, "", 193000],
  ["10/04/2025", "RTGS CR-DEF INDUSTRIES LTD", "", "10/04/2025", "", 116000, 309000],
  ["30/04/2025", "SMS CHARGES Q1", "", "30/04/2025", 17.7, "", 308982.3],
  ["12/05/2025", "NEFT CR-MYSTERY CORP-ADVANCE", "", "12/05/2025", "", 5000, 313982.3],
  ["04/06/2025", "CHQ PAID 000777 PQR LTD", "000777", "04/06/2025", 40000, "", 273982.3],
  ["05/06/2025", "ECS EMI LOAN 4455", "", "05/06/2025", 12500, "", 261482.3],
  ["15/06/2025", "INT.PD 01-04-25 TO 30-06-25", "", "15/06/2025", "", 450, 261932.3],
];
const LEDGER = [
  ["ABC Enterprises"], ["HDFC Bank A/c"], ["1-Apr-2025 to 30-Jun-2025"],
  ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"],
  ["01-04-2025", "Opening Balance", "", "", 100000, ""],
  ["03-04-2025", "By ABC Traders Pvt Ltd", "Receipt", "11", 118000, ""],
  ["06-04-2025", "To XYZ Services", "Payment", "21", "", 25000],
  ["", "Cheque no 000555 for professional fees", "", "", "", ""],
  ["10-04-2025", "By DEF Industries Ltd", "Receipt", "12", 116000, ""],
  ["28-05-2025", "To PQR Ltd", "Payment", "22", "", 40000],
  ["", "Cheque 000777", "", "", "", ""],
  ["05-06-2025", "To Term Loan A/c", "Payment", "15", "", 12500],
  ["15-06-2025", "By Interest Received", "Receipt", "14", 450, ""],
  ["25-06-2025", "To Local Vendor", "Payment", "23", "", 3000],
];
const INVOICES = [
  { invoice_type: "sales", return_type: "gstr1", buyer_name: "ABC Traders Pvt Ltd", invoice_number: "INV-101", invoice_date: "2025-04-01", invoice_total: 118000, total_taxable_value: 100000 },
  { invoice_type: "sales", return_type: "gstr1", buyer_name: "DEF Industries Ltd", invoice_number: "INV-102", invoice_date: "2025-04-02", invoice_total: 118000, total_taxable_value: 100000 },
  { invoice_type: "purchase", return_type: "gstr3b", supplier_name: "XYZ Services", invoice_number: "P-77", invoice_date: "2025-04-03", invoice_total: 25000, total_taxable_value: 21186 },
  { invoice_type: "purchase", return_type: "gstr3b", supplier_name: "PQR Ltd", invoice_number: "P-80", invoice_date: "2025-05-10", invoice_total: 40000, total_taxable_value: 33898 },
];

async function working(extra = {}) {
  const statement = await readStatement(await xlsx(STATEMENT), "stmt.xlsx");
  const ledger = await readLedger(await xlsx(LEDGER), "ledger.xlsx");
  return buildBankWorking({
    fy: "2025-26", client: { name: "ABC Enterprises", gstin: "27AAACA1234A1ZK" }, account: { bank_name: "HDFC Bank", account_number: "50100123456789" },
    statements: [{ name: "stmt.xlsx", parsed: statement }], coverage: [{ from: "2025-04", to: "2025-06" }], ledger, invoices: INVOICES, ...extra,
  });
}

test("a statement and a ledger are read from Excel, with opening balances and narration lines", async () => {
  const s = await readStatement(await xlsx(STATEMENT), "stmt.xlsx");
  assert.equal(s.opening, 100000);
  assert.equal(s.txns.length, 8);
  assert.equal(s.closing, 261932.3);
  assert.deepEqual(s.warnings, []);
  const l = await readLedger(await xlsx(LEDGER), "ledger.xlsx");
  assert.equal(l.opening, 100000);
  assert.equal(l.entries.length, 7);
  assert.equal(l.entries[1].party, "XYZ Services", "the To / By prefix is dropped");
  assert.match(l.entries[1].narration, /000555/, "the narration printed under an entry is kept with it");
  await assert.rejects(readLedger(await xlsx([["nothing", "here"]]), "x.xlsx"), /No ledger table found/);
  await assert.rejects(readStatement(await xlsx([["nothing", "here"]]), "x.xlsx"), /No bank statement table found/);
});

test("PDF statement text: debit or credit comes from the balance, wrapped narration is joined", () => {
  const p = parseStatementText(`
HDFC BANK LIMITED Statement of Account
Date     Narration                         Chq./Ref.No.  Value Dt  Withdrawal Amt.  Deposit Amt.  Closing Balance
Opening Balance 1,00,000.00
03/04/25 NEFT CR-ABC TRADERS PVT LTD       0000123456    03/04/25                   1,18,000.00   2,18,000.00
05/04/25 CHQ PAID 000555 XYZ SERVICES      000555        05/04/25  25,000.00                      1,93,000.00
         FOR PROFESSIONAL FEES
Page 1 of 1`);
  assert.equal(p.opening, 100000);
  assert.deepEqual(p.txns.map((t) => [t.date, t.debit, t.credit, t.balance]), [["2025-04-03", 0, 118000, 218000], ["2025-04-05", 25000, 0, 193000]]);
  assert.match(p.txns[1].narration, /FOR PROFESSIONAL FEES/);
});

test("26AS and TIS text give deductors, TDS lines, tax paid and income categories", () => {
  const a = parse26asText(`
1 ABC TRADERS PRIVATE LIMITED MUMA12345B 236,000.00 4,720.00 4,720.00
   1 194C 28-Feb-2025 F 15-Mar-2025 - 118,000.00 2,360.00 2,360.00
   2 194C 28-Mar-2025 F 15-Apr-2025 - 118,000.00 2,360.00 2,360.00
1 0020 100 25,000.00 0.00 0.00 0.00 0.00 25,000.00 0510308 15-Sep-2025 00123
`);
  assert.equal(a.deductors.length, 1);
  assert.deepEqual([a.deductors[0].name, a.deductors[0].tan, a.deductors[0].tds, a.deductors[0].txns.length], ["ABC TRADERS PRIVATE LIMITED", "MUMA12345B", 4720, 2]);
  assert.deepEqual(a.deductors[0].txns[0], { section: "194C", date: "2025-02-28", amount: 118000, tds: 2360 });
  assert.deepEqual(a.taxPaid.map((t) => [t.kind, t.amount, t.date, t.bsr]), [["Advance tax", 25000, "2025-09-15", "0510308"]]);
  const t = parseTisText("Interest from savings bank  HDFC BANK LIMITED  1,250  1,250\nDividend  XYZ LTD  4,000  4,000\nSome other line");
  assert.deepEqual(t.items.map((i) => [i.category, i.reported]), [["Interest from savings bank", 1250], ["Dividend", 4000]]);
});

test("bank working: every line gets a party and a remark from the documents", async () => {
  const w = await working();
  const by = (re) => w.stmt.rows.find((t) => re.test(t.narration));
  assert.match(by(/ABC TRADERS/).remark, /Receipt from ABC Traders Pvt Ltd.* against sales invoice INV-101/);
  assert.match(by(/DEF INDUSTRIES/).remark, /Receipt from DEF Industries Ltd.*sales invoice INV-102.*after TDS of Rs 2,000.00/);
  assert.match(by(/XYZ SERVICES/).remark, /Payment to XYZ Services.* against purchase invoice P-77/);
  assert.equal(by(/SMS CHARGES/).nature, "Bank charges");
  assert.match(by(/MYSTERY/).nature, /party not identified/);
  assert.equal(by(/INT\.PD/).nature, "Interest credited by the bank");
  assert.equal(by(/EMI/).nature, "Loan EMI / instalment");
  assert.equal(by(/ABC TRADERS/).booked.startsWith("Yes"), true);
  assert.match(by(/SMS CHARGES/).booked, /^No/);
  const led = w.book.rows.find((e) => e.party === "Interest Received");
  assert.equal(led.nature, "Interest credited by the bank");
  assert.match(w.book.rows.find((e) => e.party === "Local Vendor").inBank, /^No/);
});

test("bank working: monthly table and a reconciliation for each month that differs", async () => {
  const w = await working();
  const m = Object.fromEntries(w.months.map((r) => [r.month, r]));
  assert.deepEqual(m["2025-04"].stmt, { open: 100000, rec: 234000, pay: 25017.7, close: 308982.3 });
  assert.deepEqual(m["2025-04"].book, { open: 100000, rec: 234000, pay: 25000, close: 309000 });
  assert.equal(m["2025-04"].diff.close, -17.7);
  assert.equal(m["2025-05"].diff.close, 44982.3);
  assert.equal(m["2025-07"].stmt, null);
  assert.match(m["2025-07"].note, /No bank statement/);
  assert.deepEqual(w.recons.map((r) => r.month), ["2025-04", "2025-05", "2025-06"]);
  assert.ok(w.recons.every((r) => r.check === 0), "every month reconciles in full");
  const may = w.recons[1];
  assert.deepEqual(may.items.booksPayments.map((x) => [x.amount, x.note]), [[40000, "Debited by the bank on 2025-06-04"]]);
  assert.deepEqual(may.items.stmtReceipts.map((x) => x.amount), [5000]);
  assert.deepEqual(may.items.stmtPayments.map((x) => x.amount), [17.7]);
  const jun = w.recons[2];
  assert.deepEqual(jun.items.booksPayments.map((x) => x.amount), [3000]);
  assert.equal(w.summary.monthsWithDifference, 3);
});

test("bank working: an opening balance difference and a mis-keyed amount are reported", async () => {
  const rows = LEDGER.map((r) => (r[1] === "Opening Balance" ? [r[0], r[1], "", "", 99000, ""] : r[1] === "To XYZ Services" ? [...r.slice(0, 5), 24500] : r));
  const w = buildBankWorking({
    fy: "2025-26", client: { name: "ABC" }, account: { bank_name: "HDFC Bank", account_number: "50100123456789" },
    statements: [{ name: "s.xlsx", parsed: await readStatement(await xlsx(STATEMENT), "s.xlsx") }], ledger: await readLedger(await xlsx(rows), "l.xlsx"), invoices: INVOICES,
  });
  assert.equal(w.recons[0].openDiff, -1000);
  assert.ok(w.recons.every((r) => r.check === 0));
  const apr = w.recons[0].items;
  assert.match(apr.booksPayments[0].note + apr.stmtPayments.map((x) => x.note).join(" "), /Possible amount error/);
});

test("bank working without a ledger prepares the statement side only", async () => {
  const w = await working({ ledger: null });
  assert.equal(w.book, null);
  assert.equal(w.recons.length, 0);
  assert.ok(w.warnings.some((x) => /ledger has not been uploaded/.test(x)));
});

test("the Excel has the statement, ledger, reconciliation, a sheet for each month that differs, and notes", async () => {
  const w = await working();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await bankWorkbook(w));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Bank Statement", "2 Bank Ledger", "3 Bank Reconciliation", "Recon Apr-25", "Recon May-25", "Recon Jun-25", "Notes"]);
  const text = (name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
  assert.match(text("1 Bank Statement"), /Receipt from ABC Traders Pvt Ltd/);
  assert.match(text("2 Bank Ledger"), /Interest Received/);
  const recon = text("3 Bank Reconciliation");
  assert.match(recon, /Apr-25 \| 100000 \| 234000 \| 25017.7 \| 308982.3 \| 100000 \| 234000 \| 25000 \| 309000 \|[ |]*17.7 \| -17.7/);
  assert.match(text("Recon May-25"), /Balance as per books \(worked out from the above\)/);
  assert.match(text("Recon May-25"), /Unreconciled difference[^\n]*Fully reconciled/);
  assert.match(text("Notes"), /Months where the closing balance differs: 3/);
});
