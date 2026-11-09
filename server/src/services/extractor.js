import path from "node:path";
import { config } from "../config.js";
import { loadFileAsImages, assessImageQuality, imageToJpeg } from "./imageUtils.js";
import { decodeEinvoiceQr, normalizeDate } from "./qrDecoder.js";
import { validateInvoice, determineReviewStatus, extractStateCode, validateGstinChecksum, STATE_CODES } from "./validators.js";

const EXTRACTION_PROMPT = `You are an expert Indian GST Tax Invoice Extraction Specialist.
Analyze the provided invoice document and extract all fields with high precision according to Indian GST standards.

Return ONLY a valid JSON object matching this EXACT schema:
{
  "supplier": { "name": "Supplier trade or legal name", "gstin": "15-character Supplier GSTIN", "state": "Supplier State Name" },
  "buyer": { "name": "Full legal name of the Buyer / Bill To / Recipient / Customer (the party being billed, NOT the supplier)", "gstin": "15-character Buyer GSTIN (if registered B2B, otherwise null or empty string)", "state": "Buyer State Name" },
  "invoice_number": "Invoice / Bill / Tax Invoice Number",
  "invoice_date": "YYYY-MM-DD",
  "place_of_supply": "2-digit state code or state name (e.g. 27-Maharashtra)",
  "reverse_charge": false,
  "line_items": [
    {
      "description": "Item or service description",
      "hsn_sac": "4, 6, or 8 digit HSN/SAC code",
      "quantity": 1.0, "unit": "NOS", "uqc": "NOS-NUMBERS", "rate": 18.0,
      "taxable_value": 100.0, "total_value": 118.0,
      "cgst_rate": 9.0, "cgst_amount": 9.0, "sgst_rate": 9.0, "sgst_amount": 9.0,
      "igst_rate": 0.0, "igst_amount": 0.0, "cess": 0.0
    }
  ],
  "total_taxable_value": 100.0,
  "total_tax": 18.0,
  "invoice_total": 118.0,
  "confidence": { "overall": 0.95, "supplier_name": 0.95, "buyer_name": 0.95, "supplier_gstin": 0.98, "buyer_gstin": 0.95, "invoice_number": 0.95, "invoice_date": 0.95, "place_of_supply": 0.95, "totals": 0.95 }
}

Important Instructions:
1. All dates MUST be normalized to YYYY-MM-DD.
2. Rates and amounts must be numbers (float), not strings.
3. For UQC, use standard GSTR-1 format: NOS-NUMBERS, PCS-PIECES, KGS-KILOGRAMS, BOX-BOX, SET-SETS, etc.
4. If intra-state transaction, populate cgst and sgst fields; if inter-state, populate igst.
5. Never invent values. If a field is not visible, use null (or 0 for amounts) and lower its confidence.
6. Provide confidence between 0.0 and 1.0 for each key field and overall.
7. LAYOUT RULE: the box at the TOP of the invoice (letterhead / company block with the company's own address and GSTIN, or "Sold By" / "From") is ALWAYS the supplier. The box BELOW it ("Bill To", "Buyer", "Recipient", "Customer", "Consignee", "Ship To") is ALWAYS the buyer. Never swap them. Each GSTIN belongs to the party printed in the same box.
7a. Document titles such as "TAX INVOICE", "INVOICE", "BILL OF SUPPLY", "CREDIT NOTE", "DEBIT NOTE", "ORIGINAL FOR RECIPIENT", "DUPLICATE", "E-INVOICE" are headings, NOT party names. Never return one as supplier or buyer name; skip it and read the company name beneath/beside it.
7b. Copy names exactly as printed. If a name is not visible, use null.
8. Output ONLY the JSON object, without markdown code fences or conversational text.`;

const TITLE_RE = /^\s*(?:(?:original|duplicate|triplicate)(?:\s+for\s+\w+)?|(?:tax\s*)?invoice|bill\s*of\s*supply|e-?\s*invoice|credit\s*note|debit\s*note|proforma(?:\s*invoice)?|retail\s*invoice)\s*[:\-]?\s*(?:\(.*\))?\s*$/i;
export const isTitleLine = (l) => TITLE_RE.test(String(l || "")) || /^\s*(?:tax\s*invoice|original\s*for|duplicate\s*for)\b/i.test(String(l || ""));

