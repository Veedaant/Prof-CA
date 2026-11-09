import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { createQueue, isUuid, parseBody, uuidParam, wrap } from "../http.js";
import { generateSignedToken, readFile, saveFile } from "../services/storage.js";
import { runExtractionPipeline } from "../services/extractor.js";
import { validateInvoice } from "../services/validators.js";
import { notify } from "../services/notify.js";
import { prepareForClientId } from "../services/purchaseExcel.js";

const DOC_NAME = { sales: "sales invoice", purchase: "purchase invoice", credit_note: "credit note", debit_note: "debit note", other: "document" };
const docLabel = (inv) => `${DOC_NAME[inv.invoice_type] || "document"} ${inv.invoice_number || "(no number)"}`;
const returnName = (inv) => (inv.return_type === "gstr3b" ? "GSTR-3B" : "GSTR-1");

const router = Router();
router.use(authenticate);

const queue = createQueue(2);
const ALLOWED_EXT = new Set([".pdf", ".png", ".jpg", ".jpeg", ".heic", ".heif"]);
const MIME_BY_EXT = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif" };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 50 },
});

const RETURN_CATEGORIES = {
  gstr1: ["sales", "credit_note", "debit_note", "other"],
  gstr3b: ["purchase", "credit_note", "debit_note", "other"],
};

const EDITABLE = [
  "supplier_name", "supplier_gstin", "supplier_state", "buyer_name", "buyer_gstin", "buyer_state",
  "invoice_number", "invoice_date", "place_of_supply", "reverse_charge", "tax_period",
  "total_taxable_value", "cgst_total", "sgst_total", "igst_total", "cess_total", "total_tax", "invoice_total",
];

const num = z.coerce.number().finite();
const lineItemSchema = z.object({
  description: z.string().nullish(),
  hsn_sac: z.string().nullish(),
  quantity: num.optional(),
  unit: z.string().optional(),
  uqc: z.string().optional(),
  rate: num.optional(),
  taxable_value: num.optional(),
  total_value: num.optional(),
  cgst_rate: num.optional(), cgst_amount: num.optional(),
  sgst_rate: num.optional(), sgst_amount: num.optional(),
  igst_rate: num.optional(), igst_amount: num.optional(),
  cess: num.optional(),
});
const updateSchema = z.object({
  supplier_name: z.string().nullish(), supplier_gstin: z.string().nullish(), supplier_state: z.string().nullish(),
  buyer_name: z.string().nullish(), buyer_gstin: z.string().nullish(), buyer_state: z.string().nullish(),
  invoice_number: z.string().nullish(), invoice_date: z.string().nullish(), place_of_supply: z.string().nullish(),
  reverse_charge: z.boolean().optional(), tax_period: z.string().nullish(),
  total_taxable_value: num.optional(), cgst_total: num.optional(), sgst_total: num.optional(),
  igst_total: num.optional(), cess_total: num.optional(), total_tax: num.optional(), invoice_total: num.optional(),
  line_items: z.array(lineItemSchema).optional(),
});
const reviewSchema = z.object({ action: z.enum(["approve", "reject"]), reason: z.string().nullish() });

