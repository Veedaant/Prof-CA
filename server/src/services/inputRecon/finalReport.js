import ExcelJS from "exceljs";
import { r2, monthLabel } from "../banking/common.js";
import { body, head, table, title } from "../banking/xl.js";
import { itcRegisterSheet, g2bCombinedSheet } from "./combinedReport.js";
import { groupedTable } from "./recoReport.js";

/**
 * The final reconciliation workbook: the books, GSTR-2B and the finalised GSTR-3B working side by side, month by month,
 * party by party and document by document, and the GSTR-9 and 9C working.
 */

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", GREEN = "FFDCFCE7", RED = "FFFEE2E2";
const HEADS = ["igst", "cgst", "sgst", "cess"];
const HEAD_NAME = { igst: "IGST", cgst: "CGST", sgst: "SGST / UTGST", cess: "Cess" };
const sum = (list) => r2(list.reduce((a, b) => a + (Number(b) || 0), 0));
const head2 = (client, fy, extra = []) => [`Client: ${client.name}${client.gstin ? ` (GSTIN ${client.gstin})` : ""}`, `Financial year: ${fy}`, ...extra];

const STATUS_FILL = { Matches: GREEN, "Amount differs": AMBER, "Only in the first": RED, "Only in the second": RED, "For information": GREY };

/** Total line under a filtered table: SUBTOTAL, so the figures follow the filter on the Category column. */
function subtotalRow(ws, r, first, last, columns, keys, values) {
  ws.getCell(r, 1).value = "Total of the rows shown"; body(ws.getCell(r, 1), { bold: true, fill: GREY });
  columns.forEach((c, i) => {
    if (i === 0) return;
    const cell = ws.getCell(r, i + 1);
    if (keys.includes(c.key)) { const L = ws.getColumn(i + 1).letter; cell.value = { formula: `SUBTOTAL(9,${L}${first}:${L}${last})`, result: values[c.key] ?? 0 }; body(cell, { money: true, bold: true, fill: GREY }); }
    else body(cell, { fill: GREY });
  });
}

function book() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  return wb;
}

/* ------------------------------------------------------------------ sheet 3: the finalised 3B working */

function tbSheet(wb, client, fy, reco) {
  const ws = wb.addWorksheet("3 GSTR-3B Combined");
  const src = reco.tbSource === "final" ? `Finalised 3B working uploaded: ${reco.tbName}` : reco.tbSource === "workings" ? "The finalised file is not uploaded: the latest monthly workings are used" : "No document lines available";
  const r0 = title(ws, "GSTR-3B working (finalised): every document whose ITC the working claims", head2(client, fy, [src, "Credit notes are negative. Amber rows are reverse charge; red rows are not claimed."]));
  const cols = [
    { header: "Return month", key: "month", width: 12 }, { header: "Document date", key: "date", width: 13, date: true, align: "center" }, { header: "Document type", key: "doc", width: 14 },
    { header: "Party name", key: "party", width: 34, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "Invoice no", key: "no", width: 16 }, { header: "Category", key: "category", width: 20 },
    { header: "Taxable value", key: "taxable", width: 16, money: true }, { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true },
    { header: "Cess", key: "cess", width: 12, money: true }, { header: "Total ITC", key: "tot", width: 15, money: true }, { header: "ITC treatment", key: "treat", width: 34, wrap: true }, { header: "Source file", key: "file", width: 26, wrap: true },
  ];
  const rows = [...reco.tb].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0) || String(a.party).localeCompare(String(b.party))).map((l) => ({ ...l, month: l.month ? monthLabel(l.month) : "No month", doc: { inv: "Invoice", cn: "Credit note", dn: "Debit note" }[l.type] || "Invoice" }));
  const end = table(ws, r0, cols, rows, { rowFill: (x) => (x.category === "RCM" ? AMBER : x.category === "Not claimed" ? RED : null) });
  const keys = ["taxable", "igst", "cgst", "sgst", "cess", "tot"];
  if (rows.length) subtotalRow(ws, end, r0 + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(rows.map((x) => x[k]))])));
}

/* ------------------------------------------------------------------ sheet 4: month by month */

const five = (p) => [...HEADS, "tot"].map((h) => ({ key: `${p}_${h}`, header: h === "tot" ? "Total" : HEAD_NAME[h], width: 14 }));

