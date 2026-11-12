import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { isUuid, uuidParam, wrap } from "../http.js";
import { deleteObject, readFile, saveFile } from "../services/storage.js";
import { fyOfPeriod } from "../services/output/readers.js";
import { fyValid, PERIOD_RE } from "../services/banking/common.js";
import { DATA_VER, KINDS, readInput } from "../services/inputRecon/inspect.js";
import { itcWorkbook, portalWorkbook } from "../services/inputRecon/combinedReport.js";
import { work3bWorkbook, recoWorkbook } from "../services/inputRecon/recoReport.js";
import { buildReco } from "../services/inputRecon/reco.js";
import { buildItcRows, build2bRows } from "../services/inputRecon/combinedReport.js";
import { buildFinalReco } from "../services/inputRecon/finalReco.js";
import { finalWorkbook } from "../services/inputRecon/finalReport.js";
import { buildRcm, constitutionOf } from "../services/inputRecon/rcmWorking.js";
import { rcmWorkbook } from "../services/inputRecon/rcmReport.js";
import { BUSINESS } from "../services/itc/rules.js";
import { loadFiles } from "../services/inputRecon/combine.js";
import { loadNatureSources, makeNatureResolver } from "../services/inputRecon/partyNature.js";

/** Input Reconciliation (CA staff only): the books and GST portal files for a client and financial year. */
const router = Router();
router.use(authenticate, requireStaff);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 24 } });
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MIME = { ".pdf": "application/pdf", ".csv": "text/csv", ".xlsx": XLSX, ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12", ".xls": "application/vnd.ms-excel", ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12" };

async function clientFor(req, id) {
  if (!isUuid(id)) throw new HttpError(422, "client_id is required");
  const c = await db.one("select id, name, gstin, business_nature, business_detail from clients where id=$1 and firm_id=$2", [id, req.user.firm_id]);
  if (!c) throw new HttpError(404, "Client not found");
  return c;
}
const fyOf = (v) => { if (!fyValid(v)) throw new HttpError(422, "Select the financial year"); return String(v); };

/** The client's nature of business (set once for the client) decides which reverse-charge categories apply to it. */
const businessOf = (c) => ({ nature: c.business_nature || "", detail: c.business_detail || "", constitution: constitutionOf(c.gstin), options: Object.entries(BUSINESS).map(([key, v]) => ({ key, label: v.label })) });

const slim = (f) => ({ id: f.id, kind: f.kind, name: f.original_filename, size: f.file_size, period: f.period, info: f.info, at: f.created_at, by: f.uploaded_by_name });

router.get("/", wrap(async (req, res) => {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const files = await db.query("select * from input_recon_files where firm_id=$1 and client_id=$2 and fy=$3 order by kind, period nulls last, created_at", [req.user.firm_id, client.id, fy]);
  res.json({ client: { id: client.id, name: client.name, gstin: client.gstin }, fy, files: files.map(slim), business: businessOf(client) });
}));

router.post("/upload", upload.array("files", 24), wrap(async (req, res) => {
  const u = req.user;
  const client = await clientFor(req, req.body.client_id);
  const fy = fyOf(req.body.fy);
  const kind = String(req.body.kind || "");
  const spec = KINDS[kind];
  if (!spec) throw new HttpError(422, `kind must be one of ${Object.keys(KINDS).join(", ")}`);
  const list = req.files || [];
  if (!list.length) throw new HttpError(400, "No file uploaded");
  const results = [];
  for (const f of list) {
    const name = f.originalname.slice(0, 255);
    const ext = path.extname(name).toLowerCase();
    if (!spec.exts.includes(ext)) { results.push({ name, ok: false, error: `Unsupported file type '${ext || name}'. ${spec.label} takes ${spec.exts.join(", ")}.` }); continue; }
    try {
      const saved = await saveFile(f.buffer, name, u.firm_id, client.id, MIME[ext]);
      const dup = await db.one("select id from input_recon_files where firm_id=$1 and client_id=$2 and fy=$3 and kind=$4 and file_hash=$5", [u.firm_id, client.id, fy, kind, saved.fileHash]);
      if (dup) { await deleteObject(saved.storagePath); results.push({ name, ok: false, error: "This file is already uploaded here." }); continue; }
      const { info, data } = await readInput(kind, f.buffer, name, { clientGstin: client.gstin, fy });
      const row = await db.one(
        `insert into input_recon_files (firm_id, client_id, fy, kind, original_filename, storage_path, file_size, mime_type, file_hash, period, info, data, data_ver, uploaded_by, uploaded_by_name)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15) returning id`,
        [u.firm_id, client.id, fy, kind, name, saved.storagePath, saved.fileSize, MIME[ext], saved.fileHash, spec.monthly ? info.period : null, JSON.stringify(info), data ? JSON.stringify(data) : null, DATA_VER, u.id, u.full_name],
      );
      results.push({ name, ok: true, id: row.id, read: info.read, rows: info.rows, warnings: info.warnings });
    } catch (e) {
      results.push({ name, ok: false, error: String(e.message || e).slice(0, 300) });
    }
  }
  res.json({ results });
}));