/** Guards against the two classic mistakes: document titles as party names and swapped supplier/buyer. */
export function sanitizeParties(ai, qr) {
  const sup = { ...(ai.supplier || {}) };
  const buy = { ...(ai.buyer || {}) };
  for (const p of [sup, buy]) if (p.name && isTitleLine(p.name)) p.name = null;
  const swap = () => { const t = { ...sup }; for (const k of Object.keys(sup)) delete sup[k]; Object.assign(sup, buy); for (const k of Object.keys(buy)) delete buy[k]; Object.assign(buy, t); };
  const norm = (g) => String(g || "").replace(/\s+/g, "").toUpperCase();
  if (qr?.supplier_gstin && norm(buy.gstin) === norm(qr.supplier_gstin) && norm(sup.gstin) !== norm(qr.supplier_gstin)) swap();
  if (sup.name && buy.name && sup.name.trim().toLowerCase() === buy.name.trim().toLowerCase()) buy.name = null;
  return { ...ai, supplier: sup, buyer: buy };
}

const GSTIN_FIND = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g;
const toNum = (s) => {
  const n = parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function pdfText(fileBytes) {
  const mupdf = await import("mupdf");
  const doc = mupdf.Document.openDocument(fileBytes, "application/pdf");
  let text = "";
  try {
    for (let i = 0; i < Math.min(doc.countPages(), 10); i++) {
      text += doc.loadPage(i).toStructuredText("preserve-whitespace").asText() + "\n";
    }
  } finally {
    doc.destroy?.();
  }
  return text;
}

/**
 * Rule-based fallback used when Gemini is unavailable. It only reports what it can
 * actually find in the document; anything unknown is left empty so validation flags it.
 */
export async function extractFallback(fileBytes, isPdf, qr) {
  let text = "";
  if (isPdf) {
    try { text = await pdfText(fileBytes); } catch { /* unreadable text layer */ }
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const gstins = [...new Set(text.match(GSTIN_FIND) || [])];

  const hasGstin = (t) => { GSTIN_FIND.lastIndex = 0; const r = GSTIN_FIND.test(t); GSTIN_FIND.lastIndex = 0; return r; };
  const labelAfter = (re) => {
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const same = lines[i].slice(m.index + m[0].length).replace(/^[\s:\-]+/, "").trim();
      const cand = same.length > 2 ? same : (lines[i + 1] || "");
      if (cand.length > 2 && !hasGstin(cand) && !/^(gstin|address|state|phone|email)/i.test(cand)) return cand.slice(0, 120);
    }
    return "";
  };
  const gstinNear = (re) => {
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        const g = lines[j].match(GSTIN_FIND);
        if (g) return g[0];
      }
    }
    return "";
  };
  const buyerLabel = /\b(bill(?:ed)?\s*to|buyer|recipient|customer|consignee|ship(?:ped)?\s*to|sold\s*to)\b/i;
  const sellerLabel = /\b(sold\s*by|supplier|seller|from|vendor)\b/i;
  const supplierGstin = qr?.supplier_gstin || gstinNear(sellerLabel) || gstins[0] || "";
  let buyerGstin = qr?.buyer_gstin || gstinNear(buyerLabel) || gstins.find((g) => g !== supplierGstin) || "";
  if (buyerGstin === supplierGstin) buyerGstin = "";
  const buyerName = labelAfter(buyerLabel);
  const buyerIdx = lines.findIndex((l) => buyerLabel.test(l));
  const headerName = labelAfter(sellerLabel) || lines.slice(0, buyerIdx > 0 ? buyerIdx : 12).find(
    (l) => l.length > 3 && !isTitleLine(l) && !hasGstin(l) && !/^(gstin|address|state|phone|email|date|invoice\s*(no|date))/i.test(l),
  );

  let invNum = qr?.invoice_number || null;
  if (!invNum) {
    const m = /(?:Invoice\s*(?:No|Number|#)|Inv\s*No|Bill\s*No|Doc\s*No)\.?[:\s#]*([A-Za-z0-9/\-_]+)/i.exec(text);
    invNum = m ? m[1] : null;
  }

  let invDate = qr?.invoice_date || null;
  if (!invDate) {
    const m = /(?:Invoice\s*Date|Inv\s*Date|Date\s*of\s*Invoice|Bill\s*Date|Dated?)[:\s]*([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4}|[0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2,4})/i.exec(text);
    if (m) {
      const d = normalizeDate(m[1].replace(/\./g, "-").replace(/\s+/g, "-"));
      invDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }
  }

  let posCode = null;
  const pm = /(?:Place\s*of\s*Supply|POS)[:\s]*([0-9]{2}[-\sA-Za-z]*|[A-Za-z\s]+)/i.exec(text);
  if (pm) posCode = extractStateCode(pm[1].trim());
  const posStr = posCode ? `${posCode}-${STATE_CODES[posCode]}` : "";
  const supCode = extractStateCode(supplierGstin);

  const taxableM = [...text.matchAll(/(?:Taxable\s*(?:Amount|Value)|Sub\s*Total)[:\s₹RsINR]*([\d,]+\.?\d*)/gi)];
  const totalM = [...text.matchAll(/(?:Amount\s*Payable|Invoice\s*Total|Grand\s*Total|Total\s*Amount|Net\s*Amount)[:\s₹RsINR]*([\d,]+\.?\d*)/gi)];
  const taxable = taxableM.length ? toNum(taxableM.at(-1)[1]) : null;
  const total = qr?.invoice_total ?? (totalM.length ? toNum(totalM.at(-1)[1]) : null);

  const rate = (re) => { const m = re.exec(text); return m ? toNum(m[1]) || 0 : 0; };
  const cgstRate = rate(/CGST\s*@?\s*([0-9.]+)\s*%/i);
  const sgstRate = rate(/SGST\s*@?\s*([0-9.]+)\s*%/i);
  const igstRate = rate(/IGST\s*@?\s*([0-9.]+)\s*%/i);

  const base = taxable ?? 0;
  const cgstAmt = round2(base * cgstRate / 100);
  const sgstAmt = round2(base * sgstRate / 100);
  const igstAmt = round2(base * igstRate / 100);
  const totalTax = round2(cgstAmt + sgstAmt + igstAmt);

  const lineItems = taxable !== null
    ? [{
        description: "Goods / Services (summary line - verify)", hsn_sac: "", quantity: 1, unit: "NOS", uqc: "NOS-NUMBERS",
        rate: base, taxable_value: base, cgst_rate: cgstRate, cgst_amount: cgstAmt, sgst_rate: sgstRate, sgst_amount: sgstAmt,
        igst_rate: igstRate, igst_amount: igstAmt, cess: 0, total_value: total ?? round2(base + totalTax), confidence: 0.5,
      }]
    : [];

  return {
    supplier: { name: headerName || "", gstin: supplierGstin, state: supCode ? STATE_CODES[supCode] : "" },
    buyer: { name: buyerName, gstin: buyerGstin, state: posCode ? STATE_CODES[posCode] : "" },
    invoice_number: invNum,
    invoice_date: invDate,
    place_of_supply: posStr,
    reverse_charge: false,
    line_items: lineItems,
    total_taxable_value: base,
    total_tax: totalTax,
    invoice_total: total ?? (taxable !== null ? round2(base + totalTax) : 0),
    confidence: { overall: 0.6, supplier_name: headerName ? 0.6 : 0.2, buyer_name: buyerName ? 0.6 : 0.2, supplier_gstin: supplierGstin ? 0.7 : 0.2, invoice_number: invNum ? 0.7 : 0.2, invoice_date: invDate ? 0.7 : 0.2, totals: taxable !== null ? 0.6 : 0.2 },
  };
}

// A model that just ran out of quota, stalled or was overloaded is skipped for a while, so every document does not wait on it again.
const coolUntil = new Map();
const cool = (model, ms) => coolUntil.set(model, Date.now() + ms);

export async function geminiJson(parts, opts = {}) {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const all = opts.models || [...new Set([config.geminiModel, "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-flash-lite-latest"])];
  const ready = all.filter((m) => (coolUntil.get(m) || 0) <= Date.now());
  const models = ready.length ? ready : all;
  let res, lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        let timer;
        const limit = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error("TIMEOUT: Gemini did not answer in time")), opts.timeoutMs || 60000); });
        try {
          res = await Promise.race([
            ai.models.generateContent({
              model,
              contents: [{ role: "user", parts }],
              config: { responseMimeType: "application/json", temperature: 0.1 },
            }),
            limit,
          ]);
        } finally { clearTimeout(timer); }
      } catch (e) {
        if (!lastErr || !/NOT_FOUND/.test(String(e.message))) lastErr = e;
        const msg = String(e.message || "");
        // out of quota or a stalled request will not recover by retrying the same model: move to the next one
        if (/exceeded your current quota/.test(msg)) { cool(model, 30 * 60000); break; }
        if (/TIMEOUT|"code":\s*503|UNAVAILABLE/.test(msg)) { cool(model, 3 * 60000); break; }
        if (/"code":\s*429|RESOURCE_EXHAUSTED/.test(msg)) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        else break;
      }
    }
    if (res) break;
  }
  if (!res) throw lastErr;
  let raw = (res.text || "").trim();
  if (raw.startsWith("```")) raw = raw.split("```")[1].replace(/^json/, "").trim();
  return JSON.parse(raw);
}

