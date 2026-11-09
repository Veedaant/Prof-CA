import ExcelJS from "exceljs";
import { formatDateGstr1, formatPlaceOfSupply, isSalesSide } from "./gstr1Exporter.js";
import { classifyRcm } from "./gstRules.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const n = (v) => Number(v) || 0;

export const REGISTER_CATEGORIES = {
  sales: { type: "sales", title: "Sales invoices" },
  purchase: { type: "purchase", title: "Purchase invoices" },
  credit_note: { type: "credit_note", title: "Credit notes" },
  debit_note: { type: "debit_note", title: "Debit notes" },
  other: { type: "other", title: "Other documents" },
};

const money = "#,##0.00";
const COLUMNS = [
  ["doc_no", "Document Number", 20], ["doc_date", "Document Date", 14], ["side", "Side", 10],
  ["supplier_name", "Supplier Name", 28], ["supplier_gstin", "Supplier GSTIN", 20],
  ["buyer_name", "Buyer Name", 28], ["buyer_gstin", "Buyer GSTIN", 20],
  ["pos", "Place Of Supply", 16], ["rcm", "Reverse Charge", 10],
  ["hsn", "HSN/SAC", 12], ["description", "Description", 28], ["quantity", "Quantity", 12, "#,##0.00"], ["uqc", "UQC", 14],
  ["rate", "Rate %", 9, "0.00"], ["taxable", "Taxable Value", 16, money],
  ["igst", "IGST", 14, money], ["cgst", "CGST", 14, money], ["sgst", "SGST", 14, money], ["cess", "Cess", 12, money],
  ["line_total", "Line Total", 16, money], ["invoice_total", "Invoice Value", 16, money],
];

function uqcOf(it) {
  const raw = it.uqc || it.unit || "NOS";
  return String(raw).includes("-") ? String(raw) : `${raw}-${["NOS", "PCS"].includes(raw) ? "NUMBERS" : "OTHERS"}`;
}

/** One row per HSN/line item; the invoice value repeats unchanged on every line of the same document. */
export function registerRows(invoices, clientGstin) {
  const rows = [];
  for (const inv of invoices) {
    const items = inv.line_items?.length
      ? inv.line_items
      : [{ description: "Document total (no line items extracted)", hsn_sac: "", quantity: 1, taxable_value: n(inv.total_taxable_value), cgst_amount: n(inv.cgst_total), sgst_amount: n(inv.sgst_total), igst_amount: n(inv.igst_total), cess: n(inv.cess_total) }];
    const side = inv.invoice_type === "purchase" ? "Purchase" : inv.invoice_type === "other" ? "" : isSalesSide(inv, clientGstin) ? "Sales" : "Purchase";
    for (const it of items) {
      let rate = n(it.cgst_rate) + n(it.sgst_rate) + n(it.igst_rate);
      if (!rate && n(it.rate) > 0 && n(it.rate) <= 28) rate = n(it.rate);
      const tax = n(it.cgst_amount) + n(it.sgst_amount) + n(it.igst_amount) + n(it.cess);
      rows.push({
        doc_no: inv.invoice_number || "", doc_date: formatDateGstr1(inv.invoice_date), side,
        supplier_name: inv.supplier_name || "", supplier_gstin: inv.supplier_gstin || "",
        buyer_name: inv.buyer_name || "", buyer_gstin: inv.buyer_gstin || "",
        pos: formatPlaceOfSupply(inv.place_of_supply), rcm: inv.reverse_charge ? "Y" : "N",
        hsn: String(it.hsn_sac || "9999").trim(), description: String(it.description || "").slice(0, 60),
        quantity: n(it.quantity) || 1, uqc: uqcOf(it), rate, taxable: r2(n(it.taxable_value)),
        igst: r2(n(it.igst_amount)), cgst: r2(n(it.cgst_amount)), sgst: r2(n(it.sgst_amount)), cess: r2(n(it.cess)),
        line_total: r2(n(it.taxable_value) + tax), invoice_total: r2(n(inv.invoice_total)),
      });
    }
  }
  return rows;
}

const border = { style: "thin", color: { argb: "FFD9D9D9" } };
const borders = { left: border, right: border, top: border, bottom: border };
const head = (cell) => {
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = borders;
};

