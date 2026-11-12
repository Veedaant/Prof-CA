import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { isUuid, uuidParam, wrap } from "../http.js";
import { deleteObject, readFile, saveFile } from "../services/storage.js";
import { notify } from "../services/notify.js";
import { fyValid } from "../services/banking/common.js";
import { readWorkbook } from "../services/audit/requirementReader.js";
import { itemStates, loadAuditSources, programmeStates, programmeTotals, summarise } from "../services/audit/auditStatus.js";
import { auditWorkbook } from "../services/audit/auditReport.js";

/**
 * Audit compliance. The CA staff upload the audit checklist workbook for a client and year: the audit programme (the points to check) and the
 * documents required. The system checks which documents it already holds, lists what is pending, and, once the CA staff have previewed it,
 * sends it to the client, who uploads against each pending document. Documents the client gives in other sections (banking, GST) count too,
 * because the status is worked out each time the checklist is read. Each point of the programme is pending, checked, or has a query out to
 * the client; the client answers the query against the point, so every explanation is kept.
 */
const router = Router();
router.use(authenticate);

const OFFICE = "application/vnd.openxmlformats-officedocument";
const MIME_BY_EXT = {
  ".pdf": "application/pdf", ".csv": "text/csv", ".xls": "application/vnd.ms-excel", ".xlsx": `${OFFICE}.spreadsheetml.sheet`, ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12", ".doc": "application/msword", ".docx": `${OFFICE}.wordprocessingml.document`,
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif", ".zip": "application/zip", ".txt": "text/plain",
};
const ALLOWED_TEXT = "PDF, Excel, CSV, Word, ZIP, PNG, JPG or HEIC";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 20 } });
const XLSX = `${OFFICE}.spreadsheetml.sheet`;

const isStaff = (u) => u.role === "admin" || u.role === "staff";
const staffOnly = requireStaff;

/** The client an action is for: a client user is always their own client; staff name one. */
async function clientFor(req, id) {
  const u = req.user;
  if (u.role === "client") {
    if (id && id !== u.client_id) throw new HttpError(403, "Clients may only use their own account");
    id = u.client_id;
  }
  if (!isUuid(id)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [id, u.firm_id]);
  if (!c) throw new HttpError(404, "Client not found");
  return c;
}
const fyOf = (v) => { if (!fyValid(v)) throw new HttpError(422, "Select the financial year"); return String(v); };

/** The checklist with the state of every document, or null. A client sees it only once it has been sent. */
async function checklistState(req, client, fy) {
  const c = await db.one("select * from audit_checklists where client_id=$1 and fy=$2 and firm_id=$3", [client.id, fy, req.user.firm_id]);
  if (!c || (!isStaff(req.user) && c.status !== "sent")) return null;
  const items = await db.query("select * from audit_items where checklist_id=$1 order by req_no, account_number nulls first, seq", [c.id]);
  const files = await db.query("select id, item_id, original_filename, file_size, uploaded_by_name, uploaded_by_role, created_at from audit_files where checklist_id=$1 and item_id is not null order by created_at", [c.id]);
  const src = await loadAuditSources({ firmId: req.user.firm_id, clientId: client.id });
  const states = itemStates({ items, files, src, fy }).map((s) => ({
    id: s.id, reqNo: s.req_no, seq: s.seq, section: s.section, name: s.name, category: s.category, periodKind: s.period_kind, period: s.period, periodLabel: s.period_label, account: s.account_number || "", bank: s.bank_name || "",
    note: s.note || "", status: s.status, source: s.source, detail: s.detail, manual: s.manual,
    files: s.files.map((f) => ({ id: f.id, name: f.original_filename, size: f.file_size, by: f.uploaded_by_name, role: f.uploaded_by_role, at: f.created_at })),
  }));
  // the summary groups read the item fields by their database names
  const summary = summarise(states.map((s) => ({ ...s, req_no: s.reqNo, period_kind: s.periodKind, account_number: s.account, bank_name: s.bank, period_label: s.periodLabel })));
  // the audit programme: the CA firm sees every point; the client sees only the points a query has been raised on
  const all = programmeStates(
    await db.query("select * from audit_points where checklist_id=$1 order by seq", [c.id]),
    await db.query("select * from audit_queries where checklist_id=$1 and point_id is not null order by created_at", [c.id]),
  );
  const staff = isStaff(req.user);
  return {
    id: c.id, fy: c.fy, status: c.status, sentAt: c.sent_at, sentBy: c.sent_by_name, sourceName: c.source_name, uploadedBy: c.uploaded_by_name, warnings: c.warnings || [], readInfo: c.read_info || [], createdAt: c.created_at, updatedAt: c.updated_at,
    summary, states, programme: staff ? programmeTotals(all) : null, points: staff ? all : all.filter((p) => p.queries.length),
  };
}

