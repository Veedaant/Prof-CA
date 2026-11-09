import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { isUuid, parseBody, uuidParam, wrap } from "../http.js";
import { generateSignedToken, putObject, readFile, verifySignedToken } from "../services/storage.js";
import { generateGstr1Workbook, isSalesSide } from "../services/gstr1Exporter.js";
import { generateRegisterWorkbook, REGISTER_CATEGORIES } from "../services/registerExporter.js";
import { computeGstr3b, generateGstr3bWorkbook } from "../services/gstr3bExporter.js";
import { gate3b } from "./gstr3b.js";

const router = Router();
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const exportSchema = z.object({ client_id: z.string(), tax_period: z.string().regex(/^\d{4}-\d{2}$/, "must be YYYY-MM") });

const downloadUrl = (id) => `/api/exports/download/${id}?token=${generateSignedToken(id, 1440)}`;

async function getClient(firmId, clientId) {
  const c = isUuid(clientId) ? await db.one("select * from clients where id=$1 and firm_id=$2", [clientId, firmId]) : null;
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}

// Token-authenticated: browsers download via a plain link, so no Authorization header is available.
router.get("/download/:id", wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Export");
  if (verifySignedToken(String(req.query.token || "")) !== id) throw new HttpError(403, "Invalid or expired download token");
  const ex = await db.one("select * from exports where id=$1", [id]);
  if (!ex) throw new HttpError(404, "Export not found");
  let bytes;
  try { bytes = await readFile(ex.storage_path); } catch { throw new HttpError(404, "Export file missing from storage"); }
  res.setHeader("Content-Disposition", `attachment; filename="${ex.file_name.replace(/[^\w.\-]/g, "_")}"`);
  res.type(XLSX).send(bytes);
}));

router.use(authenticate, requireStaff);

router.post("/gstr1", wrap(async (req, res) => {
  const { client_id, tax_period } = parseBody(exportSchema, req.body);
  const includeUnreviewed = ["1", "true"].includes(String(req.query.include_unreviewed));
  const client = await getClient(req.user.firm_id, client_id);

  const sent = (await db.query("select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and client_approved_at is not null and review_status <> 'rejected' and return_type = 'gstr1' order by created_at", [req.user.firm_id, client.id, tax_period])).filter((i) => isSalesSide(i, client.gstin));
  // the same document uploaded twice would double-count tax: keep the first copy of each supplier + number + type
  const seenDoc = new Set();
  let duplicates = 0;
  const invoices = sent.filter((i) => {
    if (!i.invoice_number || !i.supplier_gstin) return true;
    const k = [i.invoice_type || "sales", String(i.supplier_gstin).toUpperCase(), String(i.invoice_number).trim().toUpperCase()].join("|");
    if (seenDoc.has(k)) { duplicates++; return false; }
    seenDoc.add(k);
    return true;
  });
  if (!invoices.length) throw new HttpError(400, `No invoices approved by ${client.name} and sent to the CA for tax period ${tax_period}.`);
  const approved = invoices;
  const unreviewed = [];
  if (!approved.length && !includeUnreviewed) {
    throw new HttpError(400, `Found ${unreviewed.length} unreviewed invoice(s) for ${client.name}. Please approve them in the review screen or enable 'Include Unreviewed' to generate a draft GSTR-1.`);
  }
  const selected = includeUnreviewed ? [...approved, ...unreviewed.filter((i) => i.review_status !== "rejected")] : approved;
  const ids = selected.map((i) => i.id);
  const items = ids.length ? await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [ids]) : [];
  const withItems = selected.map((i) => ({ ...i, line_items: items.filter((l) => l.invoice_id === i.id) }));

  const buf = await generateGstr1Workbook(withItems);
  const fileName = `GSTR1_${client.gstin || "CLIENT"}_${tax_period}.xlsx`;
  const storagePath = `firms/${req.user.firm_id}/exports/${Date.now()}_${fileName}`;
  await putObject(storagePath, buf, XLSX);
  const row = await db.one(
    `insert into exports (firm_id,client_id,tax_period,export_type,storage_path,file_name,invoice_count,generated_by_user_id)
     values ($1,$2,$3,'gstr1',$4,$5,$6,$7) returning id`,
    [req.user.firm_id, client.id, tax_period, storagePath, fileName, selected.length, req.user.id],
  );

  const excluded = invoices.length - selected.length;
  let warning = null;
  if (includeUnreviewed && unreviewed.length) warning = `Draft Export: Included ${selected.length - approved.length} unreviewed invoice(s) upon user request.`;
  if (duplicates) warning = `${duplicates} duplicate upload(s) of the same invoice were left out so tax is not counted twice.${warning ? " " + warning : ""}`;
  if (!warning && excluded > 0) warning = `${excluded} invoice(s) in ${tax_period} are unreviewed/rejected and were excluded from this GSTR-1.`;

  res.json({
    export_id: row.id, file_name: fileName, approved_count: approved.length, unreviewed_count: unreviewed.length,
    total_exported: selected.length, warning, download_url: downloadUrl(row.id),
  });
}));

