import { db } from "../../db/index.js";
import { isSalesSide } from "../gstr1Exporter.js";
import { normInv, SLABS } from "./sheetParser.js";
import { emptyFigures } from "./gstr3bParser.js";

const num = (v) => Number(v) || 0;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function ymd(v) {
  if (!v) return "";
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}

function slab(rate) {
  let best = 0, d = 1e9;
  for (const s of SLABS) if (Math.abs(s - rate) < d) { d = Math.abs(s - rate); best = s; }
  return best;
}

function invoiceRows(inv, side) {
  const type = inv.invoice_type === "credit_note" ? "cn" : inv.invoice_type === "debit_note" ? "dn" : "inv";
  const base = {
    src: "invoice", type, period: inv.tax_period, date: ymd(inv.invoice_date), inv_no: inv.invoice_number || "", rcm: Boolean(inv.reverse_charge), itc: true, pos: inv.place_of_supply || "",
    gstin: String((side === "sales" ? inv.buyer_gstin : inv.supplier_gstin) || "").replace(/\s+/g, "").toUpperCase(),
    party: (side === "sales" ? inv.buyer_name : inv.supplier_name) || "", ref_id: inv.id,
  };
  const items = inv.line_items || [];
  const rows = new Map();
  const put = (rate, hsn, taxable, igst, cgst, sgst, cess) => {
    const k = `${rate}|${hsn}`;
    const e = rows.get(k) || { ...base, rate, hsn, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
    e.taxable += taxable; e.igst += igst; e.cgst += cgst; e.sgst += sgst; e.cess += cess;
    rows.set(k, e);
  };
  if (items.length) {
    for (const it of items) {
      const taxable = num(it.taxable_value), igst = num(it.igst_amount), cgst = num(it.cgst_amount), sgst = num(it.sgst_amount), cess = num(it.cess);
      let rate = num(it.cgst_rate) + num(it.sgst_rate) + num(it.igst_rate);
      if (!rate && taxable) rate = slab(((igst + cgst + sgst) / taxable) * 100);
      put(rate, String(it.hsn_sac || "").trim(), taxable, igst, cgst, sgst, cess);
    }
  } else {
    const taxable = num(inv.total_taxable_value), igst = num(inv.igst_total), cgst = num(inv.cgst_total), sgst = num(inv.sgst_total);
    put(taxable ? slab(((igst + cgst + sgst) / taxable) * 100) : 0, "", taxable, igst, cgst, sgst, num(inv.cess_total));
  }
  return [...rows.values()].map((r) => ({ ...r, taxable: r2(r.taxable), igst: r2(r.igst), cgst: r2(r.cgst), sgst: r2(r.sgst), cess: r2(r.cess) }));
}

export async function loadBooks(firmId, client, periods) {
  const invs = await db.query(
    `select * from invoices where firm_id=$1 and client_id=$2 and tax_period = any($3::text[]) and client_approved_at is not null and review_status <> 'rejected'
     order by invoice_date, invoice_number`,
    [firmId, client.id, periods],
  );
  const pendingRow = await db.one(
    "select count(*)::int as c from invoices where firm_id=$1 and client_id=$2 and tax_period = any($3::text[]) and client_approved_at is null and review_status <> 'rejected'",
    [firmId, client.id, periods],
  );
  const items = invs.length ? await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [invs.map((i) => i.id)]) : [];
  const withItems = invs.map((i) => ({ ...i, line_items: items.filter((l) => l.invoice_id === i.id) }));

  const sales = [], purchases = [];
  for (const inv of withItems) {
    const t = inv.invoice_type || "sales";
    if (t === "other") continue;
    if (t === "purchase" || inv.return_type === "gstr3b") purchases.push(...invoiceRows(inv, "purchase"));
    else if (isSalesSide(inv, client.gstin)) sales.push(...invoiceRows(inv, "sales"));
    else purchases.push(...invoiceRows(inv, "purchase"));
  }

  const seen = { sales: new Set(sales.map((r) => `${normInv(r.inv_no)}|${r.type}`)), purchase: new Set(purchases.map((r) => `${normInv(r.inv_no)}|${r.type}`)) };
  const ledgers = await db.query(
    "select id, kind, tax_period, original_filename, data from recon_files where firm_id=$1 and client_id=$2 and kind in ('sales_ledger','purchase_ledger')",
    [firmId, client.id],
  );
  const ledgerInfo = { sales: new Set(), purchase: new Set(), files: ledgers.length };
  const ledgerRows = { sales: [], purchase: [] };
  let skipped = 0;
  for (const f of ledgers) {
    const side = f.kind === "sales_ledger" ? "sales" : "purchase";
    const target = side === "sales" ? sales : purchases;
    for (const r of f.data?.rows || []) {
      const period = (r.date && r.date.slice(0, 7)) || f.tax_period;
      if (!period || !periods.includes(period)) continue;
      ledgerRows[side].push({ ...r, src: "ledger", period, rcm: Boolean(r.rcm), itc: r.itc !== false, hsn: "", file: f.original_filename });
      const k = `${normInv(r.inv_no)}|${r.type}`;
      if (normInv(r.inv_no) && seen[side === "sales" ? "sales" : "purchase"].has(k)) { skipped++; continue; }
      target.push({ ...r, src: "ledger", period, rcm: Boolean(r.rcm), itc: r.itc !== false, hsn: "" });
      ledgerInfo[side].add(period);
    }
  }
  return { sales, purchases, ledgerRows, pending_approval: pendingRow?.c || 0, ledgerInfo: { sales: [...ledgerInfo.sales], purchase: [...ledgerInfo.purchase], files: ledgerInfo.files, duplicates_skipped: skipped } };
}

/** uploaded portal files: GSTR-1 / GSTR-2B rows and GSTR-3B figures keyed by period */
export async function loadPortal(firmId, clientId, periods) {
  const files = await db.query(
    "select id, kind, tax_period, original_filename, row_count, data, created_at from recon_files where firm_id=$1 and client_id=$2 and kind in ('gstr1_portal','gstr2b','gstr3b') and tax_period = any($3::text[]) order by created_at",
    [firmId, clientId, periods],
  );
  const out = { gstr1: [], gstr2b: [], gstr3b: {}, periods: { gstr1: new Set(), gstr2b: new Set(), gstr3b: new Set() } };
  for (const f of files) {
    if (f.kind === "gstr3b") { const base = emptyFigures(), inc = f.data?.figures || {};
      for (const k of Object.keys(base.outward)) base.outward[k] = { ...base.outward[k], ...(inc.outward?.[k] || {}) };
      for (const k of Object.keys(base.itc)) base.itc[k] = { ...base.itc[k], ...(inc.itc?.[k] || {}) };
      out.gstr3b[f.tax_period] = base; out.periods.gstr3b.add(f.tax_period); continue; }
    const key = f.kind === "gstr1_portal" ? "gstr1" : "gstr2b";
    out.periods[key].add(f.tax_period);
    for (const r of f.data?.rows || []) out[key].push({ ...r, src: key, period: f.tax_period });
  }
  return out;
}