function monthSheet(wb, client, fy, reco) {
  const ws = wb.addWorksheet("4 Monthwise Summary");
  let r = title(ws, "ITC month by month: GSTR-3B, GSTR-2B and the books against each other", head2(client, fy, [
    "Normal ITC and credit / debit notes only (reverse charge, unavailable and other items are on the pivot sheets). Difference = the first table less the second. Total includes cess.",
  ]));
  for (const id of ["tb_g2b", "books_tb", "books_g2b"]) {
    const p = reco.pairs[id];
    ws.getCell(r, 1).value = `${p.a} against ${p.b}`; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
    const rows = p.months.filter((m) => m.hasA || m.hasB).map((m) => {
      const row = { label: m.label, flag: m.both && Math.abs(m.diff.tot) > 2 };
      for (const h of [...HEADS, "tot"]) { row[`a_${h}`] = m.hasA ? m.a[h] : null; row[`b_${h}`] = m.hasB ? m.b[h] : null; row[`d_${h}`] = m.both ? m.diff[h] : null; }
      return row;
    });
    const dcols = five("d").map((c) => ({ ...c, flag: true }));
    r = groupedTable(ws, r, [
      { title: `As per ${p.a}`, fill: "FF1F497D", cols: five("a") }, { title: `As per ${p.b}`, fill: "FF166534", cols: five("b") }, { title: `Difference (${p.a} less ${p.b})`, fill: "FF9A3412", cols: dcols },
    ], rows) + 2;
  }
  ws.views = [{ state: "frozen", xSplit: 1 }];
}

/* ------------------------------------------------------------------ pivots and differences */

function pivotSheet(wb, client, fy, p, name) {
  const ws = wb.addWorksheet(name);
  const r0 = title(ws, `Party-wise pivot: ${p.a} against ${p.b}`, head2(client, fy, ["Use the filter on Category to see normal ITC, reverse charge, TDS, TCS and the rest apart. The total line follows the filter.", "Status 'Only in the first' means the party is in " + p.a + " only; 'Only in the second' means " + p.b + " only."]));
  const side = (key, label) => [{ header: `${label}: documents`, key: `${key}_docs`, width: 10 }, ...[...HEADS.slice(0, 3), "tot"].map((h) => ({ header: `${label}: ${h === "tot" ? "Total" : HEAD_NAME[h]}`, key: `${key}_${h}`, width: 14, money: true }))];
  const cols = [
    { header: "Party name", key: "party", width: 34, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "Category", key: "category", width: 20 },
    ...side("a", p.a), ...side("b", p.b),
    ...["igst", "cgst", "sgst", "tot"].map((h) => ({ header: `Difference: ${h === "tot" ? "Total" : HEAD_NAME[h]}`, key: `d_${h}`, width: 14, money: true })),
    { header: "Status", key: "status", width: 18 },
  ];
  const rows = p.pivot.map((x) => {
    const row = { party: x.party, gstin: x.gstin, category: x.category, status: x.status, a_docs: x.a.docs || "", b_docs: x.b.docs || "" };
    for (const h of ["igst", "cgst", "sgst", "tot"]) { row[`a_${h}`] = x.a[h]; row[`b_${h}`] = x.b[h]; row[`d_${h}`] = x.diff[h]; }
    return row;
  });
  const end = table(ws, r0, cols, rows, { rowFill: (x) => STATUS_FILL[x.status] || null });
  const keys = cols.filter((c) => c.money).map((c) => c.key);
  if (rows.length) subtotalRow(ws, end, r0 + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(rows.map((x) => x[k]))])));
  return ws;
}

