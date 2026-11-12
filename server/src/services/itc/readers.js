import { readSheets, parseSheetFile, toNum, toDate, normInv, normGstin, normName } from "../recon/sheetParser.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const norm = (h) => String(h ?? "").toLowerCase().replace(/[\r\n]+/g, " ").replace(/[₹()]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Column headings, one list of candidate texts per column. A heading can run over two rows (the GST portal's GSTR-2B puts
 * "Invoice details" and "Tax Amount" above the real column names), so the lower row is tried first and the upper row after it.
 */
export function candidates(rows, i, span) {
  const group = rows.slice(i, i + span);
  const width = Math.max(0, ...group.map((r) => (r || []).length));
  const out = [];
  for (let c = 0; c < width; c++) {
    const own = group.map((r) => norm((r || [])[c])).filter(Boolean).reverse();
    if (own.length > 1) own.push(own.slice().reverse().join(" "));
    out.push(own);
  }
  return out;
}

/** Maps each wanted field to the first column whose heading matches one of its patterns. */
export function mapColumns(cands, aliases) {
  const map = {};
  const used = new Set();
  for (const [field, res] of Object.entries(aliases)) {
    for (const re of res) {
      const i = cands.findIndex((hs, k) => !used.has(k) && hs.some((h) => re.test(h)));
      if (i >= 0) { map[field] = i; used.add(i); break; }
    }
  }
  return map;
}

export const isTextRow = (r) => (r || []).some((c) => c !== "" && c != null) && (r || []).every((c) => c === "" || c == null || (typeof c === "string" && Number.isNaN(Number(c.replace(/[,₹\s]/g, "")))));

/** Finds the heading rows: the best-scoring single row or pair of rows in the first 25. */
export function findHeader(rows, aliases, need) {
  let best = null;
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    for (const span of [1, 2]) {
      if (span === 2 && !(isTextRow(rows[i]) && isTextRow(rows[i + 1]))) continue;
      const cands = candidates(rows, i, span);
      const map = mapColumns(cands, aliases);
      const have = Object.keys(map);
      if (!need(have)) continue;
      if (!best || have.length > best.score) best = { row: i, span, map, cands, score: have.length };
    }
  }
  return best;
}

/** What was read from which column, so a wrong mapping can be seen. */
const describe = (h) => Object.entries(h.map).map(([f, i]) => `${f}: ${h.cands[i][0]}`);
const TAXES = ["igst", "cgst", "sgst", "cess"];
function taxWarning(rows, mapped) {
  if (!rows.length) return null;
  const taxCols = TAXES.filter((t) => mapped[t] != null);
  if (!taxCols.length) return "No IGST, CGST or SGST column was found in this file, so every line shows no tax. Check the column headings.";
  const total = rows.reduce((a, r) => a + r.igst + r.cgst + r.sgst + r.cess, 0);
  return total === 0 ? "Every tax amount in this file is zero. Check that the tax columns are the ones read." : null;
}

export const emptyRow = (r) => r.every((c) => c === "" || c == null);
export const isTotalRow = (r) => r.slice(0, 4).some((c) => /^(grand\s*)?(sub\s*)?total\b/i.test(String(c ?? "").trim()));
const sumKey = (type, gstin, party, no) => `${type}|${normGstin(gstin) || "N:" + normName(party)}|${normInv(no)}`;

