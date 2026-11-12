import ExcelJS from "exceljs";
import { r2, monthsOfFy, monthLabel } from "../banking/common.js";
import { body, head, table, title } from "../banking/xl.js";
import { latestByMonth, workingLines } from "./reco.js";

/**
 * Input Reco workbooks: the monthly GSTR-3B workings combined into one Excel, and the report that matches the ITC of those
 * workings with the ITC of the GSTR-3B filed.
 */

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", GREEN = "FFDCFCE7", RED = "FFFEE2E2";
const HEADS = ["igst", "cgst", "sgst", "cess"];
const HEAD_NAME = { igst: "IGST", cgst: "CGST", sgst: "SGST / UTGST", cess: "Cess" };
const total = (o) => (o ? r2(HEADS.reduce((a, h) => a + (o[h] || 0), 0)) : null);
const sum = (list) => r2(list.reduce((a, b) => a + (Number(b) || 0), 0));
const head2 = (client, fy, extra = []) => [`Client: ${client.name}${client.gstin ? ` (GSTIN ${client.gstin})` : ""}`, `Financial year: ${fy}`, ...extra];

function book() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  return wb;
}

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

/** A table whose columns come in groups, with the group name above: months down the side. */
export function groupedTable(ws, startRow, groups, rows) {
  const cols = groups.flatMap((g) => g.cols);
  ws.mergeCells(startRow, 1, startRow + 1, 1);
  ws.getCell(startRow, 1).value = "Month"; head(ws.getCell(startRow, 1)); head(ws.getCell(startRow + 1, 1));
  ws.getColumn(1).width = Math.max(ws.getColumn(1).width || 0, 13);
  let c = 2;
  for (const g of groups) {
    if (g.cols.length > 1) ws.mergeCells(startRow, c, startRow, c + g.cols.length - 1);
    ws.getCell(startRow, c).value = g.title;
    g.cols.forEach((col, i) => { head(ws.getCell(startRow, c + i), g.fill); const h = ws.getCell(startRow + 1, c + i); h.value = col.header; head(h, g.fill); ws.getColumn(c + i).width = Math.max(ws.getColumn(c + i).width || 0, col.width || 14); });
    c += g.cols.length;
  }
  let r = startRow + 2;
  const first = r;
  for (const row of rows) {
    ws.getCell(r, 1).value = row.label; body(ws.getCell(r, 1), { bold: true });
    cols.forEach((col, i) => { const cell = ws.getCell(r, i + 2); cell.value = row[col.key] ?? ""; body(cell, { money: true, fill: row[col.key] == null ? GREY : row.flag && col.flag ? AMBER : null }); });
    r++;
  }
  if (rows.length) {
    ws.getCell(r, 1).value = "Total"; body(ws.getCell(r, 1), { bold: true, fill: GREY });
    cols.forEach((col, i) => {
      const cell = ws.getCell(r, i + 2);
      const letter = ws.getColumn(i + 2).letter;
      cell.value = { formula: `SUM(${letter}${first}:${letter}${r - 1})`, result: sum(rows.map((x) => x[col.key])) };
      body(cell, { money: true, bold: true, fill: GREY });
    });
    r++;
  }
  return r;
}
const grp = (titleText, fill, cols) => ({ title: titleText, fill, cols });
const four = (p, flag = false) => HEADS.map((h) => ({ key: `${p}_${h}`, header: HEAD_NAME[h], width: 14, flag }));

function notes(wb, client, fy, lines) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes", head2(client, fy));
  ws.getColumn(1).width = 130;
  for (const [t, bold] of lines) { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold: Boolean(bold) }; c.alignment = { wrapText: true, vertical: "top" }; }
}

const fileNotes = (label, files) => files.map((f) => [`${label} ${f.period ? monthLabel(f.period) : "(month not set)"}, ${f.name}: ${f.data ? `${f.info.rows} line(s) read` : "could not be read and is not included"}${f.info.warnings?.length ? `. ${f.info.warnings.join(" ")}` : ""}`]);

/* ================================================================== the workings, combined */