// Excel for any document category (sales, purchase, credit notes, debit notes, other): only what the client has sent to the CA.
router.post("/register", wrap(async (req, res) => {
  const { client_id, tax_period } = parseBody(exportSchema, req.body);
  const category = String(req.body?.category || "");
  const cat = REGISTER_CATEGORIES[category];
  if (!cat) throw new HttpError(422, "category must be one of: sales, purchase, credit_note, debit_note, other");
  const returnType = String(req.body?.return_type || (category === "purchase" ? "gstr3b" : "gstr1"));
  const allowed = { gstr1: ["sales", "credit_note", "debit_note", "other"], gstr3b: ["purchase", "credit_note", "debit_note", "other"] };
  if (!allowed[returnType]?.includes(category)) throw new HttpError(422, `${cat.title} do not belong to ${returnType === "gstr3b" ? "GSTR-3B" : "GSTR-1"}`);
  const client = await getClient(req.user.firm_id, client_id);
  const all = await db.query(
    "select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and invoice_type=$4 and return_type=$5 and client_approved_at is not null and review_status <> 'rejected' order by invoice_date, created_at",
    [req.user.firm_id, client.id, tax_period, cat.type, returnType],
  );
  const seen = new Set();
  let duplicates = 0;
  const docs = all.filter((i) => {
    if (!i.invoice_number || !(i.supplier_gstin || i.buyer_gstin)) return true;
    const k = [String(i.supplier_gstin || "").toUpperCase(), String(i.buyer_gstin || "").toUpperCase(), String(i.invoice_number).trim().toUpperCase()].join("|");
    if (seen.has(k)) { duplicates++; return false; }
    seen.add(k);
    return true;
  });
  if (!docs.length) throw new HttpError(400, `No ${cat.title.toLowerCase()} approved by ${client.name} and sent to the CA for ${tax_period}.`);
  const ids = docs.map((i) => i.id);
  const items = await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [ids]);
  const withItems = docs.map((i) => ({ ...i, line_items: items.filter((l) => l.invoice_id === i.id) }));
  const buf = await generateRegisterWorkbook(withItems, { category, clientName: client.name, clientGstin: client.gstin, taxPeriod: tax_period, returnLabel: returnType === "gstr3b" ? "GSTR-3B" : "GSTR-1" });
  const fileName = `${returnType.toUpperCase()}_${category}_${client.gstin || "CLIENT"}_${tax_period}.xlsx`;
  const storagePath = `firms/${req.user.firm_id}/exports/${Date.now()}_${fileName}`;
  await putObject(storagePath, buf, XLSX);
  const row = await db.one(
    `insert into exports (firm_id,client_id,tax_period,export_type,storage_path,file_name,invoice_count,generated_by_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [req.user.firm_id, client.id, tax_period, `register_${category}`, storagePath, fileName, docs.length, req.user.id],
  );
  res.json({
    export_id: row.id, file_name: fileName, total_exported: docs.length,
    warning: duplicates ? `${duplicates} duplicate upload(s) of the same document were left out so it is not counted twice.` : null,
    download_url: downloadUrl(row.id),
  });
}));

// GSTR-3B working workbook: outward side from GSTR-1 documents, ITC side from GSTR-3B documents, both client-verified.
/** Everything the client has sent that feeds GSTR-3B: outward side from GSTR-1 documents, inward side from GSTR-3B documents. */
async function loadGstr3bInputs(firmId, client, taxPeriod) {
  const all = await db.query(
    "select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and client_approved_at is not null and review_status <> 'rejected' order by invoice_date, created_at",
    [firmId, client.id, taxPeriod],
  );
  const seen = new Set();
  let duplicates = 0;
  const docs = all.filter((i) => {
    if (!i.invoice_number || !(i.supplier_gstin || i.buyer_gstin)) return true;
    const k = [i.return_type, i.invoice_type, String(i.supplier_gstin || "").toUpperCase(), String(i.buyer_gstin || "").toUpperCase(), String(i.invoice_number).trim().toUpperCase()].join("|");
    if (seen.has(k)) { duplicates++; return false; }
    seen.add(k);
    return true;
  });
  const usable = docs.filter((i) => (i.return_type === "gstr1" && ["sales", "credit_note", "debit_note"].includes(i.invoice_type)) || (i.return_type === "gstr3b" && ["purchase", "credit_note", "debit_note"].includes(i.invoice_type)));
  const items = usable.length ? await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [usable.map((i) => i.id)]) : [];
  const withItems = usable.map((i) => ({ ...i, line_items: items.filter((l) => l.invoice_id === i.id) }));
  const unsent = await db.one(
    "select count(*)::int as c from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and client_approved_at is null and review_status <> 'rejected' and invoice_type in ('sales','purchase','credit_note','debit_note')",
    [firmId, client.id, taxPeriod],
  );
  return {
    usable, duplicates, unsent: unsent?.c || 0,
    outwardDocs: withItems.filter((i) => i.return_type === "gstr1"),
    inwardDocs: withItems.filter((i) => i.return_type === "gstr3b"),
  };
}

const TYPE_NAME = { sales: "Sales invoice", purchase: "Purchase invoice", credit_note: "Credit note", debit_note: "Debit note" };
const docRow = (i) => ({
  id: i.id, type: TYPE_NAME[i.invoice_type] || i.invoice_type, number: i.invoice_number || "", date: i.invoice_date ? String(i.invoice_date).slice(0, 10) : null,
  party: (i.return_type === "gstr3b" ? i.supplier_name : i.buyer_name) || "", gstin: (i.return_type === "gstr3b" ? i.supplier_gstin : i.buyer_gstin) || "",
  taxable: Number(i.total_taxable_value) || 0, tax: Number(i.total_tax) || 0, total: Number(i.invoice_total) || 0, reverse_charge: Boolean(i.reverse_charge),
});

// What will go into the GSTR-3B workbook, with draft figures. Visible before the month is verified; only the download is gated.
router.get("/gstr3b/preview", wrap(async (req, res) => {
  const { client_id, tax_period } = parseBody(exportSchema, req.query);
  const client = await getClient(req.user.firm_id, client_id);
  const gate = await gate3b(req.user.firm_id, client, tax_period);
  const review = await db.one("select status from gstr3b_reviews where client_id=$1 and tax_period=$2", [client.id, tax_period]);
  const inp = await loadGstr3bInputs(req.user.firm_id, client, tax_period);
  const result = computeGstr3b(inp.outwardDocs, inp.inwardDocs, client.gstin, tax_period);
  res.json({
    gate: { ok: gate.ok, message: gate.ok ? null : gate.message, review_status: review?.status || "pending" },
    outward: inp.outwardDocs.map(docRow), inward: inp.inwardDocs.map(docRow), unsent: inp.unsent, duplicates: inp.duplicates,
    summary: { outward_tax: result.t31.a, itc_net: result.t4.net, cash_payable: result.t61.cash, carry_forward: result.t61.carry_forward },
  });
}));

router.post("/gstr3b", wrap(async (req, res) => {
  const { client_id, tax_period } = parseBody(exportSchema, req.body);
  const client = await getClient(req.user.firm_id, client_id);
  const gate = await gate3b(req.user.firm_id, client, tax_period);
  if (!gate.ok) throw new HttpError(409, gate.message);
  const { usable, outwardDocs, inwardDocs, duplicates } = await loadGstr3bInputs(req.user.firm_id, client, tax_period);
  if (!usable.length) throw new HttpError(400, `Nothing approved by ${client.name} and sent to the CA for ${tax_period} that feeds GSTR-3B.`);

  const result = computeGstr3b(outwardDocs, inwardDocs, client.gstin, tax_period);
  const buf = await generateGstr3bWorkbook(result, { clientName: client.name, clientGstin: client.gstin, taxPeriod: tax_period });
  const fileName = `GSTR3B_${client.gstin || "CLIENT"}_${tax_period}.xlsx`;
  const storagePath = `firms/${req.user.firm_id}/exports/${Date.now()}_${fileName}`;
  await putObject(storagePath, buf, XLSX);
  const row = await db.one(
    `insert into exports (firm_id,client_id,tax_period,export_type,storage_path,file_name,invoice_count,generated_by_user_id)
     values ($1,$2,$3,'gstr3b',$4,$5,$6,$7) returning id`,
    [req.user.firm_id, client.id, tax_period, storagePath, fileName, usable.length, req.user.id],
  );
  res.json({
    export_id: row.id, file_name: fileName, total_exported: usable.length,
    outward_documents: outwardDocs.length, inward_documents: inwardDocs.length,
    summary: { outward_tax: result.t31.a, itc_net: result.t4.net, cash_payable: result.t61.cash, carry_forward: result.t61.carry_forward },
    warning: duplicates ? `${duplicates} duplicate upload(s) of the same document were left out so it is not counted twice.` : null,
    download_url: downloadUrl(row.id),
  });
}));

router.post("/approve-all", wrap(async (req, res) => {
  const { client_id, tax_period } = req.query;
  if (!client_id || !tax_period) throw new HttpError(422, "client_id and tax_period are required");
  const client = await getClient(req.user.firm_id, String(client_id));
  const result = await db.tx(async (q) => {
    const rows = await q(
      "select id, review_status from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and review_status='needs_review'",
      [req.user.firm_id, client.id, String(tax_period)],
    );
    for (const r of rows) {
      await q("update invoices set review_status='approved', updated_at=now() where id=$1", [r.id]);
      await q(
        "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'review_status',$4,$5)",
        [r.id, req.user.id, req.user.full_name, r.review_status, "approved (Bulk approved for GSTR-1)"],
      );
    }
    return rows.length;
  });
  res.json({ message: `Successfully approved ${result} invoice(s) for ${tax_period}`, approved_count: result });
}));

router.get("/history", wrap(async (req, res) => {
  const params = [req.user.firm_id];
  let sql = `select e.*, c.name as client_name from exports e join clients c on c.id=e.client_id where e.firm_id=$1`;
  if (req.query.client_id) {
    if (!isUuid(req.query.client_id)) return res.json([]);
    params.push(req.query.client_id);
    sql += " and e.client_id=$2";
  }
  const rows = await db.query(`${sql} order by e.created_at desc limit 50`, params);
  res.json(rows.map((e) => ({
    id: e.id, client_id: e.client_id, client_name: e.client_name, tax_period: e.tax_period, export_type: e.export_type,
    file_name: e.file_name, invoice_count: e.invoice_count, created_at: e.created_at, download_url: downloadUrl(e.id),
  })));
}));

export default router;
