import ExcelJS from "exceljs";
import { r2, monthsOfFy, monthLabel, monthOf } from "../banking/common.js";
import { body, head, table, title } from "../banking/xl.js";
import { assessRcm } from "../itc/rcm.js";

/**
 * The combined workbooks of the Input Reconciliation section: every Input ITC ledger file of the books in one presentable
 * workbook, and every GSTR-2B and GSTR-3B file of the GST portal in another, with the month by month workings.
 */

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", RED = "FFFEE2E2";
const sum = (list) => r2(list.reduce((a, b) => a + (Number(b) || 0), 0));
const HEADS = ["igst", "cgst", "sgst", "cess"];
const total4 = (o) => r2(HEADS.reduce((a, h) => a + (o[h] || 0), 0));

function book() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  wb.calcProperties = { fullCalcOnLoad: true };
  return wb;
}
const head2 = (client, fy, extra = []) => [`Client: ${client.name}${client.gstin ? ` (GSTIN ${client.gstin})` : ""}`, `Financial year: ${fy}`, ...extra];

/** Months in financial-year order first, then anything outside the year, then rows with no date. */
function orderMonths(keys, fy) {
  const fyM = monthsOfFy(fy);
  const set = new Set(keys);
  return [...fyM.filter((m) => set.has(m)), ...[...set].filter((m) => m && !fyM.includes(m)).sort(), ...(set.has("") ? [""] : [])];
}
const labelOf = (m) => (m ? monthLabel(m) : "No date");

/** A total line under a table: SUM formulas over the given money columns. */
function totalRow(ws, r, first, last, columns, keys, values, label = "Total") {
  ws.getCell(r, 1).value = label; body(ws.getCell(r, 1), { bold: true, fill: GREY });
  columns.forEach((c, i) => {
    const cell = ws.getCell(r, i + 1);
    if (i === 0) return;
    if (keys.includes(c.key)) {
      const letter = ws.getColumn(i + 1).letter;
      cell.value = { formula: `SUM(${letter}${first}:${letter}${last})`, result: values[c.key] ?? 0 };
      body(cell, { money: true, bold: true, fill: GREY });
    } else body(cell, { fill: GREY });
  });
}

/** Rows grouped on a key, summing the given fields; the count of rows is added as `docs`. */
function groupRows(rows, keyOf, fields) {
  const map = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    let g = map.get(k);
    if (!g) { g = { key: k, docs: 0, ...Object.fromEntries(fields.map((f) => [f, 0])) }; map.set(k, g); }
    g.docs++;
    for (const f of fields) g[f] += r[f] || 0;
  }
  return map;
}
const round = (o, fields) => { for (const f of fields) o[f] = r2(o[f]); return o; };

/* ================================================================== books: Input ITC ledger */

const DOC = { inv: "Invoice", cn: "Credit note", dn: "Debit note" };

/** Normal supply, reverse charge, or exempt: from the register's own marking and, failing that, the nature of the supply. */
function supplyKind(r) {
  if (r.charge === "Exempt") return { text: "Exempt / nil rated", ref: "" };
  const ra = assessRcm({ b: r });
  const ref = ra.rule?.ref || "";
  if (ra.mode === "rcm") return { text: ra.source === "detected" ? `RCM applicable (${ra.rule?.name || "reverse charge"}); not marked in the books` : "Reverse charge (RCM)", ref, rcm: true };
  if (ra.mode === "fcm") return { text: "Normal supply (reverse-charge kind of supply, GST charged by the supplier)", ref };
  return { text: "Normal supply (forward charge)", ref: "" };
}