function diffSheet(wb, client, fy, p, name) {
  const ws = wb.addWorksheet(name);
  const r0 = title(ws, `Differences by document: ${p.a} against ${p.b}`, head2(client, fy, ["Documents of the parties that do not match on the pivot sheet: in one and not the other, or with a different amount. Reverse charge is included; normal ITC and credit notes too."]));
  const cols = [
    { header: "Party name", key: "party", width: 32, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "Category", key: "category", width: 18 }, { header: "Invoice no", key: "no", width: 16 },
    { header: "Invoice date", key: "date", width: 13, date: true, align: "center" }, { header: "Difference type", key: "type", width: 26, wrap: true },
    { header: `${p.a}: month`, key: "aMonth", width: 11 }, { header: `${p.a}: total tax`, key: "aTot", width: 15, money: true }, { header: `${p.b}: month`, key: "bMonth", width: 11 }, { header: `${p.b}: total tax`, key: "bTot", width: 15, money: true },
    { header: "Difference", key: "diff", width: 15, money: true }, { header: "Remark and what to do", key: "remark", width: 90, wrap: true },
  ];
  const rows = p.diffs.map((d) => ({ ...d, aMonth: d.aMonth ? monthLabel(d.aMonth) : "", bMonth: d.bMonth ? monthLabel(d.bMonth) : "", aTot: d.a ? d.a.tot : null, bTot: d.b ? d.b.tot : null }));
  if (!rows.length) { ws.getCell(r0, 1).value = "Every document agrees."; return; }
  const end = table(ws, r0, cols, rows, { rowFill: (x) => (x.kind === "amount" ? AMBER : x.kind === "month" ? GREY : RED) });
  subtotalRow(ws, end, r0 + 1, end - 1, cols, ["aTot", "bTot", "diff"], { aTot: sum(rows.map((x) => x.aTot)), bTot: sum(rows.map((x) => x.bTot)), diff: sum(rows.map((x) => x.diff)) });
}

/* ------------------------------------------------------------------ sheet 9: GSTR-9 and 9C */

function gstr9Sheet(wb, client, fy, reco) {
  const ws = wb.addWorksheet("9 GSTR-9 and 9C");
  let r = title(ws, "GSTR-9 and GSTR-9C working: input tax credit", head2(client, fy, [
    "Worked out from the 3B workings, GSTR-2B and the books. Amber lines are not in the workings: enter them by hand. Check each reference against the current form.",
  ]));
  const cols = [{ header: "Table", key: "ref", width: 9 }, { header: "Particulars", key: "text", width: 78, wrap: true }, ...HEADS.map((h) => ({ header: HEAD_NAME[h], key: h, width: 15, money: true })), { header: "Total", key: "tot", width: 16, money: true }, { header: "Source and remark", key: "source", width: 70, wrap: true }];
  const part = (label, rows) => {
    ws.getCell(r, 1).value = label; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
    const data = rows.map((x) => ({ ref: x.ref, text: x.text, ...(x.v ? x.v : {}), source: x.source, _manual: x.v == null }));
    r = table(ws, r, cols, data, { rowFill: (x) => (x._manual ? AMBER : null), freeze: false, filter: false }) + 2;
  };
  part("GSTR-9: Tables 6, 7 and 8 (input tax credit)", reco.gstr9.gstr9);
  part("GSTR-9C: reconciliation of input tax credit (Part IV)", reco.gstr9.gstr9c);
  if (reco.gstr9.tdsTcs.length) {
    ws.getCell(r, 1).value = "TDS and TCS credit"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
    const tcols = [{ header: "Category", key: "category", width: 9 }, { header: "Where it is found", key: "where", width: 78 }, { header: "As per books", key: "books", width: 15, money: true }, { header: "As per GSTR-2B", key: "g2b", width: 15, money: true }, { header: "As per GSTR-3B working", key: "tb", width: 15, money: true }, { header: "Remark", key: "remark", width: 70, wrap: true }];
    table(ws, r, tcols, reco.gstr9.tdsTcs.map((x) => ({ category: x.category, where: "TDS / TCS ledgers in the books; GSTR-2B and the 3B working carry no TDS / TCS table", books: x.books.tot, g2b: x.gstr2b.tot, tb: x.tb.tot, remark: "The credit reaches the electronic credit ledger on the deductor's or operator's return: match it with the credit ledger under GST Portal." })), { freeze: false, filter: false });
  }
}

/* ------------------------------------------------------------------ sheet 12: reverse charge */

const rcmCols = (p, withTaxable, withCess = false) => [
  ...(withTaxable ? [{ key: `${p}_taxable`, header: "Taxable value", width: 15 }] : []),
  { key: `${p}_igst`, header: "IGST", width: 13 }, { key: `${p}_cgst`, header: "CGST", width: 13 }, { key: `${p}_sgst`, header: "SGST / UTGST", width: 13 },
  ...(withCess ? [{ key: `${p}_cess`, header: "Cess", width: 10 }] : []), { key: `${p}_tot`, header: "Total", width: 14 },
];