async function insertLineItems(q, invoiceId, items, defaultConfidence) {
  let idx = 0;
  for (const it of items) {
    const taxable = Number(it.taxable_value) || 0;
    const cgst = Number(it.cgst_amount) || 0, sgst = Number(it.sgst_amount) || 0;
    const igst = Number(it.igst_amount) || 0, cess = Number(it.cess) || 0;
    const unit = it.unit || "NOS";
    await q(
      `insert into line_items (invoice_id,item_index,description,hsn_sac,quantity,unit,uqc,rate,taxable_value,total_value,
        cgst_rate,cgst_amount,sgst_rate,sgst_amount,igst_rate,igst_amount,cess,confidence)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [invoiceId, idx++, it.description ?? null, it.hsn_sac ?? "", it.quantity ?? 1, unit,
        it.uqc || `${unit}-NUMBERS`, Number(it.rate) || 0, taxable,
        Number(it.total_value) || taxable + cgst + sgst + igst + cess,
        Number(it.cgst_rate) || 0, cgst, Number(it.sgst_rate) || 0, sgst, Number(it.igst_rate) || 0, igst, cess,
        it.confidence ?? defaultConfidence],
    );
  }
}

async function processFile(fileId, invoiceType, taxPeriod) {
  const file = await db.one("select * from invoice_files where id=$1", [fileId]);
  if (!file) return;
  try {
    await db.query("update invoice_files set status='processing', error_message=null, progress=5, progress_label='Starting' where id=$1", [fileId]);
    const bytes = await readFile(file.storage_path);
    const progress = (pct, label) => db.query("update invoice_files set progress=$2, progress_label=$3 where id=$1", [fileId, pct, label]).catch(() => {});
    const r = await runExtractionPipeline(bytes, file.original_filename, file.mime_type, taxPeriod, progress);
    await progress(90, "Saving the extracted data");
    await db.query(
      "update invoice_files set blur_score=$2, is_blurry=$3, is_dark=$4 where id=$1",
      [fileId, r.quality.blur_score, r.quality.is_blurry, r.quality.is_dark],
    );

    const inv = r.invoice_data;
    let clientId = file.client_id;
    for (const g of [inv.supplier_gstin, inv.buyer_gstin]) {
      if (!g) continue;
      const m = await db.one("select id from clients where firm_id=$1 and upper(gstin)=upper($2)", [file.firm_id, g.trim()]);
      if (m) { clientId = m.id; break; }
    }

    const flags = [...r.flags];
    let status = r.review_status;
    if (inv.supplier_gstin && inv.invoice_number) {
      const dup = await db.one(
        `select id from invoices where firm_id=$1 and client_id=$2 and supplier_gstin=$3 and invoice_number=$4
           and source_file_id is distinct from $5 and id is distinct from $6::uuid and replaced_at is null limit 1`,
        [file.firm_id, clientId, inv.supplier_gstin, inv.invoice_number, fileId, file.replaces_invoice_id || null],
      );
      if (dup) {
        flags.push({ type: "duplicate_invoice_detected", severity: "error", field: "invoice_number", message: `Invoice ${inv.invoice_number} from ${inv.supplier_gstin} already exists for this client.` });
        status = "needs_review";
      }
    }
    const period = taxPeriod || (inv.invoice_date ? String(inv.invoice_date).slice(0, 7) : null);

    await db.tx(async (q) => {
      const vals = [
        clientId, invoiceType, inv.supplier_name, inv.supplier_gstin, inv.supplier_state,
        inv.buyer_name, inv.buyer_gstin, inv.buyer_state, inv.invoice_number, inv.invoice_date,
        inv.place_of_supply, inv.reverse_charge, inv.total_taxable_value, inv.cgst_total, inv.sgst_total,
        inv.igst_total, inv.cess_total, inv.total_tax, inv.invoice_total, r.confidence.overall,
        JSON.stringify(r.confidence.fields || {}), status, period, JSON.stringify(flags),
        r.qr_data ? JSON.stringify(r.qr_data) : null, JSON.stringify(r.raw_ai_data ?? {}),
        file.return_type || (invoiceType === "purchase" ? "gstr3b" : "gstr1"),
      ];
      const cols = ["client_id", "invoice_type", "supplier_name", "supplier_gstin", "supplier_state", "buyer_name", "buyer_gstin",
        "buyer_state", "invoice_number", "invoice_date", "place_of_supply", "reverse_charge", "total_taxable_value", "cgst_total",
        "sgst_total", "igst_total", "cess_total", "total_tax", "invoice_total", "overall_confidence", "field_confidences",
        "review_status", "tax_period", "flags", "qr_data", "raw_extraction", "return_type"];
      const jsonCols = new Set(["field_confidences", "flags", "qr_data", "raw_extraction"]);
      const ph = cols.map((c, i) => (jsonCols.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
      const existing = (await q("select id from invoices where source_file_id=$1", [fileId]))[0];
      let invoiceId;
      if (existing) {
        invoiceId = existing.id;
        await q(`update invoices set ${cols.map((c, i) => `${c}=${ph[i]}`).join(",")}, updated_at=now() where id=$${cols.length + 1}`, [...vals, invoiceId]);
        await q("delete from line_items where invoice_id=$1", [invoiceId]);
      } else {
        const row = (await q(
          `insert into invoices (firm_id, source_file_id, ${cols.join(",")}) values ($${cols.length + 1}, $${cols.length + 2}, ${ph.join(",")}) returning id`,
          [...vals, file.firm_id, fileId],
        ))[0];
        invoiceId = row.id;
      }
      await insertLineItems(q, invoiceId, r.line_items, 0.95);
      await q(
        "insert into audit_logs (invoice_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,$4,$5)",
        [invoiceId, "AI Extraction Pipeline", "extraction", null, `Extracted with status ${status} (conf: ${r.confidence.overall.toFixed(2)})`],
      );
      await q("update invoices set client_confirmation='not_required', client_confirmed_at=null, client_confirmed_by=null, client_note=null, client_approved_at=null, client_approved_by=null where id=$1", [invoiceId]);
      await q("update invoice_files set status='done', progress=100, progress_label='Done' where id=$1", [fileId]);
      if (file.replaces_invoice_id) {
        await q("update invoices set review_status='rejected', replaced_at=now(), updated_at=now() where id=$1 and replaced_at is null", [file.replaces_invoice_id]);
        await q("insert into audit_logs (invoice_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,$4,$5)", [file.replaces_invoice_id, "Client re-upload", "replaced", null, "Replaced by a corrected re-upload"]);
      }
    });
  } catch (e) {
    console.error("[process]", fileId, e);
    await db.query("update invoice_files set status='failed', error_message=$2 where id=$1", [fileId, String(e.message || e).slice(0, 1000)]).catch(() => {});
  }
}

router.post("/upload", upload.array("files", 50), wrap(async (req, res) => {
  const u = req.user;
  const clientId = req.body.client_id;
  const rawType = req.body.doc_category || req.body.invoice_type;
  let invoiceType = ["sales", "purchase", "credit_note", "debit_note", "other"].includes(rawType) ? rawType : "sales";
  const rawReturn = String(req.body.return_type || "");
  let returnType = RETURN_CATEGORIES[rawReturn] ? rawReturn : invoiceType === "purchase" ? "gstr3b" : "gstr1";
  if (!RETURN_CATEGORIES[returnType].includes(invoiceType)) {
    throw new HttpError(400, returnType === "gstr1" ? "GSTR-1 takes sales invoices, credit notes, debit notes and other documents. Purchase invoices go under GSTR-3B." : "GSTR-3B takes purchase invoices, credit notes, debit notes and other documents. Sales invoices go under GSTR-1.");
  }
  const now = new Date();
  const currentPeriod = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let taxPeriod = req.body.tax_period && /^\d{4}-(0[1-9]|1[0-2])$/.test(req.body.tax_period) ? req.body.tax_period : currentPeriod;
  if (!isUuid(clientId)) throw new HttpError(404, "Client not found");
  if (u.role === "client" && u.client_id !== clientId) throw new HttpError(403, "Clients may only upload for their own account");
  const client = await db.one("select id from clients where id=$1 and firm_id=$2", [clientId, u.firm_id]);
  if (!client) throw new HttpError(404, "Client not found");
  const files = req.files || [];
  if (!files.length) throw new HttpError(400, "No files uploaded");
  let replacesId = null;
  if (req.body.replaces) {
    if (!isUuid(req.body.replaces)) throw new HttpError(422, "Invalid document to replace");
    const old = await db.one("select id, invoice_type, return_type, tax_period from invoices where id=$1 and firm_id=$2 and client_id=$3 and replaced_at is null and review_status <> 'rejected'", [req.body.replaces, u.firm_id, clientId]);
    if (!old) throw new HttpError(404, "The document to replace was not found");
    if (files.length !== 1) throw new HttpError(422, "Re-upload one corrected file at a time");
    replacesId = old.id;
    invoiceType = old.invoice_type;
    returnType = old.return_type || returnType;
    taxPeriod = old.tax_period || taxPeriod;
  }
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) throw new HttpError(400, `Unsupported file type '${ext || f.originalname}'. Allowed: PDF, PNG, JPG, HEIC.`);
  }

  const out = [];
  for (const f of files) {
    const ext = path.extname(f.originalname).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    const saved = await saveFile(f.buffer, f.originalname, u.firm_id, clientId, mime);
    const dup = await db.one("select 1 as x from invoice_files where firm_id=$1 and client_id=$2 and file_hash=$3 limit 1", [u.firm_id, clientId, saved.fileHash]);
    const row = await db.one(
      `insert into invoice_files (firm_id,client_id,storage_path,original_filename,file_size,mime_type,file_hash,status,doc_category,tax_period,return_type,replaces_invoice_id)
       values ($1,$2,$3,$4,$5,$6,$7,'queued',$8,$9,$10,$11) returning id`,
      [u.firm_id, clientId, saved.storagePath, f.originalname.slice(0, 255), saved.fileSize, mime, saved.fileHash, invoiceType, taxPeriod, returnType, replacesId],
    );
    queue.add(() => processFile(row.id, invoiceType, taxPeriod));
    out.push({
      file_id: row.id, filename: f.originalname, status: "queued",
      warning_message: dup ? "Warning: An identical file was previously uploaded for this client." : null,
    });
  }
  res.json(out);
}));

const listSelect = `
  select i.*, c.name as client_name, f.original_filename as source_filename,
    coalesce(f.created_at, i.created_at) as uploaded_at,
    coalesce(f.created_at, i.created_at) + interval '24 hours' as editable_until,
    (select count(*)::int from line_items l where l.invoice_id=i.id) as line_items_count
  from invoices i
  join clients c on c.id=i.client_id
  left join invoice_files f on f.id=i.source_file_id`;

// Strip heavy internal columns from API output.
const slim = ({ raw_extraction, ...rest }) => rest;

router.get("/", wrap(async (req, res) => {
  const u = req.user;
  const { tax_period, review_status, invoice_type, search } = req.query;
  let client_id = req.query.client_id;
  if (u.role === "client") client_id = u.client_id;
  const where = ["i.firm_id=$1"];
  if (u.role !== "client") where.push(STAFF_VISIBLE);
  where.push("i.replaced_at is null");
  const params = [u.firm_id];
  const add = (sql, v) => { params.push(v); where.push(sql.replace("?", `$${params.length}`)); };
  if (client_id) { if (!isUuid(client_id)) return res.json([]); add("i.client_id=?", client_id); }
  if (tax_period) add("i.tax_period=?", String(tax_period));
  if (review_status) add("i.review_status=?", String(review_status));
  if (invoice_type) add("i.invoice_type=?", String(invoice_type));
  if (search) {
    params.push(`%${String(search).replace(/[%_\\]/g, "\\$&")}%`);
    const p = `$${params.length}`;
    where.push(`(i.invoice_number ilike ${p} or i.supplier_name ilike ${p} or i.buyer_name ilike ${p} or i.supplier_gstin ilike ${p} or i.buyer_gstin ilike ${p})`);
  }
  const skip = Math.max(0, parseInt(req.query.skip) || 0);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 50));
  params.push(limit, skip);
  const rows = await db.query(
    `${listSelect} where ${where.join(" and ")} order by i.created_at desc limit $${params.length - 1} offset $${params.length}`,
    params,
  );
  res.json(rows.map(slim));
}));

// CA staff only see invoices the client has verified and sent over.
const STAFF_VISIBLE = "i.client_approved_at is not null";
const editWindowOpen = (inv) => Boolean(inv.editable_until) && new Date(inv.editable_until).getTime() > Date.now();
const STAGES = ["Uploaded", "Data retrieved", "Your verification", "Sent to CA", "Excel downloaded"];

function stageOf(row) {
  if (row.file_status === "failed") return { key: "failed", step: 1, label: "Processing failed" };
  if (!row.invoice_id) return { key: "processing", step: 1, label: "Reading your document" };
  if (row.review_status === "rejected") return { key: "rejected", step: 2, label: "Rejected" };
  if (row.client_approved_at) {
    if (row.exported) return { key: "completed", step: 4, label: "Completed - included in GSTR-1 Excel" };
    return { key: "with_staff", step: 3, label: "Sent to CA staff" };
  }
  return { key: "client_review", step: 2, label: "Data retrieved - please verify and send to CA" };
}

router.get("/requests", wrap(async (req, res) => {
  const u = req.user;
  const params = [u.firm_id];
  let scope = "";
  if (u.role === "client") { params.push(u.client_id); scope = " and f.client_id=$2"; }
  const rows = await db.query(
    `select f.id as file_id, f.original_filename, f.status as file_status, f.progress, f.progress_label, f.error_message, f.created_at as uploaded_at,
       f.client_id, c.name as client_name, i.id as invoice_id, i.invoice_number, i.invoice_total, i.review_status,
       i.client_confirmation, i.client_confirmed_at, i.client_note, i.updated_at, i.client_approved_at, i.alert_for, i.alert_text, i.alert_at, f.created_at + interval '24 hours' as editable_until, coalesce(i.invoice_type, f.doc_category) as invoice_type, coalesce(i.return_type, f.return_type) as return_type, coalesce(i.tax_period, f.tax_period) as tax_period,
       exists (select 1 from exports e where e.client_id=i.client_id and e.tax_period=i.tax_period and e.created_at > i.client_approved_at) as exported
     from invoice_files f join clients c on c.id=f.client_id
     left join invoices i on i.source_file_id=f.id
     where f.firm_id=$1${scope}${u.role === "client" ? "" : " and i.client_approved_at is not null"} and (i.id is null or i.replaced_at is null) order by f.created_at desc limit 200`,
    params,
  );
  res.json({ steps: STAGES, requests: rows.map((r) => ({ ...r, stage: stageOf(r) })) });
}));

router.post("/:id/confirm", wrap(async (req, res) => {
  if (req.user.role !== "client") throw new HttpError(403, "Only the client can confirm their invoice");
  const id = uuidParam(req.params.id, "Invoice");
  const { action, note } = parseBody(z.object({ action: z.enum(["confirm", "request_changes"]), note: z.string().max(1000).optional().nullable() }), req.body);
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (!["approved", "auto_approved"].includes(inv.review_status) || inv.client_confirmation !== "pending")
    throw new HttpError(400, "This invoice is not waiting for your confirmation");
  if (action === "request_changes" && !(note || "").trim()) throw new HttpError(422, "Please describe what needs to be corrected");
  await db.tx(async (q) => {
    if (action === "confirm") {
      await q("update invoices set client_confirmation='confirmed', client_confirmed_at=now(), client_confirmed_by=$2, client_note=$3, client_approved_at=now(), client_approved_by=$2, updated_at=now() where id=$1", [id, req.user.id, note || null]);
    } else {
      await q("update invoices set client_confirmation='changes_requested', client_note=$3, review_status='needs_review', client_approved_at=null, client_confirmed_by=$2, updated_at=now() where id=$1", [id, req.user.id, note]);
    }
    await q(
      "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'client_confirmation',$4,$5)",
      [id, req.user.id, req.user.full_name, inv.client_confirmation, action === "confirm" ? "confirmed by client" : `changes requested: ${note}`],
    );
  });
  res.json(await detail(await loadInvoice(req, id)));
}));

router.post("/:id/client-approve", wrap(async (req, res) => {
  if (req.user.role !== "client") throw new HttpError(403, "Only the client can verify and send their own invoice");
  const id = uuidParam(req.params.id, "Invoice");
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (inv.review_status === "rejected") throw new HttpError(400, "This invoice was rejected");
  if (inv.client_approved_at) throw new HttpError(400, "You have already sent this invoice to the CA");
  if (inv.review_status === "processing" || inv.review_status === "uploaded") throw new HttpError(400, "Extraction is still running");
  await db.tx(async (q) => {
    await q(
      "update invoices set client_approved_at=now(), client_approved_by=$2, client_confirmation='confirmed', client_confirmed_at=now(), client_confirmed_by=$2, review_status='approved', alert_for=null, alert_text=null, alert_at=null, updated_at=now() where id=$1",
      [id, req.user.id],
    );
    await q(
      "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'client_approval',$4,'verified by client; sent to CA staff')",
      [id, req.user.id, req.user.full_name, inv.review_status],
    );
  });
  await notify({ firmId: req.user.firm_id, audience: "staff", clientId: inv.client_id, kind: "doc_sent", title: `${inv.client_name} sent a ${docLabel(inv)}`, body: `For ${returnName(inv)} · ${inv.tax_period || ""}`, link: inv.return_type === "gstr3b" ? "/verify-3b" : "/requests", actor: req.user });
  if (inv.return_type === "gstr3b" && ["purchase", "credit_note", "debit_note"].includes(inv.invoice_type)) {
    prepareForClientId(req.user.firm_id, inv.client_id, inv.tax_period).catch((e) => console.error("[purchase excel]", e.message));
  }
  res.json(await detail(await loadInvoice(req, id)));
}));

router.post("/:id/unsend", wrap(async (req, res) => {
  if (req.user.role !== "client") throw new HttpError(403, "Only the client can unsend their own invoice");
  const id = uuidParam(req.params.id, "Invoice");
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (!inv.client_approved_at) throw new HttpError(400, "This invoice has not been sent to the CA");
  if (!editWindowOpen(inv)) throw new HttpError(403, "The 24-hour window for this invoice has ended; ask your CA firm to change it.");
  await db.tx(async (q) => {
    await q(
      "update invoices set client_approved_at=null, client_approved_by=null, client_confirmation='not_required', client_confirmed_at=null, client_confirmed_by=null, alert_for=null, alert_text=null, alert_at=null, updated_at=now() where id=$1",
      [id],
    );
    await q(
      "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'client_approval','sent to CA staff','unsent by client')",
      [id, req.user.id, req.user.full_name],
    );
  });
  await notify({ firmId: req.user.firm_id, audience: "staff", clientId: inv.client_id, kind: "doc_unsent", title: `${inv.client_name} took back ${docLabel(inv)}`, body: `It is no longer visible to you until it is sent again (${returnName(inv)} · ${inv.tax_period || ""})`, link: "/requests", actor: req.user });
  res.json(await detail(await loadInvoice(req, id)));
}));

router.post("/:id/ack", wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Invoice");
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  const mine = req.user.role === "client" ? "client" : "staff";
  if (inv.alert_for === mine) {
    await db.query("update invoices set alert_for=null, alert_text=null, alert_at=null where id=$1", [id]);
    await db.query(
      "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'change_alert',$4,'marked as reviewed')",
      [id, req.user.id, req.user.full_name, inv.alert_text],
    );
  }
  res.json(await detail(await loadInvoice(req, id)));
}));

router.get("/queue/next", requireStaff, wrap(async (req, res) => {
  const { current_invoice_id, client_id } = req.query;
  const params = [req.user.firm_id];
  let sql = "select id from invoices where firm_id=$1 and client_approved_at is not null and review_status='needs_review'";
  if (client_id && isUuid(client_id)) { params.push(client_id); sql += ` and client_id=$${params.length}`; }
  const ids = (await db.query(`${sql} order by created_at desc`, params)).map((r) => r.id);
  const pos = ids.indexOf(current_invoice_id);
  res.json({
    current_id: current_invoice_id || null,
    prev_id: pos > 0 ? ids[pos - 1] : null,
    next_id: pos >= 0 ? (ids[pos + 1] ?? null) : (ids[0] ?? null),
    total_in_queue: ids.length,
  });
}));

async function loadInvoice(req, id) {
  const params = [id, req.user.firm_id];
  let scope = "";
  if (req.user.role === "client") { params.push(req.user.client_id); scope = " and i.client_id=$3"; }
  else scope = " and i.client_approved_at is not null";
  return db.one(`${listSelect} where i.id=$1 and i.firm_id=$2${scope}`, params);
}

async function detail(inv) {
  const items = await db.query("select * from line_items where invoice_id=$1 order by item_index", [inv.id]);
  const logs = await db.query("select * from audit_logs where invoice_id=$1 order by created_at desc", [inv.id]);
  return {
    ...slim(inv),
    line_items: items,
    audit_logs: logs,
    file_preview_url: inv.source_file_id ? `/api/files/${inv.source_file_id}/view?token=${generateSignedToken(inv.source_file_id, 120)}` : null,
  };
}

router.get("/:id", wrap(async (req, res) => {
  const inv = await loadInvoice(req, uuidParam(req.params.id, "Invoice"));
  if (!inv) throw new HttpError(404, "Invoice not found");
  res.json(await detail(inv));
}));

router.put("/:id", wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Invoice");
  const body = parseBody(updateSchema, req.body);
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (req.user.role === "client" && inv.client_approved_at && !editWindowOpen(inv)) throw new HttpError(403, "The 24-hour edit window for this invoice has ended; ask your CA firm to change it.");
  const changed = EDITABLE.filter((f) => body[f] !== undefined && JSON.stringify(body[f]) !== JSON.stringify(inv[f]));
  if (body.line_items) changed.push("line_items");
  const u = req.user;

  await db.tx(async (q) => {
    const sets = [], vals = [];
    for (const f of EDITABLE) {
      if (body[f] === undefined) continue;
      const nv = body[f];
      if (JSON.stringify(nv) === JSON.stringify(inv[f])) continue;
      vals.push(nv);
      sets.push(`${f}=$${vals.length}`);
      await q(
        "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,$4,$5,$6)",
        [id, u.id, u.full_name, f, inv[f] == null ? null : String(inv[f]), nv == null ? null : String(nv)],
      );
    }
    let items = null;
    if (body.line_items) {
      await q("delete from line_items where invoice_id=$1", [id]);
      await insertLineItems(q, id, body.line_items, 1.0);
      await q(
        "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'line_items',null,$4)",
        [id, u.id, u.full_name, `Updated ${body.line_items.length} line items`],
      );
    }
    items = await q("select * from line_items where invoice_id=$1 order by item_index", [id]);
    const merged = { ...inv, ...Object.fromEntries(EDITABLE.filter((f) => body[f] !== undefined).map((f) => [f, body[f]])) };
    const flags = validateInvoice(merged, items, merged.tax_period, inv.qr_data);
    vals.push(JSON.stringify(flags));
    sets.push(`flags=$${vals.length}::jsonb`, "updated_at=now()");
    const edited = EDITABLE.filter((f) => body[f] !== undefined && JSON.stringify(body[f]) !== JSON.stringify(inv[f]));
    if (edited.length) {
      const fcm = { ...(inv.field_confidences || {}) };
      for (const f of edited) fcm[f] = 1;
      if (edited.some((f) => /total|tax|taxable/.test(f))) fcm.totals = 1;
      vals.push(JSON.stringify(fcm));
      sets.push(`field_confidences=$${vals.length}::jsonb`);
    }
    vals.push(id);
    await q(`update invoices set ${sets.join(",")} where id=$${vals.length}`, vals);
    if (changed.length && inv.client_approved_at) {
      const by = req.user.role === "client" ? "client" : "CA firm";
      await q("update invoices set alert_for=$2, alert_text=$3, alert_at=now() where id=$1", [id, req.user.role === "client" ? "staff" : "client", `Edited by ${by} (${changed.map((f) => f.replace(/_/g, " ")).join(", ")}) - please review again.`]);
    }
  });
  if (changed.length && inv.client_approved_at) {
    const list = changed.map((f) => f.replace(/_/g, " ")).join(", ");
    if (req.user.role === "client") {
      await notify({ firmId: req.user.firm_id, audience: "staff", clientId: inv.client_id, kind: "doc_edited", title: `${inv.client_name} edited ${docLabel(inv)}`, body: `Changed: ${list}. Please review it again.`, link: "/requests", actor: req.user });
    } else {
      await notify({ firmId: req.user.firm_id, audience: "client", clientId: inv.client_id, kind: "doc_edited", title: `Your CA firm changed ${docLabel(inv)}`, body: `Changed: ${list}. Please review it.`, link: "/gst", actor: req.user });
    }
  }
  res.json(await detail(await loadInvoice(req, id)));
}));

router.post("/:id/review", requireStaff, wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Invoice");
  const { action, reason } = parseBody(reviewSchema, req.body);
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  const next = action === "approve" ? "approved" : "rejected";
  await db.tx(async (q) => {
    if (next === "approved") {
      const fc = Object.fromEntries(["overall", "supplier_name", "buyer_name", "supplier_gstin", "buyer_gstin", "invoice_number", "invoice_date", "place_of_supply", "totals"].map((k) => [k, 1]));
      await q("update invoices set review_status=$2, overall_confidence=1, field_confidences=$3::jsonb, updated_at=now() where id=$1", [id, next, JSON.stringify({ ...(inv.field_confidences || {}), ...fc })]);
    } else {
      await q("update invoices set review_status=$2, updated_at=now() where id=$1", [id, next]);
    }
    await q(
      "insert into audit_logs (invoice_id,user_id,user_name,field_name,old_value,new_value) values ($1,$2,$3,'review_status',$4,$5)",
      [id, req.user.id, req.user.full_name, inv.review_status, `${next} (Reason: ${reason || "None provided"})`],
    );
  });
  if (next === "rejected") {
    await notify({ firmId: req.user.firm_id, audience: "client", clientId: inv.client_id, kind: "doc_rejected", title: `Your CA firm rejected ${docLabel(inv)}`, body: reason ? `Reason: ${reason}` : "Please upload a corrected copy.", link: "/gst", actor: req.user });
  }
  res.json(await detail(await loadInvoice(req, id)));
}));

router.post("/:id/retry", requireStaff, wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Invoice");
  const inv = await loadInvoice(req, id);
  if (!inv) throw new HttpError(404, "Invoice not found");
  if (!inv.source_file_id) throw new HttpError(404, "No source file for this invoice");
  await db.query("update invoice_files set status='queued', error_message=null where id=$1", [inv.source_file_id]);
  queue.add(() => processFile(inv.source_file_id, inv.invoice_type, inv.tax_period));
  res.json({ message: "Extraction task re-queued successfully" });
}));

// Files left queued/processing by a restart would otherwise stay stuck forever.
async function resumeUnfinished() {
  const rows = await db.query("select id, doc_category, tax_period from invoice_files where status in ('queued','processing')");
  for (const r of rows) queue.add(() => processFile(r.id, r.doc_category || "sales", r.tax_period));
  if (rows.length) console.log(`[resume] re-queued ${rows.length} unfinished file(s)`);
}

export { processFile, queue, resumeUnfinished };
export default router;
