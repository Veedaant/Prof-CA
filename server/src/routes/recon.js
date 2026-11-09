import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate } from "../auth.js";
import { isUuid, wrap } from "../http.js";
import { parseSheetFile, normInv } from "../services/recon/sheetParser.js";
import { parseGstr3bPdf, emptyFigures } from "../services/recon/gstr3bParser.js";
import { extractLedgerWithAi } from "../services/recon/ledgerAi.js";
import { notify } from "../services/notify.js";

const KIND_NAME = { sales_ledger: "a sales ledger", purchase_ledger: "a purchase ledger", gstr1_portal: "the GSTR-1 portal file" };
async function notifyUpload(req, client, kind, results) {
  if (req.user.role !== "client" || !KIND_NAME[kind]) return;
  const entries = results.reduce((a, r) => a + (Number(r.row_count) || 0), 0);
  await notify({
    firmId: req.user.firm_id, audience: "staff", clientId: client.id, kind: "ledger_uploaded",
    title: `${client.name} uploaded ${KIND_NAME[kind]}`,
    body: `${results.length} file(s), ${entries} entries${results[0]?.tax_period ? ` · ${results[0].tax_period}` : ""}`,
    link: kind === "purchase_ledger" ? "/verify-3b" : "/reconciliation", actor: req.user,
  });
}
import { buildOutput, buildInput, buildGstr3b, buildGstr9, buildGstr9c } from "../services/recon/reports.js";
import { buildOutputPack } from "../services/recon/outputPack.js";
import { reportToWorkbook, ledgerTemplate } from "../services/recon/workbook.js";

const router = Router();
router.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });

const KINDS = ["gstr1_portal", "gstr2b", "gstr3b", "sales_ledger", "purchase_ledger"];
const LEDGER_KINDS = ["sales_ledger", "purchase_ledger"];
const CLIENT_KINDS = [...LEDGER_KINDS, "gstr1_portal"];
const SINGLE = ["gstr1_portal", "gstr2b", "gstr3b"];
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const FY = /^\d{4}(-\d{2})?$/;
const isStaff = (u) => u.role === "admin" || u.role === "staff";