export function itcRegisterSheet(wb, client, fy, rows, name = "1 ITC Register Combined") {
  const ws = wb.addWorksheet(name);
  const r0 = title(ws, "Input ITC ledger of the books: all files combined", head2(client, fy, ["Credit notes are shown as negative amounts. Period is the month of the invoice date."]));
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Period", key: "period", width: 10 }, { header: "Invoice date", key: "date", width: 13, date: true, align: "center" }, { header: "Document type", key: "doc", width: 13 },
    { header: "Party name", key: "party", width: 34, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "Invoice no", key: "no", width: 16 },
    { header: "Nature of supply / services", key: "nature", width: 34, wrap: true }, { header: "Source of nature", key: "natureSource", width: 30, wrap: true }, { header: "Inter / intra state", key: "supply", width: 12 },
    { header: "Normal supply or RCM", key: "kind", width: 34, wrap: true }, { header: "RCM reference", key: "ref", width: 30, wrap: true },
    { header: "Taxable value", key: "taxable", width: 16, money: true }, { header: "Rate %", key: "rate", width: 8 },
    { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true }, { header: "Cess", key: "cess", width: 12, money: true },
    { header: "Total ITC", key: "itc", width: 15, money: true }, { header: "RCM tax booked", key: "rcm", width: 15, money: true }, { header: "Invoice value", key: "value", width: 16, money: true }, { header: "Source file", key: "file", width: 28, wrap: true },
  ];
  const data = rows.map((r, i) => ({ ...r, sr: i + 1 }));
  const end = table(ws, r0, cols, data, { rowFill: (r) => (r.rcmFlag ? AMBER : null) });
  const sums = Object.fromEntries(["taxable", "igst", "cgst", "sgst", "cess", "itc", "rcm", "value"].map((k) => [k, sum(rows.map((r) => r[k]))]));
  if (rows.length) totalRow(ws, end, r0 + 1, end - 1, cols, Object.keys(sums), sums);
  ws.getCell(r0 - 1, 1).value = "Amber rows: reverse charge (RCM).";
  ws.getCell(r0 - 1, 1).font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
}

function itcMonthSheet(wb, client, fy, rows, ledger) {
  const ws = wb.addWorksheet("2 Month-wise Summary");
  let r = title(ws, "Input ITC month by month", head2(client, fy));
  const fields = ["taxable", "igst", "cgst", "sgst", "cess", "itc", "rcm"];
  const cols = [
    { header: "Period", key: "label", width: 12 }, { header: "No. of documents", key: "docs", width: 12 }, { header: "Taxable value", key: "taxable", width: 17, money: true },
    { header: "IGST", key: "igst", width: 15, money: true }, { header: "CGST", key: "cgst", width: 15, money: true }, { header: "SGST / UTGST", key: "sgst", width: 15, money: true }, { header: "Cess", key: "cess", width: 13, money: true },
    { header: "Total ITC", key: "itc", width: 16, money: true }, { header: "RCM documents", key: "rcmDocs", width: 12 }, { header: "RCM tax booked", key: "rcm", width: 16, money: true },
  ];
  if (rows.length) {
    const g = groupRows(rows, (x) => x.month, fields);
    const rcmDocs = groupRows(rows.filter((x) => x.rcmFlag), (x) => x.month, []);
    const lines = orderMonths([...g.keys()], fy).map((m) => ({ ...round(g.get(m), fields), label: labelOf(m), rcmDocs: rcmDocs.get(m)?.docs || 0 }));
    const end = table(ws, r, cols, lines, { freeze: false, filter: false });
    const sums = { docs: lines.reduce((a, l) => a + l.docs, 0), rcmDocs: lines.reduce((a, l) => a + l.rcmDocs, 0), ...Object.fromEntries(fields.map((f) => [f, sum(lines.map((l) => l[f]))])) };
    totalRow(ws, end, r + 1, end - 1, cols, ["docs", "rcmDocs", ...fields], sums);
    r = end + 3;
  }
  if (ledger.length) {
    ws.getCell(r, 1).value = "Ledger entries by month (ledger files)"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
    const g = groupRows(ledger, (x) => x.month, ["debit", "credit", "net"]);
    const lc = [{ header: "Period", key: "label", width: 12 }, { header: "No. of entries", key: "docs", width: 12 }, { header: "Debit (ITC availed)", key: "debit", width: 17, money: true }, { header: "Credit (reversed / utilised)", key: "credit", width: 17, money: true }, { header: "Net debit", key: "net", width: 16, money: true }];
    const lines = orderMonths([...g.keys()], fy).map((m) => ({ ...round(g.get(m), ["debit", "credit", "net"]), label: labelOf(m) }));
    const end = table(ws, r, lc, lines, { freeze: false, filter: false });
    totalRow(ws, end, r + 1, end - 1, lc, ["docs", "debit", "credit", "net"], { docs: lines.reduce((a, l) => a + l.docs, 0), ...Object.fromEntries(["debit", "credit", "net"].map((f) => [f, sum(lines.map((l) => l[f]))])) });
  }
}

