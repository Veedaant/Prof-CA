import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate } from "../auth.js";
import { isUuid, wrap } from "../http.js";
import { readBooksOutput, readGstr1Excel, readGstr3bFile, fyOfPeriod, monthsOfFy, periodFromName } from "../services/output/readers.js";
import { analyseOutput } from "../services/output/analyse.js";
import { combinedBooksWorkbook, combinedGstr1Workbook, workingWorkbook } from "../services/output/report.js";

const router = Router();
router.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 40 } });
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FY = /^\d{4}-\d{2}$/;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const KINDS = ["books", "gstr1", "gstr3b"];

const staffOnly = (req) => { if (!(req.user.role === "admin" || req.user.role === "staff")) throw new HttpError(403, "Staff access required"); };
const fyOf = (v) => { if (!FY.test(String(v || "")) || Number(String(v).slice(5)) !== (Number(String(v).slice(0, 4)) + 1) % 100) throw new HttpError(422, "fy must look like 2026-27"); return String(v); };
async function clientFor(req, id) {
  if (!isUuid(id)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [id, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}

/** A GSTR-1 saved before files covering several months were recognised: a file with no month in its name and invoices of many months is one. */
function isMulti(f) {
  if (f.data.multi != null) return Boolean(f.data.multi);
  if (periodFromName(f.original_filename)) return false;
  const c = new Map();
  let n = 0;
  for (const r of f.data.rows || []) { if (!r.date || r.sec === "at" || r.sec === "atadj") continue; n++; const m = String(r.date).slice(0, 7); c.set(m, (c.get(m) || 0) + 1); }
  const top = Math.max(0, ...c.values());
  return c.size >= 2 && top / n < 0.8;
}

async function context(client, fy) {
  const files = await db.query("select id, kind, original_filename, period, row_count, warnings, data, created_at from output_files where client_id=$1 and fy=$2 order by created_at", [client.id, fy]);
  const settings = await db.one("select party_types from output_settings where client_id=$1 and fy=$2", [client.id, fy]);
  const x = analyseOutput({
    fy,
    books: files.filter((f) => f.kind === "books").map((f) => ({ name: f.original_filename, rows: f.data.rows || [] })),
    gstr1: files.filter((f) => f.kind === "gstr1").map((f) => ({ name: f.original_filename, period: f.period, multi: isMulti(f), rows: f.data.rows || [], hsn: f.data.hsn || [], exemp: f.data.exemp || [], warnings: f.warnings || [] })),
    gstr3b: files.filter((f) => f.kind === "gstr3b").map((f) => ({ name: f.original_filename, period: f.period, figures: f.data.figures })),
    partyTypesText: settings?.party_types || "",
  });
  return { files, settings, x, ctx: { clientName: client.name, clientGstin: client.gstin, fy, x } };
}

const slimFile = (f) => ({ id: f.id, kind: f.kind, name: f.original_filename, period: f.period, rows: f.row_count, warnings: f.warnings || [], at: f.created_at, sheets: f.data?.sheets || [], multi: isMulti(f) });

router.get("/", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const { files, settings, x } = await context(client, fy);
  const byKind = (k) => files.filter((f) => f.kind === k).map(slimFile);
  const cmp = (k) => ({ rows: x.compare[k].rows, total: x.compare[k].total });
  res.json({
    client, fy, months: x.months,
    files: { books: byKind("books"), gstr1: byKind("gstr1"), gstr3b: byKind("gstr3b") },
    party_types: settings?.party_types || "",
    coverage: x.coverage, totals: x.totals, notes: x.notes,
    compare: { g1_vs_3b: cmp("g1_vs_3b"), g1_vs_books: cmp("g1_vs_books"), b3_vs_books: cmp("b3_vs_books") },
    classification: Object.entries(x.C).map(([key, v]) => ({ key, name: v.name, taxable: v.taxable, igst: v.igst, cgst: v.cgst, sgst: v.sgst, cess: v.cess, docs: v.docs })),
    parties: { total: x.parties.length, different: x.parties.filter((p) => p.status !== "matched").length },
    capital: x.capital.length,
    differences: x.differences.slice(0, 400), difference_count: x.differences.length,
    ready: files.length > 0,
  });
}));