async function knownAccounts(firmId, clientId) {
  return db.query("select distinct account_number, bank_name from banking_submissions where firm_id=$1 and client_id=$2 and section='statement' order by bank_name, account_number", [firmId, clientId]);
}

router.get("/", wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const years = (await db.query(
    `select fy, status from audit_checklists where client_id=$1 and firm_id=$2 ${isStaff(req.user) ? "" : "and status='sent'"} order by fy desc`,
    [client.id, req.user.firm_id],
  )).map((r) => ({ fy: r.fy, status: r.status }));
  let fy = req.query.fy ? fyOf(String(req.query.fy)) : "";
  if (!fy) { if (isStaff(req.user)) throw new HttpError(422, "Select the financial year"); fy = years[0]?.fy || ""; }
  const checklist = fy ? await checklistState(req, client, fy) : null;
  res.json({ client, fy, years, checklist, accounts: isStaff(req.user) ? await knownAccounts(req.user.firm_id, client.id) : [] });
}));

router.post("/sheet", staffOnly, upload.single("file"), wrap(async (req, res) => {
  const u = req.user;
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(String(req.body.fy || ""));
  const f = req.file;
  if (!f) throw new HttpError(400, "No file uploaded");
  const name = f.originalname.slice(0, 255);
  let parsed;
  try { parsed = await readWorkbook(f.buffer, name, { fy, accounts: await knownAccounts(u.firm_id, client.id) }); } catch (e) { throw new HttpError(422, String(e.message || e).slice(0, 400)); }

  await db.tx(async (q) => {
    const old = (await q("select id from audit_checklists where client_id=$1 and fy=$2", [client.id, fy]))[0];
    let id = old?.id;
    const keep = old ? await q("select item_key, manual, manual_by, manual_at from audit_items where checklist_id=$1 and manual is not null", [old.id]) : [];
    const keepPoints = old ? await q("select item_key, status, status_by, status_at from audit_points where checklist_id=$1 and status <> 'pending'", [old.id]) : [];
    const info = JSON.stringify(parsed.sheets);
    if (old) {
      await q("update audit_checklists set source_name=$2, warnings=$3::jsonb, read_info=$5::jsonb, uploaded_by_name=$4, updated_at=now() where id=$1", [id, name, JSON.stringify(parsed.warnings), u.full_name, info]);
      await q("delete from audit_items where checklist_id=$1", [id]);
      await q("delete from audit_points where checklist_id=$1", [id]);
    } else {
      id = (await q("insert into audit_checklists (firm_id, client_id, fy, source_name, warnings, read_info, uploaded_by_name) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) returning id", [u.firm_id, client.id, fy, name, JSON.stringify(parsed.warnings), info, u.full_name]))[0].id;
    }
    if (parsed.points.length) {
      const pcol = (k) => parsed.points.map((p) => p[k] ?? null);
      await q(
        `insert into audit_points (checklist_id, firm_id, client_id, seq, ref, section, name, detail, item_key)
         select $1::uuid, $2::uuid, $3::uuid, a, coalesce(b, ''), coalesce(c, ''), d, e, f
           from unnest($4::int[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[]) as t(a, b, c, d, e, f)`,
        [id, u.firm_id, client.id, pcol("seq"), pcol("ref"), pcol("section"), pcol("name"), pcol("detail"), pcol("item_key")],
      );
      // the status of a point, and the queries raised on it, stay with it when the checklist is replaced
      for (const k of keepPoints) await q("update audit_points set status=$3, status_by=$4, status_at=$5 where checklist_id=$1 and item_key=$2", [id, k.item_key, k.status, k.status_by, k.status_at]);
      await q("update audit_queries set point_id = p.id from audit_points p where audit_queries.checklist_id=$1 and p.checklist_id=$1 and p.item_key = audit_queries.point_key", [id]);
    }
    const col = (k) => parsed.items.map((i) => i[k] ?? null);
    for (let from = 0; from < parsed.items.length; from += 500) {
      const part = (k) => col(k).slice(from, from + 500);
      await q(
        `insert into audit_items (checklist_id, firm_id, client_id, req_no, seq, section, name, category, period, period_kind, period_label, account_number, bank_name, note, item_key)
         select $1::uuid, $2::uuid, $3::uuid, a, b, coalesce(c, ''), d, e, f, g, h, i, j, k, l
           from unnest($4::int[], $5::int[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[]) as t(a, b, c, d, e, f, g, h, i, j, k, l)`,
        [id, u.firm_id, client.id, part("req_no"), part("seq"), part("section"), part("name"), part("category"), part("period"), part("period_kind"), part("period_label"), part("account_number"), part("bank_name"), part("note"), part("item_key")],
      );
    }
    // marks the CA firm made, and files the client uploaded, stay with their documents when the sheet is replaced
    for (const k of keep) await q("update audit_items set manual=$3, manual_by=$4, manual_at=$5 where checklist_id=$1 and item_key=$2", [id, k.item_key, k.manual, k.manual_by, k.manual_at]);
    await q("update audit_files set item_id = i.id from audit_items i where audit_files.checklist_id=$1 and i.checklist_id=$1 and i.item_key = audit_files.item_key", [id]);
  });
  const checklist = await checklistState(req, client, fy);
  res.status(201).json({ ok: true, requirements: parsed.requirements, items: parsed.items.length, points: parsed.points.length, checklist });
}));