async function extractWithGemini(fileBytes, filename, mime, images) {
  const parts = [{ text: EXTRACTION_PROMPT }];
  if (path.extname(filename).toLowerCase() === ".pdf") {
    parts.push({ inlineData: { mimeType: "application/pdf", data: fileBytes.toString("base64") } });
  } else {
    for (const img of images.slice(0, 3)) {
      parts.push({ inlineData: { mimeType: "image/jpeg", data: (await imageToJpeg(img)).toString("base64") } });
    }
  }
  return geminiJson(parts);
}

/** Raises confidence only where the value is independently verified (checksum, QR match, arithmetic). */
export function calibrateConfidence(aiConf, inv, flags, qr, mode) {
  const c = { ...aiConf };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const up = (k, v) => { c[k] = Math.max(num(c[k], 0), v); };
  const trusted = mode === "gemini";
  if (inv.supplier_gstin && validateGstinChecksum(inv.supplier_gstin)) up("supplier_gstin", qr?.supplier_gstin === inv.supplier_gstin ? 1 : 0.99);
  if (inv.buyer_gstin && validateGstinChecksum(inv.buyer_gstin)) up("buyer_gstin", qr?.buyer_gstin === inv.buyer_gstin ? 1 : 0.99);
  else if (!inv.buyer_gstin && trusted) up("buyer_gstin", 0.98);
  if (trusted && inv.supplier_name && num(c.supplier_gstin, 0) >= 0.99) up("supplier_name", 0.98);
  if (trusted && inv.buyer_name && (num(c.buyer_gstin, 0) >= 0.99 || !inv.buyer_gstin)) up("buyer_name", 0.98);
  if (qr?.invoice_number && qr.invoice_number === inv.invoice_number) up("invoice_number", 1);
  if (qr?.invoice_date && qr.invoice_date === inv.invoice_date) up("invoice_date", 1);
  if (inv.invoice_total > 0 && !flags.some((f) => /tax_calculation|total/.test(f.type))) up("totals", trusted ? 1 : 0.9);
  if (inv.supplier_gstin && !validateGstinChecksum(inv.supplier_gstin)) c.supplier_gstin = Math.min(num(c.supplier_gstin, 0), 0.5);
  if (inv.buyer_gstin && !validateGstinChecksum(inv.buyer_gstin)) c.buyer_gstin = Math.min(num(c.buyer_gstin, 0), 0.5);
  if (!trusted) for (const k of Object.keys(c)) c[k] = Math.min(num(c[k], 0), 0.85);
  const keys = ["supplier_name", "buyer_name", "supplier_gstin", "buyer_gstin", "invoice_number", "invoice_date", "place_of_supply", "totals"];
  const vals = keys.map((k) => num(c[k], num(c.overall, 0.8)));
  let overall = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (flags.some((f) => f.severity === "error")) overall = Math.min(overall, 0.85);
  c.overall = Math.min(1, Math.round(overall * 1000) / 1000);
  return c;
}

