import ExcelJS from "exceljs";
import { GSTR1_SHEET_CONFIGS } from "./gstr1Mapping.js";
import { extractStateCode, STATE_CODES } from "./validators.js";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const n = (v) => Number(v) || 0;

export function formatDateGstr1(s) {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return String(s);
  return `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}`;
}

export function formatPlaceOfSupply(pos) {
  if (!pos) return "";
  const code = extractStateCode(pos);
  return code ? `${code}-${STATE_CODES[code]}` : String(pos);
}

/** Notes/invoices that belong in the client's outward-supply return (not purchases / other documents). */
export function isSalesSide(inv, clientGstin) {
  const t = inv.invoice_type || "sales";
  if (t === "purchase" || t === "other") return false;
  if (t === "sales") return true;
  const mine = String(clientGstin || "").toUpperCase();
  if (!mine) return true;
  const sup = String(inv.supplier_gstin || "").toUpperCase();
  const buy = String(inv.buyer_gstin || "").toUpperCase();
  return !(buy === mine && sup !== mine);
}

export function categorize(invoices) {
  const b2b = [], b2cl = [], cdnr = [];
  const b2csMap = new Map();
  const hsnMap = new Map();

  for (const inv of invoices) {
    const supCode = extractStateCode(inv.supplier_gstin);
    const posCode = extractStateCode(inv.place_of_supply) || supCode;
    const pos = formatPlaceOfSupply(inv.place_of_supply || posCode);
    const inter = Boolean(supCode && posCode && supCode !== posCode);
    const buyerGstin = String(inv.buyer_gstin || "").replace(/\s+/g, "").toUpperCase();
    const registered = buyerGstin.length === 15;
    const who = { supplier_name: inv.supplier_name || "", supplier_gstin: inv.supplier_gstin || "", buyer_name: inv.buyer_name || "" };
    const note = inv.invoice_type === "credit_note" || inv.invoice_type === "debit_note";

    const items = inv.line_items?.length ? inv.line_items : [{ description: "Invoice total (no line items extracted)", hsn_sac: "", quantity: 1, taxable_value: n(inv.total_taxable_value), cgst_amount: n(inv.cgst_total), sgst_amount: n(inv.sgst_total), igst_amount: n(inv.igst_total), cess: n(inv.cess_total), rate: 0 }];
    for (const it of items) {
      const hsn = String(it.hsn_sac || "9999").trim();
      let h = hsnMap.get(hsn);
      if (!h) {
        h = { description: "", uqc: "NOS-NUMBERS", total_quantity: 0, total_value: 0, taxable_value: 0, igst_amount: 0, cgst_amount: 0, sgst_amount: 0, cess_amount: 0 };
        hsnMap.set(hsn, h);
      }
      if (!h.description) h.description = it.description || "Goods / Services";
      const rawUqc = it.uqc || it.unit || "NOS";
      h.uqc = String(rawUqc).includes("-") ? String(rawUqc) : `${rawUqc}-${["NOS", "PCS"].includes(rawUqc) ? "NUMBERS" : "OTHERS"}`;
      const qty = n(it.quantity) || 1;
      h.total_quantity += qty;

      let rate = n(it.cgst_rate) + n(it.sgst_rate) + n(it.igst_rate);
      if (rate === 0 && n(it.rate) > 0 && n(it.rate) <= 28) rate = n(it.rate);
      const tax = n(it.cgst_amount) + n(it.sgst_amount) + n(it.igst_amount) + n(it.cess);
      h.total_value += n(it.taxable_value) + tax;
      h.taxable_value += n(it.taxable_value);
      h.igst_amount += n(it.igst_amount);
      h.cgst_amount += n(it.cgst_amount);
      h.sgst_amount += n(it.sgst_amount);
      h.cess_amount += n(it.cess);

      const common = {
        invoice_number: inv.invoice_number || "",
        invoice_date: formatDateGstr1(inv.invoice_date),
        invoice_total: n(inv.invoice_total),
        hsn,
        description: String(it.description || "").slice(0, 60),
        quantity: qty,
        uqc: h.uqc,
        igst_amount: n(it.igst_amount),
        cgst_amount: n(it.cgst_amount),
        sgst_amount: n(it.sgst_amount),
        line_total: r2(n(it.taxable_value) + tax),
        place_of_supply: pos,
        applicable_tax_rate: "",
        rate,
        taxable_value: n(it.taxable_value),
        cess_amount: n(it.cess),
        ecommerce_gstin: "",
        ...who,
      };
      if (note && registered) {
        cdnr.push({ ...common, buyer_gstin: buyerGstin, note_type: inv.invoice_type === "credit_note" ? "C" : "D", reverse_charge: inv.reverse_charge ? "Y" : "N", note_supply_type: "Regular" });
      } else if (registered) {
        b2b.push({ ...common, buyer_gstin: buyerGstin, reverse_charge: inv.reverse_charge ? "Y" : "N", invoice_type: "Regular" });
      } else if (inter && n(inv.invoice_total) > 250000) {
        b2cl.push(common);
      } else {
        const key = `${pos}|${rate}`;
        const e = b2csMap.get(key) || { pos, rate, taxable: 0, cess: 0, igst: 0, cgst: 0, sgst: 0, sup: new Set() };
        if (inv.supplier_name) e.sup.add(inv.supplier_name);
        e.taxable += n(it.taxable_value);
        e.cess += n(it.cess);
        e.igst += n(it.igst_amount); e.cgst += n(it.cgst_amount); e.sgst += n(it.sgst_amount);
        b2csMap.set(key, e);
      }
    }
  }

  const b2cs = [...b2csMap.values()].map((e) => ({ type: "OE", place_of_supply: e.pos, applicable_tax_rate: "", rate: e.rate, taxable_value: r2(e.taxable), igst_amount: r2(e.igst), cgst_amount: r2(e.cgst), sgst_amount: r2(e.sgst), cess_amount: r2(e.cess), ecommerce_gstin: "", supplier_name: [...e.sup].join(", "), supplier_gstin: "" }));
  const hsn = [...hsnMap.entries()].map(([code, v]) => ({
    hsn: code, description: v.description.slice(0, 30), uqc: v.uqc,
    total_quantity: r2(v.total_quantity), total_value: r2(v.total_value), taxable_value: r2(v.taxable_value),
    igst_amount: r2(v.igst_amount), cgst_amount: r2(v.cgst_amount), sgst_amount: r2(v.sgst_amount), cess_amount: r2(v.cess_amount),
  }));
  return { b2b, b2cl, b2cs, cdnr, hsn };
}

