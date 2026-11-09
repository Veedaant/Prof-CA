import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate } from "../auth.js";
import { isUuid, wrap } from "../http.js";
import { putObject, readFile } from "../services/storage.js";
import { readBooksItc, readGstr2b } from "../services/itc/readers.js";
import { readGstr1Pdf } from "../services/itc/gstr1Reader.js";
import { analyse } from "../services/itc/reconcile.js";
import { generateItcWorkbook } from "../services/itc/report.js";
import { BUSINESS } from "../services/itc/rules.js";

const router = Router();
router.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const staffOnly = (req) => { if (!(req.user.role === "admin" || req.user.role === "staff")) throw new HttpError(403, "Staff access required"); };
const periodOf = (v) => { if (!PERIOD.test(String(v || ""))) throw new HttpError(422, "tax_period must be YYYY-MM"); return String(v); };
async function clientFor(req, id) {
  if (!isUuid(id)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin, business_nature, business_detail from clients where id=$1 and firm_id=$2", [id, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}
async function rowFor(firmId, clientId, period) {
  await db.query("insert into itc_recons (firm_id, client_id, tax_period) values ($1,$2,$3) on conflict (client_id, tax_period) do nothing", [firmId, clientId, period]);
  return db.one("select * from itc_recons where client_id=$1 and tax_period=$2", [clientId, period]);
}

const NATURES = Object.entries(BUSINESS).map(([value, b]) => ({ value, label: b.label }));

/** Entries of the purchase ledger the client uploaded for the month, without its total lines. */
async function ledgerRowsFor(clientId, period) {
  const files = await db.query("select tax_period, data from recon_files where client_id=$1 and kind='purchase_ledger'", [clientId]);
  const rows = [];
  for (const f of files) {
    for (const r of f.data?.rows || []) {
      if (!(f.tax_period === period || (r.date && String(r.date).slice(0, 7) === period))) continue;
      if (!r.inv_no && !r.gstin && /total/i.test(String(r.party || ""))) continue;
      rows.push(r);
    }
  }
  return rows;
}

/** A read that has been running for over three minutes was cut short, for instance by the server restarting. */
const staleReading = (row) => row.gstr1_status === "reading" && row.gstr1_at && Date.now() - new Date(row.gstr1_at).getTime() > 3 * 60 * 1000;

async function state(firmId, client, period) {
  const row = await db.one("select * from itc_recons where client_id=$1 and tax_period=$2", [client.id, period]);
  const uploads = {
    books: row?.books ? { name: row.books_name, at: row.books_at, rows: row.books.rows.length, sheets: row.books.sheets, columns: row.books.columns || [], warnings: row.books.warnings || [] } : null,
    gstr2b: row?.gstr2b ? { name: row.gstr2b_name, at: row.gstr2b_at, rows: row.gstr2b.rows.length, sheets: row.gstr2b.sheets, columns: row.gstr2b.columns || [], warnings: row.gstr2b.warnings || [] } : null,
    gstr1: row && row.gstr1_status !== "none" ? { name: row.gstr1_name, at: row.gstr1_at, status: staleReading(row) ? "failed" : row.gstr1_status, error: staleReading(row) ? "Reading the PDF was interrupted. Press Read again." : row.gstr1_error, warnings: row.gstr1?.warnings || [], source: row.gstr1?.source || null, return_period: row.gstr1?.return_period || null } : null,
  };
  const opening = row?.opening_itc || {};
  let result = null;
  if (row?.books && row?.gstr2b) {
    const ledgerRows = await ledgerRowsFor(client.id, period);
    result = analyse({ books: row.books.rows, g2b: row.gstr2b.rows, gstr1: row.gstr1 || null, businessNature: client.business_nature, period, clientGstin: client.gstin, opening, ledgerRows });
    result.ledger_rows = ledgerRows.length;
  }
  return {
    client: { id: client.id, name: client.name, gstin: client.gstin, business_nature: client.business_nature || "", business_detail: client.business_detail || "" },
    natures: NATURES, uploads, opening_itc: opening, result,
    uploaded_names: { books_name: row?.books_name, gstr2b_name: row?.gstr2b_name, gstr1_name: row?.gstr1_name },
  };
}

router.get("/", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  res.json(await state(req.user.firm_id, client, periodOf(req.query.tax_period)));
}));

async function readPdfInBackground(id, bytes) {
  try {
    const data = await readGstr1Pdf(bytes);
    await db.query("update itc_recons set gstr1=$2, gstr1_status='ready', gstr1_error=null, updated_at=now() where id=$1", [id, JSON.stringify(data)]);
  } catch (e) {
    await db.query("update itc_recons set gstr1_status='failed', gstr1_error=$2, updated_at=now() where id=$1", [id, String(e.message || e).slice(0, 400)]);
  }
}