/** The combined Excel of the Input ITC ledger files (books), or of the GSTR-2B and GSTR-3B files (GST portal). */
async function combined(req, kinds, none) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const files = await loadFiles({ firmId: req.user.firm_id, clientId: client.id, fy, kinds, clientGstin: client.gstin });
  if (!files.length) throw new HttpError(409, none);
  if (!files.some((f) => f.data)) throw new HttpError(409, `None of the uploaded files could be read, so there is nothing to combine. ${files.map((f) => `${f.name}: ${(f.info.warnings || [])[0] || "not read"}`).join(" ")}`.slice(0, 600));
  return { client, fy, files };
}
const xlsxHeaders = (res, name) => {
  res.setHeader("Content-Type", XLSX);
  res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^\w.\- ]/g, "_")}"`);
};

router.get("/combined/itc", wrap(async (req, res) => {
  const { client, fy, files } = await combined(req, ["books_itc"], "Upload the Input ITC ledger first.");
  const sources = await loadNatureSources({ firmId: req.user.firm_id, clientId: client.id });
  const resolveNature = makeNatureResolver({ sources, registerRows: files.filter((f) => f.data?.format === "register").flatMap((f) => f.data.rows) });
  const book = await itcWorkbook({ client, fy, files, resolveNature });
  xlsxHeaders(res, `Input_ITC_ledger_combined_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(book);
}));

router.get("/combined/portal", wrap(async (req, res) => {
  const { client, fy, files } = await combined(req, ["gstr2b", "gstr3b"], "Upload the GSTR-2B or GSTR-3B files first.");
  xlsxHeaders(res, `GSTR-2B_and_3B_combined_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(await portalWorkbook({ client, fy, files }));
}));

/** Input Reco: the ITC of each month's GSTR-3B working against the ITC of the GSTR-3B filed. */
async function recoInputs(req) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const files = await loadFiles({ firmId: req.user.firm_id, clientId: client.id, fy, kinds: ["work3b", "gstr3b"], clientGstin: client.gstin });
  return { client, fy, workFiles: files.filter((f) => f.kind === "work3b"), portalFiles: files.filter((f) => f.kind === "gstr3b") };
}

router.get("/reco", wrap(async (req, res) => {
  const { fy, workFiles, portalFiles } = await recoInputs(req);
  const reco = buildReco({ fy, workFiles, portalFiles });
  res.json({
    fy, summary: reco.summary, rows: reco.rows,
    replaced: reco.replaced.map((f) => ({ name: f.name, period: f.period, side: f.side })), unplaced: reco.unplaced.map((f) => ({ name: f.name, side: f.side })),
    have: { working: workFiles.some((f) => f.data), portal: portalFiles.some((f) => f.data) },
  });
}));

