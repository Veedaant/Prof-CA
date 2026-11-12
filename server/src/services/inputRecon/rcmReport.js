import ExcelJS from "exceljs";
import { r2, monthLabel } from "../banking/common.js";
import { body, table, title } from "../banking/xl.js";

/**
 * The RCM working as an Excel: every expense on which reverse charge applies in one sheet, the month-wise summary in the second,
 * and the ledgers reviewed (with the entries that were not treated as RCM, and why) in the third.
 */

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", RED = "FFFEE2E2";
const sum = (list) => r2(list.reduce((a, b) => a + (Number(b) || 0), 0));
const head2 = (client, fy, extra = []) => [`Client: ${client.name}${client.gstin ? ` (GSTIN ${client.gstin})` : ""}`, `Financial year: ${fy}`, ...extra];

function totalRow(ws, r, first, last, columns, keys, values, label = "Total") {
  ws.getCell(r, 1).value = label; body(ws.getCell(r, 1), { bold: true, fill: GREY });
  columns.forEach((c, i) => {
    if (i === 0) return;
    const cell = ws.getCell(r, i + 1);
    if (keys.includes(c.key)) {
      const letter = ws.getColumn(i + 1).letter;
      cell.value = { formula: `SUM(${letter}${first}:${letter}${last})`, result: values[c.key] ?? 0 };
      body(cell, { money: true, bold: true, fill: GREY });
    } else body(cell, { fill: GREY });
  });
}

const monthName = (m) => (m ? monthLabel(m) : "No date");

function detailsSheet(wb, client, fy, rcm) {
  const ws = wb.addWorksheet("1 RCM Details");
  const r0 = title(ws, "Reverse charge (RCM): every expense on which the client pays GST, all ledgers combined", head2(client, fy, [
    `Nature of business: ${rcm.businessLabel || "not set"}${rcm.constitution ? `; constitution: ${rcm.constitution}` : ""}. The amount booked in the ledger is taken as the taxable value.`,
    "Amber rows depend on a condition that cannot be read from the ledger, or on an assumed state. Red rows: the ITC on the RCM is not available or is to be checked.",
  ]));
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Month", key: "period", width: 10 }, { header: "Date", key: "date", width: 13, date: true, align: "center" },
    { header: "Expense ledger", key: "ledger", width: 24, wrap: true }, { header: "Party name", key: "party", width: 30, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 },
    { header: "Voucher / invoice no", key: "vchNo", width: 15 }, { header: "Narration", key: "narration", width: 34, wrap: true },
    { header: "RCM category", key: "category", width: 34, wrap: true }, { header: "Provision", key: "ref", width: 40, wrap: true },
    { header: "Taxable value", key: "taxable", width: 16, money: true }, { header: "Rate %", key: "rate", width: 8 },
    { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true },
    { header: "Total RCM", key: "tax", width: 15, money: true }, { header: "ITC on this RCM", key: "itc", width: 14 }, { header: "ITC note", key: "itcNote", width: 44, wrap: true },
    { header: "Basis and remarks", key: "basis", width: 60, wrap: true }, { header: "Source file", key: "file", width: 26, wrap: true },
  ];
  const data = rcm.lines.map((l, i) => ({ ...l, sr: i + 1, period: monthName(l.month) }));
  if (!data.length) { ws.getCell(r0, 1).value = rcm.have ? "No expense in the ledgers is under reverse charge." : "Upload the expense ledgers first."; return; }
  const end = table(ws, r0, cols, data, { rowFill: (l) => (["Ineligible", "Not available", "Check"].includes(l.itc) ? RED : l.verify || l.stateAssumed ? AMBER : null) });
  const keys = ["taxable", "igst", "cgst", "sgst", "tax"];
  totalRow(ws, end, r0 + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(data.map((x) => x[k]))])));
}

function monthSheet(wb, client, fy, rcm) {
  const ws = wb.addWorksheet("2 Month-wise Summary");
  let r = title(ws, "RCM month by month: expenses, taxable value and reverse charge", head2(client, fy, [
    "Expenses as per ledgers: every line of the ledgers uploaded. Taxable value: the part on which reverse charge applies.",
  ]));
  const cols = [
    { header: "Month", key: "label", width: 12 }, { header: "Entries reviewed", key: "entries", width: 11 }, { header: "Expenses as per ledgers", key: "expense", width: 18, money: true },
    { header: "RCM entries", key: "rcmEntries", width: 10 }, { header: "Taxable value (RCM)", key: "taxable", width: 18, money: true },
    { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true },
    { header: "Total RCM", key: "tot", width: 15, money: true }, { header: "ITC available on RCM", key: "itc", width: 16, money: true },
  ];
  const rows = rcm.months.map((m) => ({ ...m, label: monthName(m.month) }));
  const keys = ["entries", "expense", "rcmEntries", "taxable", "igst", "cgst", "sgst", "tot", "itc"];
  const end = table(ws, r, cols, rows, { freeze: false, filter: false });
  if (rows.length) totalRow(ws, end, r + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(rows.map((x) => x[k]))])));
  r = end + 3;
  if (rcm.categories.length) {
    ws.getCell(r, 1).value = "By reverse-charge category"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
    const cc = [{ header: "Category", key: "category", width: 12 }, { header: "Entries", key: "entries", width: 11 }, { header: "Taxable value", key: "taxable", width: 18, money: true }, { header: "Total RCM", key: "tax", width: 14, money: true }, { header: "Provision", key: "ref", width: 14 }];
    const e2 = table(ws, r, cc, rcm.categories, { freeze: false, filter: false });
    totalRow(ws, e2, r + 1, e2 - 1, cc, ["entries", "taxable", "tax"], { entries: sum(rcm.categories.map((x) => x.entries)), taxable: sum(rcm.categories.map((x) => x.taxable)), tax: sum(rcm.categories.map((x) => x.tax)) });
    // the two tables share their columns: keep the widths of the month table, and widen the first for the category names
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
    ws.getColumn(1).width = 46;
  }
}