router.post("/send", staffOnly, wrap(async (req, res) => {
  const u = req.user;
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(String(req.body.fy || ""));
  const c = await db.one("select id from audit_checklists where client_id=$1 and fy=$2 and firm_id=$3", [client.id, fy, u.firm_id]);
  if (!c) throw new HttpError(409, "Upload the audit checklist first.");
  const before = await checklistState(req, client, fy);
  const t = before.summary.totals;
  if (!t.items && !before.programme.points) throw new HttpError(409, "The checklist has no documents and no audit points, so there is nothing to send.");
  await db.query("update audit_checklists set status='sent', sent_at=now(), sent_by_name=$2, updated_at=now() where id=$1", [c.id, u.full_name]);
  await notify({
    firmId: u.firm_id, audience: "client", clientId: client.id, kind: "audit_checklist",
    title: t.pending ? `Audit documents needed for FY ${fy}` : `Audit for FY ${fy}: your CA firm may send queries here`,
    body: t.pending ? `${t.pending} of ${t.items} documents are pending. Open Audit Documents to see the list and upload each one.` : "No documents are pending. Any query on the audit will appear under Audit Documents.",
    link: "/audit-documents", actor: u,
  });
  res.json({ ok: true, checklist: await checklistState(req, client, fy) });
}));

router.put("/items/:id", staffOnly, wrap(async (req, res) => {
  const item = await db.one("select id, client_id, checklist_id from audit_items where id=$1 and firm_id=$2", [uuidParam(req.params.id, "Item"), req.user.firm_id]);
  if (!item) throw new HttpError(404, "Item not found");
  const m = req.body?.manual ?? null;
  if (m !== null && !["received", "na"].includes(m)) throw new HttpError(422, "manual must be received, na or null");
  await db.query("update audit_items set manual=$2, manual_by=$3, manual_at=$4 where id=$1", [item.id, m, m ? req.user.full_name : null, m ? new Date() : null]);
  res.json({ ok: true });
}));

