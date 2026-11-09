import ExcelJS from "exceljs";
import { monthLabel } from "./readers.js";

const border = { style: "thin", color: { argb: "FFD9D9D9" } };
const borders = { left: border, right: border, top: border, bottom: border };
const money = "#,##0.00";
const FILL = { head: "FF1F497D", sub: "FFDCE6F1", total: "FFF2F2F2", warn: "FFFFF8E1", bad: "FFFDECEA", good: "FFE8F5E9" };
const font = (o = {}) => ({ name: "Calibri", size: 10, ...o });
const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const tax = (o) => (o ? (o.igst || 0) + (o.cgst || 0) + (o.sgst || 0) + (o.cess || 0) : 0);

function headCell(c, argb = FILL.head, color = "FFFFFFFF") {
  c.font = font({ bold: true, color: { argb: color } });
  c.fill = solid(argb);
  c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  c.border = borders;
}
function put(ws, r, c, v, o = {}) {
  const x = ws.getCell(r, c);
  x.value = v ?? "";
  x.font = font({ bold: o.bold, italic: o.italic, size: o.size, color: o.color ? { argb: o.color } : undefined });
  x.border = o.noBorder ? undefined : borders;
  if (typeof v === "number" && o.num !== false) { x.numFmt = o.fmt || money; x.alignment = { horizontal: "right", vertical: "top" }; }
  else x.alignment = { vertical: "top", wrapText: o.wrap !== false };
  if (o.fill) x.fill = solid(o.fill);
  return x;
}
const title = (ws, text, sub) => {
  ws.getCell(1, 1).value = text; ws.getCell(1, 1).font = font({ bold: true, size: 13 });
  if (sub) { ws.getCell(2, 1).value = sub; ws.getCell(2, 1).font = font({ italic: true, color: { argb: "FF595959" } }); }
};
const widths = (ws, w) => w.forEach((x, i) => { ws.getColumn(i + 1).width = x; });
const meta = (clientName, clientGstin, fy) => `${clientName}${clientGstin ? ` (${clientGstin})` : ""} - financial year ${fy}`;