router.get("/combined/work3b", wrap(async (req, res) => {
  const { client, fy, workFiles } = await recoInputs(req);
  if (!workFiles.length) throw new HttpError(409, "Upload the GSTR-3B workings first.");
  if (!workFiles.some((f) => f.data)) throw new HttpError(409, `None of the uploaded workings could be read. ${workFiles.map((f) => `${f.name}: ${(f.info.warnings || [])[0] || "not read"}`).join(" ")}`.slice(0, 600));
  xlsxHeaders(res, `GSTR-3B_workings_combined_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(await work3bWorkbook({ client, fy, files: workFiles }));
}));

router.get("/combined/reco", wrap(async (req, res) => {
  const { client, fy, workFiles, portalFiles } = await recoInputs(req);
  if (!workFiles.some((f) => f.data)) throw new HttpError(409, "Upload the GSTR-3B workings first.");
  const reco = buildReco({ fy, workFiles, portalFiles });
  xlsxHeaders(res, `Input_Reco_3B_workings_vs_GSTR-3B_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(await recoWorkbook({ client, fy, reco, workFiles, portalFiles }));
}));

/** Step 2, the final reconciliation: the books, GSTR-2B and the finalised 3B working (or the latest monthly workings). */
async function finalInputs(req) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const files = await loadFiles({ firmId: req.user.firm_id, clientId: client.id, fy, kinds: ["books_itc", "books_tdstcs", "gstr2b", "work3b", "final3b", "gstr3b", "books_rcm"], clientGstin: client.gstin });
  const of = (kind) => files.filter((f) => f.kind === kind);
  const itcFiles = of("books_itc");
  const sources = await loadNatureSources({ firmId: req.user.firm_id, clientId: client.id });
  const resolveNature = makeNatureResolver({ sources, registerRows: itcFiles.filter((f) => f.data?.format === "register").flatMap((f) => f.data.rows) });
  const { rows: registerRows, ledger } = buildItcRows(itcFiles.filter((f) => f.data), resolveNature);
  const finals = of("final3b").filter((f) => f.data?.docs?.length).sort((a, b) => b.at - a.at);
  const g2bFiles = of("gstr2b").filter((f) => f.data);
  const rcm = buildRcm({ files: of("books_rcm"), client, registerRows, g2bRows: build2bRows(g2bFiles), fy });
  const reco = buildFinalReco({ fy, registerRows, tdsTcsFiles: of("books_tdstcs").filter((f) => f.data), g2bFiles, workFiles: of("work3b"), finalFile: finals[0] || null, rcm, portalFiles: of("gstr3b") });
  if (ledger.length && !registerRows.length) reco.warnings.push("The Input ITC files are plain ledgers, without party and invoice details, so they cannot be compared document by document. Upload the ITC register.");
  if (finals.length > 1) reco.warnings.push(`${finals.length} finalised 3B files are uploaded; the latest (${finals[0].name}) is used.`);
  return { client, fy, reco, registerRows, g2bFiles, counts: { books: itcFiles.length, tdsTcs: of("books_tdstcs").length, g2b: of("gstr2b").length, work3b: of("work3b").length, final3b: of("final3b").length, rcm: of("books_rcm").length } };
}

router.get("/final", wrap(async (req, res) => {
  const { fy, reco, counts } = await finalInputs(req);
  const pair = (p) => ({ id: p.id, a: p.a, b: p.b, summary: p.summary, months: p.months.filter((m) => m.hasA || m.hasB).map((m) => ({ label: m.label, a: m.a, b: m.b, diff: m.diff, both: m.both })), diffs: p.diffs.slice(0, 8).map(({ party, gstin, no, type, diff, remark }) => ({ party, gstin, no, type, diff, remark })) });
  const rr = reco.rcmReco;
  res.json({
    fy, ready: reco.ready, counts, source: { tb: reco.tbSource, name: reco.tbName }, warnings: reco.warnings,
    rcm: {
      have: reco.rcm.have, summary: rr.summary, totals: rr.totals,
      months: rr.rows.filter((m) => m.status !== "No data").map((m) => ({ label: m.label, ledger: m.ledger && { tot: m.ledger.tot }, books: m.books, paid: m.paid && { tot: m.paid.tot }, claimed: m.claimed && { tot: m.claimed.tot }, diffLedgerPaid: m.diffLedgerPaid, diffPaidItc: m.diffPaidItc, diffLedgerBooks: m.diffLedgerBooks, status: m.status, remark: m.remark })),
    },
    pairs: Object.values(reco.pairs).map(pair),
    tdsTcs: reco.gstr9.tdsTcs,
  });
}));