async function clientFor(req, id) {
  const cid = req.user.role === "client" ? req.user.client_id : id;
  if (!isUuid(cid)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin, state from clients where id=$1 and firm_id=$2", [cid, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}
function staffOnly(req) { if (!isStaff(req.user)) throw new HttpError(403, "Staff access required"); }
const needPeriod = (v, what) => { if (!PERIOD.test(String(v || ""))) throw new HttpError(422, `${what} must be YYYY-MM`); return String(v); };
const needFy = (v) => { if (!FY.test(String(v || ""))) throw new HttpError(422, "fy must be like 2025 (FY 2025-26)"); return String(v).slice(0, 4); };

router.get("/ledger-template", wrap(async (req, res) => {
  const kind = req.query.kind === "purchase_ledger" ? "purchase_ledger" : "sales_ledger";
  const buf = await ledgerTemplate(kind);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${kind}_template.xlsx"`);
  res.send(Buffer.from(buf));
}));

router.get("/files", wrap(async (req, res) => {
  const c = await clientFor(req, req.query.client_id);
  const params = [req.user.firm_id, c.id];
  let extra = "";
  if (req.user.role === "client") extra = " and kind in ('sales_ledger','purchase_ledger','gstr1_portal')";
  const rows = await db.query(
    `select id, kind, tax_period, original_filename, row_count, uploaded_by_role, created_at,
            case when kind='gstr3b' then data->'figures' else null end as figures, data->'meta' as meta
     from recon_files where firm_id=$1 and client_id=$2${extra} order by kind, tax_period nulls first, created_at desc`,
    params,
  );
  res.json(rows);
}));

router.post("/files", upload.array("files", 24), wrap(async (req, res) => {
  const { kind } = req.body;
  if (!KINDS.includes(kind)) throw new HttpError(422, "Invalid file kind");
  if (req.user.role === "client" && !CLIENT_KINDS.includes(kind)) throw new HttpError(403, "Clients can upload ledgers and the GSTR-1 file only");
  const c = await clientFor(req, req.body.client_id);
  const files = req.files || [];
  if (!files.length) throw new HttpError(422, "Choose a file to upload");
  const results = [];
  const side = kind === "sales_ledger" ? "sales" : "purchase";

  // Merge: every selected file becomes part of ONE ledger. A row that is in more than one file is counted once.
  if (["1", "true"].includes(String(req.body.merge || "")) && LEDGER_KINDS.includes(kind)) {
    const period = req.body.tax_period ? needPeriod(req.body.tax_period, "tax_period") : null;
    const rows = [], parts = [], earlier = new Set();
    let duplicates = 0, ai = false;
    for (const f of files) {
      let fileRows;
      if (/\.(pdf|png|jpe?g)$/i.test(f.originalname)) {
        try { fileRows = (await extractLedgerWithAi(f.buffer, f.originalname, side)).rows; ai = true; } catch (e) { throw new HttpError(422, `${f.originalname}: ${e.message || "could not be read"}`); }
      } else if (/\.(xlsx|xlsm|csv)$/i.test(f.originalname)) {
        try { fileRows = (await parseSheetFile(f.buffer, f.originalname, { kind: "ledger", clientGstin: c.gstin })).rows; } catch (e) { throw new HttpError(422, `${f.originalname}: ${e.message || "could not be read"}`); }
      } else {
        throw new HttpError(422, `${f.originalname}: upload an Excel, CSV, PDF or image file`);
      }
      const keys = new Set();
      let added = 0;
      for (const r of fileRows) {
        const key = [r.type, normInv(r.inv_no), r.gstin, r.date, r.taxable, r.igst, r.cgst, r.sgst, r.cess, r.rate].join("|");
        keys.add(key);
        if (earlier.has(key)) { duplicates++; continue; }
        rows.push(r);
        added++;
      }
      for (const k of keys) earlier.add(k);
      parts.push({ name: f.originalname, rows: fileRows.length, added });
    }
    if (!rows.length) throw new HttpError(422, "No entries could be read from the selected files");
    const name = files.length === 1 ? files[0].originalname : `Merged batch of ${files.length} files`;
    const row = await db.one(
      `insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by, uploaded_by_role)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, kind, tax_period, original_filename, row_count`,
      [req.user.firm_id, c.id, kind, period, name, rows.length, JSON.stringify({ rows, meta: { sheets: parts.map((p) => p.name), batch: parts, duplicates_skipped: duplicates, ai } }), req.user.id, req.user.role],
    );
    results.push({
      ...row, batch: parts, duplicates_skipped: duplicates,
      warning: [duplicates ? `${duplicates} row(s) that appeared in more than one file were counted once.` : "", ai ? "Some files were read with AI - the CA will check the entries against your documents." : ""].filter(Boolean).join(" ") || null,
    });
    await notifyUpload(req, c, kind, results);
    return res.status(201).json(results);
  }

  for (const f of files) {
    let period = req.body.tax_period || null;
    let data, rowCount = 0;
    if (kind === "gstr3b") {
      if (!/\.pdf$/i.test(f.originalname)) throw new HttpError(422, "GSTR-3B must be uploaded as the PDF downloaded from the portal");
      let parsed;
      try { parsed = await parseGstr3bPdf(new Uint8Array(f.buffer)); } catch (e) { throw new HttpError(422, `Could not read the PDF: ${e.message}`); }
      period = parsed.period || period;
      data = { figures: parsed.figures, meta: { found: parsed.found, expected: parsed.expected, detected_period: parsed.period, text_length: parsed.text_length } };
      rowCount = parsed.found;
    } else {
      const aiLedger = LEDGER_KINDS.includes(kind) && /\.(pdf|png|jpe?g)$/i.test(f.originalname);
      if (aiLedger) {
        let ai;
        try { ai = await extractLedgerWithAi(f.buffer, f.originalname, side); } catch (e) { throw new HttpError(422, e.message || "Could not read the ledger"); }
        data = { rows: ai.rows, meta: { sheets: ["AI reading of " + f.originalname], ai: true } };
        rowCount = ai.rows.length;
        if (SINGLE.includes(kind)) period = needPeriod(period, "tax_period");
        else if (period) period = needPeriod(period, "tax_period");
        const row = await db.one(
          `insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by, uploaded_by_role)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, kind, tax_period, original_filename, row_count`,
          [req.user.firm_id, c.id, kind, period, f.originalname, rowCount, JSON.stringify(data), req.user.id, req.user.role],
        );
        results.push({ ...row, warning: "Read with AI - the CA will check these entries against your documents." });
        continue;
      }
      if (!/\.(xlsx|xlsm|csv)$/i.test(f.originalname)) throw new HttpError(422, "Upload an Excel (.xlsx), CSV, PDF or image file");
      let parsed;
      try { parsed = await parseSheetFile(f.buffer, f.originalname, { kind: LEDGER_KINDS.includes(kind) ? "ledger" : "portal", clientGstin: c.gstin }); } catch (e) { throw new HttpError(422, e.message || "Could not read the file"); }
      data = { rows: parsed.rows, meta: { sheets: parsed.sheets_used } };
      rowCount = parsed.rows.length;
    }
    if (SINGLE.includes(kind)) period = needPeriod(period, "tax_period");
    else if (period) period = needPeriod(period, "tax_period");
    if (SINGLE.includes(kind)) await db.query("delete from recon_files where client_id=$1 and kind=$2 and tax_period=$3", [c.id, kind, period]);
    const row = await db.one(
      `insert into recon_files (firm_id, client_id, kind, tax_period, original_filename, row_count, data, uploaded_by, uploaded_by_role)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, kind, tax_period, original_filename, row_count`,
      [req.user.firm_id, c.id, kind, period, f.originalname, rowCount, JSON.stringify(data), req.user.id, req.user.role],
    );
    results.push({ ...row, warning: kind === "gstr3b" && data.meta.found < data.meta.expected ? `Only ${data.meta.found} of ${data.meta.expected} 3B lines could be read - please check and correct the figures.` : null });
  }
  await notifyUpload(req, c, kind, results);
  res.status(201).json(results);
}));

router.delete("/files/:id", wrap(async (req, res) => {
  if (!isUuid(req.params.id)) throw new HttpError(422, "Invalid id");
  const f = await db.one("select id, client_id, kind from recon_files where id=$1 and firm_id=$2", [req.params.id, req.user.firm_id]);
  if (!f) throw new HttpError(404, "File not found");
  if (req.user.role === "client" && (f.client_id !== req.user.client_id || !CLIENT_KINDS.includes(f.kind))) throw new HttpError(403, "Access denied");
  await db.query("delete from recon_files where id=$1", [f.id]);
  res.json({ ok: true });
}));

router.put("/files/:id/figures", wrap(async (req, res) => {
  staffOnly(req);
  if (!isUuid(req.params.id)) throw new HttpError(422, "Invalid id");
  const f = await db.one("select id, kind, data from recon_files where id=$1 and firm_id=$2", [req.params.id, req.user.firm_id]);
  if (!f || f.kind !== "gstr3b") throw new HttpError(404, "GSTR-3B file not found");
  const base = emptyFigures(), inc = req.body?.figures || {};
  const merge = (b, i) => { const o = {}; for (const k of Object.keys(b)) o[k] = Number.isFinite(Number(i?.[k])) && i?.[k] !== "" && i?.[k] != null ? Math.round(Number(i[k]) * 100) / 100 : b[k]; return o; };
  const figures = { outward: {}, itc: {}, tax_paid: base.tax_paid };
  for (const k of Object.keys(base.outward)) figures.outward[k] = merge(base.outward[k], inc.outward?.[k]);
  for (const k of Object.keys(base.itc)) figures.itc[k] = merge(base.itc[k], inc.itc?.[k]);
  const meta = { ...(f.data?.meta || {}), edited: true };
  await db.query("update recon_files set data=$2 where id=$1", [f.id, JSON.stringify({ figures, meta })]);
  res.json({ ok: true, figures });
}));

async function run(req, fn) {
  staffOnly(req);
  const c = await clientFor(req, req.query.client_id);
  return fn(c);
}
const range = (req) => {
  const from = needPeriod(req.query.from, "from"), to = needPeriod(req.query.to, "to");
  if (from > to) throw new HttpError(422, "'from' must not be after 'to'");
  return [from, to];
};
const builders = {
  output: (req, c) => { const [f, t] = range(req); return buildOutput(req.user.firm_id, c, f, t); },
  input: (req, c) => { const [f, t] = range(req); return buildInput(req.user.firm_id, c, f, t); },
  gstr3b: (req, c) => { const [f, t] = range(req); return buildGstr3b(req.user.firm_id, c, f, t); },
  gstr9: (req, c) => buildGstr9(req.user.firm_id, c, needFy(req.query.fy)),
  gstr9c: (req, c) => buildGstr9c(req.user.firm_id, c, needFy(req.query.fy), req.query.fin_turnover !== undefined && req.query.fin_turnover !== "" ? Number(req.query.fin_turnover) : null),
};
for (const [name, build] of Object.entries(builders)) {
  router.get(`/${name}`, wrap(async (req, res) => res.json(await run(req, (c) => build(req, c)))));
}
const PACK = ["books", "g1working", "g1_3b", "working_g1", "books_working", "books_3b"];
router.get("/output-status", wrap(async (req, res) => {
  const pack = await run(req, (c) => { const [f, t] = range(req); return buildOutputPack(req.user.firm_id, c, f, t); });
  const counts = Object.fromEntries(Object.entries(pack.reports).map(([k, r]) => [k, { discrepancies: r.summary.total, missing: r.missing }]));
  res.json({ ...pack.status, reports: counts });
}));
router.get("/output-export/:name", wrap(async (req, res) => {
  if (!PACK.includes(req.params.name)) throw new HttpError(404, "Unknown report");
  const pack = await run(req, (c) => { const [f, t] = range(req); return buildOutputPack(req.user.firm_id, c, f, t); });
  const report = pack.reports[req.params.name];
  const buf = await reportToWorkbook(report);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="output_${req.params.name}_${(report.client.name || "client").replace(/[^\w]+/g, "_")}_${report.from}_${report.to}.xlsx"`);
  res.send(Buffer.from(buf));
}));
router.get("/export/:name", wrap(async (req, res) => {
  const build = builders[req.params.name];
  if (!build) throw new HttpError(404, "Unknown report");
  const report = await run(req, (c) => build(req, c));
  const buf = await reportToWorkbook(report);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.name}_${(report.client.name || "client").replace(/[^\w]+/g, "_")}_${report.from}_${report.to}.xlsx"`);
  res.send(Buffer.from(buf));
}));

export default router;