// HSN-wise summary of one sheet's rows, written below its data; its totals tie to the rows above.
function addHsnBlock(ws, rows, borders) {
  if (!rows.length) return;
  const agg = new Map();
  for (const r of rows) {
    const e = agg.get(r.hsn) || { hsn: r.hsn, description: r.description, uqc: r.uqc, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
    e.qty += n(r.quantity); e.taxable += n(r.taxable_value); e.igst += n(r.igst_amount); e.cgst += n(r.cgst_amount); e.sgst += n(r.sgst_amount);
    e.cess += n(r.cess_amount); e.total += n(r.line_total);
    agg.set(r.hsn, e);
  }
  let row = rows.length + 4;
  ws.getCell(row, 1).value = "HSN-wise summary";
  ws.getCell(row, 1).font = { name: "Calibri", size: 12, bold: true };
  row++;
  const heads = ["HSN/SAC", "Description", "UQC", "Total Quantity", "Taxable Value", "IGST", "CGST", "SGST", "Cess", "Total Value"];
  heads.forEach((h, i) => {
    const c = ws.getCell(row, i + 1);
    c.value = h;
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
    c.alignment = { horizontal: "center", wrapText: true };
    c.border = borders;
  });
  const tot = { qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
  const put = (vals, bold) => {
    row++;
    vals.forEach((v, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = v;
      c.font = { name: "Calibri", size: 10, bold };
      c.border = borders;
      if (typeof v === "number") { c.numFmt = "#,##0.00"; c.alignment = { horizontal: "right" }; }
    });
  };
  for (const e of agg.values()) {
    put([e.hsn, e.description, e.uqc, r2(e.qty), r2(e.taxable), r2(e.igst), r2(e.cgst), r2(e.sgst), r2(e.cess), r2(e.total)], false);
    for (const k of Object.keys(tot)) tot[k] += e[k];
  }
  put(["Total", "", "", r2(tot.qty), r2(tot.taxable), r2(tot.igst), r2(tot.cgst), r2(tot.sgst), r2(tot.cess), r2(tot.total)], true);
}

/** invoices: invoice rows each with a `line_items` array. Returns a Buffer (.xlsx). */
export async function generateGstr1Workbook(invoices) {
  const data = categorize(invoices);
  const wb = new ExcelJS.Workbook();
  const border = { style: "thin", color: { argb: "FFD9D9D9" } };
  const borders = { left: border, right: border, top: border, bottom: border };

  for (const [key, cfg] of Object.entries(GSTR1_SHEET_CONFIGS)) {
    const ws = wb.addWorksheet(cfg.sheet_title);
    cfg.columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = c.width;
      const cell = ws.getCell(1, i + 1);
      cell.value = c.header;
      cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
      cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      cell.border = borders;
    });
    ws.getRow(1).height = 28;
    data[key].forEach((rec, r) => {
      cfg.columns.forEach((c, i) => {
        const val = rec[c.key] ?? "";
        const cell = ws.getCell(r + 2, i + 1);
        cell.value = val;
        cell.font = { name: "Calibri", size: 10 };
        cell.border = borders;
        if (c.format && typeof val === "number") {
          cell.numFmt = c.format;
          cell.alignment = { horizontal: "right", vertical: "middle" };
        } else {
          cell.alignment = { horizontal: "left", vertical: "middle" };
        }
      });
      ws.getRow(r + 2).height = 20;
    });
    if (["b2b", "b2cl", "cdnr"].includes(key)) addHsnBlock(ws, data[key], borders);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
