import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { SHEET_EXTS } from "../services/recon/sheetParser.js";
import { isUuid, uuidParam, wrap } from "../http.js";
import { deleteObject, saveFile } from "../services/storage.js";
import { accountKey, fyValid } from "../services/banking/common.js";
import { readLedger } from "../services/banking/ledgerReader.js";
import { read26as, readTis } from "../services/banking/taxDocs.js";
import { buildBankWorking } from "../services/banking/bankWorking.js";
import { bankWorkbook } from "../services/banking/bankReport.js";
import { buildLoanWorking } from "../services/banking/loanWorking.js";
import { loanWorkbook } from "../services/banking/loanReport.js";
import { loadBankInputs, loadLoanInputs, sameAccount } from "../services/banking/data.js";

/** The CA firm's side of Banking: the ledgers, 26AS and TIS it uploads, the loan details it confirms, and the workings. */
const router = Router();
router.use(authenticate, requireStaff);

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

const KINDS = {
  bank_ledger: { exts: SHEET_EXTS, needsAccount: "statement", read: (b, n) => readLedger(b, n), label: "bank ledger" },
  loan_ledger: { exts: SHEET_EXTS, needsAccount: "loan", read: (b, n) => readLedger(b, n), label: "loan ledger" },
  form_26as: { exts: [".pdf", ".txt", ...SHEET_EXTS], needsAccount: null, read: (b, n) => read26as(b, n), label: "Form 26AS" },
  tis: { exts: [".pdf", ".txt", ...SHEET_EXTS], needsAccount: null, read: (b, n) => readTis(b, n), label: "TIS" },
};
const MIME = { ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".xlsx": XLSX, ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".xls": "application/vnd.ms-excel", ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12" };

async function clientFor(req, id) {
  if (!isUuid(id)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [id, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found");
  return c;
}
const fyOf = (v) => { if (!fyValid(v)) throw new HttpError(422, "Select the financial year"); return String(v); };

const staffFileInfo = (f) => ({ id: f.id, kind: f.kind, name: f.original_filename, account_number: f.account_number, rows: f.parsed?.rows ?? f.parsed?.entries?.length ?? 0, warnings: f.warnings || [], at: f.created_at, by: f.uploaded_by_name });

/** Everything the Banking screen needs to show under each upload: the CA firm's files for every year, the read state of the statements, the loan terms. */
router.get("/overview", wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const firmId = req.user.firm_id;
  const staff = await db.query("select * from banking_staff_files where firm_id=$1 and client_id=$2 order by created_at", [firmId, client.id]);
  const statementFiles = await db.query(
    `select f.id, f.submission_id, f.original_filename, (f.parsed is not null) as read, f.parse_error
       from banking_files f join banking_submissions s on s.id=f.submission_id
      where s.firm_id=$1 and s.client_id=$2 and f.kind='statement' order by f.created_at`,
    [firmId, client.id],
  );
  const loanYears = (await db.query("select distinct fy from banking_submissions where firm_id=$1 and client_id=$2 and section='loan' and fy is not null order by fy desc", [firmId, client.id])).map((r) => r.fy);
  const loans = [];
  for (const fy of loanYears) {
    const { loans: list } = await loadLoanInputs({ firmId, clientId: client.id, fy });
    for (const l of list) loans.push({ id: l.id, fy, bank_name: l.bank_name, account_number: l.account_number, schedule_rows: l.schedule?.rows.length || 0, extracted: l.extracted, saved: l.saved, details: l.details, warnings: l.warnings });
  }
  res.json({
    client,
    files: staff.map((f) => ({ ...staffFileInfo(f), fy: f.fy })),
    statement_files: statementFiles.map((f) => ({ id: f.id, submission_id: f.submission_id, name: f.original_filename, read: f.read, error: f.parse_error })),
    loans,
  });
}));

router.post("/files", upload.single("file"), wrap(async (req, res) => {
  const u = req.user;
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(req.body.fy);
  const kind = String(req.body.kind || "");
  const spec = KINDS[kind];
  if (!spec) throw new HttpError(422, "kind must be bank_ledger, loan_ledger, form_26as or tis");
  if (!req.file) throw new HttpError(400, "No file uploaded");
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (!spec.exts.includes(ext)) throw new HttpError(400, `Unsupported file type '${ext || req.file.originalname}'. Upload ${spec.exts.join(", ")} for the ${spec.label}.`);

  let account = null;
  if (spec.needsAccount) {
    const subs = await db.query("select account_number from banking_submissions where firm_id=$1 and client_id=$2 and fy=$3 and section=$4", [u.firm_id, client.id, fy, spec.needsAccount]);
    account = subs.find((s) => sameAccount(s.account_number, req.body.account_number))?.account_number;
    if (!account) throw new HttpError(422, `Choose the ${spec.needsAccount === "loan" ? "loan" : "bank"} account this ledger is for. It must be one the client has uploaded for ${fy}.`);
  }
  let parsed;
  try { parsed = await spec.read(req.file.buffer, req.file.originalname); } catch (e) { throw new HttpError(422, String(e.message || e)); }
  const warnings = parsed.warnings || [];
  const stored = { ...parsed };
  if (kind === "bank_ledger" || kind === "loan_ledger") stored.rows = parsed.entries.length;

  const old = await db.query(
    "select id, storage_path from banking_staff_files where firm_id=$1 and client_id=$2 and fy=$3 and kind=$4 and ($5::text is null or account_number=$5)",
    [u.firm_id, client.id, fy, kind, account],
  );
  const saved = await saveFile(req.file.buffer, req.file.originalname, u.firm_id, client.id, MIME[ext]);
  let id;
  try {
    id = (await db.one(
      `insert into banking_staff_files (firm_id, client_id, fy, kind, account_number, original_filename, storage_path, file_size, mime_type, file_hash, parsed, warnings, uploaded_by, uploaded_by_name)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14) returning id`,
      [u.firm_id, client.id, fy, kind, account, req.file.originalname.slice(0, 255), saved.storagePath, saved.fileSize, MIME[ext], saved.fileHash, JSON.stringify(stored), JSON.stringify(warnings), u.id, u.full_name],
    )).id;
  } catch (e) { await deleteObject(saved.storagePath); throw e; }
  for (const o of old) { await db.query("delete from banking_staff_files where id=$1", [o.id]); await deleteObject(o.storage_path); }
  res.status(201).json({ ok: true, id, rows: stored.rows ?? 0, warnings, replaced: old.length });
}));

router.delete("/files/:id", wrap(async (req, res) => {
  const f = await db.one("select id, storage_path from banking_staff_files where id=$1 and firm_id=$2", [uuidParam(req.params.id, "File"), req.user.firm_id]);
  if (!f) throw new HttpError(404, "File not found");
  await db.query("delete from banking_staff_files where id=$1", [f.id]);
  await deleteObject(f.storage_path);
  res.json({ ok: true });
}));

const DETAIL_FIELDS = { loan_type: 80, sanction_date: 10, sanctioned_amount: 20, interest_rate: 10, tenure_months: 6, emi_amount: 20, moratorium: 80, processing_fee: 80, security: 2000, guarantee: 2000, remarks: 2000 };
router.put("/loans/:id/details", wrap(async (req, res) => {
  const s = await db.one("select id, client_id, section from banking_submissions where id=$1 and firm_id=$2", [uuidParam(req.params.id, "Loan"), req.user.firm_id]);
  if (!s || s.section !== "loan") throw new HttpError(404, "Loan not found");
  const out = {};
  for (const [k, max] of Object.entries(DETAIL_FIELDS)) {
    const v = req.body?.[k];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    if (["sanctioned_amount", "interest_rate", "tenure_months", "emi_amount"].includes(k)) {
      const n = Number(String(v).replace(/,/g, ""));
      if (!Number.isFinite(n) || n < 0) throw new HttpError(422, `${k.replace(/_/g, " ")} must be a number`);
      out[k] = n;
    } else if (k === "sanction_date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new HttpError(422, "sanction date must be a date");
      out[k] = String(v);
    } else out[k] = String(v).trim().slice(0, max);
  }
  await db.query("update banking_submissions set loan_details=$2::jsonb where id=$1", [s.id, JSON.stringify(out)]);
  res.json({ ok: true, details: out });
}));

/* ------------------------------------------------------------------ the workings */

async function bankWorking(req) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const input = await loadBankInputs({ firmId: req.user.firm_id, clientId: client.id, fy, accountNumber: String(req.query.account || "") });
  if (input.error) throw new HttpError(409, input.error);
  if (!input.statements.length) throw new HttpError(422, `No statement could be read for this account. ${input.errors.join(" ")}`);
  const w = buildBankWorking({ fy, ...input });
  for (const e of input.errors) w.warnings.unshift(e);
  return { w, client };
}

