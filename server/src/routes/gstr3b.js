import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, authenticate } from "../auth.js";
import { isUuid, parseBody, uuidParam, wrap } from "../http.js";
import { verify3b } from "../services/recon/verify3b.js";
import { notify } from "../services/notify.js";
import { excelInfo, prepareGstr3bExcel } from "../services/purchaseExcel.js";
import { generateVerificationWorkbook, isChanged, isMissing } from "../services/recon/verifyReport.js";

const router = Router();
router.use(authenticate);

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const isStaff = (u) => u.role === "admin" || u.role === "staff";
const staffOnly = (req) => { if (!isStaff(req.user)) throw new HttpError(403, "Staff access required"); };
const STANDARD_LINE = "The GSTR-3B report cannot be generated until these are corrected. Please upload the documents again carefully.";

async function clientFor(req, id) {
  const cid = req.user.role === "client" ? req.user.client_id : id;
  if (!isUuid(cid)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [cid, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}
const periodOf = (v) => { if (!PERIOD.test(String(v || ""))) throw new HttpError(422, "tax_period must be YYYY-MM"); return String(v); };

async function reviewFor(firmId, clientId, period) {
  const existing = await db.one("select * from gstr3b_reviews where client_id=$1 and tax_period=$2", [clientId, period]);
  if (existing) return existing;
  return db.one("insert into gstr3b_reviews (firm_id, client_id, tax_period) values ($1,$2,$3) returning *", [firmId, clientId, period]);
}

/** live findings with staff dismissals applied, plus the staff's own notes */
async function state(firmId, client, period) {
  const review = await reviewFor(firmId, client.id, period);
  const v = await verify3b(firmId, client, period);
  const dismissals = await db.query("select finding_key, reason, hidden from gstr3b_dismissals where review_id=$1", [review.id]);
  const dmap = new Map(dismissals.map((d) => [d.finding_key, d]));
  // a deleted finding is hidden from the list and no longer blocks; the staff member took that decision
  const findings = v.findings.map((f) => ({ ...f, dismissed: dmap.has(f.key), dismissed_reason: dmap.get(f.key)?.reason || null, hidden: Boolean(dmap.get(f.key)?.hidden) }));
  const notes = await db.query("select * from gstr3b_notes where review_id=$1 order by created_at", [review.id]);
  const blockers = findings.filter((f) => f.severity === "error" && !f.dismissed).length;
  const openNotes = notes.filter((n) => !n.resolved).length;
  // the check of the Excel against the ledger counts only while nothing has changed since it was run
  const run = { at: review.last_run_at, current: Boolean(review.last_run_sig) && review.last_run_sig === v.sig };
  return { review, verification: { ...v, findings }, notes, blockers, open_notes: openNotes, run };
}

/** Used by the GSTR-3B export: may the report be generated for this client and period? */
export async function gate3b(firmId, client, period) {
  const review = await db.one("select * from gstr3b_reviews where client_id=$1 and tax_period=$2", [client.id, period]);
  if (!review || review.status !== "verified") {
    return { ok: false, message: `GSTR-3B for ${period} has not been verified. Open GSTR-3B Verification, check the documents against the ledger and mark it verified before generating the report.` };
  }
  const s = await state(firmId, client, period);
  if (s.blockers || s.open_notes) {
    return { ok: false, message: `GSTR-3B for ${period} cannot be generated: ${s.blockers + s.open_notes} issue(s) are open after the last verification. Re-check it in GSTR-3B Verification.` };
  }
  const changed = await db.one(
    `select
       (select max(updated_at) from invoices where client_id=$1 and tax_period=$2 and return_type='gstr3b') as inv_at,
       (select max(created_at) from recon_files where client_id=$1 and kind='purchase_ledger') as led_at`,
    [client.id, period],
  );
  const after = (t) => t && new Date(t).getTime() > new Date(review.verified_at).getTime();
  if (after(changed.inv_at) || after(changed.led_at)) {
    return { ok: false, message: `Documents or the ledger for ${period} changed after it was verified. Re-verify it in GSTR-3B Verification before generating the report.` };
  }
  return { ok: true };
}

// ------------------------------------------------------------------ staff: the verification workspace
router.get("/review", wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const period = periodOf(req.query.tax_period);
  const review = await reviewFor(req.user.firm_id, client.id, period);
  const feedback = await db.query("select * from gstr3b_feedback where review_id=$1 order by created_at desc", [review.id]);

  if (!isStaff(req.user)) {
    // clients only see the status and the feedback the CA firm chose to send
    return res.json({ review: { id: review.id, status: review.status, tax_period: period, verified_at: review.verified_at }, feedback });
  }
  const s = await state(req.user.firm_id, client, period);
  const excel = await excelInfo(req.user.firm_id, client.id, period);
  res.json({ client, ...s, excel, feedback, can_verify: s.blockers === 0 && s.open_notes === 0 && s.run.current });
}));