// ------------------------------------------------------------------ sheet 1 / combined books
function booksSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Books of account - all uploaded sales registers and GST ledgers, combined", meta(clientName, clientGstin, fy));
  const cols = [["Source file", 26], ["Kind", 10], ["Sheet / ledger", 22], ["Ledger head", 10], ["Date", 11], ["Month", 9], ["Party / particulars", 30], ["GSTIN", 18], ["Invoice / voucher no.", 18], ["Taxable value", 15], ["IGST", 13], ["CGST", 13], ["SGST", 13], ["Cess", 11], ["Invoice value", 15], ["Debit", 14], ["Credit", 14]];
  widths(ws, cols.map((c) => c[1]));
  cols.forEach(([h], i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  ws.getRow(4).height = 30;
  const all = [...x.regRows, ...x.ledRows].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const fmt = (d) => (d ? String(d).split("-").reverse().join("-") : "");
  all.forEach((r, i) => {
    const sg = r.kind === "register" ? r.sign : 1;
    const vals = [r.file, r.kind === "register" ? "Register" : "Ledger", r.sheet, r.head ? r.head.toUpperCase() : "", fmt(r.date), r.month ? monthLabel(r.month) : "", r.party, r.gstin, r.inv_no,
      r.kind === "register" ? r.taxable * sg : "", r.kind === "register" ? r.igst * sg : "", r.kind === "register" ? r.cgst * sg : "", r.kind === "register" ? r.sgst * sg : "", r.kind === "register" ? r.cess * sg : "", r.kind === "register" ? r.value * sg : "", r.debit || "", r.credit || ""];
    vals.forEach((v, j) => put(ws, 5 + i, j + 1, v, { wrap: j === 6 }));
  });
  if (!all.length) put(ws, 5, 1, "Nothing uploaded yet.", { noBorder: true });
  else {
    const at = 5 + all.length;
    put(ws, at, 1, "Total", { bold: true, fill: FILL.total });
    const sums = Array(8).fill(0);
    for (const r of all) {
      const sg = r.kind === "register" ? r.sign : 1;
      if (r.kind === "register") [r.taxable * sg, r.igst * sg, r.cgst * sg, r.sgst * sg, r.cess * sg, r.value * sg].forEach((v, k) => { sums[k] += v; });
      sums[6] += r.debit || 0; sums[7] += r.credit || 0;
    }
    sums.forEach((v, k) => put(ws, at, 10 + k, r2(v), { bold: true, fill: FILL.total }));
  }
  ws.views = [{ state: "frozen", ySplit: 4, xSplit: 0 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return ws;
}

// ------------------------------------------------------------------ sheet 2 / combined GSTR-1
const SEC_NAME = { b2b: "B2B", b2cl: "B2CL", b2cs: "B2CS", cdnr: "CDNR", cdnur: "CDNUR", exp: "EXP", at: "AT", atadj: "ATADJ", exemp: "EXEMP" };
const SUPPLY_BASE = {
  regular: "Regular supply", regular_igst: "Regular supply", b2c: "Regular supply", sez_pay: "SEZ supply with payment of tax", sez_nopay: "SEZ supply without payment of tax (zero rated)",
  deemed: "Deemed export", export_pay: "Export with payment of tax (zero rated)", export_nopay: "Export without payment of tax (zero rated)", rcm: "Reverse charge - tax paid by the recipient",
};
/** What kind of supply a GSTR-1 line is: regular, exempted, nil rated, zero rated, advance, credit note and so on. */
export function supplyType(r) {
  if (r.cls === "advance") return r.sign < 0 ? "Advance adjusted" : "Advance received";
  const base = SUPPLY_BASE[r.cls] || r.cls;
  if (r.sec === "cdnr" || r.sec === "cdnur") return `${r.sign < 0 ? "Credit" : "Debit"} note - ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  return base;
}
const TAXABLE_TYPES = (r) => r.sec !== "exemp";

function gstr1Sheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "GSTR-1 - all months, all sections, combined", `${meta(clientName, clientGstin, fy)}. The supply type column says whether a line is regular, nil rated, exempted, zero rated and so on.`);
  const cols = [["Month", 9], ["Section", 9], ["Supply type", 36], ["GSTIN", 18], ["Party / description", 30], ["Invoice / note no.", 18], ["Date", 11], ["Note type", 9], ["Invoice type", 18], ["Place of supply", 16], ["Rate %", 8], ["Taxable value", 15], ["IGST", 13], ["CGST", 13], ["SGST", 13], ["Cess", 11], ["Invoice value", 15], ["Effect", 8], ["Source file", 26]];
  widths(ws, cols.map((c) => c[1]));
  cols.forEach(([h], i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  ws.getRow(4).height = 30;
  const fmt = (d) => (d ? String(d).split("-").reverse().join("-") : "");

  // the invoice lines and the nil rated / exempted / non-GST lines of Table 8, in one list
  const lines = x.g1Rows.map((r) => ({ ...r, supply: supplyType(r) }));
  for (const e of x.exemp) {
    for (const [k, label] of [["nil", "Nil rated supply"], ["exempt", "Exempted supply"], ["non_gst", "Non-GST supply"]]) {
      if (!e[k]) continue;
      lines.push({ month: e.month, sec: "exemp", cls: k, supply: label, gstin: "", party: e.desc, inv_no: "", date: null, note_type: "", inv_type: "", pos: "", rate: "", taxable: e[k], igst: 0, cgst: 0, sgst: 0, cess: 0, value: 0, sign: 1, file: e.file || "" });
    }
  }
  const order = ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp", "at", "atadj", "exemp"];
  lines.sort((a, b) => (a.month || "9999").localeCompare(b.month || "9999") || order.indexOf(a.sec) - order.indexOf(b.sec));
  lines.forEach((r, i) => {
    const shade = r.sec === "exemp" ? FILL.warn : undefined;
    [monthLabel(r.month), SEC_NAME[r.sec] || r.sec, r.supply, r.gstin, r.party, r.inv_no, fmt(r.date), r.note_type, r.inv_type, r.pos, r.rate, r.taxable, r.igst, r.cgst, r.sgst, r.cess, r.value || "", r.sign < 0 ? "Less" : "Add", r.file]
      .forEach((v, j) => put(ws, 5 + i, j + 1, v, { wrap: j === 4 || j === 2, fmt: j === 10 ? "0.00" : undefined, fill: j === 2 ? shade : undefined }));
  });
  let at = 5 + lines.length;
  if (!lines.length) { put(ws, 5, 1, "Nothing uploaded yet.", { noBorder: true }); return ws; }
  const sumOf = (list) => list.reduce((o, r) => { for (const k of ["taxable", "igst", "cgst", "sgst", "cess"]) o[k] += r.sign * r[k]; return o; }, { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
  const totals = [["Total taxable supplies (credit notes and adjusted advances deducted)", sumOf(lines.filter(TAXABLE_TYPES))], ["Nil rated, exempted and non-GST supplies (value only)", sumOf(lines.filter((r) => !TAXABLE_TYPES(r)))]];
  for (const [label, t] of totals) {
    put(ws, at, 1, label, { bold: true, fill: FILL.total, wrap: false });
    for (let c = 2; c <= 11; c++) put(ws, at, c, "", { fill: FILL.total });
    [t.taxable, t.igst, t.cgst, t.sgst, t.cess].forEach((v, k) => put(ws, at, 12 + k, r2(v), { bold: true, fill: FILL.total }));
    at++;
  }
  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return ws;
}

// ------------------------------------------------------------------ sheet 3 / combined GSTR-3B
function gstr3bSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "GSTR-3B - Table 3.1, all months, combined", meta(clientName, clientGstin, fy));
  const groups = [["3.1(a) Outward taxable supplies (other than zero rated, nil rated, exempted)", "a"], ["3.1(b) Outward taxable supplies (zero rated)", "b"], ["3.1(c) Other outward supplies (nil rated, exempted)", "c"], ["3.1(d) Inward supplies liable to reverse charge", "d"], ["3.1(e) Non-GST outward supplies", "e"]];
  widths(ws, [10, 12, ...groups.flatMap(() => [14, 12, 12, 12, 10])]);
  put(ws, 4, 1, "Month", { bold: true, fill: FILL.head, color: "FFFFFFFF" }); headCell(ws.getCell(4, 1)); ws.mergeCells(4, 1, 5, 1);
  put(ws, 4, 2, "Return filed", { bold: true }); headCell(ws.getCell(4, 2)); ws.mergeCells(4, 2, 5, 2);
  groups.forEach(([label], g) => {
    const c0 = 3 + g * 5;
    const c = ws.getCell(4, c0); c.value = label; headCell(c); ws.mergeCells(4, c0, 4, c0 + 4);
    ["Taxable value", "IGST", "CGST", "SGST", "Cess"].forEach((h, k) => { const q = ws.getCell(5, c0 + k); q.value = h; headCell(q, FILL.sub, "FF000000"); });
  });
  ws.getRow(4).height = 42;
  const tot = groups.map(() => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }));
  x.months.forEach((m, i) => {
    const r = 6 + i;
    put(ws, r, 1, monthLabel(m));
    put(ws, r, 2, x.b3[m].hasFile ? "Yes" : "No", { fill: x.b3[m].hasFile ? undefined : FILL.warn });
    groups.forEach(([, key], g) => {
      ["taxable", "igst", "cgst", "sgst", "cess"].forEach((k, j) => { const v = x.b3[m][key][k] || 0; put(ws, r, 3 + g * 5 + j, v); tot[g][k] += v; });
    });
  });
  const tr = 6 + x.months.length;
  put(ws, tr, 1, "Total", { bold: true, fill: FILL.total }); put(ws, tr, 2, "", { fill: FILL.total });
  groups.forEach((_, g) => ["taxable", "igst", "cgst", "sgst", "cess"].forEach((k, j) => put(ws, tr, 3 + g * 5 + j, r2(tot[g][k]), { bold: true, fill: FILL.total })));
  put(ws, tr + 2, 1, "The figures are read from the PDF or Excel of each month. Check them against the return where a month shows nil.", { noBorder: true, italic: true });
  ws.views = [{ state: "frozen", ySplit: 5, xSplit: 2 }];
  return ws;
}

// ------------------------------------------------------------------ sheet 4 / month-wise comparison
function comparisonSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Month-wise comparison: GSTR-1 against GSTR-3B, GSTR-1 against books, GSTR-3B against books", `${meta(clientName, clientGstin, fy)}. Difference = first less second. GSTR-1 and GSTR-3B include zero-rated supplies; credit notes are deducted.`);
  widths(ws, [12, ...Array(12).fill(14), 30]);
  let r = 4;
  const SETS = [["g1_vs_3b", "A. GSTR-1 against GSTR-3B", "GSTR-1", "GSTR-3B"], ["g1_vs_books", "B. GSTR-1 against books", "GSTR-1", "Books"], ["b3_vs_books", "C. GSTR-3B against books", "GSTR-3B", "Books"]];
  for (const [key, label, la, lb] of SETS) {
    put(ws, r, 1, label, { bold: true, size: 11, noBorder: true });
    r++;
    put(ws, r, 1, "Month"); headCell(ws.getCell(r, 1)); ws.mergeCells(r, 1, r + 1, 1);
    [[la, 2], [lb, 6], ["Difference", 10]].forEach(([t, c0]) => { const c = ws.getCell(r, c0); c.value = t; headCell(c); ws.mergeCells(r, c0, r, c0 + 3); });
    put(ws, r, 14, "Remark"); headCell(ws.getCell(r, 14)); ws.mergeCells(r, 14, r + 1, 14);
    r++;
    for (let g = 0; g < 3; g++) ["Taxable value", "IGST", "CGST", "SGST"].forEach((h, k) => { const c = ws.getCell(r, 2 + g * 4 + k); c.value = h; headCell(c, FILL.sub, "FF000000"); });
    const set = x.compare[key];
    for (const row of [...set.rows, set.total]) {
      r++;
      const isT = row.month === "total";
      const fill = isT ? FILL.total : undefined;
      put(ws, r, 1, row.label, { bold: isT, fill });
      ["a", "b", "d"].forEach((k, g) => ["taxable", "igst", "cgst", "sgst"].forEach((h, j) => {
        const bad = k === "d" && Math.abs(row.d[h]) > 1;
        put(ws, r, 2 + g * 4 + j, row[k][h], { bold: isT || bad, fill: bad && !isT ? FILL.bad : fill });
      }));
      const missing = !isT ? [!row.hasA ? `${la} missing` : "", !row.hasB ? `${lb} missing` : ""].filter(Boolean).join(", ") : "";
      put(ws, r, 14, missing, { fill: missing ? FILL.warn : fill, italic: true });
    }
    r += 3;
  }
  ws.views = [{ state: "frozen", ySplit: 3, xSplit: 1 }];
  return ws;
}

// ------------------------------------------------------------------ sheet 5 / party-wise
function partySheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Party and GSTIN-wise comparison: books against GSTR-1", `${meta(clientName, clientGstin, fy)}. Credit notes are deducted. Sales to parties without a GSTIN are grouped as B2C. Difference = books less GSTR-1.`);
  widths(ws, [32, 18, 14, ...Array(12).fill(14), 14]);
  const heads = [["Party", 1, 1], ["GSTIN", 2, 1], ["Party type", 3, 1]];
  heads.forEach(([h, c]) => { const q = ws.getCell(4, c); q.value = h; headCell(q); ws.mergeCells(4, c, 5, c); });
  [["Books", 4], ["GSTR-1", 8], ["Difference", 12]].forEach(([t, c0]) => { const c = ws.getCell(4, c0); c.value = t; headCell(c); ws.mergeCells(4, c0, 4, c0 + 3); });
  const sc = ws.getCell(4, 16); sc.value = "Status"; headCell(sc); ws.mergeCells(4, 16, 5, 16);
  for (let g = 0; g < 3; g++) ["Taxable value", "IGST", "CGST", "SGST"].forEach((h, k) => { const c = ws.getCell(5, 4 + g * 4 + k); c.value = h; headCell(c, FILL.sub, "FF000000"); });
  const label = { matched: "Matches", books_only: "Books only", gstr1_only: "GSTR-1 only", different: "Differs" };
  const fills = { matched: FILL.good, books_only: FILL.bad, gstr1_only: FILL.warn, different: FILL.bad };
  const tot = { b: [0, 0, 0, 0], g: [0, 0, 0, 0] };
  x.parties.forEach((p, i) => {
    const r = 6 + i;
    put(ws, r, 1, p.party || "(no name)"); put(ws, r, 2, p.gstin); put(ws, r, 3, p.type || "");
    ["taxable", "igst", "cgst", "sgst"].forEach((h, j) => { put(ws, r, 4 + j, p.books[h]); put(ws, r, 8 + j, p.g1[h]); put(ws, r, 12 + j, p.d[h], { bold: Math.abs(p.d[h]) > 1 }); tot.b[j] += p.books[h]; tot.g[j] += p.g1[h]; });
    put(ws, r, 16, label[p.status], { fill: fills[p.status] });
  });
  const tr = 6 + x.parties.length;
  put(ws, tr, 1, "Total", { bold: true, fill: FILL.total }); put(ws, tr, 2, "", { fill: FILL.total }); put(ws, tr, 3, "", { fill: FILL.total });
  for (let j = 0; j < 4; j++) { put(ws, tr, 4 + j, r2(tot.b[j]), { bold: true, fill: FILL.total }); put(ws, tr, 8 + j, r2(tot.g[j]), { bold: true, fill: FILL.total }); put(ws, tr, 12 + j, r2(tot.b[j] - tot.g[j]), { bold: true, fill: FILL.total }); }
  put(ws, tr, 16, "", { fill: FILL.total });
  ws.views = [{ state: "frozen", ySplit: 5, xSplit: 1 }];
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: 16 } };
  return ws;
}

// ------------------------------------------------------------------ sheet 6 / classification
function classificationSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Classification of turnover and GST liability", `${meta(clientName, clientGstin, fy)}. Source: GSTR-1 (sections and invoice types), GSTR-3B for reverse charge on inward supplies, books for capital assets.`);
  widths(ws, [64, 16, 14, 14, 14, 12, 14, 10, 34]);
  let r = 4;
  ["Classification", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Total tax", "Docs", "Basis"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; headCell(c); });
  const line = (o, basis, opts = {}) => {
    r++;
    put(ws, r, 1, o.name, { bold: opts.bold, fill: opts.fill });
    [o.taxable, o.igst, o.cgst, o.sgst, o.cess].forEach((v, i) => put(ws, r, 2 + i, r2(v), { bold: opts.bold, fill: opts.fill }));
    put(ws, r, 7, r2(tax(o)), { bold: opts.bold, fill: opts.fill });
    put(ws, r, 8, o.docs ?? "", { fill: opts.fill, fmt: "0" });
    put(ws, r, 9, basis || "", { fill: opts.fill, italic: true });
  };
  const sum = (name_, list) => { const o = { name: name_, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, docs: 0 }; for (const k of list) for (const f of ["taxable", "igst", "cgst", "sgst", "cess", "docs"]) o[f] += x.C[k][f]; return o; };
  const C = x.C;
  const sect = (t) => { r++; put(ws, r, 1, t, { bold: true, fill: FILL.sub }); for (let c = 2; c <= 9; c++) put(ws, r, c, "", { fill: FILL.sub }); };

  sect("A. Supplies to registered persons (B2B)");
  line(C.regular, "GSTR-1 b2b, invoice type Regular"); line(C.composition, "Parties marked composition in the party classification"); line(C.sez_pay, "b2b, SEZ supplies with payment"); line(C.sez_nopay, "b2b, SEZ supplies without payment");
  line(C.deemed, "b2b, deemed exports"); line(C.other_reg, "Parties marked EOU / other in the party classification");
  const b2b = sum("Total B2B", ["regular", "composition", "sez_pay", "sez_nopay", "deemed", "other_reg"]); line(b2b, "", { bold: true, fill: FILL.total });
  sect("B. Supplies to unregistered persons (B2C)");
  line(C.b2cl, "GSTR-1 b2cl"); line(C.b2cs, "GSTR-1 b2cs");
  const b2c = sum("Total B2C", ["b2cl", "b2cs"]); line(b2c, "", { bold: true, fill: FILL.total });
  sect("C. Exports");
  line(C.export_pay, "GSTR-1 exp, with payment"); line(C.export_nopay, "GSTR-1 exp, without payment (LUT / bond)");
  sect("D. Notes and advances");
  line(C.cn, "GSTR-1 cdnr and cdnur, credit notes (negative)"); line(C.dn, "GSTR-1 cdnr and cdnur, debit notes"); line(C.advance, "GSTR-1 at less atadj");
  const liab = sum("Total outward taxable turnover and liability (A + B + C + D)", ["regular", "composition", "sez_pay", "sez_nopay", "deemed", "other_reg", "b2cl", "b2cs", "export_pay", "export_nopay", "cn", "dn", "advance"]);
  line(liab, "Compare with GSTR-3B 3.1(a) and (b)", { bold: true, fill: FILL.good });
  sect("E. Reverse charge");
  line(C.rcm, "GSTR-1 table 4B: the recipient pays the tax");
  line({ name: "Inward supplies liable to reverse charge (tax paid by the client)", ...x.inwardRcm, docs: "" }, "GSTR-3B 3.1(d), all months");
  sect("F. Nil rated, exempted and non-GST supplies (taxable value only)");
  line({ name: "Nil rated supplies", taxable: x.exemptTotals.nil, igst: 0, cgst: 0, sgst: 0, cess: 0, docs: "" }, "GSTR-1 Table 8");
  line({ name: "Exempted supplies", taxable: x.exemptTotals.exempt, igst: 0, cgst: 0, sgst: 0, cess: 0, docs: "" }, "GSTR-1 Table 8");
  line({ name: "Non-GST supplies", taxable: x.exemptTotals.non_gst, igst: 0, cgst: 0, sgst: 0, cess: 0, docs: "" }, "GSTR-1 Table 8");
  line({ name: "Total outward turnover, taxable and non-taxable, excluding reverse charge on outward supplies", taxable: liab.taxable + x.exemptTotals.nil + x.exemptTotals.exempt + x.exemptTotals.non_gst, igst: liab.igst, cgst: liab.cgst, sgst: liab.sgst, cess: liab.cess, docs: "" }, "", { bold: true, fill: FILL.total });
  r += 2;

  put(ws, r, 1, "G. Sale of capital assets (identified from the books by the description)", { bold: true, size: 11, noBorder: true });
  r++;
  ["Party and description", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Date", "", "In GSTR-1"].forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; headCell(c); });
  const capTot = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  for (const c of x.capital) {
    r++;
    put(ws, r, 1, `${c.party || ""} ${c.inv_no ? `(${c.inv_no})` : ""} ${c.text && c.text !== c.party ? "- " + c.text : ""}`.trim());
    [c.taxable, c.igst, c.cgst, c.sgst, c.cess].forEach((v, i) => { put(ws, r, 2 + i, r2(v)); capTot[["taxable", "igst", "cgst", "sgst", "cess"][i]] += v; });
    put(ws, r, 7, c.date ? String(c.date).split("-").reverse().join("-") : ""); put(ws, r, 8, "");
    put(ws, r, 9, c.g1_month ? `Yes, ${monthLabel(c.g1_month)} (${(c.g1_section || "").toUpperCase()})` : c.source === "register" ? "Not found by invoice number" : "Ledger entry", { fill: c.g1_month ? FILL.good : FILL.warn });
  }
  if (!x.capital.length) { r++; put(ws, r, 1, "No sale of a capital asset was identified. A sale is picked up when the description, party or ledger name says fixed asset, machinery, vehicle and so on.", { italic: true, noBorder: true }); }
  else { r++; put(ws, r, 1, "Total sale of capital assets", { bold: true, fill: FILL.total }); Object.values(capTot).forEach((v, i) => put(ws, r, 2 + i, r2(v), { bold: true, fill: FILL.total })); }
  r += 3;

  put(ws, r, 1, "H. Month-wise taxable value by class", { bold: true, size: 11, noBorder: true });
  r++;
  const cols = [["regular", "B2B regular"], ["composition", "Composition"], ["sez_pay", "SEZ with pay"], ["sez_nopay", "SEZ without pay"], ["deemed", "Deemed"], ["other_reg", "Other reg."], ["b2cl", "B2CL"], ["b2cs", "B2CS"], ["export_pay", "Export with pay"], ["export_nopay", "Export w/o pay"], ["cn", "Credit notes"], ["dn", "Debit notes"], ["advance", "Advances net"], ["rcm", "RCM outward"]];
  put(ws, r, 1, "Month"); headCell(ws.getCell(r, 1));
  cols.forEach(([, h], i) => { const c = ws.getCell(r, 2 + i); c.value = h; headCell(c); });
  const tc = ws.getCell(r, 2 + cols.length); tc.value = "Total (excl. RCM outward)"; headCell(tc);
  ws.getRow(r).height = 30;
  for (let i = 0; i < cols.length + 1; i++) if (!ws.getColumn(2 + i).width || ws.getColumn(2 + i).width < 14) ws.getColumn(2 + i).width = 14;
  const colTot = Array(cols.length).fill(0);
  for (const m of x.months) {
    r++;
    put(ws, r, 1, monthLabel(m));
    let rowTot = 0;
    cols.forEach(([k], i) => { const v = x.monthCls[m][k].taxable; put(ws, r, 2 + i, r2(v)); colTot[i] += v; if (k !== "rcm") rowTot += v; });
    put(ws, r, 2 + cols.length, r2(rowTot), { bold: true });
  }
  r++;
  put(ws, r, 1, "Total", { bold: true, fill: FILL.total });
  colTot.forEach((v, i) => put(ws, r, 2 + i, r2(v), { bold: true, fill: FILL.total }));
  put(ws, r, 2 + cols.length, r2(colTot.reduce((a, v, i) => a + (cols[i][0] === "rcm" ? 0 : v), 0)), { bold: true, fill: FILL.total });
  ws.views = [{ state: "frozen", ySplit: 4 }];
  return ws;
}

// ------------------------------------------------------------------ sheet 7 / HSN
function hsnSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "HSN-wise summary of outward supplies", `${meta(clientName, clientGstin, fy)}. Added from the HSN sheet of each month's GSTR-1. Used for GSTR-9 Tables 17 and 18.`);
  const cols = [["HSN / SAC", 14], ["Description", 36], ["UQC", 10], ["Rate %", 8], ["Total quantity", 14], ["Total value", 16], ["Taxable value", 16], ["IGST", 14], ["CGST", 14], ["SGST", 14], ["Cess", 12], ["Months", 9]];
  widths(ws, cols.map((c) => c[1]));
  cols.forEach(([h], i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  const tot = { value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  x.hsnRows.forEach((h, i) => {
    [h.hsn, h.desc, h.uqc, h.rate || "", h.qty, h.value, h.taxable, h.igst, h.cgst, h.sgst, h.cess, h.months].forEach((v, j) => put(ws, 5 + i, j + 1, v, { fmt: j === 11 ? "0" : j === 3 ? "0.##" : undefined }));
    for (const k of Object.keys(tot)) tot[k] += h[k];
  });
  let r = 5 + x.hsnRows.length;
  if (!x.hsnRows.length) { put(ws, 5, 1, "No HSN sheet was found in the GSTR-1 files uploaded.", { italic: true, noBorder: true }); r = 7; }
  else {
    put(ws, r, 1, "Total", { bold: true, fill: FILL.total }); put(ws, r, 2, "", { fill: FILL.total }); put(ws, r, 3, "", { fill: FILL.total }); put(ws, r, 4, "", { fill: FILL.total }); put(ws, r, 5, "", { fill: FILL.total });
    ["value", "taxable", "igst", "cgst", "sgst", "cess"].forEach((k, i) => put(ws, r, 6 + i, r2(tot[k]), { bold: true, fill: FILL.total }));
    r += 2;
    const gl = Object.values(x.g1Monthly).reduce((a, v) => a + v.taxable, 0);
    put(ws, r, 1, "Taxable value as per the invoice sections of GSTR-1", { noBorder: true }); put(ws, r, 7, r2(gl), { noBorder: true });
    put(ws, r + 1, 1, "Difference (HSN summary less invoice sections)", { bold: true, noBorder: true }); put(ws, r + 1, 7, r2(tot.taxable - gl), { bold: true, noBorder: true });
  }
  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return ws;
}

// ------------------------------------------------------------------ sheet 8 / rate-wise
function rateSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Rate-wise summary of outward supplies with classification", `${meta(clientName, clientGstin, fy)}. Regular supply, capital goods (sales identified from the books), SEZ / export / deemed, credit and debit notes (net) and advances (net). For GSTR-9C Table 7.`);
  const classes = [["regular", "Regular supply"], ["capital", "Capital goods"], ["special", "SEZ, export and deemed export"], ["notes", "Credit and debit notes (net)"], ["advance", "Advances (net)"]];
  widths(ws, [10, ...classes.flatMap(() => [15, 13]), 15, 13, 13, 13, 11, 15, 15, 14]);
  put(ws, 4, 1, "Rate %"); headCell(ws.getCell(4, 1)); ws.mergeCells(4, 1, 5, 1);
  classes.forEach(([, label], g) => { const c = ws.getCell(4, 2 + g * 2); c.value = label; headCell(c); ws.mergeCells(4, 2 + g * 2, 4, 3 + g * 2); ["Taxable value", "Tax"].forEach((h, k) => { const q = ws.getCell(5, 2 + g * 2 + k); q.value = h; headCell(q, FILL.sub, "FF000000"); }); });
  const c0 = 2 + classes.length * 2;
  const tg = ws.getCell(4, c0); tg.value = "Total (excluding reverse charge)"; headCell(tg); ws.mergeCells(4, c0, 4, c0 + 5);
  ["Taxable value", "IGST", "CGST", "SGST", "Cess", "Total tax"].forEach((h, k) => { const q = ws.getCell(5, c0 + k); q.value = h; headCell(q, FILL.sub, "FF000000"); });
  const cb = ws.getCell(4, c0 + 6); cb.value = "RCM outward (info)"; headCell(cb); ws.mergeCells(4, c0 + 6, 5, c0 + 6);
  const cbk = ws.getCell(4, c0 + 7); cbk.value = "Books taxable"; headCell(cbk); ws.mergeCells(4, c0 + 7, 5, c0 + 7);
  const cd = ws.getCell(4, c0 + 8); cd.value = "Difference (return less books)"; headCell(cd); ws.mergeCells(4, c0 + 8, 5, c0 + 8);
  ws.getRow(4).height = 36;
  const T = { cls: classes.map(() => [0, 0]), total: [0, 0, 0, 0, 0], rcm: 0, books: 0 };
  x.rateRows.forEach((o, i) => {
    const r = 6 + i;
    put(ws, r, 1, o.rate, { fmt: "0.##" });
    classes.forEach(([k], g) => { put(ws, r, 2 + g * 2, r2(o[k].taxable)); put(ws, r, 3 + g * 2, r2(tax(o[k]))); T.cls[g][0] += o[k].taxable; T.cls[g][1] += tax(o[k]); });
    ["taxable", "igst", "cgst", "sgst", "cess"].forEach((k, j) => { put(ws, r, c0 + j, r2(o.total[k])); T.total[j] += o.total[k]; });
    put(ws, r, c0 + 5, r2(tax(o.total)));
    put(ws, r, c0 + 6, r2(o.rcm.taxable)); T.rcm += o.rcm.taxable;
    put(ws, r, c0 + 7, r2(o.books)); T.books += o.books;
    const d = r2(o.total.taxable - o.books);
    put(ws, r, c0 + 8, d, { bold: Math.abs(d) > 1, fill: Math.abs(d) > 1 ? FILL.bad : undefined });
  });
  const tr = 6 + x.rateRows.length;
  put(ws, tr, 1, "Total", { bold: true, fill: FILL.total });
  classes.forEach((_, g) => { put(ws, tr, 2 + g * 2, r2(T.cls[g][0]), { bold: true, fill: FILL.total }); put(ws, tr, 3 + g * 2, r2(T.cls[g][1]), { bold: true, fill: FILL.total }); });
  T.total.forEach((v, j) => put(ws, tr, c0 + j, r2(v), { bold: true, fill: FILL.total }));
  put(ws, tr, c0 + 5, r2(T.total.slice(1).reduce((a, v) => a + v, 0)), { bold: true, fill: FILL.total });
  put(ws, tr, c0 + 6, r2(T.rcm), { bold: true, fill: FILL.total }); put(ws, tr, c0 + 7, r2(T.books), { bold: true, fill: FILL.total });
  put(ws, tr, c0 + 8, r2(T.total[0] - T.books), { bold: true, fill: FILL.total });
  if (!x.rateRows.length) put(ws, 6, 1, "No rate found in the GSTR-1 files or the books.", { italic: true, noBorder: true });
  put(ws, tr + 2, 1, "Zero-rated supplies without payment of tax (export / SEZ under LUT) appear under their own rate, often 0 or 18. Books taxable is taken from the register lines that carry a GST rate.", { italic: true, noBorder: true });
  ws.views = [{ state: "frozen", ySplit: 5, xSplit: 1 }];
  return ws;
}

// ------------------------------------------------------------------ sheet 9 / GSTR-9 and 9C
function annualSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Workings for GSTR-9 and GSTR-9C (outward supplies)", `${meta(clientName, clientGstin, fy)}. Taken from GSTR-1 and GSTR-3B. Amendments (4K, 4L, 5J, 5K) are not read and have to be added by hand.`);
  widths(ws, [10, 70, 16, 14, 14, 14, 12, 52]);
  let r = 4;
  const head = (labels) => labels.forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; headCell(c); });
  const row = (id, desc, o, remark, opts = {}) => {
    r++;
    put(ws, r, 1, id, { bold: opts.bold, fill: opts.fill });
    put(ws, r, 2, desc, { bold: opts.bold, fill: opts.fill });
    ["taxable", "igst", "cgst", "sgst", "cess"].forEach((k, i) => put(ws, r, 3 + i, o ? r2(o[k] || 0) : "", { bold: opts.bold, fill: opts.fill }));
    put(ws, r, 8, remark || "", { italic: true, fill: opts.fill });
  };
  const sect = (t) => { r += 2; put(ws, r, 1, t, { bold: true, size: 11, noBorder: true }); r++; head(["Table", "Description", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Source and remark"]); };
  const g = x.gstr9, T = g.T;

  sect("GSTR-9 Part II - Table 4: outward and inward supplies on which tax is payable");
  row("4A", "Supplies made to un-registered persons (B2C)", T["4A"], "GSTR-1 b2cl and b2cs, with credit and debit notes to unregistered persons");
  row("4B", "Supplies made to registered persons (B2B)", T["4B"], "GSTR-1 b2b regular, excluding reverse charge, SEZ and deemed");
  row("4C", "Zero rated supply (export) on payment of tax (except supplies to SEZs)", T["4C"], "GSTR-1 exp, WPAY");
  row("4D", "Supply to SEZs on payment of tax", T["4D"], "GSTR-1 b2b, SEZ supplies with payment");
  row("4E", "Deemed exports", T["4E"], "GSTR-1 b2b, deemed exports");
  row("4F", "Advances on which tax has been paid but invoice has not been issued", T["4F"], "GSTR-1 at less atadj");
  row("4G", "Inward supplies on which tax is to be paid on reverse charge basis", T["4G"], "GSTR-3B 3.1(d), all months");
  row("4H", "Sub-total (A to G above)", g.T4H, "", { bold: true, fill: FILL.total });
  row("4I", "Credit notes issued in respect of transactions specified in (B) to (E) above (-)", T["4I"], "GSTR-1 cdnr and cdnur");
  row("4J", "Debit notes issued in respect of transactions specified in (B) to (E) above (+)", T["4J"], "GSTR-1 cdnr and cdnur");
  row("4K", "Supplies / tax declared through Amendments (+)", null, "Enter by hand from the amendment sheets");
  row("4L", "Supplies / tax reduced through Amendments (-)", null, "Enter by hand from the amendment sheets");
  row("4M", "Sub-total (I to L above)", g.T4M, "", { bold: true, fill: FILL.total });
  row("4N", "Supplies and advances on which tax is payable (H + M above)", g.T4N, "", { bold: true, fill: FILL.good });

  sect("GSTR-9 Part II - Table 5: outward supplies on which tax is not payable");
  row("5A", "Zero rated supply (export) without payment of tax", T["5A"], "GSTR-1 exp, WOPAY (LUT / bond)");
  row("5B", "Supply to SEZs without payment of tax", T["5B"], "GSTR-1 b2b, SEZ supplies without payment");
  row("5C", "Supplies on which tax is to be paid by the recipient on reverse charge basis", T["5C"], "GSTR-1 table 4B");
  row("5D", "Exempted", T["5D"], "GSTR-1 Table 8");
  row("5E", "Nil Rated", T["5E"], "GSTR-1 Table 8");
  row("5F", "Non-GST supply", T["5F"], "GSTR-1 Table 8");
  row("5G", "Sub-total (A to F above)", g.T5G, "", { bold: true, fill: FILL.total });
  row("5H", "Credit notes issued in respect of transactions specified in A to F above (-)", T["5H"], "GSTR-1 cdnr and cdnur, without payment");
  row("5I", "Debit notes issued in respect of transactions specified in A to F above (+)", T["5I"], "");
  row("5J", "Supplies declared through Amendments (+)", null, "Enter by hand");
  row("5K", "Supplies reduced through Amendments (-)", null, "Enter by hand");
  row("5L", "Sub-total (H to K above)", g.T5L, "", { bold: true, fill: FILL.total });
  row("5M", "Turnover on which tax is not to be paid (G + L above)", g.T5M, "", { bold: true, fill: FILL.total });
  row("5N", "Total turnover (including advances) (4N + 5M - 4G above)", g.T5N, "Compare with the turnover in the audited financial statements in GSTR-9C", { bold: true, fill: FILL.good });

  r += 2;
  put(ws, r, 1, "Cross-checks against GSTR-3B and the books", { bold: true, size: 11, noBorder: true });
  r++; head(["", "Figure", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Comment"]);
  const t3 = x.totals.b3, tb = x.totals.books;
  const gl = { taxable: g.T4N.taxable - T["4G"].taxable, igst: g.T4N.igst - T["4G"].igst, cgst: g.T4N.cgst - T["4G"].cgst, sgst: g.T4N.sgst - T["4G"].sgst, cess: g.T4N.cess - T["4G"].cess };
  row("", "Tax payable as per GSTR-1 (4N less 4G, plus zero-rated without payment in the taxable value)", { ...gl, taxable: gl.taxable + T["5A"].taxable + T["5B"].taxable }, "");
  row("", "As per GSTR-3B 3.1(a) + 3.1(b), all months", t3, "");
  const dif = (a, b) => Object.fromEntries(["taxable", "igst", "cgst", "sgst", "cess"].map((k) => [k, (a[k] || 0) - (b[k] || 0)]));
  row("", "Difference: GSTR-1 less GSTR-3B", dif({ ...gl, taxable: gl.taxable + T["5A"].taxable + T["5B"].taxable }, t3), "GSTR-9 takes the higher of the two. Pay any short tax before filing.", { bold: true });
  row("", "As per books (sales register / ledgers)", tb, "");
  row("", "Difference: GSTR-1 less books", dif({ ...gl, taxable: gl.taxable + T["5A"].taxable + T["5B"].taxable }, tb), "To be explained in GSTR-9C Table 5.", { bold: true });

  r += 2;
  put(ws, r, 1, "GSTR-9C Part II - Table 5: reconciliation of gross turnover (working)", { bold: true, size: 11, noBorder: true });
  r++; head(["Item", "Description", "Amount", "", "", "", "", "Remark"]);
  const c9 = (id, desc, v, remark, opts = {}) => { r++; put(ws, r, 1, id, opts); put(ws, r, 2, desc, opts); put(ws, r, 3, v === null ? "" : r2(v), opts); for (let c = 4; c <= 7; c++) put(ws, r, c, "", opts); put(ws, r, 8, remark || "", { italic: true, fill: opts.fill }); };
  c9("A", "Turnover as per audited annual financial statements", null, "Enter from the financial statements (not uploaded here)");
  c9("", "Turnover as per books (sales register / sales ledgers), net of credit notes", tb.taxable, "Sheet 4, books");
  c9("B", "Unbilled revenue at the beginning of the financial year", null, "Enter");
  c9("C", "Unadjusted advances at the end of the financial year", null, "Enter");
  c9("D", "Credit notes accounted for in the audited financial statements but not included in the GST turnover", null, "Enter");
  c9("E", "Trade discounts accounted but not permissible under section 15", null, "Enter");
  c9("F", "Adjustments on account of supply of goods by SEZ units to DTA", null, "Enter");
  c9("G", "Turnover for the period under composition scheme", null, "Enter");
  c9("H", "Adjustments in turnover under section 15 and rules", null, "Enter");
  c9("I", "Adjustments in turnover due to foreign exchange fluctuations", null, "Enter");
  c9("J", "Adjustments in turnover due to reasons not listed above", null, "Enter");
  c9("K", "Annual turnover after adjustments (A to J)", null, "Total of the lines above", { bold: true, fill: FILL.total });
  c9("L", "Turnover as per GSTR-9 (Table 5N)", g.T5N.taxable, "Above", { bold: true, fill: FILL.good });
  c9("M", "Unreconciled turnover (K less L)", null, "To be explained in Table 5R and in the reasons of GSTR-9C", { bold: true });
  c9("", "Memo: total sales of capital assets identified in the books", x.capital.reduce((a, c) => a + c.taxable, 0), "Included in turnover; see sheet 6");

  r += 2;
  put(ws, r, 1, "GSTR-9C Part II - Table 7: rate-wise liability, and Table 9 / 10: tax payable", { bold: true, size: 11, noBorder: true });
  r++; head(["Ref", "Description", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Remark"]);
  row("7", "Taxable value and tax rate-wise: see sheet 8 (rate-wise summary)", { taxable: x.rateRows.reduce((a, o) => a + o.total.taxable, 0), igst: x.rateRows.reduce((a, o) => a + o.total.igst, 0), cgst: x.rateRows.reduce((a, o) => a + o.total.cgst, 0), sgst: x.rateRows.reduce((a, o) => a + o.total.sgst, 0), cess: x.rateRows.reduce((a, o) => a + o.total.cess, 0) }, "Total of the rate-wise summary, excluding reverse charge");
  row("", "Tax as per books: output tax ledgers (or the register where no ledger was uploaded)", tb, "");
  row("", "Tax declared in GSTR-3B 3.1(a) and (b)", t3, "");
  row("", "Tax payable on the inward supplies under reverse charge (GSTR-3B 3.1(d))", x.inwardRcm, "GSTR-9 Table 4G; GSTR-9C Table 9");

  r += 2;
  [
    "How to use: the figures in Tables 4 and 5 are what GSTR-9 shows. Where they differ from the books, explain the difference in GSTR-9C Table 5 (turnover) and Table 9 (tax).",
    "GSTR-9 is required from every registered person under section 44 and rule 80. GSTR-9C (self-certified reconciliation statement) is required where the aggregate turnover exceeds the limit notified for the year. Check the notification for the year.",
    "Not read from the files: amendments (4K, 4L, 5J, 5K), tax paid in cash and by ITC (Table 9), turnover as per the financial statements, and the unreconciled items. Add them by hand.",
  ].forEach((t) => { r++; put(ws, r, 1, t, { italic: true, noBorder: true, wrap: false }); });
  ws.views = [{ state: "frozen", ySplit: 3 }];
  return ws;
}

// ------------------------------------------------------------------ sheet 10 / differences
function differenceSheet(wb, name, { clientName, clientGstin, fy, x }) {
  const ws = wb.addWorksheet(name);
  title(ws, "Differences, reasons and recommended course of action", `${meta(clientName, clientGstin, fy)}. Month-wise differences between the returns and the books, parties that differ, and other items to resolve before filing GSTR-9 and GSTR-9C.`);
  const cols = [["No.", 5], ["Area", 18], ["Period", 9], ["Item", 36], ["First figure", 12], ["Taxable value", 15], ["Second figure", 12], ["Taxable value", 15], ["Difference: taxable value", 15], ["IGST", 13], ["CGST", 13], ["SGST", 13], ["Reason for the difference", 62], ["Recommended course of action", 62], ["Provision / reference", 36]];
  widths(ws, cols.map((c) => c[1]));
  cols.forEach(([h], i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  ws.getRow(4).height = 32;
  const order = { "Missing month": 0, "GSTR-1 vs GSTR-3B": 1, "GSTR-1 vs books": 2, "GSTR-3B vs books": 3, "Party-wise": 4 };
  const rows = [...x.differences].sort((a, b) => (order[a.area] ?? 9) - (order[b.area] ?? 9) || String(a.period).localeCompare(String(b.period)));
  rows.forEach((d, i) => {
    const r = 5 + i;
    const v = (o, k) => (o && typeof o[k] === "number" ? r2(o[k]) : "");
    [i + 1, d.area, d.period ? monthLabel(d.period) : "", d.item, d.a_label, v(d.a, "taxable"), d.b_label, v(d.b, "taxable"), v(d.d, "taxable"), v(d.d, "igst"), v(d.d, "cgst"), v(d.d, "sgst"), d.reason, d.action, d.ref]
      .forEach((val, j) => put(ws, r, j + 1, val, { wrap: j === 3 || j >= 12, fill: j === 8 && typeof val === "number" && Math.abs(val) > 1 ? FILL.bad : undefined, bold: j === 8 && typeof val === "number" && Math.abs(val) > 1 }));
  });
  ws.views = [{ state: "frozen", ySplit: 4, xSplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: cols.length } };
  return ws;
}

// ------------------------------------------------------------------ the three workbooks
export async function combinedBooksWorkbook(ctx) {
  const wb = new ExcelJS.Workbook();
  const x = ctx.x;
  booksSheet(wb, "Books combined", ctx);
  const ws = wb.addWorksheet("Month-wise summary");
  title(ws, "Books - month-wise totals", meta(ctx.clientName, ctx.clientGstin, ctx.fy));
  widths(ws, [12, 16, 14, 14, 14, 12, 16]);
  ["Month", "Taxable value / sales", "IGST", "CGST", "SGST", "Cess", "Total tax"].forEach((h, i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  const tot = [0, 0, 0, 0, 0];
  x.months.forEach((m, i) => {
    const o = x.booksMonthly[m];
    put(ws, 5 + i, 1, monthLabel(m));
    [o.taxable, o.igst, o.cgst, o.sgst, o.cess].forEach((v, j) => { put(ws, 5 + i, 2 + j, r2(v)); tot[j] += v; });
    put(ws, 5 + i, 7, r2(tax(o)));
  });
  const tr = 5 + x.months.length;
  put(ws, tr, 1, "Total", { bold: true, fill: FILL.total });
  tot.forEach((v, j) => put(ws, tr, 2 + j, r2(v), { bold: true, fill: FILL.total }));
  put(ws, tr, 7, r2(tot.slice(1).reduce((a, v) => a + v, 0)), { bold: true, fill: FILL.total });
  put(ws, tr + 2, 1, "Tax comes from the GST ledgers where uploaded, otherwise from the sales register. Taxable value comes from the register, otherwise from the sales ledger.", { italic: true, noBorder: true, wrap: false });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function combinedGstr1Workbook(ctx) {
  const wb = new ExcelJS.Workbook();
  const x = ctx.x;
  const ws = wb.addWorksheet("Month-wise summary");
  title(ws, "GSTR-1 - month-wise totals", meta(ctx.clientName, ctx.clientGstin, ctx.fy));
  widths(ws, [12, 16, 14, 14, 14, 12, 16, 16, 16]);
  ["Month", "Taxable value", "IGST", "CGST", "SGST", "Cess", "Total tax", "Zero-rated w/o payment", "Nil, exempt, non-GST"].forEach((h, i) => { const c = ws.getCell(4, i + 1); c.value = h; headCell(c); });
  const tot = Array(8).fill(0);
  const g1Months = [...x.months.map((m) => [m, x.g1[m]]), ...(x.g1Undated.hasFile ? [["undated", x.g1Undated]] : [])];
  g1Months.forEach(([m, o], i) => {
    const vals = [o.liab.taxable, o.liab.igst, o.liab.cgst, o.liab.sgst, o.liab.cess, tax(o.liab), o.zero.taxable, o.exempt];
    put(ws, 5 + i, 1, monthLabel(m), { fill: o.hasFile ? undefined : FILL.warn });
    vals.forEach((v, j) => { put(ws, 5 + i, 2 + j, r2(v)); tot[j] += v; });
  });
  const tr = 5 + g1Months.length;
  put(ws, tr, 1, "Total", { bold: true, fill: FILL.total });
  tot.forEach((v, j) => put(ws, tr, 2 + j, r2(v), { bold: true, fill: FILL.total }));
  put(ws, tr + 2, 1, "Taxable value and tax exclude reverse-charge supplies (table 4B) and supplies without payment of tax. Credit notes and adjusted advances are deducted. Months in yellow have no file.", { italic: true, noBorder: true, wrap: false });
  gstr1Sheet(wb, "All sections", ctx);
  hsnSheet(wb, "HSN summary", ctx);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function workingWorkbook(ctx) {
  const wb = new ExcelJS.Workbook();
  booksSheet(wb, "1 Books Combined", ctx);
  gstr1Sheet(wb, "2 GSTR-1 Combined", ctx);
  gstr3bSheet(wb, "3 GSTR-3B Combined", ctx);
  comparisonSheet(wb, "4 Monthly Comparison", ctx);
  partySheet(wb, "5 Party Comparison", ctx);
  classificationSheet(wb, "6 Turnover Classification", ctx);
  hsnSheet(wb, "7 HSN Summary", ctx);
  rateSheet(wb, "8 Rate-wise Summary", ctx);
  annualSheet(wb, "9 GSTR-9 and 9C Workings", ctx);
  differenceSheet(wb, "10 Differences and Actions", ctx);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