router.post("/upload", upload.array("files", 40), wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(req.body.fy);
  const kind = String(req.body.kind || "");
  if (!KINDS.includes(kind)) throw new HttpError(422, "kind must be books, gstr1 or gstr3b");
  const list = req.files || [];
  if (!list.length) throw new HttpError(400, "No file uploaded");
  const results = [];
  for (const f of list) {
    const name = f.originalname.slice(0, 255);
    try {
      const ext = path.extname(name).toLowerCase();
      let parsed;
      if (kind === "books") {
        if (![".xlsx", ".xlsm", ".csv"].includes(ext)) throw new Error("Upload an Excel (.xlsx) or CSV file.");
        parsed = await readBooksOutput(f.buffer, name);
      } else if (kind === "gstr1") {
        if (![".xlsx", ".xlsm", ".csv"].includes(ext)) throw new Error("Upload the GSTR-1 Excel.");
        parsed = await readGstr1Excel(f.buffer, name, { clientGstin: client.gstin });
      } else parsed = await readGstr3bFile(f.buffer, name);
      const warnings = [...(parsed.warnings || [])];
      if (parsed.period && fyOfPeriod(parsed.period) !== fy) warnings.push(`This file is for ${parsed.period}, which is outside ${fy}. Change the month or the financial year.`);
      if (parsed.multi) {
        const dated = parsed.rows.filter((r) => r.date);
        const outside = dated.filter((r) => fyOfPeriod(String(r.date).slice(0, 7)) !== fy).length;
        if (dated.length && outside / dated.length > 0.5) warnings.push(`Most lines of this file are dated outside ${fy}. It looks like the GSTR-1 of another financial year.`);
      }
      const data = kind === "books" ? { rows: parsed.rows, sheets: parsed.sheets } : kind === "gstr1" ? { rows: parsed.rows, hsn: parsed.hsn, exemp: parsed.exemp, sheets: parsed.sheets, multi: Boolean(parsed.multi) } : { figures: parsed.figures, found: parsed.found };
      const rowCount = kind === "books" ? parsed.rows.length : kind === "gstr1" ? parsed.rows.length : parsed.found;
      const row = await db.one(
        "insert into output_files (firm_id, client_id, fy, kind, original_filename, period, row_count, data, warnings) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
        [req.user.firm_id, client.id, fy, kind, name, parsed.period || null, rowCount, JSON.stringify(data), JSON.stringify(warnings)],
      );
      results.push({ name, ok: true, id: row.id, period: parsed.period || null, rows: rowCount, warnings });
    } catch (e) {
      results.push({ name, ok: false, error: e.message || "Could not read the file" });
    }
  }
  res.json({ results });
}));

router.put("/file/:id", wrap(async (req, res) => {
  staffOnly(req);
  if (!isUuid(req.params.id)) throw new HttpError(404, "File not found");
  const period = String(req.body.period || "");
  if (!PERIOD.test(period)) throw new HttpError(422, "period must be YYYY-MM");
  const row = await db.one("select id, fy, kind from output_files where id=$1 and firm_id=$2", [req.params.id, req.user.firm_id]);
  if (!row) throw new HttpError(404, "File not found");
  if (row.kind === "books") throw new HttpError(422, "Books files are not tied to a month");
  await db.query("update output_files set period=$2 where id=$1", [row.id, period]);
  res.json({ ok: true, outside: fyOfPeriod(period) !== row.fy });
}));

router.delete("/file/:id", wrap(async (req, res) => {
  staffOnly(req);
  if (!isUuid(req.params.id)) throw new HttpError(404, "File not found");
  await db.query("delete from output_files where id=$1 and firm_id=$2", [req.params.id, req.user.firm_id]);
  res.json({ ok: true });
}));

router.put("/settings", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(req.body.fy);
  await db.query(
    "insert into output_settings (client_id, fy, party_types, updated_at) values ($1,$2,$3,now()) on conflict (client_id, fy) do update set party_types=excluded.party_types, updated_at=now()",
    [client.id, fy, String(req.body.party_types || "").slice(0, 20000)],
  );
  res.json({ ok: true });
}));

const send = (res, buf, name) => {
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send(buf);
};
const part = (client, fy) => `${(client.gstin || "CLIENT")}_${fy}`;

router.get("/combined/books", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const { files, ctx } = await context(client, fy);
  if (!files.some((f) => f.kind === "books")) throw new HttpError(409, "Upload the GST ledgers or sales register from the books first.");
  send(res, await combinedBooksWorkbook(ctx), `Books_GST_ledgers_combined_${part(client, fy)}.xlsx`);
}));

router.get("/combined/gstr1", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const { files, ctx } = await context(client, fy);
  if (!files.some((f) => f.kind === "gstr1")) throw new HttpError(409, "Upload the GSTR-1 Excel files first.");
  send(res, await combinedGstr1Workbook(ctx), `GSTR1_combined_${part(client, fy)}.xlsx`);
}));

router.get("/working", wrap(async (req, res) => {
  staffOnly(req);
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const { files, ctx } = await context(client, fy);
  if (!files.length) throw new HttpError(409, "Upload the books, GSTR-1 and GSTR-3B files first.");
  send(res, await workingWorkbook(ctx), `Output_GST_reconciliation_${part(client, fy)}.xlsx`);
}));

export { monthsOfFy };
export default router;