function itcPartySheet(wb, client, fy, rows) {
  const ws = wb.addWorksheet("3 Party-wise Summary");
  const r = title(ws, "Input ITC party by party", head2(client, fy));
  const fields = ["taxable", "igst", "cgst", "sgst", "cess", "itc"];
  const g = groupRows(rows, (x) => `${x.gstin || ""}|${(x.party || "").toUpperCase()}`, fields);
  const lines = [...g.entries()].map(([k, v]) => ({ ...round(v, fields), party: rows.find((x) => `${x.gstin || ""}|${(x.party || "").toUpperCase()}` === k)?.party || "", gstin: k.split("|")[0] })).sort((a, b) => b.itc - a.itc);
  const cols = [
    { header: "Party name", key: "party", width: 36, wrap: true }, { header: "GSTIN", key: "gstin", width: 19 }, { header: "No. of documents", key: "docs", width: 12 }, { header: "Taxable value", key: "taxable", width: 17, money: true },
    { header: "IGST", key: "igst", width: 15, money: true }, { header: "CGST", key: "cgst", width: 15, money: true }, { header: "SGST / UTGST", key: "sgst", width: 15, money: true }, { header: "Cess", key: "cess", width: 13, money: true }, { header: "Total ITC", key: "itc", width: 16, money: true },
  ];
  const end = table(ws, r, cols, lines);
  if (lines.length) totalRow(ws, end, r + 1, end - 1, cols, ["docs", ...fields], { docs: lines.reduce((a, l) => a + l.docs, 0), ...Object.fromEntries(fields.map((f) => [f, sum(lines.map((l) => l[f]))])) });
}

function ledgerSheet(wb, client, fy, ledger) {
  const ws = wb.addWorksheet("4 Ledger Entries");
  const r0 = title(ws, "Input ITC ledger entries (files without invoice details)", head2(client, fy, ["These files are plain ledgers: they carry the party and the amount, not the GSTIN or taxable value."]));
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Period", key: "period", width: 10 }, { header: "Date", key: "date", width: 13, date: true, align: "center" }, { header: "Particulars", key: "party", width: 34, wrap: true },
    { header: "Vch type", key: "vchType", width: 13 }, { header: "Vch no", key: "vchNo", width: 12 }, { header: "Narration", key: "narration", width: 36, wrap: true },
    { header: "Debit (ITC availed)", key: "debit", width: 17, money: true }, { header: "Credit (reversed / utilised)", key: "credit", width: 17, money: true }, { header: "Net debit", key: "net", width: 16, money: true }, { header: "Source file", key: "file", width: 28, wrap: true },
  ];
  const data = ledger.map((e, i) => ({ ...e, sr: i + 1 }));
  const end = table(ws, r0, cols, data);
  if (ledger.length) totalRow(ws, end, r0 + 1, end - 1, cols, ["debit", "credit", "net"], { debit: sum(ledger.map((e) => e.debit)), credit: sum(ledger.map((e) => e.credit)), net: sum(ledger.map((e) => e.net)) });
}

function notesSheet(wb, client, fy, lines) {
  const ws = wb.addWorksheet("Notes");
  let r = title(ws, "Notes", head2(client, fy));
  ws.getColumn(1).width = 130;
  for (const [t, bold] of lines) { const c = ws.getCell(r++, 1); c.value = t; c.font = { name: "Calibri", size: 10, bold: Boolean(bold) }; c.alignment = { wrapText: true, vertical: "top" }; }
}