router.get("/working/bank", wrap(async (req, res) => {
  const { w } = await bankWorking(req);
  res.json({
    fy: w.fy, account: w.account, summary: w.summary, warnings: w.warnings, has_ledger: Boolean(w.book), has_26as: w.has26as, has_tis: w.hasTis,
    months: w.months.map((m) => ({ month: m.month, label: m.label, stmt: m.stmt, book: m.book, diff: m.diff, has_diff: m.hasDiff, note: m.note })),
    recons: w.recons.map((r) => ({ label: r.label, stmt_close: r.stmtClose, book_close: r.bookClose, check: r.check })),
  });
}));

router.get("/working/bank/excel", wrap(async (req, res) => {
  const { w, client } = await bankWorking(req);
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="Bank_working_${accountKey(w.account.account_number)}_${w.fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx"`);
  res.send(await bankWorkbook(w));
}));

async function loanWorking(req) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  let { loans } = await loadLoanInputs({ firmId: req.user.firm_id, clientId: client.id, fy });
  if (req.query.account) loans = loans.filter((l) => sameAccount(l.account_number, String(req.query.account)));
  if (!loans.length) throw new HttpError(409, req.query.account ? "No loan with that account number has been uploaded for this financial year." : "No loan has been uploaded for this financial year.");
  return { w: buildLoanWorking({ fy, client, loans }), client };
}

router.get("/working/loan", wrap(async (req, res) => {
  const { w } = await loanWorking(req);
  res.json({
    fy: w.fy, totals: w.totals, warnings: w.warnings,
    loans: w.loans.map((l) => ({ id: l.id, label: l.label, summary: l.summary, points: l.points, months: l.months.map((m) => ({ label: m.label, diff: m.diff, remark: m.remark })) })),
  });
}));

router.get("/working/loan/excel", wrap(async (req, res) => {
  const { w, client } = await loanWorking(req);
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="Loan_working_${req.query.account ? `${accountKey(String(req.query.account))}_` : ""}${w.fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx"`);
  res.send(await loanWorkbook(w));
}));

export default router;