// ------------------------------------------------------------------ the books: "ITC as per books"
const BOOKS = {
  // in a ledger-style register "Particulars" (or the ledger or account name) is the party; it is read as the nature only when the file has a separate party column
  party: [/^party'?s? name/, /party name/, /(supplier|vendor) name/, /trade\/?legal/, /^name of (the )?(party|supplier)/, /^party$/, /^supplier$/, /^vendor$/, /^name$/, /^particulars$/, /^ledger( name)?$/, /^account( name)?$/],
  gstin: [/gstin/, /gst no/, /\buin\b/],
  invno: [/invoice (no|number)/, /inv(oice)? ?no/, /bill (no|number)/, /document (no|number)/, /note (no|number)/, /voucher (no|number)/, /^invoice$/, /^bill$/],
  date: [/invoice date/, /inv(oice)? date/, /bill date/, /document date/, /note date/, /^date$/],
  nature: [/nature of (services|supply|goods)/, /^nature/, /description/, /particulars/],
  supply: [/type of supply/, /inter ?\/ ?intra/, /inter.?state/],
  charge: [/type of charge/, /^charge/, /fcm/],
  nil: [/nil/],
  taxable: [/taxable/],
  rate: [/gst rate/, /^rate/, /tax rate/],
  igst: [/\bigst\b/, /integrated/],
  cgst: [/\bcgst\b/, /central tax/],
  sgst: [/\bsgst\b/, /state\/?ut tax/, /state tax/],
  utgst: [/\butgst\b/],
  cess: [/cess/],
  rcm: [/^rcm$/, /rcm (tax|amount|amt)/, /reverse charge (tax|amount)/],
  value: [/invoice value/, /^total/, /gross/, /^value$/],
  type: [/document type/, /^type$/],
};

/** The ITC register as kept in the books: one line per invoice and GST rate; invoices are totalled across their lines. */
export async function readBooksItc(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  const merged = new Map();
  let lines = 0;
  const used = [];
  const columns = [];
  let mappedAll = {};
  for (const sh of sheets) {
    if (/read ?me|summary|instruction|help/i.test(sh.name)) continue;
    const h = findHeader(sh.rows, BOOKS, (have) => have.includes("invno") && (have.includes("taxable") || have.includes("igst") || have.includes("cgst") || have.includes("value")));
    if (!h) continue;
    used.push(sh.name);
    columns.push(...describe(h).map((x) => `${sh.name} - ${x}`));
    mappedAll = { ...mappedAll, ...h.map };
    const m = h.map;
    const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
    const sheetType = /credit/i.test(sh.name) ? "cn" : /debit/i.test(sh.name) ? "dn" : "inv";
    for (let i = h.row + h.span; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (emptyRow(r) || isTotalRow(r)) continue;
      const invNo = String(get(r, "invno") ?? "").trim();
      if (!invNo) continue;
      const typeTxt = norm(get(r, "type"));
      const type = /credit/.test(typeTxt) ? "cn" : /debit/.test(typeTxt) ? "dn" : sheetType;
      const gstin = normGstin(get(r, "gstin"));
      const party = String(get(r, "party") ?? "").trim();
      const key = sumKey(type, gstin, party, invNo);
      let d = merged.get(key);
      if (!d) {
        d = { type, gstin, party, inv_no: invNo, date: toDate(get(r, "date")), nature: [], supply: "", charge: "", taxable: 0, nil: 0, rates: [], igst: 0, cgst: 0, sgst: 0, cess: 0, rcm: 0, value: 0, sheet: sh.name };
        merged.set(key, d);
      }
      d.taxable += toNum(get(r, "taxable"));
      d.nil += toNum(get(r, "nil"));
      d.igst += toNum(get(r, "igst"));
      d.cgst += toNum(get(r, "cgst"));
      d.sgst += toNum(get(r, "sgst")) + toNum(get(r, "utgst"));
      d.cess += toNum(get(r, "cess"));
      d.rcm += toNum(get(r, "rcm"));
      d.value = Math.max(d.value, toNum(get(r, "value")));
      const rate = toNum(get(r, "rate"));
      if (rate && !d.rates.includes(rate)) d.rates.push(rate);
      const nature = String(get(r, "nature") ?? "").trim();
      if (nature && !d.nature.includes(nature) && d.nature.length < 3) d.nature.push(nature);
      const supply = norm(get(r, "supply"));
      if (supply && !d.supply) d.supply = /^inter|igst/.test(supply) ? "inter" : /intra/.test(supply) ? "intra" : "";
      const charge = norm(get(r, "charge"));
      if (/rcm|reverse/.test(charge)) d.charge = "RCM";
      else if (/exempt|nil/.test(charge) && d.charge !== "RCM") d.charge = "Exempt";
      else if (!d.charge && charge) d.charge = "FCM";
      lines++;
    }
  }
  if (!used.length) throw new Error("Could not find the ITC register in this file. It needs columns such as Party's Name, GSTIN, Invoice No, Invoice Date, Taxable Value, IGST, CGST and SGST.");
  const rows = [...merged.values()].map((d) => {
    const taxable = r2(d.taxable);
    const tax = d.igst + d.cgst + d.sgst + d.cess;
    return {
      ...d, taxable, nil: r2(d.nil), igst: r2(d.igst), cgst: r2(d.cgst), sgst: r2(d.sgst), cess: r2(d.cess), rcm: r2(d.rcm),
      nature: d.nature.join("; "), rate: d.rates.length === 1 ? d.rates[0] : d.rates.length ? Math.max(...d.rates) : 0,
      charge: d.charge || (d.rcm > 0 ? "RCM" : "FCM"),
      value: d.value || r2(taxable + d.nil + tax),
    };
  });
  if (!rows.length) warnings.push("The register has no invoice rows.");
  const tw = taxWarning(rows, mappedAll);
  if (tw) warnings.push(tw);
  return { rows, sheets: used, lines, warnings, columns };
}

// ------------------------------------------------------------------ GSTR-2B as downloaded from the portal
const G2B = {
  gstin: [/gstin of (supplier|isd)/, /gstin/],
  party: [/trade\/?legal name/, /legal name|trade name/, /party|supplier name/],
  invno: [/^invoice number$/, /invoice (no|number)/, /note (no|number)/, /isd document number/, /^number$/],
  date: [/^invoice date$/, /^note date$/, /isd document date/, /^date$/],
  notetype: [/^note type$/, /^isd document type$/],
  value: [/invoice value/, /note value/],
  pos: [/place of supply/],
  reverse: [/attract reverse charge/, /reverse charge/],
  taxable: [/taxable value/],
  igst: [/integrated tax/, /\bigst\b/],
  cgst: [/central tax/, /\bcgst\b/],
  sgst: [/state\/?ut tax/, /state tax/, /\bsgst\b/, /\butgst\b/],
  cess: [/^cess/, /\bcess\b/],
  period: [/gstr-?1.*period/, /gstr-?5.*period/],
  avail: [/itc availability/, /itc eligib/],
  reason: [/^reason$/],
  pct: [/applicable/],
};

const SHEET_SRC = (name) => {
  const s = String(name).toLowerCase().trim();
  if (/^b2b$/.test(s)) return "b2b";
  if (/cdnr$/.test(s) && !/cdnra/.test(s)) return "cdnr";
  if (/^impg$/.test(s)) return "impg";
  if (/^isd$/.test(s)) return "isd";
  return null;
};

/** The GSTR-2B Excel from the GST portal: B2B invoices, credit/debit notes, imports and ISD credits. */
export async function readGstr2b(buffer, filename, opts = {}) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  const merged = new Map();
  const used = [];
  const columns = [];
  let mappedAll = {};
  const take = (sh, src) => {
    const h = findHeader(sh.rows, G2B, (have) => have.includes("invno") && (have.includes("taxable") || have.includes("igst") || have.includes("cgst")));
    if (!h) return false;
    used.push(sh.name);
    columns.push(...describe(h).map((x) => `${sh.name} - ${x}`));
    mappedAll = { ...mappedAll, ...h.map };
    const m = h.map;
    const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
    for (let i = h.row + h.span; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (emptyRow(r) || isTotalRow(r)) continue;
      const invNo = String(get(r, "invno") ?? "").trim();
      if (!invNo) continue;
      const nt = norm(get(r, "notetype"));
      const type = src === "cdnr" ? (/debit/.test(nt) ? "dn" : "cn") : "inv";
      const gstin = src === "impg" ? "IMPORT" : normGstin(get(r, "gstin"));
      const key = `${src}|${sumKey(type, gstin, get(r, "party"), invNo)}`;
      let d = merged.get(key);
      if (!d) {
        const rv = norm(get(r, "reverse"));
        const av = norm(get(r, "avail"));
        d = {
          src, type, gstin, party: String(get(r, "party") ?? "").trim(), inv_no: invNo, date: toDate(get(r, "date")), value: toNum(get(r, "value")),
          pos: String(get(r, "pos") ?? "").trim(), reverse: rv === "y" || rv === "yes", taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0,
          period: String(get(r, "period") ?? "").trim(), avail: src === "impg" || src === "isd" ? (av ? (/^n/.test(av) ? "No" : "Yes") : "Yes") : /^y/.test(av) ? "Yes" : /^n/.test(av) ? "No" : av ? "Temporary" : "",
          reason: String(get(r, "reason") ?? "").trim(), pct: toNum(get(r, "pct")),
        };
        merged.set(key, d);
      }
      d.taxable += toNum(get(r, "taxable"));
      d.igst += toNum(get(r, "igst"));
      d.cgst += toNum(get(r, "cgst"));
      d.sgst += toNum(get(r, "sgst"));
      d.cess += toNum(get(r, "cess"));
    }
    return true;
  };
  for (const sh of sheets) {
    const src = SHEET_SRC(sh.name);
    if (src) take(sh, src);
    else if (/b2ba|cdnra/i.test(sh.name) && sh.rows.length > 6) warnings.push(`The amendment sheet "${sh.name}" is not read. Amended invoices appear in the main sheets.`);
  }
  if (!used.length) {
    // not a portal file: try every sheet for a plain list of supplier invoices
    for (const sh of sheets) if (!/read ?me|summary|instruction|help/i.test(sh.name) && take(sh, "b2b")) break;
  }
  if (!used.length) throw new Error("Could not find the invoices in this GSTR-2B file. Upload the Excel downloaded from the GST portal (it has B2B and B2B-CDNR sheets).");
  const rows = [...merged.values()].map((d) => ({
    ...d, taxable: r2(d.taxable), igst: r2(d.igst), cgst: r2(d.cgst), sgst: r2(d.sgst), cess: r2(d.cess),
    value: d.value || r2(d.taxable + d.igst + d.cgst + d.sgst + d.cess),
  }));
  let tw = taxWarning(rows, mappedAll);
  if (tw) {
    // the file has its own layout: let the general register reader (which also derives tax from the rate) try before giving up
    const alt = await generalRows(buffer, filename, opts);
    if (alt && alt.reduce((a, r) => a + r.igst + r.cgst + r.sgst + r.cess, 0) > 0) {
      warnings.push("The tax columns in this file were not in the usual GSTR-2B layout, so it was read with the general reader. Check the tax amounts below.");
      return { rows: alt, sheets: used, warnings, columns };
    }
    warnings.push(tw);
  }
  return { rows, sheets: used, warnings, columns };
}

