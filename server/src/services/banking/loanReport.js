import ExcelJS from "exceljs";
import { r2, money } from "./common.js";
import { body, head, table, title } from "./xl.js";

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", BLUE = "FFE0F2FE", GREEN = "FFDCFCE7";
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : "");
const head2 = (w) => [`Client: ${w.client.name}${w.client.gstin ? ` (GSTIN ${w.client.gstin})` : ""}`, `Financial year: ${w.fy}`];

function scheduleSheet(wb, w) {
  const ws = wb.addWorksheet("1 Repayment Schedule");
  const top = title(ws, "Loan repayment schedule as per the lender / sanction letter", [...head2(w), "Blue rows fall due after the year end."]);
  const cols = [
    { header: "Loan", key: "loan", width: 30, wrap: true }, { header: "Inst. no", key: "no", width: 8 }, { header: "Date", key: "date", width: 12 }, { header: "Particulars", key: "part", width: 22 },
    { header: "Opening balance", key: "open", width: 17, money: true }, { header: "Interest", key: "interest", width: 15, money: true }, { header: "Principal repaid", key: "principal", width: 16, money: true },
    { header: "Instalment (EMI)", key: "inst", width: 16, money: true }, { header: "Closing balance", key: "close", width: 17, money: true },
  ];
  const rows = [];
  const fyEnd = `${Number(w.fy.slice(0, 4)) + 1}-03-31`;
  for (const l of w.loans) {
    if (!l.schedule.length) { rows.push({ loan: l.label, part: "Schedule not available" }); continue; }
    l.schedule.forEach((r, i) => rows.push({ loan: l.label, no: r.no ?? i + 1, date: dmy(r.date), part: r.installment > 0 ? `Instalment ${r.no ?? i + 1}` : "Disbursement / balance", open: r.opening, interest: r.interest, principal: r.principal, inst: r.installment, close: r.closing, _late: r.date > fyEnd }));
  }
  table(ws, top, cols, rows, { rowFill: (r) => (r._late ? BLUE : null) });
}

function ledgerSheet(wb, w) {
  const ws = wb.addWorksheet("2 Loan Ledger");
  const top = title(ws, "Loan ledger as per books, with remarks", [...head2(w), "The balance is the amount owed (a credit balance)."]);
  const cols = [
    { header: "Loan", key: "loan", width: 28, wrap: true }, { header: "Date", key: "date", width: 12 }, { header: "Particulars as per books", key: "party", width: 28, wrap: true }, { header: "Vch type", key: "vchType", width: 12 },
    { header: "Vch no", key: "vchNo", width: 10 }, { header: "Narration", key: "narration", width: 34, wrap: true }, { header: "Debit (paid / reduced)", key: "debit", width: 16, money: true }, { header: "Credit (added)", key: "credit", width: 16, money: true },
    { header: "Balance owed", key: "bal", width: 17, money: true }, { header: "Nature of transaction", key: "nature", width: 34, wrap: true }, { header: "Remark", key: "remark", width: 56, wrap: true },
  ];
  const rows = [];
  for (const l of w.loans) {
    if (!l.ledger.length && l.ledgerOpening == null) { rows.push({ loan: l.label, party: "Loan ledger not uploaded" }); continue; }
    let run = -(l.ledgerOpening ?? 0);
    rows.push({ loan: l.label, party: "Opening balance", bal: run, _g: true });
    for (const e of l.ledger) { run = r2(run + e.credit - e.debit); rows.push({ loan: l.label, date: dmy(e.date), party: e.party, vchType: e.vchType, vchNo: e.vchNo, narration: e.narration, debit: e.debit || "", credit: e.credit || "", bal: run, nature: e.nature, remark: e.remark, _chk: /^other_/.test(e.kind) }); }
  }
  table(ws, top, cols, rows, { rowFill: (r) => (r._g ? GREY : r._chk ? AMBER : null) });
}

