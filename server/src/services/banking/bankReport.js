import ExcelJS from "exceljs";
import { r2, money } from "./common.js";
import { body, head, table, title, sheetName } from "./xl.js";

const AMBER = "FFFEF3C7", RED = "FFFEE2E2", GREY = "FFF3F4F6", GREEN = "FFDCFCE7";
const dmy = (iso) => (iso ? `${iso.slice(8, 10)}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : "");

function head3(w) {
  return [`Client: ${w.client.name}${w.client.gstin ? ` (GSTIN ${w.client.gstin})` : ""}`, `Bank: ${w.account.bank_name}   Account no.: ${w.account.account_number}   Financial year: ${w.fy}`];
}

function statementSheet(wb, w) {
  const ws = wb.addWorksheet("1 Bank Statement");
  const row = title(ws, "Bank statement with remarks", [...head3(w), `Statement files: ${w.stmt.files.join(", ")}`]);
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Date", key: "date", width: 12 }, { header: "Narration as per bank statement", key: "narration", width: 46, wrap: true },
    { header: "Cheque / Ref no", key: "ref", width: 14 }, { header: "Withdrawals (Dr)", key: "debit", width: 16, money: true }, { header: "Deposits (Cr)", key: "credit", width: 16, money: true },
    { header: "Balance", key: "balance", width: 17, money: true }, { header: "Receipt / Payment", key: "kind", width: 11 }, { header: "Party", key: "party", width: 26, wrap: true },
    { header: "Nature of transaction", key: "nature", width: 28, wrap: true }, { header: "Remark", key: "remark", width: 70, wrap: true },
    { header: "Supporting documents", key: "support", width: 50, wrap: true }, { header: "Entry in books", key: "booked", width: 34, wrap: true },
  ];
  let run = w.stmt.opening;
  const rows = [{ sr: "", date: "", narration: "Opening balance", balance: w.stmt.opening }];
  w.stmt.rows.forEach((t, i) => {
    run = r2(run + t.credit - t.debit);
    rows.push({ sr: i + 1, date: dmy(t.date), narration: t.narration, ref: t.ref, debit: t.debit || "", credit: t.credit || "", balance: t.balance ?? run, kind: t.kind, party: t.party, nature: t.nature, remark: t.remark, support: t.support, booked: t.booked, _m: t.matched, _u: /not identified/.test(t.nature) });
  });
  const dr = w.stmt.rows.reduce((a, t) => a + t.debit, 0), cr = w.stmt.rows.reduce((a, t) => a + t.credit, 0);
  rows.push({ sr: "", date: "", narration: "Total / closing balance", debit: r2(dr), credit: r2(cr), balance: w.stmt.closing, _t: true });
  table(ws, row, cols, rows, { rowFill: (r) => (r._t ? GREY : r.narration === "Opening balance" ? GREY : r._u ? RED : r._m === false && w.book ? AMBER : null) });
  ws.getCell(row - 1, 1).value = "Amber: not found in the books.  Red: party could not be identified.";
  ws.getCell(row - 1, 1).font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
}

function ledgerSheet(wb, w) {
  const ws = wb.addWorksheet("2 Bank Ledger");
  const row = title(ws, "Bank ledger as per books, with remarks", head3(w));
  if (!w.book) { ws.getCell(row, 1).value = "The bank ledger has not been uploaded yet."; return; }
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Date", key: "date", width: 12 }, { header: "Particulars as per books", key: "party", width: 30, wrap: true },
    { header: "Vch type", key: "vchType", width: 12 }, { header: "Vch no", key: "vchNo", width: 12 }, { header: "Narration", key: "narration", width: 36, wrap: true },
    { header: "Receipts (Dr)", key: "debit", width: 16, money: true }, { header: "Payments (Cr)", key: "credit", width: 16, money: true }, { header: "Balance", key: "balance", width: 17, money: true },
    { header: "Receipt / Payment", key: "kind", width: 11 }, { header: "Nature of transaction", key: "nature", width: 28, wrap: true }, { header: "Remark", key: "remark", width: 70, wrap: true },
    { header: "Supporting documents", key: "support", width: 50, wrap: true }, { header: "In the bank statement", key: "inBank", width: 26, wrap: true },
  ];
  let run = w.book.opening;
  const rows = [{ party: "Opening balance", balance: w.book.opening }];
  w.book.rows.forEach((e, i) => {
    run = r2(run + e.debit - e.credit);
    rows.push({ sr: i + 1, date: dmy(e.date), party: e.party, vchType: e.vchType, vchNo: e.vchNo, narration: e.narration, debit: e.debit || "", credit: e.credit || "", balance: run, kind: e.kind, nature: e.nature, remark: e.remark, support: e.support, inBank: e.inBank, _m: e.matched });
  });
  rows.push({ party: "Total / closing balance", debit: r2(w.book.rows.reduce((a, e) => a + e.debit, 0)), credit: r2(w.book.rows.reduce((a, e) => a + e.credit, 0)), balance: w.book.closing, _t: true });
  table(ws, row, cols, rows, { rowFill: (r) => (r._t || r.party === "Opening balance" ? GREY : r._m === false ? AMBER : null) });
  ws.getCell(row - 1, 1).value = "Amber: not found in the bank statement.";
  ws.getCell(row - 1, 1).font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
}

function reconSheet(wb, w) {
  const ws = wb.addWorksheet("3 Bank Reconciliation");
  const top = title(ws, "Bank reconciliation: bank statement against books, month by month", [...head3(w), "Receipts are money in, payments are money out. Difference = bank statement less books."]);
  const labels = ["Opening balance", "Receipts", "Payments", "Closing balance"];
  const groups = [["As per bank statement", 2, "FF1F497D"], ["As per books (bank ledger)", 6, "FF166534"], ["Difference (statement less books)", 10, "FF9A3412"]];
  ws.getCell(top, 1).value = "Month"; head(ws.getCell(top, 1)); ws.mergeCells(top, 1, top + 1, 1);
  for (const [text, col, fill] of groups) {
    ws.mergeCells(top, col, top, col + 3);
    ws.getCell(top, col).value = text; head(ws.getCell(top, col), fill);
    labels.forEach((l, i) => { const c = ws.getCell(top + 1, col + i); c.value = l; head(c, fill); });
  }
  ws.getCell(top, 14).value = "Note"; head(ws.getCell(top, 14)); ws.mergeCells(top, 14, top + 1, 14);
  ws.getColumn(1).width = 12;
  for (let c = 2; c <= 13; c++) ws.getColumn(c).width = 16;
  ws.getColumn(14).width = 38;
  let r = top + 2;
  const first = r;
  for (const m of w.months) {
    ws.getCell(r, 1).value = m.label; body(ws.getCell(r, 1), { bold: true });
    const put = (col, side) => {
      if (!side) { for (let i = 0; i < 4; i++) body(ws.getCell(r, col + i), { money: true, fill: GREY }); return; }
      const o = ws.getCell(r, col), rc = ws.getCell(r, col + 1), p = ws.getCell(r, col + 2), c = ws.getCell(r, col + 3);
      o.value = side.open; rc.value = side.rec; p.value = side.pay;
      c.value = { formula: `${o.address}+${rc.address}-${p.address}`, result: side.close };
      [o, rc, p, c].forEach((x) => body(x, { money: true }));
    };
    put(2, m.stmt); put(6, m.book);
    for (let i = 0; i < 4; i++) {
      const cell = ws.getCell(r, 10 + i);
      if (m.diff) { cell.value = { formula: `${ws.getCell(r, 2 + i).address}-${ws.getCell(r, 6 + i).address}`, result: [m.diff.open, m.diff.rec, m.diff.pay, m.diff.close][i] }; body(cell, { money: true, fill: m.hasDiff && i === 3 ? AMBER : null }); }
      else body(cell, { money: true, fill: GREY });
    }
    ws.getCell(r, 14).value = m.hasDiff ? `Closing balance differs: see sheet "Recon ${m.label}"` : m.note;
    body(ws.getCell(r, 14), { wrap: true });
    r++;
  }
  const last = r - 1;
  ws.getCell(r, 1).value = "Total"; body(ws.getCell(r, 1), { bold: true, fill: GREY });
  const totals = {};
  const tot = (col, kind, side) => {
    const c = ws.getCell(r, col);
    const letter = ws.getColumn(col).letter;
    const have = w.months.map((m) => m[side]).filter(Boolean);
    let result = 0;
    if (kind === "open") { c.value = { formula: `${letter}${first}`, result: (result = have[0]?.open ?? 0) }; }
    else if (kind === "sum") { result = r2(have.reduce((x, y) => x + (col === (side === "stmt" ? 3 : 7) ? y.rec : y.pay), 0)); c.value = { formula: `SUM(${letter}${first}:${letter}${last})`, result }; }
    else { c.value = { formula: `${letter}${last}`, result: (result = have[have.length - 1]?.close ?? 0) }; }
    totals[col] = result;
    body(c, { money: true, bold: true, fill: GREY });
  };
  for (const [col, side] of [[2, "stmt"], [6, "book"]]) { tot(col, "open", side); tot(col + 1, "sum", side); tot(col + 2, "sum", side); tot(col + 3, "close", side); }
  for (let i = 0; i < 4; i++) { const c = ws.getCell(r, 10 + i); c.value = { formula: `${ws.getCell(r, 2 + i).address}-${ws.getCell(r, 6 + i).address}`, result: r2((totals[2 + i] || 0) - (totals[6 + i] || 0)) }; body(c, { money: true, bold: true, fill: GREY }); }
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: top + 1 }];
  if (!w.book) { ws.getCell(r + 2, 1).value = "The bank ledger has not been uploaded, so the books side is blank."; }
}

function monthReconSheet(wb, w, rc) {
  const ws = wb.addWorksheet(sheetName(`Recon ${rc.label}`));
  const top = title(ws, `Reconciliation of the closing bank balance for ${rc.label}`, [...head3(w), `As at ${dmy(rc.asOf)}`]);
  ws.getColumn(1).width = 64; ws.getColumn(2).width = 13; ws.getColumn(3).width = 18; ws.getColumn(4).width = 18; ws.getColumn(5).width = 60;
  ["Particulars", "Date", "Amount (Rs)", "Total (Rs)", "Remark"].forEach((h, i) => { const c = ws.getCell(top, i + 1); c.value = h; head(c); });
  let r = top + 1;
  const subtotalCells = [];
  const line = (text, amount, { bold = false, fill = null, totalCol = false, date = "", note = "" } = {}) => {
    ws.getCell(r, 1).value = text; body(ws.getCell(r, 1), { bold, fill, wrap: true });
    ws.getCell(r, 2).value = date; body(ws.getCell(r, 2), { fill });
    const c = ws.getCell(r, totalCol ? 4 : 3);
    ws.getCell(r, totalCol ? 3 : 4).value = ""; body(ws.getCell(r, totalCol ? 3 : 4), { fill, money: true });
    if (amount !== null) c.value = amount;
    body(c, { money: true, bold, fill });
    ws.getCell(r, 5).value = note; body(ws.getCell(r, 5), { wrap: true, fill });
    r++;
    return r - 1;
  };
  const start = line(`Balance as per bank statement as at ${dmy(rc.asOf)}`, rc.stmtClose, { bold: true, fill: GREY, totalCol: true });
  const group = (heading, items, sign) => {
    line(heading, null, { bold: true });
    const a = r;
    if (!items.length) line("   (none)", null);
    for (const it of items) line(`   ${it.text}`, it.amount, { date: dmy(it.date), note: it.note });
    const b = r - 1;
    const sub = line(`   Total ${sign === 1 ? "to add" : "to deduct"}`, items.length ? { formula: `SUM(C${a}:C${b})`, result: r2(items.reduce((x, y) => x + y.amount, 0)) } : 0, { totalCol: true });
    subtotalCells.push({ row: sub, sign });
  };
  group("Add: receipts entered in the books but not credited by the bank", rc.items.booksReceipts, 1);
  group("Less: payments entered in the books but not debited by the bank", rc.items.booksPayments, -1);
  group("Less: credits in the bank statement not entered in the books", rc.items.stmtReceipts, -1);
  group("Add: debits in the bank statement not entered in the books", rc.items.stmtPayments, 1);
  const od = line("Add / (less): difference in the opening balance (books less statement) at the start of the comparison", rc.openDiff, { totalCol: true, note: "Carried from before the first month compared." });
  const formula = `D${start}${subtotalCells.map((s) => `${s.sign === 1 ? "+" : "-"}D${s.row}`).join("")}+D${od}`;
  const comp = line("Balance as per books (worked out from the above)", { formula, result: rc.computed }, { bold: true, fill: GREEN, totalCol: true });
  const led = line("Balance as per bank ledger", rc.bookClose, { bold: true, totalCol: true });
  line("Unreconciled difference", { formula: `D${led}-D${comp}`, result: rc.check }, { bold: true, fill: rc.check === 0 ? GREEN : RED, totalCol: true, note: rc.check === 0 ? "Fully reconciled." : "Part of the difference could not be explained by the entries above." });
  ws.views = [{ state: "frozen", ySplit: top }];
}

function notesSheet(wb, w) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes and checks", head3(w));
  ws.getColumn(1).width = 120;
  const add = (t, bold = false) => { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold }; c.alignment = { wrapText: true, vertical: "top" }; };
  const s = w.summary;
  add("Summary", true);
  add(`Statement lines: ${s.stmtLines}. Ledger lines: ${s.bookLines}. Matched: ${s.matched}. Only in the statement: ${s.stmtOnly}. Only in the books: ${s.booksOnly}. Lines whose party could not be identified: ${s.unidentified}.`);
  add(`Months compared: ${s.monthsCompared}. Months where the closing balance differs: ${s.monthsWithDifference}.`);
  r++;
  add("How the working was prepared", true);
  add("Each statement line is matched with the books entry of the same amount and direction, first by cheque or reference number and then by the nearest date within 90 days.");
  add("The party and the remark come from the books entry matched to the line, and from the invoices available in the system (sales invoices for receipts, purchase invoices for payments) and Form 26AS. A remark that says no invoice is available means the system has none for that party.");
  add("Month reconciliation: balance as per the statement, plus books receipts and statement debits not matched in the month, less books payments and statement credits not matched, plus or minus the opening difference, gives the balance as per books.");
  r++;
  if (w.tis.length) {
    add("Cross-check with the Taxpayer Information Summary (TIS)", true);
    const interest = r2(w.stmt.rows.filter((t) => /Interest credited/.test(t.nature)).reduce((a, t) => a + t.credit, 0));
    for (const t of w.tis.slice(0, 15)) add(`${t.category}: reported Rs ${money(t.reported)}, derived Rs ${money(t.derived)}`);
    add(`Interest credited by the bank in this account as per the statement: Rs ${money(interest)}. Compare with the interest categories above.`);
    r++;
  } else if (!w.hasTis) add("The Taxpayer Information Summary (TIS) has not been uploaded.");
  if (!w.has26as) add("Form 26AS has not been uploaded, so TDS on receipts is not shown in the remarks.");
  r++;
  add("Points to check", true);
  if (!w.warnings.length) add("None.");
  for (const x of w.warnings) add(`- ${x}`);
}

export async function bankWorkbook(w) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  statementSheet(wb, w);
  ledgerSheet(wb, w);
  reconSheet(wb, w);
  for (const rc of w.recons) monthReconSheet(wb, w, rc);
  notesSheet(wb, w);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