/** Marks every pending period of one document (a line of the sheet, for one account) at once. */
router.put("/documents", staffOnly, wrap(async (req, res) => {
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(String(req.body.fy || ""));
  const reqNo = Number(req.body.req_no);
  const m = req.body?.manual ?? null;
  if (!Number.isInteger(reqNo)) throw new HttpError(422, "req_no is required");
  if (m !== null && !["received", "na"].includes(m)) throw new HttpError(422, "manual must be received, na or null");
  const c = await db.one("select id from audit_checklists where client_id=$1 and fy=$2 and firm_id=$3", [client.id, fy, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Checklist not found");
  const account = String(req.body.account || "");
  await db.query(
    "update audit_items set manual=$3, manual_by=$4, manual_at=$5 where checklist_id=$1 and req_no=$2 and coalesce(account_number,'')=$6",
    [c.id, reqNo, m, m ? req.user.full_name : null, m ? new Date() : null, account],
  );
  res.json({ ok: true });
}));

/** A point of the audit programme the user may see: the CA firm any, the client only on a checklist that has been sent to them. */
async function pointFor(req, id) {
  const u = req.user;
  const p = await db.one(
    `select p.*, c.status as list_status, c.fy from audit_points p join audit_checklists c on c.id=p.checklist_id
      where p.id=$1 and p.firm_id=$2 and ($3::uuid is null or p.client_id=$3::uuid)`,
    [uuidParam(id, "Audit point"), u.firm_id, u.role === "client" ? u.client_id : null],
  );
  if (!p || (!isStaff(u) && p.list_status !== "sent")) throw new HttpError(404, "Audit point not found");
  return p;
}
const brief = (s, n = 160) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** The CA firm sets a point of the programme to pending, checked, or query. */
router.put("/points/:id", staffOnly, wrap(async (req, res) => {
  const p = await pointFor(req, req.params.id);
  const status = String(req.body?.status || "");
  if (!["pending", "checked", "query"].includes(status)) throw new HttpError(422, "status must be pending, checked or query");
  await db.query("update audit_points set status=$2, status_by=$3, status_at=now() where id=$1", [p.id, status, req.user.full_name]);
  res.json({ ok: true });
}));

/** A query on a point, written by the CA firm; or the client's reply to it. Both stay in the thread of the point. */
router.post("/points/:id/queries", wrap(async (req, res) => {
  const u = req.user;
  const p = await pointFor(req, req.params.id);
  const body = String(req.body?.body ?? "").trim();
  if (!body) throw new HttpError(422, "Write the query or the reply first");
  if (body.length > 2000) throw new HttpError(422, "Keep it to 2,000 characters or fewer");
  const staffSide = isStaff(u);
  if (staffSide && p.list_status !== "sent") throw new HttpError(409, "Send the checklist to the client first, so the client can see the query.");
  if (!staffSide) {
    const asked = await db.one("select count(*)::int as n from audit_queries where point_id=$1 and author_role <> 'client'", [p.id]);
    if (!asked.n) throw new HttpError(404, "Audit point not found");
    if (p.status !== "query") throw new HttpError(409, "This point is closed: your CA firm has no query open on it.");
  }
  const row = await db.one(
    "insert into audit_queries (firm_id, client_id, checklist_id, point_id, point_key, author_role, author_name, body) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
    [u.firm_id, p.client_id, p.checklist_id, p.id, p.item_key, staffSide ? "staff" : "client", u.full_name, body],
  );
  // a query puts the point in the query state; the client's reply leaves it there until the CA firm checks it
  if (staffSide) await db.query("update audit_points set status='query', status_by=$2, status_at=now() where id=$1", [p.id, u.full_name]);
  const client = await db.one("select name from clients where id=$1", [p.client_id]);
  await notify({
    firmId: u.firm_id, audience: staffSide ? "client" : "staff", clientId: p.client_id, kind: staffSide ? "audit_query" : "audit_reply",
    title: staffSide ? `Query from your CA firm on the audit: ${brief(p.name, 90)}` : `${client?.name || "The client"} replied to a query on the audit: ${brief(p.name, 90)}`,
    body: brief(body, 300), link: staffSide ? "/audit-documents" : "/audit-compliance", actor: u,
  });
  res.status(201).json({ ok: true, id: row.id });
}));

/** The CA firm takes back a query it wrote (a mistake); a point left with no query returns to pending. */
router.delete("/queries/:id", staffOnly, wrap(async (req, res) => {
  const q = await db.one("select * from audit_queries where id=$1 and firm_id=$2", [uuidParam(req.params.id, "Query"), req.user.firm_id]);
  if (!q) throw new HttpError(404, "Query not found");
  if (q.author_role !== "staff") throw new HttpError(403, "Only a query written by the CA firm can be taken back.");
  await db.query("delete from audit_queries where id=$1", [q.id]);
  if (q.point_id) {
    const left = await db.one("select count(*)::int as n from audit_queries where point_id=$1", [q.point_id]);
    if (!left.n) await db.query("update audit_points set status='pending' where id=$1 and status='query'", [q.point_id]);
  }
  res.json({ ok: true });
}));

router.delete("/", staffOnly, wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(String(req.query.fy || ""));
  const c = await db.one("select id from audit_checklists where client_id=$1 and fy=$2 and firm_id=$3", [client.id, fy, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Checklist not found");
  const files = await db.query("select storage_path from audit_files where checklist_id=$1", [c.id]);
  await db.query("delete from audit_checklists where id=$1", [c.id]);
  await Promise.all(files.map((f) => deleteObject(f.storage_path)));
  res.json({ ok: true });
}));

/** The client uploads a document against an item of the checklist (the CA firm may too). */
router.post("/items/:id/upload", upload.array("files", 20), wrap(async (req, res) => {
  const u = req.user;
  const item = await db.one(
    `select i.*, c.status as list_status, c.fy from audit_items i join audit_checklists c on c.id=i.checklist_id
      where i.id=$1 and i.firm_id=$2 and ($3::uuid is null or i.client_id=$3::uuid)`,
    [uuidParam(req.params.id, "Item"), u.firm_id, u.role === "client" ? u.client_id : null],
  );
  if (!item) throw new HttpError(404, "Document not found");
  if (!isStaff(u) && item.list_status !== "sent") throw new HttpError(404, "Document not found");
  if (item.manual === "na") throw new HttpError(409, "The CA firm has marked this document as not applicable.");
  const list = req.files || [];
  if (!list.length) throw new HttpError(400, "No file uploaded");
  for (const f of list) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new HttpError(400, `Unsupported file type '${ext || f.originalname}'. Allowed: ${ALLOWED_TEXT}.`);
  }
  const client = await db.one("select id, name from clients where id=$1", [item.client_id]);
  const saved = [];
  try {
    for (const f of list) {
      const mime = MIME_BY_EXT[path.extname(f.originalname).toLowerCase()];
      const s = await saveFile(f.buffer, f.originalname, u.firm_id, item.client_id, mime);
      const dup = await db.one("select id from audit_files where item_id=$1 and file_hash=$2", [item.id, s.fileHash]);
      if (dup) { await deleteObject(s.storagePath); continue; }
      saved.push({ name: f.originalname.slice(0, 255), mime, ...s });
    }
    for (const s of saved) {
      await db.query(
        `insert into audit_files (firm_id, client_id, checklist_id, item_id, item_key, storage_path, original_filename, file_size, mime_type, file_hash, uploaded_by, uploaded_by_name, uploaded_by_role)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [u.firm_id, item.client_id, item.checklist_id, item.id, item.item_key, s.storagePath, s.name, s.fileSize, s.mime, s.fileHash, u.id, u.full_name, u.role],
      );
    }
  } catch (e) {
    await Promise.all(saved.map((s) => deleteObject(s.storagePath)));
    throw e;
  }
  if (saved.length) {
    const what = `${item.name}${item.period_label ? ` (${item.period_label})` : ""}`;
    const staffSide = isStaff(u);
    await notify({
      firmId: u.firm_id, audience: staffSide ? "client" : "staff", clientId: item.client_id, kind: "audit_upload",
      title: staffSide ? `Your CA firm added a document for the audit: ${what}` : `${client.name} uploaded ${saved.length} file(s) for the audit`,
      body: `${what}, FY ${item.fy}`, link: staffSide ? "/audit-documents" : "/audit-compliance", actor: u,
    });
  }
  res.status(201).json({ ok: true, uploaded: saved.length, skipped: list.length - saved.length });
}));

async function fileFor(req, id) {
  const u = req.user;
  const f = await db.one(
    "select * from audit_files where id=$1 and firm_id=$2 and ($3::uuid is null or client_id=$3::uuid)",
    [uuidParam(id, "File"), u.firm_id, u.role === "client" ? u.client_id : null],
  );
  if (!f) throw new HttpError(404, "File not found");
  return f;
}

router.get("/files/:id/download", wrap(async (req, res) => {
  const f = await fileFor(req, req.params.id);
  let bytes;
  try { bytes = await readFile(f.storage_path); } catch { throw new HttpError(404, "File not found in storage"); }
  const safe = f.original_filename.replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(f.original_filename)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.type(f.mime_type).send(bytes);
}));

router.delete("/files/:id", wrap(async (req, res) => {
  const f = await fileFor(req, req.params.id);
  // a client takes back only what the client uploaded
  if (!isStaff(req.user) && f.uploaded_by_role !== "client") throw new HttpError(403, "Only the CA firm can remove this file.");
  await db.query("delete from audit_files where id=$1", [f.id]);
  await deleteObject(f.storage_path);
  res.json({ ok: true });
}));

router.get("/export", staffOnly, wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(String(req.query.fy || ""));
  const checklist = await checklistState(req, client, fy);
  if (!checklist) throw new HttpError(409, "Upload the audit checklist first.");
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="Audit_documents_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx"`);
  res.send(await auditWorkbook({ client, checklist }));
}));

export default router;