const sum = (items, k) => items.reduce((a, it) => a + (Number(it[k]) || 0), 0);

export async function runExtractionPipeline(fileBytes, filename, mime, expectedTaxPeriod = null, onProgress = () => {}) {
  onProgress(10, "Opening the document");
  const images = await loadFileAsImages(fileBytes, filename, mime);
  if (!images.length) throw new Error("Could not extract any readable pages or images from the uploaded file.");

  onProgress(25, "Checking image quality");
  const { blurScore, isBlurry, isDark } = await assessImageQuality(images[0]);
  onProgress(38, "Looking for the e-invoice QR code");
  const qrData = await decodeEinvoiceQr(images);
  const isPdf = path.extname(filename).toLowerCase() === ".pdf" || mime === "application/pdf";

  let ai;
  let mode = "gemini";
  onProgress(50, "Reading the details with AI");
  if (config.geminiApiKey) {
    try {
      ai = await extractWithGemini(fileBytes, filename, mime, images);
    } catch (e) {
      console.warn("[extractor] Gemini failed, using fallback:", e.message);
      ai = null;
    }
  }
  if (!ai) {
    ai = await extractFallback(fileBytes, isPdf, qrData);
    mode = config.geminiApiKey ? "fallback_after_ai_error" : "rule_based_fallback";
  }

  onProgress(80, "Checking the figures");
  ai = sanitizeParties(ai, qrData);
  const supplier = ai.supplier;
  const buyer = ai.buyer;
  const lineItems = Array.isArray(ai.line_items) ? ai.line_items : [];
  const cgst = sum(lineItems, "cgst_amount"), sgst = sum(lineItems, "sgst_amount");
  const igst = sum(lineItems, "igst_amount"), cess = sum(lineItems, "cess");

  const invoice = {
    supplier_name: supplier.name || null,
    supplier_gstin: supplier.gstin || null,
    supplier_state: supplier.state || null,
    buyer_name: buyer.name || null,
    buyer_gstin: buyer.gstin || null,
    buyer_state: buyer.state || null,
    invoice_number: ai.invoice_number || null,
    invoice_date: ai.invoice_date || null,
    place_of_supply: String(ai.place_of_supply || ""),
    reverse_charge: Boolean(ai.reverse_charge),
    total_taxable_value: Number(ai.total_taxable_value) || 0,
    cgst_total: round2(cgst),
    sgst_total: round2(sgst),
    igst_total: round2(igst),
    cess_total: round2(cess),
    total_tax: Number(ai.total_tax) || cgst + sgst + igst + cess,
    invoice_total: Number(ai.invoice_total) || 0,
  };

  const flags = validateInvoice(invoice, lineItems, expectedTaxPeriod, qrData);
  if (!invoice.invoice_number) flags.push({ type: "invoice_number_missing", severity: "error", field: "invoice_number", message: "Invoice number could not be read." });
  if (!lineItems.length) flags.push({ type: "no_line_items", severity: "error", field: "line_items", message: "No line items could be extracted." });
  if (mode !== "gemini") {
    flags.push({ type: "fallback_extraction", severity: "warning", field: "extraction", message: "AI extraction was unavailable; values come from a basic text parser. Verify every field." });
  }
  if (isBlurry) flags.push({ type: "blurry_image_warning", severity: "warning", field: "image", message: "Image appears blurry. Text extraction may be inaccurate; please verify carefully." });
  if (isDark) flags.push({ type: "dark_image_warning", severity: "warning", field: "image", message: "Image is very dark. Please consider re-capturing with better lighting." });

  const conf = calibrateConfidence(ai.confidence || {}, invoice, flags, qrData, mode);
  const overall = conf.overall;

  return {
    quality: { blur_score: blurScore, is_blurry: isBlurry, is_dark: isDark },
    qr_data: qrData,
    extraction_mode: mode,
    invoice_data: invoice,
    line_items: lineItems,
    confidence: { overall, fields: conf },
    flags,
    review_status: determineReviewStatus(overall, flags),
    raw_ai_data: ai,
  };
}