/** One register sheet: a title, one row per HSN line (invoice value repeated), and an HSN-wise summary block under it. */
function writeRegisterSheet(ws, titleText, rows) {
  ws.getCell(1, 1).value = titleText;
  ws.getCell(1, 1).font = { name: "Calibri", size: 12, bold: true };
  COLUMNS.forEach(([, label, width], i) => { ws.getColumn(i + 1).width = width; const c = ws.getCell(3, i + 1); c.value = label; head(c); });
  ws.getRow(3).height = 28;
  rows.forEach((rec, r) => {
    COLUMNS.forEach(([key, , , fmt], i) => {
      const c = ws.getCell(r + 4, i + 1);
      c.value = rec[key] ?? "";
      c.font = { name: "Calibri", size: 10 };
      c.border = borders;
      if (fmt && typeof rec[key] === "number") { c.numFmt = fmt; c.alignment = { horizontal: "right" }; }
    });
  });

  if (rows.length) {
    const agg = new Map();
    for (const r of rows) {
      const e = agg.get(r.hsn) || { hsn: r.hsn, description: r.description, uqc: r.uqc, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
      e.qty += r.quantity; e.taxable += r.taxable; e.igst += r.igst; e.cgst += r.cgst; e.sgst += r.sgst; e.cess += r.cess; e.total += r.line_total;
      agg.set(r.hsn, e);
    }
    let at = rows.length + 6;
    ws.getCell(at, 1).value = "HSN-wise summary";
    ws.getCell(at, 1).font = { name: "Calibri", size: 12, bold: true };
    at++;
    ["HSN/SAC", "Description", "UQC", "Total Quantity", "Taxable Value", "IGST", "CGST", "SGST", "Cess", "Total Value"].forEach((h, i) => { const c = ws.getCell(at, i + 1); c.value = h; head(c); });
    const tot = { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
    const put = (vals, bold) => {
      at++;
      vals.forEach((v, i) => {
        const c = ws.getCell(at, i + 1);
        c.value = v; c.font = { name: "Calibri", size: 10, bold }; c.border = borders;
        if (typeof v === "number") { c.numFmt = money; c.alignment = { horizontal: "right" }; }
      });
    };
    for (const e of agg.values()) { put([e.hsn, e.description, e.uqc, r2(e.qty), r2(e.taxable), r2(e.igst), r2(e.cgst), r2(e.sgst), r2(e.cess), r2(e.total)], false); for (const k of Object.keys(tot)) tot[k] += e[k]; }
    put(["Total", "", "", r2(tot.qty), r2(tot.taxable), r2(tot.igst), r2(tot.cgst), r2(tot.sgst), r2(tot.cess), r2(tot.total)], true);
  }
  ws.views = [{ state: "frozen", ySplit: 3 }];
}

export async function generateRegisterWorkbook(invoices, { category, clientName, clientGstin, taxPeriod, returnLabel = "" }) {
  const cat = REGISTER_CATEGORIES[category];
  const rows = registerRows(invoices, clientGstin);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(cat.title.slice(0, 31));
  writeRegisterSheet(ws, `${returnLabel ? returnLabel + " - " : ""}${cat.title} - ${clientName}${clientGstin ? ` (${clientGstin})` : ""} - ${taxPeriod}`, rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PURCHASE_COLUMNS = [
  ["party", "Party's Name", 30], ["gstin", "GSTIN", 20], ["doc_no", "Invoice No", 20], ["doc_date", "Invoice Date", 13],
  ["nature", "Nature of Services", 30], ["supply", "Type of Supply (Inter / Intra State)", 18], ["charge", "Type of Charge (FCM / RCM / Exempt)", 18],
  ["nil", "Nil Rated", 14, money], ["taxable", "Taxable Value", 16, money], ["rate", "GST Rate %", 9, "0.00"],
  ["igst", "IGST", 14, money], ["cgst", "CGST", 14, money], ["sgst", "SGST", 14, money], ["utgst", "UTGST", 12, money],
  ["rcm", "RCM", 14, money], ["invoice_total", "Invoice Value", 16, money],
];

const stateOf = (g) => String(g || "").slice(0, 2);

/** One row per invoice and GST rate (an invoice at two rates takes two rows); invoice value is shown once per invoice. */
export function purchaseRows(docs, clientGstin) {
  const rows = [];
  for (const inv of docs) {
    const items = inv.line_items?.length
      ? inv.line_items
      : [{ description: "", taxable_value: n(inv.total_taxable_value), cgst_amount: n(inv.cgst_total), sgst_amount: n(inv.sgst_total), igst_amount: n(inv.igst_total), cess: 0 }];
    const mine = String(clientGstin || "").toUpperCase();
    const supplierIsClient = mine && String(inv.supplier_gstin || "").toUpperCase() === mine;
    const party = supplierIsClient ? inv.buyer_name : inv.supplier_name;
    const gstin = supplierIsClient ? inv.buyer_gstin : inv.supplier_gstin;
    const groups = new Map();
    for (const it of items) {
      let rate = n(it.cgst_rate) + n(it.sgst_rate) + n(it.igst_rate);
      if (!rate && n(it.rate) > 0 && n(it.rate) <= 28) rate = n(it.rate);
      const tax = n(it.cgst_amount) + n(it.sgst_amount) + n(it.igst_amount);
      if (!rate && n(it.taxable_value) && tax) rate = Math.round((tax / n(it.taxable_value)) * 1000) / 10;
      const g = groups.get(rate) || { rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, desc: [] };
      g.taxable += n(it.taxable_value); g.igst += n(it.igst_amount); g.cgst += n(it.cgst_amount); g.sgst += n(it.sgst_amount);
      const d = String(it.description || "").trim();
      if (d && !g.desc.includes(d)) g.desc.push(d);
      groups.set(rate, g);
    }
    const intra = !groups.size ? true : [...groups.values()].every((g) => !g.igst);
    const sameState = stateOf(gstin) && stateOf(mine) ? stateOf(gstin) === stateOf(mine) : intra;
    // reverse charge: the bill carries no tax, so the recipient works it out at the rate on the bill or the notified rate
    const info = classifyRcm(inv, registerRows([inv], clientGstin));
    const rcm = info.rcm;
    let inter = [...groups.values()].some((g) => g.igst) || (!intra ? true : !sameState);
    if (rcm) {
      if (info.import) inter = true;
      for (const g of groups.values()) {
        if (g.igst + g.cgst + g.sgst > 0 || g.taxable <= 0) continue;
        if (!g.rate) g.rate = info.rate;
        const t = r2((g.taxable * g.rate) / 100);
        if (inter) g.igst = t; else { g.cgst = r2(t / 2); g.sgst = r2(t - g.cgst); }
      }
    }
    let first = true;
    for (const g of groups.values()) {
      const nilRated = !g.rate && !g.igst && !g.cgst && !g.sgst;
      const tax = g.igst + g.cgst + g.sgst;
      rows.push({
        party: party || "", gstin: gstin || "", doc_no: inv.invoice_number || "", doc_date: formatDateGstr1(inv.invoice_date),
        nature: g.desc.join("; ").slice(0, 80), supply: inter ? "Inter-state" : "Intra-state",
        charge: nilRated ? "Exempt supply" : rcm ? "RCM" : "FCM",
        nil: nilRated ? r2(g.taxable) : 0, taxable: nilRated ? 0 : r2(g.taxable), rate: g.rate,
        igst: r2(g.igst), cgst: r2(g.cgst), sgst: r2(g.sgst), utgst: 0, rcm: rcm ? r2(tax) : 0,
        invoice_total: first ? r2(n(inv.invoice_total)) : "",
      });
      first = false;
    }
  }
  return rows;
}

function writePurchaseSheet(ws, titleText, rows) {
  ws.getCell(1, 1).value = titleText;
  ws.getCell(1, 1).font = { name: "Calibri", size: 12, bold: true };
  PURCHASE_COLUMNS.forEach(([, label, width], i) => { ws.getColumn(i + 1).width = width; const c = ws.getCell(3, i + 1); c.value = label; head(c); });
  ws.getRow(3).height = 42;
  const sums = {};
  rows.forEach((rec, r) => {
    PURCHASE_COLUMNS.forEach(([key, , , fmt], i) => {
      const c = ws.getCell(r + 4, i + 1);
      c.value = rec[key] ?? "";
      c.font = { name: "Calibri", size: 10 };
      c.border = borders;
      if (fmt && typeof rec[key] === "number") { c.numFmt = fmt; c.alignment = { horizontal: "right" }; }
      if (fmt === money && typeof rec[key] === "number") sums[key] = (sums[key] || 0) + rec[key];
    });
  });
  if (rows.length) {
    const at = rows.length + 4;
    PURCHASE_COLUMNS.forEach(([key, , , fmt], i) => {
      const c = ws.getCell(at, i + 1);
      c.value = i === 0 ? "Total" : fmt === money ? r2(sums[key] || 0) : "";
      c.font = { name: "Calibri", size: 10, bold: true }; c.border = borders;
      if (fmt === money) { c.numFmt = money; c.alignment = { horizontal: "right" }; }
    });
  }
  ws.views = [{ state: "frozen", ySplit: 3 }];
}

/** The GSTR-3B purchase-side Excel: purchase invoices, credit notes and debit notes the client has sent, one sheet each. */
export async function generatePurchaseExcel({ purchase = [], credit_note = [], debit_note = [] }, { clientName, clientGstin, taxPeriod }) {
  const wb = new ExcelJS.Workbook();
  const sheets = [["Purchase invoices", purchase], ["Credit notes", credit_note], ["Debit notes", debit_note]];
  for (const [title, docs] of sheets) {
    const ws = wb.addWorksheet(title);
    writePurchaseSheet(ws, `GSTR-3B - ${title} - ${clientName}${clientGstin ? ` (${clientGstin})` : ""} - ${taxPeriod}`, purchaseRows(docs, clientGstin));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