export async function work3bWorkbook({ client, fy, files }) {
  const wb = book();
  const { byMonth, replaced, unplaced } = latestByMonth(files.filter((f) => f.data));
  const months = [...monthsOfFy(fy), ...[...byMonth.keys()].filter((m) => !monthsOfFy(fy).includes(m)).sort()];

  // 1. eligible ITC by month: the figure that is matched with GSTR-3B
  const ws = wb.addWorksheet("1 Eligible ITC by Month");
  const r0 = title(ws, "Eligible ITC as per the GSTR-3B workings, month by month", head2(client, fy, ["Net ITC is Table 4(A) less 4(B): the ITC the working claims for the month."]));
  const rows = months.map((m) => {
    const f = byMonth.get(m);
    const l = f ? workingLines(f.data) : null;
    return {
      month: monthLabel(m), file: f ? f.name : "Working not uploaded", a5: l ? total(l.a5) : null, a3: l ? total(l.a3) : null, other: l ? total(l.other) : null, reversed: l ? total(l.reversed) : null,
      igst: l?.net.igst ?? null, cgst: l?.net.cgst ?? null, sgst: l?.net.sgst ?? null, cess: l?.net.cess ?? null, net: l ? total(l.net) : null, _none: !f,
    };
  });
  const cols = [
    { header: "Month", key: "month", width: 11 }, { header: "Working file", key: "file", width: 34, wrap: true },
    { header: "4(A)(5) All other ITC", key: "a5", width: 17, money: true }, { header: "4(A)(3) Reverse charge", key: "a3", width: 17, money: true }, { header: "4(A)(1), (2), (4) Imports and ISD", key: "other", width: 17, money: true }, { header: "4(B) ITC reversed", key: "reversed", width: 16, money: true },
    { header: "Net ITC: IGST", key: "igst", width: 15, money: true }, { header: "Net ITC: CGST", key: "cgst", width: 15, money: true }, { header: "Net ITC: SGST / UTGST", key: "sgst", width: 15, money: true }, { header: "Net ITC: Cess", key: "cess", width: 13, money: true }, { header: "Net ITC: Total", key: "net", width: 16, money: true },
  ];
  const end = table(ws, r0, cols, rows, { rowFill: (x) => (x._none ? GREY : null) });
  const keys = ["a5", "a3", "other", "reversed", "igst", "cgst", "sgst", "cess", "net"];
  totalRow(ws, end, r0 + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(rows.map((x) => x[k]))])));

  // 2. Table 4 line by line, by head
  const w2 = wb.addWorksheet("2 Table 4 Line-wise");
  let r = title(w2, "Table 4 of each working, line by line", head2(client, fy));
  const lineRows = (keysList) => months.filter((m) => byMonth.has(m)).map((m) => {
    const t4 = byMonth.get(m).data.t4;
    const row = { label: monthLabel(m) };
    for (const k of keysList) for (const h of HEADS) row[`${k}_${h}`] = t4[k] ? t4[k][h] : 0;
    return row;
  });
  w2.getCell(r, 1).value = "Table 4(A): ITC available"; w2.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  r = groupedTable(w2, r, [
    grp("4(A)(1) Import of goods", "FF0F766E", four("a1")), grp("4(A)(2) Import of services", "FF0F766E", four("a2")), grp("4(A)(3) Reverse charge", "FF9A3412", four("a3")),
    grp("4(A)(4) From ISD", "FF6B7280", four("a4")), grp("4(A)(5) All other ITC", "FF1F497D", four("a5")),
  ], lineRows(["a1", "a2", "a3", "a4", "a5"])) + 2;
  w2.getCell(r, 1).value = "Table 4(B) ITC reversed, and the net ITC claimed"; w2.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  const netRows = months.filter((m) => byMonth.has(m)).map((m) => {
    const t4 = byMonth.get(m).data.t4, l = workingLines(byMonth.get(m).data);
    const row = { label: monthLabel(m) };
    for (const k of ["b1", "b2"]) for (const h of HEADS) row[`${k}_${h}`] = t4[k] ? t4[k][h] : 0;
    for (const h of HEADS) row[`n_${h}`] = l.net[h];
    return row;
  });
  groupedTable(w2, r, [grp("4(B)(1) Reversed: rules 38, 42, 43 and 17(5)", "FF6B7280", four("b1")), grp("4(B)(2) Reversed: others", "FF6B7280", four("b2")), grp("Net ITC claimed (A less B)", "FF166534", four("n"))], netRows);
  w2.views = [{ state: "frozen", xSplit: 1 }];

  // 3. the documents behind the ITC, when the workings list them: this sheet is what the final reconciliation reads back
  const TYPE = { inv: "Invoice", cn: "Credit note", dn: "Debit note" };
  const docRows = months.filter((m) => byMonth.has(m)).flatMap((m) => (byMonth.get(m).data.docs || []).map((d) => ({
    month: monthLabel(m), date: d.date || "", type: TYPE[d.type] || "Invoice", party: d.party, gstin: d.gstin, no: d.inv_no, rcm: d.rcm ? "Yes" : "No",
    taxable: d.taxable, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess, itc: r2(d.igst + d.cgst + d.sgst + d.cess), treat: d.treat || "",
  })));
  if (docRows.length) {
    const wd = wb.addWorksheet("3 ITC Documents");
    const rd = title(wd, "ITC claimed in the workings: every document, all months", head2(client, fy, ["Credit notes are negative. The final reconciliation reads this sheet, so keep the headings."]));
    const dcols = [
      { header: "Return month", key: "month", width: 12 }, { header: "Document date", key: "date", width: 13, date: true, align: "center" }, { header: "Document type", key: "type", width: 13 },
      { header: "Party name", key: "party", width: 34, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "Invoice no", key: "no", width: 16 }, { header: "Reverse charge", key: "rcm", width: 10 },
      { header: "Taxable value", key: "taxable", width: 16, money: true }, { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true },
      { header: "Cess", key: "cess", width: 12, money: true }, { header: "Total ITC", key: "itc", width: 15, money: true }, { header: "ITC treatment", key: "treat", width: 34, wrap: true },
    ];
    const de = table(wd, rd, dcols, docRows);
    const dk = ["taxable", "igst", "cgst", "sgst", "cess", "itc"];
    totalRow(wd, de, rd + 1, de - 1, dcols, dk, Object.fromEntries(dk.map((k) => [k, sum(docRows.map((x) => x[k]))])));
  }

  // 4. outward supplies and tax paid, when the workings carry them
  const have31 = months.some((m) => byMonth.get(m)?.data.t31), have61 = months.some((m) => byMonth.get(m)?.data.t61);
  if (have31 || have61) {
    const w3 = wb.addWorksheet("4 Outward and Tax Paid");
    let q = title(w3, "Table 3.1 and Table 6.1 of the workings", head2(client, fy, ["Shown for the workings that carry these tables."]));
    if (have31) {
      const v = (m, k, f) => byMonth.get(m).data.t31?.[k]?.[f] ?? 0;
      const rows31 = months.filter((m) => byMonth.get(m)?.data.t31).map((m) => {
        const row = { label: monthLabel(m) };
        for (const k of ["a", "b", "c", "d", "e"]) for (const f of ["taxable", "igst", "cgst", "sgst", "cess"]) row[`${k}_${f}`] = v(m, k, f);
        return row;
      });
      const five = (p) => [["taxable", "Taxable value", 15], ...HEADS.map((h) => [h, HEAD_NAME[h], 13])].map(([k, hd, w]) => ({ key: `${p}_${k}`, header: hd, width: w }));
      w3.getCell(q, 1).value = "Table 3.1: outward supplies and inward supplies liable to reverse charge"; w3.getCell(q, 1).font = { name: "Calibri", size: 12, bold: true }; q++;
      q = groupedTable(w3, q, [grp("(a) Outward taxable supplies", "FF1F497D", five("a")), grp("(b) Zero rated", "FF0F766E", five("b")), grp("(c) Nil rated, exempted", "FF6B7280", five("c")), grp("(d) Inward supplies liable to RCM", "FF9A3412", five("d")), grp("(e) Non-GST outward", "FF374151", five("e"))], rows31) + 2;
    }
    if (have61) {
      const rows61 = months.filter((m) => byMonth.get(m)?.data.t61).map((m) => {
        const t = byMonth.get(m).data.t61;
        const row = { label: monthLabel(m) };
        for (const k of ["liability", "itcUsed", "cash"]) for (const h of HEADS) row[`${k}_${h}`] = t[k] ? t[k][h] : 0;
        return row;
      });
      w3.getCell(q, 1).value = "Table 6.1: payment of tax"; w3.getCell(q, 1).font = { name: "Calibri", size: 12, bold: true }; q++;
      groupedTable(w3, q, [grp("Tax payable", "FF1F497D", four("liability")), grp("Paid through ITC", "FF0F766E", four("itcUsed")), grp("Paid in cash", "FF166534", four("cash"))], rows61);
    }
    w3.views = [{ state: "frozen", xSplit: 1 }];
  }

  const missing = months.filter((m) => !byMonth.has(m) && monthsOfFy(fy).includes(m)).map(monthLabel);
  notes(wb, client, fy, [
    ["Files combined", true], ...fileNotes("GSTR-3B working", files),
    ...replaced.map((f) => [`${f.name} (${f.period ? monthLabel(f.period) : ""}) is not used: a later working for the same month was uploaded.`]),
    ...unplaced.map((f) => [`${f.name} is not used: its month is not set. Choose the month on the list.`]),
    ["", false], ["How to read the sheets", true],
    ["Sheet 1 gives the eligible ITC of each month: the net of Table 4 (all of 4(A) less 4(B)), by head. This is the figure matched with the GSTR-3B filed on the portal."],
    ["Sheet 3 lists every document whose ITC the workings claim, with the party, GSTIN, invoice and tax. After the differences with the filed GSTR-3B are settled, finalise this file and upload it in Step 2 of Input Reco."],
    ["Sheet 2 gives each line of Table 4 for every month. Each working is read by its labels, so the firm's own layout reads as long as it has Table 4 lines such as (A)(5) All other ITC."],
    ...(missing.length ? [[`No working is uploaded for: ${missing.join(", ")}.`]] : []),
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ================================================================== the match with GSTR-3B */

const STATUS_FILL = { Matches: GREEN, "Does not match": RED };

export async function recoWorkbook({ client, fy, reco, workFiles, portalFiles }) {
  const wb = book();
  const s = reco.summary;

  const ws = wb.addWorksheet("1 Match Summary");
  let r = title(ws, "Input Reco: ITC as per the GSTR-3B workings against the GSTR-3B filed", head2(client, fy, [
    "Both sides are the net ITC of Table 4: all of 4(A) less 4(B). Difference = working less GSTR-3B. A month matches when every head is within Rs 1.",
  ]));
  const stat = [["Months compared", s.compared], ["Match", s.matching], ["Do not match", s.differing], ["Working missing", s.noWorking], ["GSTR-3B missing", s.noPortal]];
  stat.forEach(([k, v], i) => { const a = ws.getCell(r, 1 + i * 2); a.value = k; body(a, { bold: true, fill: GREY }); const b = ws.getCell(r, 2 + i * 2); b.value = v; body(b, { fill: i === 2 && v ? RED : null, bold: true }); });
  r += 2;
  const cols = [
    { header: "Month", key: "label", width: 11 }, { header: "ITC as per GSTR-3B working", key: "w", width: 19, money: true }, { header: "ITC as per GSTR-3B filed", key: "p", width: 19, money: true },
    { header: "Difference", key: "d", width: 16, money: true }, { header: "Status", key: "status", width: 16 }, { header: "What differs", key: "remark", width: 84, wrap: true },
  ];
  const rows = reco.rows.filter((x) => !x.outsideYear || x.working || x.portal).map((x) => ({ label: x.label, w: x.working ? total(x.working.net) : null, p: x.portal ? total(x.portal.net) : null, d: x.diff ? x.diffTotal : null, status: x.status, remark: x.remark }));
  const end = table(ws, r, cols, rows, { rowFill: (x) => STATUS_FILL[x.status] || (x.status === "Not uploaded" ? GREY : AMBER), freeze: false, filter: false });
  totalRow(ws, end, r + 1, end - 1, cols, ["w", "p", "d"], { w: sum(rows.map((x) => x.w)), p: sum(rows.map((x) => x.p)), d: sum(rows.map((x) => x.d)) });
  ws.views = [{ state: "frozen", ySplit: r }];

  // head by head
  const w2 = wb.addWorksheet("2 Head-wise");
  let q = title(w2, "Net ITC head by head: working, GSTR-3B and the difference", head2(client, fy));
  const compared = reco.rows.filter((x) => x.diff);
  const headRows = compared.map((x) => {
    const row = { label: x.label, flag: x.status !== "Matches" };
    for (const h of HEADS) { row[`w_${h}`] = x.working.net[h]; row[`p_${h}`] = x.portal.net[h]; row[`d_${h}`] = x.diff[h]; }
    return row;
  });
  if (headRows.length) groupedTable(w2, q, [grp("ITC as per GSTR-3B working", "FF1F497D", four("w")), grp("ITC as per GSTR-3B filed", "FF166534", four("p")), grp("Difference (working less GSTR-3B)", "FF9A3412", four("d", true))], headRows);
  else w2.getCell(q, 1).value = "No month has both a working and a GSTR-3B yet.";
  w2.views = [{ state: "frozen", xSplit: 1 }];

  // line by line, for the months that differ
  const w3 = wb.addWorksheet("3 Line-wise");
  const lr = title(w3, "Where the months that do not match differ, line by line", head2(client, fy, ["Totals of IGST, CGST, SGST and cess."]));
  const lineCols = [
    { header: "Month", key: "label", width: 11 }, { header: "Line of Table 4", key: "line", width: 38 }, { header: "As per GSTR-3B working", key: "w", width: 19, money: true },
    { header: "As per GSTR-3B filed", key: "p", width: 19, money: true }, { header: "Difference", key: "d", width: 16, money: true },
  ];
  const lineRows = [];
  const names = { a5: "4(A)(5) All other ITC", a3: "4(A)(3) Reverse charge", other: "4(A)(1), (2), (4) Imports and ISD", reversed: "4(B) ITC reversed" };
  for (const x of compared.filter((c) => c.status !== "Matches")) {
    for (const k of ["a5", "a3", "other", "reversed"]) {
      const wv = total(x.working[k]), pv = total(x.portal[k]);
      lineRows.push({ label: x.label, line: names[k], w: wv, p: pv, d: r2(wv - pv), _diff: Math.abs(wv - pv) > 1 });
    }
    lineRows.push({ label: x.label, line: "Net ITC", w: total(x.working.net), p: total(x.portal.net), d: x.diffTotal, _net: true });
  }
  if (lineRows.length) table(w3, lr, lineCols, lineRows, { rowFill: (x) => (x._net ? GREY : x._diff ? AMBER : null) });
  else w3.getCell(lr, 1).value = "Every month compared matches, so there is nothing to show line by line.";

  const workUsed = latestByMonth(workFiles.filter((f) => f.data)), portalUsed = latestByMonth(portalFiles.filter((f) => f.data));
  notes(wb, client, fy, [
    ["How the match was made", true],
    ["The ITC claimed in each month's GSTR-3B working (net of Table 4: all of 4(A) less 4(B)) is set against the same figure read from the GSTR-3B filed for that month. The filed GSTR-3B is read from the files under GST Portal."],
    ["A month matches when IGST, CGST, SGST and cess are each within Rs 1 of the other side. Where a month does not match, sheet 3 shows which line of Table 4 differs."],
    ["If the workings agree to the GSTR-3B, they can be used for the reconciliation with the books and GSTR-2B."],
    ["", false], ["GSTR-3B workings used", true], ...[...workUsed.byMonth.values()].map((f) => [`${monthLabel(f.period)}: ${f.name}`]),
    ["", false], ["GSTR-3B filed (portal files) used", true], ...[...portalUsed.byMonth.values()].map((f) => [`${monthLabel(f.period)}: ${f.name}`]),
    ...reco.replaced.map((f) => [`${f.name} (${monthLabel(f.period)}) is not used: a later ${f.side === "working" ? "working" : "GSTR-3B"} for the same month was uploaded.`]),
    ...reco.unplaced.map((f) => [`${f.name} is not used: its month is not set.`]),
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
