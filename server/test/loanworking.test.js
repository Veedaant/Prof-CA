import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { readSchedule, parseScheduleText, extractSanction, completeSchedule } from "../src/services/banking/scheduleReader.js";
import { readLedger } from "../src/services/banking/ledgerReader.js";
import { buildLoanWorking, classifyLoanEntry } from "../src/services/banking/loanWorking.js";
import { loanWorkbook } from "../src/services/banking/loanReport.js";

async function xlsx(rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 12 instalments May-25 to Apr-26 on 1,20,000 at 1% a month: principal 10,000 a month. */
const SCHEDULE = Array.from({ length: 12 }, (_, i) => {
  const open = 120000 - i * 10000, interest = open / 100;
  const m = 5 + i, y = m > 12 ? 2026 : 2025, mm = ((m - 1) % 12) + 1;
  return { no: i + 1, date: `05-${String(mm).padStart(2, "0")}-${y}`, open, interest, principal: 10000, emi: 10000 + interest, close: open - 10000 };
});
const scheduleSheet = () => [
  ["HDFC Bank - Term loan 4455 - repayment schedule"], [],
  ["Inst No", "Due Date", "Opening Balance", "Interest", "Principal", "EMI", "Closing Balance"],
  ...SCHEDULE.map((s) => [s.no, s.date, s.open, s.interest, s.principal, s.emi, s.close]),
];

/** The books: interest booked and EMI paid every month, except July (EMI not paid) and August (two EMIs paid together). */
function ledgerSheet() {
  const rows = [["ABC Enterprises"], ["Term Loan HDFC A/c 4455"], ["Date", "Particulars", "Vch Type", "Vch No.", "Debit", "Credit"], ["01-04-2025", "Opening Balance", "", "", "", 120000]];
  let no = 1;
  for (const s of SCHEDULE) {
    const [d, m, y] = s.date.split("-");
    if (`${y}-${m}` > "2026-03") continue;
    const date = `28-${m}-${y}`;
    rows.push([date, "By Interest on Term Loan", "Journal", String(no++), "", s.interest]);
    if (m === "07" && y === "2025") continue;
    rows.push([date, "To HDFC Bank", "Payment", String(no++), m === "08" ? s.emi + 11000 : s.emi, ""]);
  }
  return rows;
}

async function working(details = {}) {
  const schedule = await readSchedule(await xlsx(scheduleSheet()), "schedule.xlsx");
  const ledger = await readLedger(await xlsx(ledgerSheet()), "ledger.xlsx");
  return buildLoanWorking({ fy: "2025-26", client: { name: "ABC Enterprises" }, loans: [{ id: "1", bank_name: "HDFC Bank", account_number: "4455", schedule, ledger, details }] });
}

test("a repayment schedule is read from Excel; missing columns are worked out", async () => {
  const s = await readSchedule(await xlsx(scheduleSheet()), "schedule.xlsx");
  assert.equal(s.rows.length, 12);
  assert.deepEqual([s.rows[0].date, s.rows[0].opening, s.rows[0].interest, s.rows[0].installment, s.rows[0].closing], ["2025-05-05", 120000, 1200, 11200, 110000]);
  assert.equal(s.rows[11].closing, 0);
  const lean = completeSchedule([{ date: "2025-05-05", principal: 10000, interest: 1200, closing: 110000 }, { date: "2025-06-05", installment: 11100, interest: 1100, closing: 100000 }]);
  assert.deepEqual([lean[0].installment, lean[0].opening, lean[1].principal, lean[1].opening], [11200, 120000, 10000, 110000]);
  await assert.rejects(readSchedule(await xlsx([["a", "b"]]), "x.xlsx"), /No repayment schedule table found/);
});

test("PDF schedule text: the column order comes from the heading, or from the arithmetic", () => {
  const withHead = parseScheduleText(`Repayment schedule
Inst No Due Date Opening Balance Interest Principal EMI Closing Balance
1 05-05-2025 1,20,000.00 1,200.00 10,000.00 11,200.00 1,10,000.00
2 05-06-2025 1,10,000.00 1,100.00 10,000.00 11,100.00 1,00,000.00`);
  assert.deepEqual(withHead.map((r) => [r.no, r.date, r.opening, r.interest, r.principal, r.installment, r.closing]), [[1, "2025-05-05", 120000, 1200, 10000, 11200, 110000], [2, "2025-06-05", 110000, 1100, 10000, 11100, 100000]]);
  const noHead = parseScheduleText("05-05-2025 11,200.00 1,200.00 10,000.00 1,10,000.00\n05-06-2025 11,100.00 1,100.00 10,000.00 1,00,000.00");
  assert.deepEqual(noHead.map((r) => [r.installment, r.interest, r.principal, r.closing]), [[11200, 1200, 10000, 110000], [11100, 1100, 10000, 100000]]);
});

test("the sanction letter's terms are picked out of its text", () => {
  const d = extractSanction(`HDFC Bank Limited
Sanction letter dated 10-Apr-2025
We are pleased to sanction a Term Loan of Rs. 1,20,000 to M/s ABC Enterprises.
Rate of interest: 12.00% p.a. Tenure: 12 months. EMI Rs. 10,666.
Processing fee: 1% of the loan amount.
Security: Hypothecation of plant and machinery and equitable mortgage of factory land at Pune.
Personal guarantee of Mr. Rajesh Sharma, director.`);
  assert.equal(d.sanctioned_amount, 120000);
  assert.equal(d.interest_rate, 12);
  assert.equal(d.tenure_months, 12);
  assert.equal(d.emi_amount, 10666);
  assert.equal(d.sanction_date, "2025-04-10");
  assert.equal(d.loan_type, "Term loan");
  assert.match(d.security, /equitable mortgage of factory land/);
  assert.match(d.guarantee, /Rajesh Sharma/);
  assert.equal(extractSanction("Working capital limit sanctioned: Rs. 5 crore").sanctioned_amount, 5e7);
});

test("loan ledger entries are classified", () => {
  const c = (o) => classifyLoanEntry({ party: "", narration: "", vchType: "", debit: 0, credit: 0, ...o }).kind;
  assert.equal(c({ credit: 100, party: "Interest on Term Loan" }), "interest");
  assert.equal(c({ credit: 100000, party: "HDFC Bank", vchType: "Receipt" }), "disbursement");
  assert.equal(c({ credit: 500, party: "Processing Fee" }), "charges");
  assert.equal(c({ debit: 11200, party: "HDFC Bank", vchType: "Payment" }), "emi");
  assert.equal(c({ debit: 50000, narration: "part prepayment of loan" }), "prepayment");
  assert.equal(c({ debit: 1200, narration: "interest paid" }), "interest_paid");
});

test("loan working: months that agree, a missed instalment, and the year-end position", async () => {
  const w = await working({ security: "Hypothecation of plant", guarantee: "Director's guarantee", interest_rate: 12 });
  const l = w.loans[0];
  const m = Object.fromEntries(l.months.map((x) => [x.month, x]));
  assert.equal(m["2025-04"].sched, null, "the loan starts in May");
  assert.deepEqual(m["2025-05"].diff, { open: 0, interest: 0, installment: 0, close: 0 });
  assert.equal(m["2025-05"].remark, "");
  assert.match(m["2025-07"].remark, /instalment due is not recorded in the books/);
  assert.equal(m["2025-07"].diff.close, -11000);
  assert.match(m["2025-08"].remark, /Instalment in the books differs/);
  assert.equal(m["2025-08"].diff.close, 0, "paying both instalments together brings the balance back");
  const s = l.summary;
  assert.equal(s.closingBooks, 10000);
  assert.equal(s.closingSchedule, 10000);
  assert.equal(s.closingDiff, 0);
  assert.deepEqual([s.total, s.paid, s.pending, s.pendingPrincipal, s.pendingInterest, s.pendingTotal], [12, 11, 1, 10000, 100, 10100]);
  assert.deepEqual([s.nextCount, s.short, s.laterCount, s.long], [1, 10000, 0, 0]);
  assert.equal(s.lastDate, "2026-04-05");
  assert.deepEqual(l.points.filter((p) => /not available/.test(p)), [], "details were given");
  assert.ok(l.points.some((p) => /current maturity/.test(p)));
  const bare = (await working()).loans[0];
  assert.ok(bare.points.some((p) => /Security \/ mortgage details are not available/.test(p)));
});

test("loan working without a ledger shows the schedule side and says so", async () => {
  const schedule = await readSchedule(await xlsx(scheduleSheet()), "schedule.xlsx");
  const w = buildLoanWorking({ fy: "2025-26", client: { name: "ABC" }, loans: [{ id: "1", bank_name: "HDFC Bank", account_number: "4455", schedule, ledger: null, details: {} }] });
  assert.ok(w.warnings.some((x) => /loan ledger has not been uploaded/.test(x)));
  assert.equal(w.loans[0].summary.closingBooks, null);
  assert.equal(w.loans[0].summary.short, 10000, "the split falls back to the schedule's balance");
});

test("a ledger that stops early is compared with the schedule at the same month, and said to be partial", async () => {
  const schedule = await readSchedule(await xlsx(scheduleSheet()), "schedule.xlsx");
  const rows = ledgerSheet().filter((r) => { const m = /^\d{2}-(\d{2})-(\d{4})$/.exec(String(r[0])); return !m || `${m[2]}-${m[1]}` <= "2025-08"; });
  const ledger = await readLedger(await xlsx(rows), "ledger.xlsx");
  const s = buildLoanWorking({ fy: "2025-26", client: { name: "ABC" }, loans: [{ id: "1", bank_name: "HDFC Bank", account_number: "4455", schedule, ledger, details: {} }] }).loans[0];
  assert.equal(s.summary.closingBooks, 80000);
  assert.equal(s.summary.closingDiff, 0, "the schedule's balance at August is also 80,000");
  assert.equal(s.summary.comparedTo, "Aug-25");
  assert.ok(s.points.some((p) => /up to Aug-25 only/.test(p)));
});

test("the loan Excel has the four sheets and notes", async () => {
  const w = await working({ security: "Hypothecation of plant" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await loanWorkbook(w));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["1 Repayment Schedule", "2 Loan Ledger", "3 Monthly Reconciliation", "4 Summary", "Notes"]);
  const text = (name) => { const out = []; wb.getWorksheet(name).eachRow((r) => out.push(r.values.slice(1).map((v) => (v && typeof v === "object" ? (v.result ?? v.text ?? "") : v)).join(" | "))); return out.join("\n"); };
  assert.match(text("1 Repayment Schedule"), /HDFC Bank - 4455 \| 1 \| 05-May-2025 \| Instalment 1 \| 120000 \| 1200 \| 10000 \| 11200 \| 110000/);
  assert.match(text("2 Loan Ledger"), /Interest charged to the loan account/);
  assert.match(text("3 Monthly Reconciliation"), /Jul-25[^\n]*not recorded in the books/);
  assert.match(text("4 Summary"), /Short-term borrowings/);
  assert.match(text("4 Summary"), /Security \/ mortgage \| Hypothecation of plant/);
});
