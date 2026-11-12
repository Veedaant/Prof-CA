import * as XLSX from "xlsx";

/**
 * Excel files ExcelJS cannot open: Excel 97-2003 (.xls), the binary .xlsb, and the HTML or XML "spreadsheets" that
 * accounting and portal downloads often save under an .xls name. They come back in the same shape as readSheets gives
 * for .xlsx: { name, rows } with a Date at UTC midnight for a date cell and the master value in every cell of a merged block.
 */

function value(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "e") return "";
  if (cell.v instanceof Date) return new Date(Date.UTC(cell.v.getFullYear(), cell.v.getMonth(), cell.v.getDate()));
  if (cell.t === "n" && typeof cell.v === "number") {
    // a number formatted as a date is a date; a bare time of day stays a number
    if (cell.z && cell.v >= 1 && XLSX.SSF.is_date(cell.z)) {
      const d = XLSX.SSF.parse_date_code(cell.v);
      if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H, d.M, Math.round(d.S)));
    }
    return cell.v;
  }
  return cell.v;
}

export function readOldSheets(buffer) {
  let wb;
  try {
    // raw: text formats (HTML, XML, delimited text) keep their cells as written, so 03/04/2025 stays the 3rd of April instead of being guessed as a US date
    wb = XLSX.read(buffer, { type: "buffer", cellNF: true, cellDates: false, raw: true });
  } catch (e) {
    throw new Error(`The Excel file could not be opened (${String(e.message || e).slice(0, 100)}). Save it as .xlsx or .csv and upload that.`);
  }
  const sheets = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws || !ws["!ref"]) { sheets.push({ name, rows: [] }); continue; }
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const filled = new Map();
    for (const m of ws["!merges"] || []) {
      const master = value(ws[XLSX.utils.encode_cell(m.s)]);
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) filled.set(`${r},${c}`, master);
    }
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = 0; c <= range.e.c; c++) {
        const own = value(ws[XLSX.utils.encode_cell({ r, c })]);
        row.push(own === "" && filled.has(`${r},${c}`) ? filled.get(`${r},${c}`) : own);
      }
      while (row.length && row[row.length - 1] === "") row.pop();
      if (row.length) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