function rcmRecoSheet(wb, client, fy, reco) {
  const ws = wb.addWorksheet("12 RCM Reconciliation");
  const rr = reco.rcmReco, rcm = reco.rcm;
  let r = title(ws, "RCM reconciliation month by month: expense ledgers, books, GSTR-3B tax paid and ITC claimed", head2(client, fy, [
    `Nature of business: ${rcm?.businessLabel || "not set"}. The RCM on the expense ledgers is worked out under Books > RCM. GSTR-3B is the filed return where it is uploaded under GST Portal, otherwise the 3B working.`,
    rcm?.have ? "Difference = the first figure less the second. Amber rows: the month does not agree." : "No expense ledger is uploaded under Books > RCM, so the first group is empty: the books, the tax paid and the ITC claimed are compared.",
  ]));
  const rows = rr.rows.map((m) => {
    const o = { label: m.label, flag: m.status === "Differs" };
    const put = (p, v, keys) => keys.forEach((k) => { o[`${p}_${k}`] = v ? v[k] : null; });
    put("l", m.ledger, ["taxable", "igst", "cgst", "sgst", "tot"]);
    o.l_itc = m.ledgerItc;
    o.b_tot = m.books ? m.books.tot : null;
    put("p", m.paid, ["taxable", "igst", "cgst", "sgst", "tot"]);
    put("c", m.claimed, ["igst", "cgst", "sgst", "tot"]);
    o.d1 = m.diffLedgerPaid; o.d2 = m.diffPaidItc; o.d3 = m.diffLedgerBooks;
    return o;
  });
  const flagged = (cols) => cols.map((c) => ({ ...c, flag: true }));
  const first = r + 2;
  r = groupedTable(ws, r, [
    { title: "RCM on the expense ledgers (working)", fill: "FF1F497D", cols: rcmCols("l", true) },
    { title: "ITC on it available (working)", fill: "FF1F497D", cols: [{ key: "l_itc", header: "Eligible lines", width: 14 }] },
    { title: "RCM tax booked (ITC register)", fill: "FF166534", cols: [{ key: "b_tot", header: "Total", width: 14 }] },
    { title: "RCM tax paid: GSTR-3B 3.1(d)", fill: "FF0F766E", cols: rcmCols("p", true) },
    { title: "ITC claimed on RCM: GSTR-3B 4(A)(3)", fill: "FF7C3AED", cols: rcmCols("c", false) },
    { title: "Differences", fill: "FF9A3412", cols: flagged([{ key: "d1", header: "Working less 3B paid", width: 15 }, { key: "d2", header: "3B paid less ITC claimed", width: 15 }, { key: "d3", header: "Working less books", width: 15 }]) },
  ], rows);
  // the source of the return used, and a remark for each month
  const ncols = 1 + rcmCols("l", true).length + 1 + 1 + rcmCols("p", true).length + rcmCols("c", false).length + 3;
  const heads = [["3B used", 14], ["Status", 13], ["Remark", 90]];
  heads.forEach(([h, w], i) => {
    ws.mergeCells(first - 2, ncols + 1 + i, first - 1, ncols + 1 + i);
    ws.getCell(first - 2, ncols + 1 + i).value = h; head(ws.getCell(first - 2, ncols + 1 + i)); head(ws.getCell(first - 1, ncols + 1 + i));
    ws.getColumn(ncols + 1 + i).width = w;
  });
  rr.rows.forEach((m, i) => {
    const fill = m.status === "Differs" ? AMBER : null;
    [[m.source, false], [m.status, false], [m.remark, true]].forEach(([v, wrap], k) => { const c = ws.getCell(first + i, ncols + 1 + k); c.value = v; body(c, { wrap, fill }); });
  });
  ws.views = [{ state: "frozen", xSplit: 1 }];
  r += 1;
  const add = (t) => { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, color: { argb: "FF4B5563" } }; };
  add("RCM tax booked: the tax booked on the lines of the ITC register marked as reverse charge. Eligible lines: the RCM whose ITC is available to this business (not blocked under section 17(5), not apportioned under rules 42 and 43).");
  add("RCM tax paid is Table 3.1(d) of GSTR-3B (inward supplies liable to reverse charge). The ITC claimed on it is Table 4(A)(3); it should equal the RCM paid in cash for the lines whose ITC is available.");
  if (rcm?.have) add(`RCM on the ledgers for the year: Rs ${rr.totals.ledger.tot ?? 0}; paid in GSTR-3B: Rs ${rr.totals.paid.tot ?? 0}; ITC claimed: Rs ${rr.totals.claimed.tot ?? 0}.`);
}