function reconSheet(wb, w) {
  const ws = wb.addWorksheet("3 Monthly Reconciliation");
  let r = title(ws, "Loan reconciliation month by month: lender's schedule against the books", [...head2(w), "Difference = schedule less books."]);
  const widths = [11, 16, 14, 16, 16, 16, 14, 14, 16, 14, 16, 15, 14, 15, 15, 60];
  widths.forEach((x, i) => { ws.getColumn(i + 1).width = x; });
  for (const l of w.loans) {
    ws.getCell(r, 1).value = l.label; ws.getCell(r, 1).font = { name: "Calibri", size: 11, bold: true }; r++;
    const groups = [["Month", 1, 1, "FF374151"], ["As per repayment schedule", 2, 5, "FF1F497D"], ["As per loan ledger (books)", 6, 11, "FF166534"], ["Difference (schedule less books)", 12, 15, "FF9A3412"], ["Remark", 16, 16, "FF374151"]];
    for (const [text, a, b, fill] of groups) { if (b > a) ws.mergeCells(r, a, r, b); else ws.mergeCells(r, a, r + 1, a); ws.getCell(r, a).value = text; for (let c = a; c <= b; c++) head(ws.getCell(r, c), fill); }
    const subs = ["Opening", "Interest", "Instalment", "Closing", "Opening", "Additions", "Interest", "Instalment", "Prepayment", "Closing", "Opening", "Interest", "Instalment", "Closing"];
    subs.forEach((s, i) => { const c = ws.getCell(r + 1, 2 + i); c.value = s; head(c, groups[i < 4 ? 1 : i < 10 ? 2 : 3][3]); });
    r += 2;
    const first = r;
    for (const m of l.months) {
      ws.getCell(r, 1).value = m.label; body(ws.getCell(r, 1), { bold: true });
      const s = m.sched, b = m.book;
      const set = (col, v, fill) => { const c = ws.getCell(r, col); c.value = v ?? ""; body(c, { money: true, fill: v == null ? GREY : fill || null }); };
      set(2, s?.open); set(3, s?.interest); set(4, s?.installment); set(5, s?.close);
      set(6, b?.open); set(7, b?.adds); set(8, b?.interest); set(9, b?.installment); set(10, b?.prepay); set(11, b?.close);
      const d = m.diff;
      set(12, d?.open, d && d.open ? AMBER : null); set(13, d?.interest, d && d.interest ? AMBER : null); set(14, d?.installment, d && d.installment ? AMBER : null); set(15, d?.close, d && d.close ? AMBER : null);
      ws.getCell(r, 16).value = m.remark; body(ws.getCell(r, 16), { wrap: true });
      r++;
    }
    ws.getCell(r, 1).value = "Total"; body(ws.getCell(r, 1), { bold: true, fill: GREY });
    const L = (c) => ws.getColumn(c).letter;
    const tot = (col, kind) => {
      const c = ws.getCell(r, col);
      const vals = l.months.map((m) => [m.sched, m.book, m.diff]).map(([s, b, d]) => ({ 2: s?.open, 3: s?.interest, 4: s?.installment, 5: s?.close, 6: b?.open, 7: b?.adds, 8: b?.interest, 9: b?.installment, 10: b?.prepay, 11: b?.close, 12: d?.open, 13: d?.interest, 14: d?.installment, 15: d?.close })).map((o) => o[col]).filter((v) => v != null && v !== "");
      c.value = kind === "sum" ? { formula: `SUM(${L(col)}${first}:${L(col)}${r - 1})`, result: r2(vals.reduce((x, y) => x + y, 0)) } : kind === "last" ? { formula: `${L(col)}${r - 1}`, result: vals[vals.length - 1] ?? 0 } : vals[0] ?? "";
      body(c, { money: true, bold: true, fill: GREY });
    };
    [[2, "first"], [3, "sum"], [4, "sum"], [5, "last"], [6, "first"], [7, "sum"], [8, "sum"], [9, "sum"], [10, "sum"], [11, "last"], [12, "first"], [13, "sum"], [14, "sum"], [15, "last"]].forEach(([c, k]) => tot(c, k));
    body(ws.getCell(r, 16), { fill: GREY });
    r += 3;
  }
  ws.views = [{ state: "frozen", xSplit: 1 }];
}

