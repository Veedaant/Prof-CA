import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate } from "../auth.js";
import { isUuid, uuidParam, wrap } from "../http.js";
import { deleteObject, readFile, saveFile } from "../services/storage.js";
import { notify } from "../services/notify.js";
import { BANKS, OTHER_BANK, bankOptions } from "../services/banks.js";
import { fyValid, monthsOfFy } from "../services/banking/common.js";

const router = Router();
router.use(authenticate);

const OFFICE = "application/vnd.openxmlformats-officedocument";
const MIME_BY_EXT = {
  ".pdf": "application/pdf", ".csv": "text/csv", ".xls": "application/vnd.ms-excel",
  ".xlsx": `${OFFICE}.spreadsheetml.sheet`, ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ".doc": "application/msword", ".docx": `${OFFICE}.wordprocessingml.document`,
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif",
};
const ALLOWED_TEXT = "PDF, Excel, CSV, Word, PNG, JPG or HEIC";

const FIELDS = [
  { name: "statement", maxCount: 20 }, { name: "sanction_letter", maxCount: 5 },
  { name: "repayment_schedule", maxCount: 5 }, { name: "other", maxCount: 10 },
];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 40 } });

/** What each section takes, and what it must have before it can be submitted. */
const SECTIONS = {
  statement: { takes: ["statement", "other"], needs: { statement: "a bank statement" }, noun: "bank statement" },
  loan: { takes: ["sanction_letter", "repayment_schedule", "other"], needs: { sanction_letter: "the loan sanction letter", repayment_schedule: "the repayment schedule" }, noun: "loan sanction letter and repayment schedule" },
};

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

function accountNumber(v) {
  const s = String(v || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z0-9/-]{4,30}$/.test(s)) throw new HttpError(422, "Enter the account number: 4 to 30 letters, digits, / or -");
  return s;
}

function bankChoice(body) {
  const bank = String(body.bank || "").trim();
  if (bank === OTHER_BANK) {
    const name = String(body.other_bank_name || "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 100) throw new HttpError(422, "Type the name of the bank (2 to 100 characters)");
    return { name, other: true };
  }
  if (!BANKS.includes(bank)) throw new HttpError(422, "Choose the bank from the list, or choose Other and type its name");
  return { name: bank, other: false };
}

/** The financial year, and for a bank statement the months it covers (inside that year). A loan only needs the year. */
function yearAndPeriod(body, section) {
  const fy = String(body.fy || "").trim();
  if (!fyValid(fy)) throw new HttpError(422, "Select the financial year");
  if (section !== "statement") return { fy, from: null, to: null };
  const months = monthsOfFy(fy);
  const from = String(body.period_from || ""), to = String(body.period_to || "");
  if (!months.includes(from) || !months.includes(to)) throw new HttpError(422, `Select the period the statement covers, from month and to month, within ${fy}`);
  if (from > to) throw new HttpError(422, "The 'to' month cannot be before the 'from' month");
  return { fy, from, to };
}

const last4 = (acc) => `xxxx${acc.slice(-4)}`;
const slim = (s, files) => ({
  id: s.id, section: s.section, account_number: s.account_number, bank_name: s.bank_name, is_other_bank: s.is_other_bank,
  fy: s.fy, period_from: s.period_from, period_to: s.period_to, loan_details: s.loan_details || {},
  uploaded_by_name: s.uploaded_by_name, uploaded_by_role: s.uploaded_by_role, created_at: s.created_at,
  files: files.filter((f) => f.submission_id === s.id).map((f) => ({ id: f.id, kind: f.kind, name: f.original_filename, size: f.file_size, created_at: f.created_at })),
});

router.get("/", wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const subs = await db.query(
    "select * from banking_submissions where firm_id=$1 and client_id=$2 order by created_at desc",
    [req.user.firm_id, client.id],
  );
  const files = subs.length
    ? await db.query("select id, submission_id, kind, original_filename, file_size, created_at from banking_files where submission_id = any($1::uuid[]) order by created_at, original_filename", [subs.map((s) => s.id)])
    : [];
  const mapped = subs.map((s) => slim(s, files));
  res.json({
    client, banks: bankOptions(),
    statements: mapped.filter((s) => s.section === "statement"),
    loans: mapped.filter((s) => s.section === "loan"),
  });
}));

