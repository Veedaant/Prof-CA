import { db } from "../db/index.js";
import { generateSignedToken, putObject } from "./storage.js";
import { generatePurchaseExcel } from "./registerExporter.js";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const TYPES = ["purchase", "credit_note", "debit_note"];
export const EXCEL_TYPE = "gstr3b_purchase";
const downloadUrl = (id) => `/api/exports/download/${id}?token=${generateSignedToken(id, 1440)}`;

/** Purchase invoices, credit notes and debit notes the client has verified and sent for GSTR-3B, grouped by type. */
export async function sentPurchaseDocs(firmId, clientId, period) {
  const all = await db.query(
    `select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and return_type='gstr3b' and invoice_type = any($4::text[])
       and client_approved_at is not null and review_status <> 'rejected' and replaced_at is null order by invoice_date, created_at`,
    [firmId, clientId, period, TYPES],
  );
  const seen = new Set();
  const docs = all.filter((i) => {
    if (!i.invoice_number || !(i.supplier_gstin || i.buyer_gstin)) return true;
    const k = [i.invoice_type, String(i.supplier_gstin || "").toUpperCase(), String(i.buyer_gstin || "").toUpperCase(), String(i.invoice_number).trim().toUpperCase()].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const items = docs.length ? await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [docs.map((d) => d.id)]) : [];
  const withItems = docs.map((d) => ({ ...d, line_items: items.filter((l) => l.invoice_id === d.id) }));
  const out = { purchase: [], credit_note: [], debit_note: [], total: withItems.length };
  for (const d of withItems) out[d.invoice_type].push(d);
  return out;
}

/** Builds (or rebuilds) the purchase Excel for the month and stores it. Returns null when nothing has been sent. */
export async function prepareGstr3bExcel({ firmId, client, period, userId = null }) {
  const g = await sentPurchaseDocs(firmId, client.id, period);
  if (!g.total) return null;
  const buf = await generatePurchaseExcel(g, { clientName: client.name, clientGstin: client.gstin, taxPeriod: period });
  const fileName = `GSTR3B_purchases_${client.gstin || "CLIENT"}_${period}.xlsx`;
  const storagePath = `firms/${firmId}/exports/${Date.now()}_${fileName}`;
  await putObject(storagePath, buf, XLSX);
  const row = await db.one(
    `insert into exports (firm_id,client_id,tax_period,export_type,storage_path,file_name,invoice_count,generated_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [firmId, client.id, period, EXCEL_TYPE, storagePath, fileName, g.total, userId],
  );
  // only the newest prepared file per client and month is kept in the list
  await db.query("delete from exports where client_id=$1 and tax_period=$2 and export_type=$3 and id <> $4", [client.id, period, EXCEL_TYPE, row.id]);
  return excelInfo(firmId, client.id, period);
}

export async function prepareForClientId(firmId, clientId, period) {
  const client = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [clientId, firmId]);
  if (client) await prepareGstr3bExcel({ firmId, client, period });
}

/** The prepared Excel for the month, and whether the documents have changed since it was prepared. */
export async function excelInfo(firmId, clientId, period) {
  const ex = await db.one(
    "select id, file_name, invoice_count, created_at from exports where firm_id=$1 and client_id=$2 and tax_period=$3 and export_type=$4 order by created_at desc limit 1",
    [firmId, clientId, period, EXCEL_TYPE],
  );
  const g = await sentPurchaseDocs(firmId, clientId, period);
  const counts = { purchase: g.purchase.length, credit_note: g.credit_note.length, debit_note: g.debit_note.length, total: g.total };
  if (!ex) return { prepared: false, counts, stale: g.total > 0 };
  const latest = [...g.purchase, ...g.credit_note, ...g.debit_note].reduce((m, d) => Math.max(m, new Date(d.updated_at).getTime(), new Date(d.client_approved_at).getTime()), 0);
  return {
    prepared: true, id: ex.id, file_name: ex.file_name, prepared_at: ex.created_at, download_url: downloadUrl(ex.id),
    counts, stale: ex.invoice_count !== g.total || latest > new Date(ex.created_at).getTime(),
  };
}