function summarySheet(wb, w) {
  const ws = wb.addWorksheet("4 Summary");
  let r = title(ws, "Summary of loans at the year end, for the audit", [...head2(w), `As at ${dmy(`${Number(w.fy.slice(0, 4)) + 1}-03-31`)}`]);
  const cols = [
    { header: "Loan", key: "loan", width: 30, wrap: true }, { header: "Closing balance as per books", key: "cb", width: 18, money: true }, { header: "Closing balance as per lender's schedule", key: "cs", width: 18, money: true },
    { header: "Difference (schedule less books)", key: "diff", width: 16, money: true }, { header: "Instalments pending (no.)", key: "pn", width: 12 }, { header: "Pending principal", key: "pp", width: 16, money: true },
    { header: "Pending interest", key: "pi", width: 16, money: true }, { header: "Pending instalments, total", key: "pt", width: 17, money: true },
    { header: "Due within 12 months (no.)", key: "nn", width: 12 }, { header: "Short-term borrowings (current maturities)", key: "short", width: 19, money: true },
    { header: "Due later (no.)", key: "ln", width: 11 }, { header: "Long-term borrowings", key: "long", width: 18, money: true }, { header: "Split worked out on", key: "basis", width: 34, wrap: true },
  ];
  const rows = w.loans.map((l) => { const s = l.summary; return { loan: l.label, cb: s.closingBooks, cs: s.closingSchedule, diff: s.closingDiff, pn: s.pending, pp: s.pendingPrincipal, pi: s.pendingInterest, pt: s.pendingTotal, nn: s.nextCount, short: s.short, ln: s.laterCount, long: s.long, basis: s.basis }; });
  const sumOf = (k) => r2(rows.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  rows.push({ loan: "Total", cb: sumOf("cb"), cs: sumOf("cs"), diff: sumOf("diff"), pn: sumOf("pn"), pp: sumOf("pp"), pi: sumOf("pi"), pt: sumOf("pt"), nn: sumOf("nn"), short: sumOf("short"), ln: sumOf("ln"), long: sumOf("long"), basis: "", _t: true });
  r = table(ws, r, cols, rows, { rowFill: (x) => (x._t ? GREY : null), freeze: false, filter: false }) + 2;

  ws.getCell(r, 1).value = "Loan details and points to check"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  for (const l of w.loans) {
    const d = l.details || {}, s = l.summary;
    const items = [
      ["Lender", l.bank_name], ["Loan account number", l.account_number], ["Type of loan", d.loan_type], ["Date of sanction", dmy(d.sanction_date) || d.sanction_date], ["Sanctioned amount", d.sanctioned_amount ? money(d.sanctioned_amount) : ""],
      ["Rate of interest (% p.a.)", d.interest_rate], ["Tenure (months)", d.tenure_months], ["Instalment (EMI)", s.emi ? money(s.emi) : d.emi_amount ? money(d.emi_amount) : ""],
      ["First instalment as per schedule", dmy(s.firstDate)], ["Last instalment as per schedule", dmy(s.lastDate)], ["Total number of instalments", s.total], ["Instalments paid up to the year end", s.paid], ["Instalments pending", s.pending],
      ["Moratorium", d.moratorium], ["Processing fee", d.processing_fee], ["Security / mortgage", d.security], ["Guarantee", d.guarantee], ["Remarks", d.remarks],
    ];
    ws.getCell(r, 1).value = l.label; head(ws.getCell(r, 1)); ws.mergeCells(r, 1, r, 4); r++;
    for (const [k, v] of items) {
      ws.getCell(r, 1).value = k; body(ws.getCell(r, 1), { bold: true, fill: GREY });
      ws.getCell(r, 2).value = v ?? ""; body(ws.getCell(r, 2), { wrap: true }); ws.mergeCells(r, 2, r, 4);
      if (String(v ?? "").includes("\n")) ws.getRow(r).height = 15 * String(v).split("\n").length;
      r++;
    }
    ws.getCell(r, 1).value = "Points to check"; body(ws.getCell(r, 1), { bold: true, fill: AMBER });
    ws.getCell(r, 2).value = l.points.length ? l.points.map((p, i) => `${i + 1}. ${p}`).join("\n") : "None."; body(ws.getCell(r, 2), { wrap: true, fill: l.points.length ? AMBER : GREEN }); ws.mergeCells(r, 2, r, 4);
    ws.getRow(r).height = Math.max(18, 15 * Math.max(1, l.points.length) * 2);
    r += 2;
  }
}

function notesSheet(wb, w) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes and checks", head2(w));
  ws.getColumn(1).width = 120;
  const add = (t, bold = false) => { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold }; c.alignment = { wrapText: true, vertical: "top" }; };
  add("How the working was prepared", true);
  add("Sheet 1 lists the instalments of each loan from the lender's repayment schedule; anything the schedule leaves out (opening balance, closing balance, principal) is worked out from the other columns.");
  add("Sheet 2 is the loan ledger from the books. Each entry is classified from the other ledger named, the narration and the voucher type: interest, instalment paid, prepayment, loan received, charges.");
  add("Sheet 3 compares the schedule and the books month by month. Interest is the interest charged to the loan account; instalment is what was paid to the lender. A remark explains each difference.");
  add("Sheet 4 gives the closing balance at the year end, the instalments still pending, and the split between short-term borrowings (principal falling due within 12 months of the year end, the current maturity of long-term debt) and long-term borrowings. The split is worked out on the closing balance as per the books, or as per the schedule when there is no ledger.");
  add("Security, guarantee, rate and the other terms are read from the sanction letter where it is a PDF; the CA staff can correct them on the screen before the working is downloaded. Verify them against the sanction letter.");
  r++;
  add("Points to check", true);
  if (!w.warnings.length) add("None.");
  for (const x of w.warnings) add(`- ${x}`);
}

export async function loanWorkbook(w) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  scheduleSheet(wb, w);
  ledgerSheet(wb, w);
  reconSheet(wb, w);
  summarySheet(wb, w);
  notesSheet(wb, w);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