router.post("/upload", upload.fields(FIELDS), wrap(async (req, res) => {
  const u = req.user;
  const client = await clientFor(req, req.body.client_id);
  const section = String(req.body.section || "");
  const rule = SECTIONS[section];
  if (!rule) throw new HttpError(422, "section must be statement or loan");
  const account = accountNumber(req.body.account_number);
  const bank = bankChoice(req.body);
  const year = yearAndPeriod(req.body, section);

  const sent = Object.entries(req.files || {}).flatMap(([kind, list]) => list.map((f) => ({ kind, f })));
  const stray = sent.find((x) => !rule.takes.includes(x.kind));
  if (stray) throw new HttpError(400, section === "statement" ? "A bank statement upload takes the statement and other documents only." : "A loan upload takes the sanction letter, the repayment schedule and other documents only.");
  for (const [kind, what] of Object.entries(rule.needs)) {
    if (!sent.some((x) => x.kind === kind)) throw new HttpError(422, `Upload ${what}.`);
  }
  for (const { f } of sent) {
    const ext = path.extname(f.originalname).toLowerCase();
    if (!MIME_BY_EXT[ext]) throw new HttpError(400, `Unsupported file type '${ext || f.originalname}'. Allowed: ${ALLOWED_TEXT}.`);
  }

  const saved = [];
  try {
    for (const { kind, f } of sent) {
      const mime = MIME_BY_EXT[path.extname(f.originalname).toLowerCase()];
      saved.push({ kind, name: f.originalname.slice(0, 255), mime, ...(await saveFile(f.buffer, f.originalname, u.firm_id, client.id, mime)) });
    }
    const id = await db.tx(async (q) => {
      const row = (await q(
        `insert into banking_submissions (firm_id, client_id, section, account_number, bank_name, is_other_bank, fy, period_from, period_to, uploaded_by, uploaded_by_name, uploaded_by_role)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [u.firm_id, client.id, section, account, bank.name, bank.other, year.fy, year.from, year.to, u.id, u.full_name, u.role],
      ))[0];
      for (const s of saved) {
        await q(
          "insert into banking_files (submission_id, kind, storage_path, original_filename, file_size, mime_type, file_hash) values ($1,$2,$3,$4,$5,$6,$7)",
          [row.id, s.kind, s.storagePath, s.name, s.fileSize, s.mime, s.fileHash],
        );
      }
      return row.id;
    });

    const staffSide = u.role !== "client";
    await notify({
      firmId: u.firm_id, audience: staffSide ? "client" : "staff", clientId: client.id, kind: "banking_upload",
      title: staffSide ? `Your CA firm added a ${rule.noun} for ${bank.name} ${last4(account)}` : `${client.name} uploaded a ${rule.noun}`,
      body: `${bank.name}, account ${last4(account)}, FY ${year.fy}`, link: "/banking", actor: u,
    });
    res.status(201).json({ ok: true, id, files: saved.length });
  } catch (e) {
    await Promise.all(saved.map((s) => deleteObject(s.storagePath)));
    throw e;
  }
}));

/** A submission this user may touch: staff any in their firm, a client only their own. */
async function submissionFor(req, id) {
  const u = req.user;
  const s = await db.one(
    "select * from banking_submissions where id=$1 and firm_id=$2 and ($3::uuid is null or client_id=$3::uuid)",
    [uuidParam(id, "Upload"), u.firm_id, u.role === "client" ? u.client_id : null],
  );
  if (!s) throw new HttpError(404, "Upload not found");
  return s;
}

router.get("/files/:id/download", wrap(async (req, res) => {
  const u = req.user;
  const f = await db.one(
    `select f.* from banking_files f join banking_submissions s on s.id=f.submission_id
      where f.id=$1 and s.firm_id=$2 and ($3::uuid is null or s.client_id=$3::uuid)`,
    [uuidParam(req.params.id, "File"), u.firm_id, u.role === "client" ? u.client_id : null],
  );
  if (!f) throw new HttpError(404, "File not found");
  let bytes;
  try { bytes = await readFile(f.storage_path); } catch { throw new HttpError(404, "File not found in storage"); }
  const safe = f.original_filename.replace(/[^\w.\- ]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(f.original_filename)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.type(f.mime_type).send(bytes);
}));

router.delete("/:id", wrap(async (req, res) => {
  const s = await submissionFor(req, req.params.id);
  const files = await db.query("select storage_path from banking_files where submission_id=$1", [s.id]);
  await db.query("delete from banking_submissions where id=$1", [s.id]);
  await Promise.all(files.map((f) => deleteObject(f.storage_path)));
  res.json({ ok: true });
}));

export default router;
