import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { isSheetFile, readSheets } from "../services/recon/sheetParser.js";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { isUuid, wrap } from "../http.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024 } });
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(String(v ?? "").replace(/[₹,\s]/g, "")); return Number.isFinite(n) ? n : 0; };
const normNo = (s) => String(s ?? "").replace(/[\s/\-_#]/g, "").toUpperCase();

async function getClient(req, clientId) {
  const c = isUuid(clientId) ? await db.one("select * from clients where id=$1 and firm_id=$2", [clientId, req.user.firm_id]) : null;
  if (!c) throw new HttpError(404, "Client not found in your firm");
  return c;
}

router.get("/sample-template", wrap(async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales_Register");
  const headers = ["Invoice Number", "Invoice Date", "Customer GSTIN", "Customer Name", "Place of Supply", "Taxable Value", "Rate (%)", "CGST", "SGST", "IGST", "Invoice Total"];
  ws.addRow(headers);
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E40AF" } };
  });
  ws.addRows([
    ["INV-2024-001", "2024-04-05", "27AABCU9603R1ZM", "Sample Customer Pvt Ltd", "27-Maharashtra", 10000, 18, 900, 900, 0, 11800],
    ["INV-2024-002", "2024-04-12", "29AAACR5055K1Z8", "Another Buyer LLP", "29-Karnataka", 25000, 18, 0, 0, 4500, 29500],
    ["INV-2024-003", "2024-04-18", "", "Walk-in Customer", "27-Maharashtra", 5000, 12, 300, 300, 0, 5600],
    ["INV-2024-004", "2024-04-25", "24AAACC1206D1ZM", "Gujarat Traders", "24-Gujarat", 40000, 5, 1000, 1000, 0, 42000],
  ]);
  headers.forEach((_, i) => { ws.getColumn(i + 1).width = 20; });
  res.setHeader("Content-Disposition", 'attachment; filename="Sample_Sales_Register_Template.xlsx"');
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(Buffer.from(await wb.xlsx.writeBuffer()));
}));

router.use(authenticate, requireStaff);

router.get("/summary", wrap(async (req, res) => {
  const client = await getClient(req, req.query.client_id);
  const period = req.query.tax_period ? String(req.query.tax_period) : null;
  const params = [req.user.firm_id, client.id];
  let sql = "select * from invoices where firm_id=$1 and client_id=$2 and client_approved_at is not null";
  if (period) { params.push(period); sql += " and tax_period=$3"; }
  const invoices = await db.query(`${sql} order by created_at desc`, params);

  const counts = new Map();
  for (const i of invoices) {
    const k = normNo(i.invoice_number);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  let clean = 0, dups = 0, mism = 0, comp = 0;
  const out = invoices.map((i) => {
    const dupCount = counts.get(normNo(i.invoice_number)) || 1;
    const calc = num(i.total_taxable_value) + num(i.cgst_total) + num(i.sgst_total) + num(i.igst_total) + num(i.cess_total);
    const diff = Math.abs(calc - num(i.invoice_total));
    const flags = Array.isArray(i.flags) ? i.flags : [];
    const hasErr = flags.some((f) => f.severity === "error");
    let status = "clean", label = "Clean / Verified";
    if (dupCount > 1) { status = "duplicate"; label = `Duplicate (${dupCount} uploads)`; dups++; }
    else if (diff > 1.0) { status = "math_mismatch"; label = `Tax Math Mismatch (Diff: ₹${diff.toFixed(2)})`; mism++; }
    else if (hasErr) { status = "flagged"; label = "Compliance Warning"; comp++; }
    else clean++;
    return {
      id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date,
      supplier_name: i.supplier_name, supplier_gstin: i.supplier_gstin, buyer_name: i.buyer_name, buyer_gstin: i.buyer_gstin,
      place_of_supply: i.place_of_supply, taxable_value: i.total_taxable_value, total_tax: i.total_tax, invoice_total: i.invoice_total,
      review_status: i.review_status, reconciliation_status: status, reconciliation_label: label, duplicate_count: dupCount, flags,
    };
  });
  res.json({
    client_id: client.id, client_name: client.name, tax_period: period || "All", total_invoices: invoices.length,
    clean_count: clean, duplicates_count: dups, math_mismatches_count: mism, compliance_issues_count: comp, invoices: out,
  });
}));

function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); cur = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

