/** Small helpers for the banking workbooks: one look for titles, headings and tables. */
export const MONEY = "#,##0.00;[Red]-#,##0.00";
const BORDER = { style: "thin", color: { argb: "FFD9D9D9" } };
const borders = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const DARK = "FF1F2937";

export function title(ws, text, lines = []) {
  ws.getCell(1, 1).value = text;
  ws.getCell(1, 1).font = { name: "Calibri", size: 14, bold: true };
  lines.forEach((l, i) => { ws.getCell(2 + i, 1).value = l; ws.getCell(2 + i, 1).font = { name: "Calibri", size: 10, color: { argb: "FF4B5563" } }; });
  return 2 + lines.length + 1;
}

export function head(cell, fill = DARK) {
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = borders;
}

export function body(cell, { money = false, wrap = false, bold = false, fill = null, align = null } = {}) {
  cell.font = { name: "Calibri", size: 10, bold };
  cell.border = borders;
  cell.alignment = { vertical: "top", wrapText: wrap, horizontal: align || (money ? "right" : "left") };
  if (money) cell.numFmt = MONEY;
  if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
}

/**
 * columns: [{ header, key, width, money?, wrap? }]; rows: array of objects or arrays keyed by `key`.
 * Returns the row number after the last row.
 */
export function table(ws, startRow, columns, rows, { rowFill = null, freeze = true, filter = true } = {}) {
  columns.forEach((c, i) => {
    const cell = ws.getCell(startRow, i + 1);
    cell.value = c.header;
    head(cell);
    ws.getColumn(i + 1).width = c.width || 14;
  });
  ws.getRow(startRow).height = 30;
  let r = startRow + 1;
  for (const row of rows) {
    const fill = rowFill ? rowFill(row) : null;
    columns.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      const v = row[c.key];
      cell.value = v === undefined || v === null ? "" : c.date && /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? new Date(`${v}T00:00:00Z`) : v;
      body(cell, { money: c.money, wrap: c.wrap, fill, align: c.align });
      if (c.date) cell.numFmt = "dd-mmm-yyyy";
    });
    r++;
  }
  if (freeze) ws.views = [{ state: "frozen", ySplit: startRow }];
  if (filter && rows.length) ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: startRow, column: columns.length } };
  return r;
}

export const sheetName = (s) => String(s).replace(/[\\/?*[\]:]/g, "-").slice(0, 31);