/** The register lines and the plain-ledger lines of the Input ITC ledger files, ready for the sheets. */
export function buildItcRows(files, resolveNature) {
  const reg = files.filter((f) => f.data?.format === "register");
  const led = files.filter((f) => f.data?.format === "ledger");
  const rows = reg.flatMap((f) => f.data.rows.map((r) => {
    const s = r.type === "cn" ? -1 : 1;
    // the nature comes from the register or, failing that, from every document held for the party; it also decides whether a supply is of a reverse-charge kind
    const nat = resolveNature ? resolveNature(r.party || "", r.gstin || "", r.nature) : { nature: r.nature || "", source: r.nature ? "As per the register" : "" };
    const k = supplyKind({ ...r, nature: nat.nature });
    const month = r.date ? monthOf(r.date) : "";
    const tax = { igst: s * (r.igst || 0), cgst: s * (r.cgst || 0), sgst: s * (r.sgst || 0), cess: s * (r.cess || 0) };
    return {
      file: f.name, month, period: labelOf(month), date: r.date || "", doc: DOC[r.type] || "Invoice", party: r.party || "", gstin: r.gstin || "", no: r.inv_no || "", nature: nat.nature, natureSource: nat.source,
      supply: r.supply === "inter" ? "Inter-state" : r.supply === "intra" ? "Intra-state" : "", kind: k.text, ref: k.ref, rcmFlag: Boolean(k.rcm),
      taxable: r2(s * (r.taxable || 0)), rate: r.rate || "", ...tax, itc: total4(tax), rcm: r2(s * (r.rcm || 0)), value: r2(s * (r.value || 0)),
    };
  })).sort((a, b) => ((a.date || "9999") < (b.date || "9999") ? -1 : (a.date || "9999") > (b.date || "9999") ? 1 : 0));
  const ledger = led.flatMap((f) => f.data.entries.map((e) => {
    const month = e.date ? monthOf(e.date) : "";
    return { file: f.name, month, period: labelOf(month), date: e.date, party: e.party, vchType: e.vchType, vchNo: e.vchNo, narration: e.narration, debit: e.debit, credit: e.credit, net: r2(e.debit - e.credit) };
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, ledger };
}

export async function itcWorkbook({ client, fy, files, resolveNature }) {
  const wb = book();
  const { rows, ledger } = buildItcRows(files, resolveNature);

  if (rows.length) { itcRegisterSheet(wb, client, fy, rows); }
  itcMonthSheet(wb, client, fy, rows, ledger);
  if (rows.length) itcPartySheet(wb, client, fy, rows);
  if (ledger.length) ledgerSheet(wb, client, fy, ledger);

  const notes = [["Files combined", true]];
  for (const f of files) notes.push([`${f.name}: ${f.data ? `${f.info.rows} line(s) read as ${f.data.format === "register" ? "an ITC register" : "a ledger"}` : "could not be read and is not included"}${f.info.warnings?.length ? `. ${f.info.warnings.join(" ")}` : ""}`]);
  notes.push(["", false], ["How to read the sheets", true]);
  notes.push(["Sheet 1 lists every invoice, credit note and debit note of the ITC register files, with the period (month of the invoice date), party, GSTIN, taxable value, tax and whether it is a normal supply or reverse charge."]);
  notes.push(["Normal supply or RCM is taken from the register's own marking; where the register does not mark a supply that is of a reverse-charge kind (for example transport of goods by road or an advocate's service) and no GST is charged, it is shown as RCM applicable, with the reference. References are from the notifications as understood on the date of this working and should be verified."]);
  notes.push(["Nature of supply / services is taken from the register when it gives one. Otherwise it is worked out from the documents held for the party: the descriptions on the party's invoices in the system, the party's other lines in the register, the bank ledger and bank statements that name the party, and last the party's name. The Source of nature column says which."]);
  notes.push(["Credit notes are shown as negative amounts so the totals are net."]);
  const outside = rows.filter((r) => r.date && (r.date < `${fy.slice(0, 4)}-04-01` || r.date > `${Number(fy.slice(0, 4)) + 1}-03-31`)).length;
  if (outside) notes.push([`${outside} document(s) are dated outside ${fy}.`]);
  if (!rows.length && ledger.length) notes.push(["Only plain ledger files were uploaded, so there are no invoice details (GSTIN, taxable value). Upload the ITC register for those."]);
  notesSheet(wb, client, fy, notes);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ================================================================== GST portal: GSTR-2B and GSTR-3B */

const SRC = { b2b: "B2B invoices", cdnr: "Credit / debit notes", impg: "Import of goods", isd: "ISD credits" };

/** Header rows for a table with groups of columns; the first column is the month. */
function groupedTable(ws, startRow, groups, rows, label = "Month") {
  const cols = groups.flatMap((g) => g.cols);
  ws.mergeCells(startRow, 1, startRow + 1, 1);
  ws.getCell(startRow, 1).value = label; head(ws.getCell(startRow, 1));
  head(ws.getCell(startRow + 1, 1));
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
    cols.forEach((col, i) => { const cell = ws.getCell(r, i + 2); cell.value = row[col.key] ?? ""; body(cell, { money: true, fill: row[col.key] == null ? GREY : null }); });
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
const g = (title, fill, cols) => ({ title, fill, cols: cols.map(([key, header, width]) => ({ key, header, width })) });

/** The GSTR-2B lines of every month, with the credit notes negative. */
export function build2bRows(list) {
  return list.flatMap((f) => (f.data.rows || []).map((r) => {
    const s = r.type === "cn" ? -1 : 1;
    const tax = { igst: s * (r.igst || 0), cgst: s * (r.cgst || 0), sgst: s * (r.sgst || 0), cess: s * (r.cess || 0) };
    return {
      month: f.period || "", period: f.period ? monthLabel(f.period) : "Month not set", table: SRC[r.src] || "Invoices", doc: DOC[r.type] || "Invoice", gstin: r.gstin || "", party: r.party || "", no: r.inv_no || "", date: r.date || "",
      taxable: r2(s * (r.taxable || 0)), ...tax, itc: total4(tax), value: r2(s * (r.value || 0)), pos: r.pos || "", kind: r.reverse ? "Reverse charge (RCM)" : "Normal supply", rcmFlag: Boolean(r.reverse),
      avail: r.avail || "", reason: r.reason || "", g1: r.period || "", rate: r.pct || "", file: f.name,
    };
  }));
}

export function g2bCombinedSheet(wb, client, fy, rows, name = "1 GSTR-2B Combined") {
  const ws = wb.addWorksheet(name);
  const r0 = title(ws, "GSTR-2B: all months combined", head2(client, fy, ["Credit notes are shown as negative amounts. Return period is the month of the GSTR-2B file."]));
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Return period", key: "period", width: 12 }, { header: "Table", key: "table", width: 18 }, { header: "Document type", key: "doc", width: 13 },
    { header: "Supplier GSTIN", key: "gstin", width: 19 }, { header: "Party name", key: "party", width: 34, wrap: true }, { header: "Invoice / note no", key: "no", width: 16 }, { header: "Invoice / note date", key: "date", width: 13, date: true, align: "center" },
    { header: "Taxable value", key: "taxable", width: 16, money: true }, { header: "IGST", key: "igst", width: 14, money: true }, { header: "CGST", key: "cgst", width: 14, money: true }, { header: "SGST / UTGST", key: "sgst", width: 14, money: true }, { header: "Cess", key: "cess", width: 12, money: true },
    { header: "Total ITC as per 2B", key: "itc", width: 16, money: true }, { header: "Invoice value", key: "value", width: 16, money: true }, { header: "Place of supply", key: "pos", width: 18 },
    { header: "Normal supply or RCM", key: "kind", width: 20 }, { header: "ITC available", key: "avail", width: 11 }, { header: "Reason if not available", key: "reason", width: 28, wrap: true }, { header: "Supplier's GSTR-1 period", key: "g1", width: 13 }, { header: "Source file", key: "file", width: 26, wrap: true },
  ];
  const data = rows.map((x, i) => ({ ...x, sr: i + 1 }));
  const end = table(ws, r0, cols, data, { rowFill: (x) => (x.rcmFlag ? AMBER : x.avail === "No" ? RED : null) });
  const keys = ["taxable", "igst", "cgst", "sgst", "cess", "itc", "value"];
  if (rows.length) totalRow(ws, end, r0 + 1, end - 1, cols, keys, Object.fromEntries(keys.map((k) => [k, sum(rows.map((x) => x[k]))])));
  ws.getCell(r0 - 1, 1).value = "Amber rows: reverse charge. Red rows: ITC not available.";
  ws.getCell(r0 - 1, 1).font = { size: 9, italic: true, color: { argb: "FF6B7280" } };
}

function g2bSheets(wb, client, fy, list) {
  const rows = build2bRows(list);
  g2bCombinedSheet(wb, client, fy, rows);
  const w2 = wb.addWorksheet("2 GSTR-2B Month-wise");
  let r = title(w2, "GSTR-2B month by month", head2(client, fy));
  const f = ["taxable", "igst", "cgst", "sgst", "cess", "itc", "itcRcm", "itcNo"];
  const enriched = rows.map((x) => ({ ...x, itcRcm: x.rcmFlag ? x.itc : 0, itcNo: !x.rcmFlag && x.avail === "No" ? x.itc : 0 }));
  const gm = groupRows(enriched, (x) => x.month, f);
  const lines = orderMonths([...gm.keys()], fy).map((m) => ({ ...round(gm.get(m), f), label: m ? monthLabel(m) : "Month not set", itcOk: r2(gm.get(m).itc - gm.get(m).itcRcm - gm.get(m).itcNo) }));
  const c2 = [
    { header: "Return period", key: "label", width: 14 }, { header: "No. of documents", key: "docs", width: 12 }, { header: "Taxable value", key: "taxable", width: 17, money: true },
    { header: "IGST", key: "igst", width: 15, money: true }, { header: "CGST", key: "cgst", width: 15, money: true }, { header: "SGST / UTGST", key: "sgst", width: 15, money: true }, { header: "Cess", key: "cess", width: 13, money: true },
    { header: "Total tax per 2B", key: "itc", width: 16, money: true }, { header: "of which reverse charge", key: "itcRcm", width: 16, money: true }, { header: "of which ITC not available", key: "itcNo", width: 16, money: true }, { header: "ITC available, normal supply", key: "itcOk", width: 18, money: true },
  ];
  const e2 = table(w2, r, c2, lines, { freeze: false, filter: false });
  if (lines.length) totalRow(w2, e2, r + 1, e2 - 1, c2, ["docs", ...f, "itcOk"], { docs: lines.reduce((a, l) => a + l.docs, 0), ...Object.fromEntries([...f, "itcOk"].map((k) => [k, sum(lines.map((l) => l[k]))])) });
  return rows;
}

/** The 2B ITC of a month that can be claimed as normal supply, by head; credit notes reduce it. */
function itc2bByMonth(rows) {
  const out = new Map();
  for (const x of rows) {
    if (x.rcmFlag || x.avail === "No" || !["B2B invoices", "Credit / debit notes"].includes(x.table)) continue;
    const m = out.get(x.month) || { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    for (const h of HEADS) m[h] += x[h];
    out.set(x.month, m);
  }
  return out;
}

function g3bSheets(wb, client, fy, list) {
  const months = list.map((f) => ({ month: f.period || f.data.period || "", fig: f.data.figures, name: f.name })).sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const label = (m) => (m ? monthLabel(m) : "Month not set");
  const ws = wb.addWorksheet("3 GSTR-3B Combined");
  let r = title(ws, "GSTR-3B: all months combined", head2(client, fy, ["Figures are as read from each month's return."]));
  const heads = (key, p, extra = []) => [["taxable", "Taxable value", 15], ["igst", "IGST", 13], ["cgst", "CGST", 13], ["sgst", "SGST / UTGST", 13], ["cess", "Cess", 11], ...extra].map(([k, h, w]) => [`${p}_${k}`, h, w]);
  const o = (m) => m.fig.outward;
  const t31 = months.map((m) => {
    const row = { label: label(m.month) };
    for (const k of ["a", "b", "c", "d", "e"]) for (const f of ["taxable", "igst", "cgst", "sgst", "cess"]) row[`${k}_${f}`] = o(m)[k][f];
    return row;
  });
  ws.getCell(r, 1).value = "Table 3.1: outward supplies and inward supplies liable to reverse charge"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  r = groupedTable(ws, r, [
    g("(a) Outward taxable supplies", "FF1F497D", heads("a", "a")), g("(b) Zero rated", "FF0F766E", heads("b", "b")), g("(c) Nil rated, exempted", "FF6B7280", heads("c", "c")),
    g("(d) Inward supplies liable to reverse charge", "FF9A3412", heads("d", "d")), g("(e) Non-GST outward", "FF374151", heads("e", "e")),
  ], t31) + 2;

  const sumH = (m, keys, h) => r2(keys.reduce((a, k) => a + (m.fig.itc[k]?.[h] || 0), 0));
  const t4 = months.map((m) => {
    const row = { label: label(m.month) };
    for (const h of HEADS) {
      row[`o_${h}`] = sumH(m, ["other"], h); row[`r_${h}`] = sumH(m, ["rcm"], h); row[`i_${h}`] = sumH(m, ["import_goods", "import_services"], h);
      row[`v_${h}`] = sumH(m, ["reversed_rules", "reversed_others"], h); row[`n_${h}`] = sumH(m, ["ineligible_17_5", "ineligible_others"], h);
    }
    return row;
  });
  ws.getCell(r, 1).value = "Table 4: input tax credit"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  const four = (p) => HEADS.map((h) => [`${p}_${h}`, h === "sgst" ? "SGST / UTGST" : h.toUpperCase().replace("CESS", "Cess"), 13]);
  r = groupedTable(ws, r, [
    g("4A(5) All other ITC", "FF1F497D", four("o")), g("4A(3) Inward supplies liable to RCM", "FF9A3412", four("r")), g("4A(1)-(2) Import of goods and services", "FF0F766E", four("i")),
    g("4B ITC reversed", "FF6B7280", four("v")), g("4D Ineligible ITC", "FF7F1D1D", four("n")),
  ], t4) + 2;

  const t6 = months.map((m) => ({ label: label(m.month), igst: m.fig.tax_paid.igst, cgst: m.fig.tax_paid.cgst, sgst: m.fig.tax_paid.sgst, cess: m.fig.tax_paid.cess }));
  ws.getCell(r, 1).value = "Table 6.1: tax paid in cash"; ws.getCell(r, 1).font = { name: "Calibri", size: 12, bold: true }; r++;
  groupedTable(ws, r, [g("Tax paid in cash", "FF166534", [["igst", "IGST", 13], ["cgst", "CGST", 13], ["sgst", "SGST / UTGST", 13], ["cess", "Cess", 11]])], t6);
  ws.views = [{ state: "frozen", xSplit: 1 }];
  return months;
}

function compareSheet(wb, client, fy, rows2b, m3b) {
  const ws = wb.addWorksheet("4 ITC as per 2B and 3B");
  const r0 = title(ws, "ITC available as per GSTR-2B against ITC claimed in GSTR-3B", head2(client, fy, [
    "2B side: B2B invoices and credit / debit notes marked ITC available, normal supply (reverse charge and ineligible items are left out; credit notes reduce it).",
    "3B side: Table 4A(5), all other ITC. Difference = 2B less 3B.",
  ]));
  const by2b = itc2bByMonth(rows2b);
  const by3b = new Map(m3b.map((m) => [m.month, m.fig.itc.other]));
  const months = monthsOfFy(fy);
  const extra = [...new Set([...by2b.keys(), ...by3b.keys()])].filter((m) => m && !months.includes(m)).sort();
  const lines = [...months, ...extra].map((m) => {
    const a = by2b.get(m), b = by3b.get(m);
    const row = { label: monthLabel(m) };
    for (const h of HEADS) { row[`a_${h}`] = a ? r2(a[h]) : null; row[`b_${h}`] = b ? r2(b[h] || 0) : null; row[`d_${h}`] = a && b ? r2(a[h] - (b[h] || 0)) : null; }
    row.a_t = a ? total4(a) : null; row.b_t = b ? total4(b) : null; row.d_t = a && b ? r2(row.a_t - row.b_t) : null;
    row.remark = !a && !b ? "Neither GSTR-2B nor GSTR-3B uploaded" : !a ? "GSTR-2B not uploaded" : !b ? "GSTR-3B not uploaded" : Math.abs(row.d_t) < 1 ? "Agrees" : row.d_t > 0 ? `ITC per 2B is more than claimed in 3B by Rs ${row.d_t}: may be claimed in a later month` : `ITC claimed in 3B is more than 2B by Rs ${-row.d_t}: check the eligibility (rule 36(4)) and the supplier's filing`;
    row.flag = row.d_t != null && Math.abs(row.d_t) >= 1;
    return row;
  });
  const hd = (p) => HEADS.map((h) => ({ key: `${p}_${h}`, header: h === "sgst" ? "SGST / UTGST" : h.toUpperCase().replace("CESS", "Cess"), money: true, width: 13 }));
  const cols = [{ header: "Month", key: "label", width: 11 }, ...hd("a"), { key: "a_t", header: "Total", money: true, width: 14 }, ...hd("b"), { key: "b_t", header: "Total", money: true, width: 14 }, ...hd("d"), { key: "d_t", header: "Total", money: true, width: 14 }, { key: "remark", header: "Remark", width: 60, wrap: true }];
  // two header rows: the group names above the column names
  const groups = [[2, 6, "ITC as per GSTR-2B", "FF1F497D"], [7, 11, "ITC claimed in GSTR-3B (4A(5))", "FF166534"], [12, 16, "Difference (2B less 3B)", "FF9A3412"]];
  ws.mergeCells(r0, 1, r0 + 1, 1); ws.getCell(r0, 1).value = "Month"; head(ws.getCell(r0, 1)); head(ws.getCell(r0 + 1, 1));
  for (const [a, b, text, fill] of groups) { ws.mergeCells(r0, a, r0, b); ws.getCell(r0, a).value = text; for (let c = a; c <= b; c++) head(ws.getCell(r0, c), fill); }
  cols.slice(1).forEach((c, i) => { const cell = ws.getCell(r0 + 1, i + 2); cell.value = c.header; head(cell, i < 5 ? groups[0][3] : i < 10 ? groups[1][3] : i < 15 ? groups[2][3] : "FF374151"); ws.getColumn(i + 2).width = c.width; });
  ws.mergeCells(r0, 17, r0 + 1, 17); ws.getCell(r0, 17).value = "Remark"; head(ws.getCell(r0, 17));
  ws.getColumn(1).width = 11;
  let r = r0 + 2;
  const first = r;
  for (const l of lines) {
    ws.getCell(r, 1).value = l.label; body(ws.getCell(r, 1), { bold: true });
    cols.slice(1, 16).forEach((c, i) => { const cell = ws.getCell(r, i + 2); cell.value = l[c.key] ?? ""; body(cell, { money: true, fill: l[c.key] == null ? GREY : l.flag && c.key.startsWith("d_") ? AMBER : null }); });
    ws.getCell(r, 17).value = l.remark; body(ws.getCell(r, 17), { wrap: true, fill: l.flag ? AMBER : null });
    r++;
  }
  ws.getCell(r, 1).value = "Total"; body(ws.getCell(r, 1), { bold: true, fill: GREY });
  cols.slice(1, 16).forEach((c, i) => {
    const cell = ws.getCell(r, i + 2);
    const letter = ws.getColumn(i + 2).letter;
    cell.value = { formula: `SUM(${letter}${first}:${letter}${r - 1})`, result: sum(lines.map((l) => l[c.key])) };
    body(cell, { money: true, bold: true, fill: GREY });
  });
  body(ws.getCell(r, 17), { fill: GREY });
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: r0 + 1 }];
}

export async function portalWorkbook({ client, fy, files }) {
  const wb = book();
  const g2b = files.filter((f) => f.kind === "gstr2b" && f.data);
  const g3b = files.filter((f) => f.kind === "gstr3b" && f.data);
  const rows2b = g2b.length ? g2bSheets(wb, client, fy, g2b) : [];
  const m3b = g3b.length ? g3bSheets(wb, client, fy, g3b) : [];
  if (g2b.length || g3b.length) compareSheet(wb, client, fy, rows2b, m3b);

  const notes = [["Files combined", true]];
  for (const f of files) notes.push([`${f.kind === "gstr2b" ? "GSTR-2B" : "GSTR-3B"} ${f.period ? monthLabel(f.period) : "(month not set)"}, ${f.name}: ${f.data ? `${f.info.rows} line(s) read` : "could not be read and is not included"}${f.info.warnings?.length ? `. ${f.info.warnings.join(" ")}` : ""}`]);
  notes.push(["", false], ["How to read the sheets", true]);
  notes.push(["Sheet 1 puts every GSTR-2B invoice and note of every month in one list. Sheet 2 totals it by return period. Sheet 3 puts the GSTR-3B of every month side by side: Table 3.1, Table 4 and the tax paid in cash. Sheet 4 compares the ITC available in 2B with the ITC claimed in 3B."]);
  notes.push(["Normal supply or RCM in GSTR-2B follows the portal's own 'attracts reverse charge' marking. Credit notes are shown as negative amounts."]);
  if (!g2b.length) notes.push(["No GSTR-2B file could be read, so the 2B sheets are not in this workbook."]);
  if (!g3b.length) notes.push(["No GSTR-3B file could be read, so the 3B sheet is not in this workbook."]);
  const unset = g2b.concat(g3b).filter((f) => !f.period).length;
  if (unset) notes.push([`${unset} file(s) have no month set. Choose the month on the list so they fall in the right period.`]);
  notesSheet(wb, client, fy, notes);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

