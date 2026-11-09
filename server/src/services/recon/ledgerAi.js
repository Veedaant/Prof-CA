import path from "node:path";
import { config } from "../../config.js";
import { geminiJson } from "../extractor.js";
import { normGstin, toDate, toNum, SLABS } from "./sheetParser.js";

const n2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

const buildPrompt = (side) => `You are reading a ${side === "sales" ? "sales ledger / sales register" : "purchase ledger / purchase register"} of an Indian business (a PDF or a photo of it).
List EVERY entry that is a ${side === "sales" ? "sales invoice" : "purchase invoice"}, a credit note or a debit note. Skip opening/closing balances, totals, bank and payment entries.
Return ONLY JSON: {"entries":[{
  "kind": "invoice" | "credit_note" | "debit_note",
  "date": "YYYY-MM-DD",
  "document_number": string,
  "party_name": string (the ${side === "sales" ? "customer" : "supplier"}),
  "party_gstin": string or "",
  "taxable_value": number,
  "cgst": number, "sgst": number, "igst": number, "cess": number,
  "invoice_value": number,
  "reverse_charge": true | false
}]}
Rules: numbers are plain numbers without commas or currency symbols. Use 0 for a tax that is not shown. Never invent an entry or a value; if a field is unreadable use "" for text and 0 for numbers. Keep each ledger line as one entry.`;

const MIME = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// the AI sometimes keeps the voucher type in the number, e.g. "CN-77 (Credit Note)"
const TYPE_SUFFIX = /\s*[(\[]\s*(credit|debit|purchase|invoice|cr|dr)[^)\]]*[)\]]\s*/gi;
const cleanNumber = (v) => String(v || "").replace(TYPE_SUFFIX, " ").trim();

function slab(rate) {
  let best = 0, d = 1e9;
  for (const s of SLABS) if (Math.abs(s - rate) < d) { d = Math.abs(s - rate); best = s; }
  return best;
}

/** Reads a ledger PDF / photo with AI and returns rows in the same shape as the spreadsheet ledger parser. */
export async function extractLedgerWithAi(buffer, filename, side = "purchase") {
  if (!config.geminiApiKey) throw new Error("AI reading is not set up on this server. Upload the ledger as an Excel or CSV file instead.");
  const mimeType = MIME[path.extname(filename).toLowerCase()];
  if (!mimeType) throw new Error("Unsupported ledger file type");
  let out;
  try {
    out = await geminiJson([{ text: buildPrompt(side) }, { inlineData: { mimeType, data: Buffer.from(buffer).toString("base64") } }]);
  } catch (e) {
    throw new Error(`The AI could not read this ledger right now (${String(e.message || e).slice(0, 120)}). Try again, or upload it as an Excel or CSV file.`);
  }
  const entries = Array.isArray(out?.entries) ? out.entries : [];
  const rows = [];
  for (const e of entries) {
    const taxable = toNum(e.taxable_value), igst = toNum(e.igst), cgst = toNum(e.cgst), sgst = toNum(e.sgst), cess = toNum(e.cess);
    const value = toNum(e.invoice_value);
    if (!taxable && !igst && !cgst && !sgst && !value) continue;
    const t = taxable || n2(value - igst - cgst - sgst - cess);
    const type = e.kind === "credit_note" ? "cn" : e.kind === "debit_note" ? "dn" : "inv";
    rows.push({
      section: "ledger", type, gstin: normGstin(e.party_gstin), party: String(e.party_name || "").trim(), inv_no: cleanNumber(e.document_number),
      date: toDate(e.date), pos: "", rcm: Boolean(e.reverse_charge), itc: true, sheet: "AI",
      rate: t ? slab(((igst + cgst + sgst) / t) * 100) : 0,
      taxable: n2(t), igst: n2(igst), cgst: n2(cgst), sgst: n2(sgst), cess: n2(cess), value: n2(value),
    });
  }
  if (!rows.length) throw new Error("No invoice, credit note or debit note entries could be read from this ledger. Upload a clearer copy, or an Excel / CSV file.");
  return { rows };
}