function notesSheet(wb, client, fy, reco) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes", head2(client, fy));
  ws.getColumn(1).width = 130;
  const add = (t, bold = false) => { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold }; c.alignment = { wrapText: true, vertical: "top" }; };
  add("What each sheet is", true);
  [
    "1 Books Combined ITC: every line of the Input ITC ledger files. 2 GSTR-2B Combined: every invoice and note of every month. 3 GSTR-3B Combined: every document the finalised 3B working claims.",
    "4 Monthwise Summary: for each month, the ITC by head as per GSTR-3B, GSTR-2B and the books, three comparisons side by side with the difference.",
    "5, 7 and 10 are party-wise pivots (3B against 2B, books against 3B, books against 2B). The Category column separates normal ITC, credit / debit notes, reverse charge, TDS, TCS and items not compared; filter on it. 6, 8 and 11 list the documents behind the parties that do not match, with a remark and what to do.",
    "9 GSTR-9 and 9C: the input tax credit tables and the reverse-charge lines (Table 4G, 6C and 6D) worked out from the above, with the lines that need a manual entry shown in amber.",
    "12 RCM Reconciliation: month by month, the reverse charge worked out on the expense ledgers (Books > RCM) against the RCM tax booked, the RCM paid in GSTR-3B 3.1(d) and the ITC claimed in 4(A)(3).",
  ].forEach((t) => add(t));
  r++;
  add("How the comparison is made", true);
  [
    "Normal ITC and credit / debit notes are compared in the monthly tables. A document is the same on two sides when the party (GSTIN, or the name where there is no GSTIN) and the invoice number agree; the taxes are then compared head by head within Rs 1.",
    "GSTR-3B is the finalised working. Its month is the month of the return it was claimed in; GSTR-2B's month is the month of its file; the books' month is the month of the invoice date. A document in a different month on two sides is a timing difference.",
    "Credit notes are negative on every side. TDS and TCS appear from the TDS / TCS ledgers in the books; GSTR-2B and the 3B have no TDS / TCS table, so those credits are shown for information and are matched with the electronic credit ledger.",
    "Reverse-charge supplies are compared in their own rows. For the books, the tax booked as paid is the ITC.",
  ].forEach((t) => add(t));
  r++;
  add("Sources", true);
  add(`Books: ${reco.books.length} line(s). GSTR-2B: ${reco.g2b.length} line(s). GSTR-3B working: ${reco.tb.length} line(s)${reco.tbName ? ` from ${reco.tbName}` : ""}.`);
  r++;
  add("Points to check", true);
  if (!reco.warnings.length) add("None.");
  for (const w of reco.warnings) add(`- ${w}`);
}

export async function finalWorkbook({ client, fy, reco, itcRows, g2bRows }) {
  const wb = book();
  itcRegisterSheet(wb, client, fy, itcRows, "1 Books Combined ITC");
  g2bCombinedSheet(wb, client, fy, g2bRows, "2 GSTR-2B Combined");
  tbSheet(wb, client, fy, reco);
  monthSheet(wb, client, fy, reco);
  pivotSheet(wb, client, fy, reco.pairs.tb_g2b, "5 Party Pivot 3B vs 2B");
  diffSheet(wb, client, fy, reco.pairs.tb_g2b, "6 Differences 3B vs 2B");
  pivotSheet(wb, client, fy, reco.pairs.books_tb, "7 Party Pivot Books vs 3B");
  diffSheet(wb, client, fy, reco.pairs.books_tb, "8 Differences Books vs 3B");
  gstr9Sheet(wb, client, fy, reco);
  pivotSheet(wb, client, fy, reco.pairs.books_g2b, "10 Party Pivot Books vs 2B");
  diffSheet(wb, client, fy, reco.pairs.books_g2b, "11 Differences Books vs 2B");
  rcmRecoSheet(wb, client, fy, reco);
  notesSheet(wb, client, fy, reco);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
