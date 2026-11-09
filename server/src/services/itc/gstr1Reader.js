import { config } from "../../config.js";
import { geminiJson } from "../extractor.js";
import { pdfText } from "../recon/gstr3bParser.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const n = (v) => {
  if (v == null || v === "") return 0;
  const x = Number(String(v).replace(/[₹,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
  return Number.isFinite(x) ? x : 0;
};

const PROMPT = `You are reading a GSTR-1 return PDF (downloaded from the GST portal, either the summary or the full return). Extract the outward tax liability of the taxpayer for the month.

Return ONLY JSON in exactly this shape:
{
  "gstin": "15-character GSTIN of the taxpayer or empty",
  "legal_name": "",
  "return_period": "as printed, e.g. November 2026",
  "printed_total_liability": null or { "taxable_value": 0, "integrated_tax": 0, "central_tax": 0, "state_ut_tax": 0, "cess": 0 },
  "sections": [
    { "table": "4A", "description": "B2B supplies", "effect": "add", "taxable_value": 0, "integrated_tax": 0, "central_tax": 0, "state_ut_tax": 0, "cess": 0 }
  ],
  "nil_exempt_non_gst": { "nil_rated": 0, "exempt": 0, "non_gst": 0 }
}

Rules:
- "printed_total_liability" is the figure printed as "Total Liability (Outward supplies other than Reverse charge)" or similar. Use null if the document does not print one.
- "sections" has one entry per table total that is printed (use the section total, never individual invoices): 4A B2B, 4B supplies attracting reverse charge, 5A B2CL, 6A exports, 6B SEZ supplies, 6C deemed exports, 7 B2CS, 9A amended supplies, 9B credit/debit notes (registered), 9B credit/debit notes (unregistered), 11A advances received, 11B adjustment of advances, and any other taxable table with amounts.
- "effect" is "add" for taxable outward supplies, debit notes and advances received; "subtract" for credit notes and adjustment of advances; "ignore" for 4B (supplies attracting reverse charge), nil/exempt/non-GST table 8, HSN summary, documents issued, e-commerce tables and anything that is not outward tax liability. If a table shows credit notes and debit notes separately, make two entries.
- Amounts are in rupees as plain numbers (no commas). Use 0 when a figure is not shown. Do not invent numbers.
- "nil_exempt_non_gst" comes from table 8 (taxable value only).`;

const HEADS = ["taxable", "igst", "cgst", "sgst", "cess"];
const toFive = (o) => ({ taxable: r2(n(o?.taxable_value)), igst: r2(n(o?.integrated_tax)), cgst: r2(n(o?.central_tax)), sgst: r2(n(o?.state_ut_tax)), cess: r2(n(o?.cess)) });

/** Turns the model's answer into the liability used in the GSTR-3B summary. Exported so it can be tested without the model. */
export function liabilityFrom(ai) {
  const warnings = [];
  const sections = (Array.isArray(ai?.sections) ? ai.sections : []).map((s) => ({
    table: String(s.table || ""), description: String(s.description || ""), effect: ["add", "subtract", "ignore"].includes(s.effect) ? s.effect : "ignore", ...toFive(s),
  }));
  const computed = Object.fromEntries(HEADS.map((h) => [h, 0]));
  for (const s of sections) {
    if (s.effect === "ignore") continue;
    const sign = s.effect === "subtract" ? -1 : 1;
    for (const h of HEADS) computed[h] += sign * s[h];
  }
  for (const h of HEADS) computed[h] = r2(computed[h]);
  const printed = ai?.printed_total_liability ? toFive(ai.printed_total_liability) : null;
  let liability = printed || computed;
  const source = printed ? "printed" : "computed";
  if (printed && sections.some((s) => s.effect !== "ignore")) {
    const off = HEADS.filter((h) => Math.abs(printed[h] - computed[h]) > 10);
    if (off.length) warnings.push(`The total printed in the PDF differs from the sum of its tables for ${off.join(", ")}. The printed total is used; check it against the PDF.`);
  }
  if (!printed && !sections.some((s) => s.effect !== "ignore")) warnings.push("No outward tax liability could be read from this PDF. Check that it is the GSTR-1 summary or return.");
  const nil = ai?.nil_exempt_non_gst || {};
  return {
    gstin: String(ai?.gstin || "").toUpperCase(), legal_name: String(ai?.legal_name || ""), return_period: String(ai?.return_period || ""),
    sections, printed, computed, liability, source, warnings,
    exempt: { nil: r2(n(nil.nil_rated)), exempt: r2(n(nil.exempt)), non_gst: r2(n(nil.non_gst)) },
  };
}

/** Reads the outward liability from a GSTR-1 PDF. */
export async function readGstr1Pdf(bytes) {
  if (!config.geminiApiKey) throw new Error("The AI key is not set, so the GSTR-1 PDF cannot be read.");
  let text = "";
  try { text = await pdfText(bytes); } catch { text = ""; }
  const parts = [{ text: PROMPT }];
  if (text.replace(/\s+/g, "").length > 300) parts.push({ text: `GSTR-1 PDF text:\n${text.slice(0, 60000)}` });
  else parts.push({ inlineData: { mimeType: "application/pdf", data: Buffer.from(bytes).toString("base64") } });
  // models that answer quickly are tried first: this runs while the staff member waits
  const ai = await geminiJson(parts, { models: ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-flash-lite-latest"], timeoutMs: 45000 });
  return liabilityFrom(ai);
}