async function readRegister(file) {
  const name = file.originalname.toLowerCase();
  let grid;
  if (isSheetFile(name) && !name.endsWith(".csv")) {
    const rows = (await readSheets(file.buffer, file.originalname))[0]?.rows || [];
    grid = rows.map((r) => r.map((c) => (c instanceof Date ? c.toISOString().slice(0, 10) : c)));
  } else if (name.endsWith(".csv") || name.endsWith(".txt")) {
    grid = parseCsv(file.buffer.toString("utf8").replace(/^﻿/, ""));
  } else {
    throw new HttpError(400, "Only Excel (any version) or CSV files are supported for register matching");
  }
  if (!grid || grid.length < 2) throw new HttpError(400, "The uploaded register file contains no data rows");
  const headers = grid[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return grid.slice(1).filter((r) => r.some((c) => String(c).trim() !== "")).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
}

function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) if (c in row && String(row[c]).trim() !== "") return row[c];
  for (const c of candidates) {
    const k = keys.find((k) => k.includes(c) && String(row[k]).trim() !== "");
    if (k) return row[k];
  }
  return "";
}

router.post("/match-register", upload.single("file"), wrap(async (req, res) => {
  const client = await getClient(req, req.body.client_id);
  if (!req.file) throw new HttpError(422, "file is required");
  const period = req.body.tax_period || null;
  const rows = await readRegister(req.file);
  if (!rows.length) throw new HttpError(400, "The uploaded register file contains no data rows");

  const params = [req.user.firm_id, client.id];
  let sql = "select * from invoices where firm_id=$1 and client_id=$2 and client_approved_at is not null";
  if (period) { params.push(period); sql += " and tax_period=$3"; }
  const invoices = await db.query(sql, params);
  const byNo = new Map();
  for (const i of invoices) { const k = normNo(i.invoice_number); if (k && !byNo.has(k)) byNo.set(k, i); }

  const records = [];
  const matched = new Set();
  const stats = { exact: 0, value: 0, date: 0, missingInv: 0, missingReg: 0 };

  rows.forEach((row, idx) => {
    const no = String(pick(row, ["invoice_number", "invoice_no", "inv_no", "bill_no", "doc_no", "voucher_no", "invoice"])).trim();
    const regDate = String(pick(row, ["invoice_date", "inv_date", "bill_date", "date"])).trim();
    const gstin = String(pick(row, ["gstin", "party_gstin", "buyer_gstin", "supplier_gstin", "uin"])).trim();
    const taxable = num(pick(row, ["taxable", "basic", "net_amount"]));
    const total = num(pick(row, ["invoice_total", "invoice_value", "grand_total", "total", "amount"]));
    const reg = { invoice_number: no, invoice_date: regDate, gstin, taxable_value: taxable, invoice_total: total };
    const app = no ? byNo.get(normNo(no)) : null;
    if (!app) {
      stats.missingInv++;
      records.push({ row_index: idx + 2, invoice_number: no, status: "missing_in_invoices", status_text: "Missing in Uploaded Invoices", register: reg, app_invoice: null, difference: null });
      return;
    }
    matched.add(app.id);
    const dTaxable = r2(taxable - num(app.total_taxable_value));
    const dTotal = r2(total - num(app.invoice_total));
    const valueOk = Math.abs(dTaxable) <= 1.0 && Math.abs(dTotal) <= 1.0;
    const dateOk = !regDate || regDate.slice(0, 10) === String(app.invoice_date || "").slice(0, 10);
    let status = "exact_match", text = "Exact Match";
    if (!valueOk) { status = "value_mismatch"; text = `Value Mismatch (Diff: ₹${Math.abs(dTotal).toFixed(2)})`; stats.value++; }
    else if (!dateOk) { status = "date_mismatch"; text = `Date Mismatch (App: ${app.invoice_date} vs Reg: ${regDate})`; stats.date++; }
    else stats.exact++;
    records.push({
      row_index: idx + 2, invoice_number: no, status, status_text: text, register: reg,
      app_invoice: { id: app.id, invoice_number: app.invoice_number, invoice_date: app.invoice_date, taxable_value: app.total_taxable_value, invoice_total: app.invoice_total },
      difference: { taxable_value: dTaxable, invoice_total: dTotal },
    });
  });

  for (const i of invoices) {
    if (matched.has(i.id)) continue;
    stats.missingReg++;
    records.push({
      row_index: null, invoice_number: i.invoice_number, status: "missing_in_register", status_text: "Missing in Uploaded Register", register: null,
      app_invoice: { id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, taxable_value: i.total_taxable_value, invoice_total: i.invoice_total },
      difference: null,
    });
  }

  res.json({
    summary: {
      total_register_rows: rows.length, total_app_invoices: invoices.length, exact_matches: stats.exact,
      value_mismatches: stats.value, date_mismatches: stats.date, missing_in_invoices: stats.missingInv, missing_in_register: stats.missingReg,
      match_rate_percent: rows.length ? r2((stats.exact / rows.length) * 100) : 0,
    },
    records,
  });
}));

export default router;