router.post("/upload", upload.single("file"), wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.body.client_id);
  const period = periodOf(req.body.tax_period);
  const kind = String(req.body.kind || "");
  const f = req.file;
  if (!f) throw new HttpError(400, "No file uploaded");
  const ext = path.extname(f.originalname).toLowerCase();
  const row = await rowFor(req.user.firm_id, client.id, period);
  const name = f.originalname.slice(0, 255);

  if (kind === "books" || kind === "gstr2b") {
    if (![".xlsx", ".xlsm", ".csv"].includes(ext)) throw new HttpError(400, "Upload the Excel (.xlsx) or CSV file.");
    let parsed;
    try { parsed = kind === "books" ? await readBooksItc(f.buffer, f.originalname) : await readGstr2b(f.buffer, f.originalname, { clientGstin: client.gstin }); }
    catch (e) { throw new HttpError(422, e.message || "Could not read the file"); }
    if (kind === "books") await db.query("update itc_recons set books=$2, books_name=$3, books_at=now(), updated_at=now() where id=$1", [row.id, JSON.stringify(parsed), name]);
    else await db.query("update itc_recons set gstr2b=$2, gstr2b_name=$3, gstr2b_at=now(), updated_at=now() where id=$1", [row.id, JSON.stringify(parsed), name]);
    return res.json({ ok: true, rows: parsed.rows.length, sheets: parsed.sheets, warnings: parsed.warnings || [] });
  }
  if (kind === "gstr1") {
    if (ext !== ".pdf") throw new HttpError(400, "Upload the GSTR-1 as a PDF.");
    const storagePath = `firms/${req.user.firm_id}/itc/${client.id}/${period}_gstr1.pdf`;
    await putObject(storagePath, f.buffer, "application/pdf");
    await db.query("update itc_recons set gstr1=null, gstr1_name=$2, gstr1_path=$3, gstr1_status='reading', gstr1_error=null, gstr1_at=now(), updated_at=now() where id=$1", [row.id, name, storagePath]);
    readPdfInBackground(row.id, f.buffer);
    return res.json({ ok: true, status: "reading" });
  }
  throw new HttpError(422, "kind must be books, gstr2b or gstr1");
}));

router.post("/gstr1/reread", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.body.client_id);
  const period = periodOf(req.body.tax_period);
  const row = await db.one("select * from itc_recons where client_id=$1 and tax_period=$2", [client.id, period]);
  if (!row?.gstr1_path) throw new HttpError(404, "No GSTR-1 PDF has been uploaded for this month");
  await db.query("update itc_recons set gstr1_status='reading', gstr1_error=null, updated_at=now() where id=$1", [row.id]);
  readPdfInBackground(row.id, await readFile(row.gstr1_path));
  res.json({ ok: true, status: "reading" });
}));

router.delete("/upload", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const period = periodOf(req.query.tax_period);
  const kind = String(req.query.kind || "");
  const sql = {
    books: "update itc_recons set books=null, books_name=null, books_at=null, updated_at=now() where client_id=$1 and tax_period=$2",
    gstr2b: "update itc_recons set gstr2b=null, gstr2b_name=null, gstr2b_at=null, updated_at=now() where client_id=$1 and tax_period=$2",
    gstr1: "update itc_recons set gstr1=null, gstr1_name=null, gstr1_path=null, gstr1_status='none', gstr1_error=null, gstr1_at=null, updated_at=now() where client_id=$1 and tax_period=$2",
  }[kind];
  if (!sql) throw new HttpError(422, "kind must be books, gstr2b or gstr1");
  await db.query(sql, [client.id, period]);
  res.json({ ok: true });
}));

router.put("/settings", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.body.client_id);
  const period = periodOf(req.body.tax_period);
  if ("business_nature" in req.body) {
    const v = String(req.body.business_nature || "");
    if (v && !BUSINESS[v]) throw new HttpError(422, "Unknown nature of business");
    await db.query("update clients set business_nature=$2, business_detail=$3 where id=$1", [client.id, v || null, String(req.body.business_detail || "").slice(0, 500) || null]);
  }
  if (req.body.opening_itc && typeof req.body.opening_itc === "object") {
    const o = {};
    for (const h of ["igst", "cgst", "sgst", "cess"]) {
      const x = Number(req.body.opening_itc[h]) || 0;
      if (x < 0) throw new HttpError(422, "Opening ITC cannot be negative");
      o[h] = Math.round(x * 100) / 100;
    }
    const row = await rowFor(req.user.firm_id, client.id, period);
    await db.query("update itc_recons set opening_itc=$2, updated_at=now() where id=$1", [row.id, JSON.stringify(o)]);
  }
  const fresh = await clientFor(req, client.id);
  res.json(await state(req.user.firm_id, fresh, period));
}));

/** Picks up PDFs that were being read when the server stopped. */
export async function resumeGstr1Reads() {
  const rows = await db.query("select id, gstr1_path from itc_recons where gstr1_status='reading' and gstr1_path is not null");
  for (const r of rows) {
    try { await db.query("update itc_recons set gstr1_at=now() where id=$1", [r.id]); readPdfInBackground(r.id, await readFile(r.gstr1_path)); }
    catch (e) { await db.query("update itc_recons set gstr1_status='failed', gstr1_error=$2 where id=$1", [r.id, String(e.message || e).slice(0, 300)]); }
  }
}

router.get("/excel", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const period = periodOf(req.query.tax_period);
  const s = await state(req.user.firm_id, client, period);
  if (!s.result) throw new HttpError(409, "Upload the ITC as per books and the GSTR-2B Excel first.");
  const buf = await generateItcWorkbook({ clientName: client.name, clientGstin: client.gstin, period, result: s.result, uploads: s.uploaded_names });
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="GSTR2B_reco_${client.gstin || "CLIENT"}_${period}.xlsx"`);
  res.send(buf);
}));

export default router;