async function generalRows(buffer, filename, opts) {
  try {
    const parsed = await parseSheetFile(buffer, filename, { kind: "portal", clientGstin: opts.clientGstin });
    const merged = new Map();
    for (const r of parsed.rows) {
      if (r.section === "b2ba" || r.section === "cdnra") continue;
      const type = r.type === "cn" ? "cn" : r.type === "dn" ? "dn" : "inv";
      const key = sumKey(type, r.gstin, r.party, r.inv_no);
      let d = merged.get(key);
      if (!d) {
        d = { src: r.section === "cdnr" ? "cdnr" : "b2b", type, gstin: r.gstin, party: r.party, inv_no: r.inv_no, date: r.date, value: r.value || 0, pos: r.pos || "", reverse: Boolean(r.rcm), taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, period: "", avail: r.itc === false ? "No" : "Yes", reason: "", pct: r.rate || 0 };
        merged.set(key, d);
      }
      d.taxable += r.taxable; d.igst += r.igst; d.cgst += r.cgst; d.sgst += r.sgst; d.cess += r.cess;
    }
    return [...merged.values()].map((d) => ({ ...d, taxable: r2(d.taxable), igst: r2(d.igst), cgst: r2(d.cgst), sgst: r2(d.sgst), cess: r2(d.cess), value: d.value || r2(d.taxable + d.igst + d.cgst + d.sgst + d.cess) }));
  } catch { return null; }
}