router.get("/reviews", wrap(async (req, res) => {
  staffOnly(req);
  const rows = await db.query(
    `select r.id, r.client_id, c.name as client_name, r.tax_period, r.status, r.verified_at, r.updated_at
       from gstr3b_reviews r join clients c on c.id=r.client_id where r.firm_id=$1 order by r.updated_at desc limit 100`,
    [req.user.firm_id],
  );
  res.json(rows);
}));

const noteSchema = z.object({
  client_id: z.string(), tax_period: z.string(),
  invoice_id: z.string().nullish(), doc_ref: z.string().max(80).nullish(), field_label: z.string().max(60).nullish(),
  ledger_value: z.string().max(80).nullish(), document_value: z.string().max(80).nullish(),
  message: z.string().min(3).max(1000), severity: z.enum(["error", "warning"]).default("error"),
});
router.post("/notes", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(noteSchema, req.body);
  const client = await clientFor(req, b.client_id);
  const period = periodOf(b.tax_period);
  const review = await reviewFor(req.user.firm_id, client.id, period);
  if (b.invoice_id && !isUuid(b.invoice_id)) throw new HttpError(422, "Invalid invoice");
  const row = await db.one(
    `insert into gstr3b_notes (review_id, invoice_id, doc_ref, field_label, ledger_value, document_value, message, severity, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [review.id, b.invoice_id || null, b.doc_ref || null, b.field_label || null, b.ledger_value || null, b.document_value || null, b.message, b.severity, req.user.id],
  );
  res.status(201).json(row);
}));

async function ownNote(req) {
  staffOnly(req);
  const id = uuidParam(req.params.id, "Note");
  const n = await db.one("select n.* from gstr3b_notes n join gstr3b_reviews r on r.id=n.review_id where n.id=$1 and r.firm_id=$2", [id, req.user.firm_id]);
  if (!n) throw new HttpError(404, "Note not found");
  return n;
}
router.delete("/notes/:id", wrap(async (req, res) => { const n = await ownNote(req); await db.query("delete from gstr3b_notes where id=$1", [n.id]); res.json({ ok: true }); }));
router.post("/notes/:id/resolve", wrap(async (req, res) => {
  const n = await ownNote(req);
  const resolved = req.body?.resolved !== false;
  res.json(await db.one("update gstr3b_notes set resolved=$2 where id=$1 returning *", [n.id, resolved]));
}));

const dismissSchema = z.object({ client_id: z.string(), tax_period: z.string(), finding_key: z.string().min(1).max(300), reason: z.string().max(300).optional(), hidden: z.boolean().optional() });
router.post("/dismiss", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(dismissSchema, req.body);
  const client = await clientFor(req, b.client_id);
  const review = await reviewFor(req.user.firm_id, client.id, periodOf(b.tax_period));
  const hidden = Boolean(b.hidden);
  await db.query(
    "insert into gstr3b_dismissals (review_id, finding_key, reason, hidden, dismissed_by) values ($1,$2,$3,$4,$5) on conflict (review_id, finding_key) do update set reason=coalesce(excluded.reason, gstr3b_dismissals.reason), hidden=excluded.hidden, dismissed_by=excluded.dismissed_by",
    [review.id, b.finding_key, b.reason || (hidden ? "Deleted by staff" : null), hidden, req.user.id],
  );
  res.json({ ok: true });
}));
router.post("/restore", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(dismissSchema.omit({ reason: true, hidden: true }), req.body);
  const client = await clientFor(req, b.client_id);
  const review = await reviewFor(req.user.firm_id, client.id, periodOf(b.tax_period));
  await db.query("delete from gstr3b_dismissals where review_id=$1 and finding_key=$2", [review.id, b.finding_key]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ feedback
const feedbackSchema = z.object({
  client_id: z.string(), tax_period: z.string(), message: z.string().max(2000).optional(),
  finding_keys: z.array(z.string()).default([]), note_ids: z.array(z.string()).default([]),
});
router.post("/feedback", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(feedbackSchema, req.body);
  const client = await clientFor(req, b.client_id);
  const period = periodOf(b.tax_period);
  const s = await state(req.user.firm_id, client, period);
  const pick = new Set(b.finding_keys);
  const items = [];
  for (const f of s.verification.findings) {
    if (!pick.has(f.key) || f.dismissed) continue;
    items.push({ source: "system", kind: f.kind, severity: f.severity, invoice_id: f.invoice_id || null, doc_type: f.doc_type, doc_ref: f.doc_ref, party: f.party, field_label: f.field_label, ledger_value: f.ledger_value, document_value: f.document_value, message: f.message });
  }
  const noteSet = new Set(b.note_ids);
  for (const n of s.notes) {
    if (!noteSet.has(n.id)) continue;
    items.push({ source: "staff", kind: "note", severity: n.severity, invoice_id: n.invoice_id || null, doc_type: null, doc_ref: n.doc_ref || "", party: "", field_label: n.field_label || "", ledger_value: n.ledger_value || "", document_value: n.document_value || "", message: n.message });
  }
  if (!items.length && !(b.message || "").trim()) throw new HttpError(422, "Select at least one issue or write a message for the client");
  const hasError = items.some((i) => i.severity === "error") || !items.length;
  const text = [(b.message || "").trim(), hasError ? STANDARD_LINE : ""].filter(Boolean).join("\n\n");
  const row = await db.one(
    "insert into gstr3b_feedback (review_id, sent_by, sent_by_name, message, items) values ($1,$2,$3,$4,$5::jsonb) returning *",
    [s.review.id, req.user.id, req.user.full_name, text, JSON.stringify(items)],
  );
  await db.query("update gstr3b_reviews set status='feedback_sent', verified_at=null, verified_by=null, updated_at=now() where id=$1", [s.review.id]);
  const docs = new Set(items.map((i) => i.doc_ref).filter(Boolean)).size;
  await notify({
    firmId: req.user.firm_id, audience: "client", clientId: client.id, kind: "feedback",
    title: `Your CA firm sent feedback on your GSTR-3B documents for ${period}`,
    body: `${items.length} point(s)${docs ? ` about ${docs} document(s)` : ""}. ${hasError ? "The GSTR-3B report cannot be generated until they are corrected." : ""}`.trim(),
    link: "/gst", actor: req.user,
  });
  res.status(201).json(row);
}));

router.post("/feedback/:id/resubmit", wrap(async (req, res) => {
  if (req.user.role !== "client") throw new HttpError(403, "Only the client can respond to feedback");
  const id = uuidParam(req.params.id, "Feedback");
  const fb = await db.one("select f.*, r.client_id, r.id as rid from gstr3b_feedback f join gstr3b_reviews r on r.id=f.review_id where f.id=$1 and r.firm_id=$2", [id, req.user.firm_id]);
  if (!fb || fb.client_id !== req.user.client_id) throw new HttpError(404, "Feedback not found");
  await db.query("update gstr3b_feedback set status='resubmitted', resubmitted_at=now() where id=$1", [id]);
  await db.query("update gstr3b_reviews set status='resubmitted', updated_at=now() where id=$1", [fb.rid]);
  const rv = await db.one("select r.tax_period, c.name from gstr3b_reviews r join clients c on c.id=r.client_id where r.id=$1", [fb.rid]);
  await notify({ firmId: req.user.firm_id, audience: "staff", clientId: fb.client_id, kind: "resubmitted", title: `${rv?.name || "A client"} says the GSTR-3B corrections for ${rv?.tax_period || ""} are done`, body: "Please re-check the documents against the ledger.", link: "/verify-3b", actor: req.user });
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ verify
router.post("/verify", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(z.object({ client_id: z.string(), tax_period: z.string() }), req.body);
  const client = await clientFor(req, b.client_id);
  const period = periodOf(b.tax_period);
  const s = await state(req.user.firm_id, client, period);
  if (!s.run.current) throw new HttpError(409, "Check the Excel against the ledger first. The documents or the ledger changed since the last check.");
  if (s.blockers || s.open_notes) {
    throw new HttpError(409, `${s.blockers} error(s) and ${s.open_notes} open note(s) must be cleared, or dismissed with a reason, before this can be marked verified.`);
  }
  const row = await db.one("update gstr3b_reviews set status='verified', verified_at=now(), verified_by=$2, updated_at=now() where id=$1 returning *", [s.review.id, req.user.id]);
  await notify({ firmId: req.user.firm_id, audience: "client", clientId: client.id, kind: "verified", title: `Your GSTR-3B documents for ${period} are verified`, body: "They match your purchase ledger.", link: "/gst", actor: req.user });
  res.json(row);
}));

// ------------------------------------------------------------------ the Excel, and checking it against the ledger
const monthBody = z.object({ client_id: z.string(), tax_period: z.string() });

router.post("/excel", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(monthBody, req.body);
  const client = await clientFor(req, b.client_id);
  const period = periodOf(b.tax_period);
  const info = await prepareGstr3bExcel({ firmId: req.user.firm_id, client, period, userId: req.user.id });
  if (!info) throw new HttpError(400, "No purchase invoices, credit notes or debit notes have been sent for GSTR-3B for this month yet.");
  res.json(info);
}));

router.post("/run", wrap(async (req, res) => {
  staffOnly(req);
  const b = parseBody(monthBody, req.body);
  const client = await clientFor(req, b.client_id);
  const period = periodOf(b.tax_period);
  const before = await excelInfo(req.user.firm_id, client.id, period);
  if (before.counts.total && (!before.prepared || before.stale)) await prepareGstr3bExcel({ firmId: req.user.firm_id, client, period, userId: req.user.id });
  const s = await state(req.user.firm_id, client, period);
  await db.query("update gstr3b_reviews set last_run_at=now(), last_run_sig=$2, last_run_by=$3 where id=$1", [s.review.id, s.verification.sig, req.user.id]);
  const open = s.verification.findings.filter((f) => !f.dismissed);
  res.json({ run: { at: new Date().toISOString(), current: true }, counts: { missing: open.filter(isMissing).length, changed: open.filter(isChanged).length, matched: s.verification.matched } });
}));

router.get("/verification-excel", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const period = periodOf(req.query.tax_period);
  const s = await state(req.user.firm_id, client, period);
  const buf = await generateVerificationWorkbook({ clientName: client.name, clientGstin: client.gstin, period, verification: s.verification, runAt: s.review.last_run_at });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="GSTR3B_ledger_check_${(client.gstin || "CLIENT")}_${period}.xlsx"`);
  res.send(buf);
}));

export default router;