router.get("/combined/final", wrap(async (req, res) => {
  const { client, fy, reco, registerRows, g2bFiles } = await finalInputs(req);
  if (!reco.ready.books && !reco.ready.g2b && !reco.ready.tb) throw new HttpError(409, "Upload the Input ITC register, the GSTR-2B files and the 3B working first.");
  xlsxHeaders(res, `Final_reconciliation_ITC_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(await finalWorkbook({ client, fy, reco, itcRows: registerRows, g2bRows: build2bRows(g2bFiles) }));
}));

/** Books, RCM: the expense ledgers, the RCM worked out on them, and the client's nature of business that decides which categories apply. */
async function rcmInputs(req) {
  const client = await clientFor(req, req.query.client_id);
  const fy = fyOf(req.query.fy);
  const files = await loadFiles({ firmId: req.user.firm_id, clientId: client.id, fy, kinds: ["books_rcm", "books_itc", "gstr2b"], clientGstin: client.gstin });
  const itcFiles = files.filter((f) => f.kind === "books_itc" && f.data);
  const sources = await loadNatureSources({ firmId: req.user.firm_id, clientId: client.id });
  const resolveNature = makeNatureResolver({ sources, registerRows: itcFiles.filter((f) => f.data?.format === "register").flatMap((f) => f.data.rows) });
  const { rows: registerRows } = buildItcRows(itcFiles, resolveNature);
  const rcmFiles = files.filter((f) => f.kind === "books_rcm");
  const rcm = buildRcm({ files: rcmFiles, client, registerRows, g2bRows: build2bRows(files.filter((f) => f.kind === "gstr2b" && f.data)), fy });
  return { client, fy, rcmFiles, rcm };
}

router.get("/rcm", wrap(async (req, res) => {
  const { client, fy, rcmFiles, rcm } = await rcmInputs(req);
  res.json({
    fy, business: businessOf(client), have: rcm.have, files: rcmFiles.length, totals: rcm.totals, months: rcm.months, categories: rcm.categories,
    ledgers: rcm.ledgers.slice(0, 40), held: rcm.held.length, heldSample: rcm.held.slice(0, 5).map((h) => ({ party: h.party, ledger: h.ledger, amount: h.amount, category: h.category, reason: h.reason })), warnings: rcm.warnings,
  });
}));

router.get("/combined/rcm", wrap(async (req, res) => {
  const { client, fy, rcmFiles, rcm } = await rcmInputs(req);
  if (!rcmFiles.length) throw new HttpError(409, "Upload the expense ledgers first.");
  if (!rcm.have) throw new HttpError(409, `None of the uploaded ledgers could be read. ${rcmFiles.map((f) => `${f.name}: ${(f.info.warnings || [])[0] || "not read"}`).join(" ")}`.slice(0, 600));
  xlsxHeaders(res, `RCM_working_${fy}_${(client.name || "client").replace(/[^\w]+/g, "_")}.xlsx`);
  res.send(await rcmWorkbook({ client, fy, rcm, files: rcmFiles }));
}));

router.put("/business", wrap(async (req, res) => {
  const client = await clientFor(req, req.body?.client_id);
  const v = String(req.body?.business_nature || "");
  if (v && !BUSINESS[v]) throw new HttpError(422, "Unknown nature of business");
  await db.query("update clients set business_nature=$2, business_detail=$3 where id=$1", [client.id, v || null, String(req.body?.business_detail ?? client.business_detail ?? "").slice(0, 500) || null]);
  res.json({ ok: true, business: businessOf({ ...client, business_nature: v || null }) });
}));

router.put("/file/:id", wrap(async (req, res) => {
  const f = await db.one("select id, fy, kind from input_recon_files where id=$1 and firm_id=$2", [uuidParam(req.params.id, "File"), req.user.firm_id]);
  if (!f) throw new HttpError(404, "File not found");
  if (!KINDS[f.kind].monthly) throw new HttpError(422, "Only GSTR-2B and GSTR-3B files are tied to a month");
  const period = String(req.body?.period || "");
  if (!PERIOD_RE.test(period)) throw new HttpError(422, "period must be YYYY-MM");
  await db.query("update input_recon_files set period=$2 where id=$1", [f.id, period]);
  res.json({ ok: true, outside: fyOfPeriod(period) !== f.fy });
}));

router.get("/file/:id/download", wrap(async (req, res) => {
  const f = await db.one("select * from input_recon_files where id=$1 and firm_id=$2", [uuidParam(req.params.id, "File"), req.user.firm_id]);
  if (!f) throw new HttpError(404, "File not found");
  let bytes;
  try { bytes = await readFile(f.storage_path); } catch { throw new HttpError(404, "File not found in storage"); }
  res.setHeader("Content-Disposition", `attachment; filename="${f.original_filename.replace(/[^\w.\- ]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.original_filename)}`);
  res.setHeader("Cache-Control", "private, no-store");
  res.type(f.mime_type).send(bytes);
}));

router.delete("/file/:id", wrap(async (req, res) => {
  const f = await db.one("select id, storage_path from input_recon_files where id=$1 and firm_id=$2", [uuidParam(req.params.id, "File"), req.user.firm_id]);
  if (!f) throw new HttpError(404, "File not found");
  await db.query("delete from input_recon_files where id=$1", [f.id]);
  await deleteObject(f.storage_path);
  res.json({ ok: true });
}));

export default router;