function reviewedSheet(wb, client, fy, rcm) {
  const ws = wb.addWorksheet("3 Ledgers Reviewed");
  let r = title(ws, "Ledgers reviewed, and entries a category matched but RCM is not payable", head2(client, fy));
  const cols = [
    { header: "Expense ledger", key: "ledger", width: 40, wrap: true }, { header: "Entries", key: "entries", width: 10 }, { header: "Amount booked", key: "amount", width: 18, money: true },
    { header: "RCM entries", key: "rcmEntries", width: 11 }, { header: "RCM tax", key: "tax", width: 15, money: true }, { header: "Result", key: "result", width: 70, wrap: true },
  ];
  const rows = rcm.ledgers.map((l) => ({ ...l, result: l.rcmEntries ? `Reverse charge on ${l.rcmEntries} entr${l.rcmEntries === 1 ? "y" : "ies"}${l.heldEntries ? `; ${l.heldEntries} more matched a category but RCM is not payable (below)` : ""}.` : l.heldEntries ? `${l.heldEntries} entr${l.heldEntries === 1 ? "y" : "ies"} matched a category but RCM is not payable (below).` : "No reverse-charge supply found in this ledger." }));
  const end = table(ws, r, cols, rows, { freeze: false, filter: false });
  if (rows.length) totalRow(ws, end, r + 1, end - 1, cols, ["entries", "amount", "rcmEntries", "tax"], { entries: sum(rows.map((x) => x.entries)), amount: sum(rows.map((x) => x.amount)), rcmEntries: sum(rows.map((x) => x.rcmEntries)), tax: sum(rows.map((x) => x.tax)) });
  r = end + 3;
  ws.getCell(r, 1).value = "Entries where a reverse-charge category matched but RCM is not payable"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  if (!rcm.held.length) { ws.getCell(r, 1).value = "None."; return; }
  const hc = [
    { header: "Expense ledger", key: "ledger", width: 40, wrap: true }, { header: "Date", key: "date", width: 13, date: true, align: "center" }, { header: "Party name", key: "party", width: 18, wrap: true },
    { header: "Voucher no", key: "vchNo", width: 11 }, { header: "Amount", key: "amount", width: 15, money: true }, { header: "Why RCM is not payable", key: "reason", width: 70, wrap: true }, { header: "Category matched", key: "category", width: 34, wrap: true },
  ];
  table(ws, r, hc, rcm.held, { freeze: false, filter: false, rowFill: () => AMBER });
}

function notesSheet(wb, client, fy, rcm, files) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes", head2(client, fy));
  ws.getColumn(1).width = 130;
  const add = (t, bold = false) => { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold }; c.alignment = { wrapText: true, vertical: "top" }; };
  add("How the RCM is worked out", true);
  [
    "Every line of every expense ledger is read with its ledger name, party and narration, and tested against the reverse-charge categories of section 9(3) and 9(4) of the CGST Act and the notifications behind them (goods transport agency, legal services, sponsorship, director's fee, security, import of services and the others listed under Provision).",
    "The client's nature of business and constitution decide which categories can apply to this recipient: for example insurance agent's commission applies to an insurance company, recovery agent and direct selling agent services to a bank or NBFC, director's fee to a company, and the real estate categories to a promoter. Categories that do not apply to this client are listed on sheet 3 with the reason.",
    "RCM is payable only when the supplier has charged no GST. If the ITC register or GSTR-2B shows the supplier charging GST on the invoice, or in the month, the supply is under forward charge and is listed on sheet 3 instead. A supplier whose state is not known is taken as in the client's state (CGST and SGST); an import of services is IGST.",
    "The amount booked in the ledger is taken as the taxable value, the rate is the rate of the category, and the ITC column tests the credit against the blocked-credit rules (section 17(5)) and the client's exempt or mixed supplies (section 17(2), rules 42 and 43).",
    "References are from the notifications as understood on the date of this working: lines marked amber depend on conditions the ledger cannot show, and should be confirmed.",
  ].forEach((t) => add(t));
  r++;
  add("Files read", true);
  for (const f of files) add(`${f.name}: ${f.data ? `${f.info.rows} entr${f.info.rows === 1 ? "y" : "ies"} read` : "could not be read and is not included"}${f.info.warnings?.length ? `. ${f.info.warnings.join(" ")}` : ""}`);
  r++;
  add("Points to check", true);
  if (!rcm.warnings.length) add("None.");
  for (const w of rcm.warnings) add(`- ${w}`);
}

export async function rcmWorkbook({ client, fy, rcm, files }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  detailsSheet(wb, client, fy, rcm);
  monthSheet(wb, client, fy, rcm);
  reviewedSheet(wb, client, fy, rcm);
  notesSheet(wb, client, fy, rcm, files);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
