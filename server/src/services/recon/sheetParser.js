import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { extractStateCode } from "../validators.js";

const n2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const SLABS = [0, 0.25, 1, 1.5, 3, 5, 7.5, 12, 18, 28, 40];

export function toNum(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  let s = String(v).replace(/[₹,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  if (/cr$/i.test(s)) s = s.replace(/cr$/i, "");
  if (/dr$/i.test(s)) s = s.replace(/dr$/i, "");
  const x = Number(s);
  return Number.isFinite(x) ? x : 0;
}

function cellValue(v) {
  if (v == null) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result);
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if ("error" in v) return "";
  }
  return v;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function toDate(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
  }
  if (typeof v === "number" && v > 20000 && v < 80000) return toDate(new Date(Math.round((v - 25569) * 86400000)));
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/. ]([A-Za-z]{3})[a-z]*[-/. ,]+(\d{2,4})$/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return `${m[3].length === 2 ? "20" + m[3] : m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

export const normInv = (s) => String(s ?? "").replace(/[^A-Za-z0-9]/g, "").replace(/^0+/, "").toUpperCase();
export const normGstin = (s) => String(s ?? "").replace(/\s+/g, "").toUpperCase();
export const normName = (s) => String(s ?? "").toUpperCase().replace(/\b(PVT|PRIVATE|LTD|LIMITED|LLP|THE|M\/S|MS)\b/g, "").replace(/[^A-Z0-9]/g, "");

// canonical field -> [regex, ...] tested against a normalised header (lowercase, single spaces)
const ALIASES = {
  gstin: [/gstin\/uin of (recipient|supplier)/, /gstin of (supplier|recipient)/, /^(party |customer |supplier |buyer |recipient |receiver )?gst(in)?( no\.?| number)?(\/uin)?$/, /\bgstin\b/, /\buin\b/, /gst no/],
  party: [/(trade|legal)\/?(legal|trade)? name/, /(receiver|recipient|supplier|customer|party|buyer|ledger) name/, /^particulars$/, /^party$/, /^name$/, /^customer$/, /^supplier$/, /^buyer$/, /^ledger$/],
  invno: [/(invoice|inv|bill|voucher|vch|document|doc|note|credit note|debit note) ?(number|no\.?|#)/, /^(invoice|bill|voucher)$/, /supplier inv/],
  date: [/(invoice|inv|bill|voucher|vch|document|doc|note) date/, /^date$/, /\bdate\b/],
  value: [/(invoice|note|voucher|document|bill) value/, /gross total/, /(invoice|bill|total) amount/, /^total$/, /^amount$/, /^value$/],
  pos: [/place of supply/, /^pos$/],
  rcm: [/reverse charge/, /^rcm$/],
  rate: [/^rate( ?\(%\))?$/, /tax rate/, /gst rate/, /applicable % of tax rate/, /^rate/],
  taxable: [/taxable (value|amount|amt)/, /assessable/, /^taxable$/, /net amount/, /^basic value$/],
  igst: [/integrated tax/, /\bigst\b(?! ?@)/, /^igst/],
  cgst: [/central tax/, /\bcgst\b(?! ?@)/, /^cgst/],
  sgst: [/state\/ut tax/, /state tax/, /\bsgst\b(?! ?@)/, /\butgst\b/, /^sgst/],
  cess: [/\bcess\b/],
  type: [/(note|document|voucher|vch|transaction) type/, /^type$/, /note\/refund voucher type/],
  invtype: [/^invoice type$/],
  itc: [/itc availab/, /eligible for itc/],
  period: [/gstr-?1\/?(iff)?\/?(5)? period/, /return period/, /filing period/],
};

const norm = (h) => String(h ?? "").toLowerCase().replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

function mapHeaders(headers) {
  const hs = headers.map(norm);
  const map = {};
  const used = new Set();
  for (const [field, res] of Object.entries(ALIASES)) {
    for (const re of res) {
      const idx = hs.findIndex((h, i) => h && !used.has(i) && re.test(h) && !(field !== "gstin" && /ecommerce|e-commerce/.test(h)) && !(field === "gstin" && /e-?commerce/.test(h)));
      if (idx >= 0) {
        // date must not be a filing date; value must not be taxable value
        if (field === "date" && /filing|gstr|period/.test(hs[idx])) continue;
        if (field === "value" && /taxable/.test(hs[idx])) continue;
        if (field === "party" && /gstin/.test(hs[idx])) continue;
        map[field] = idx;
        used.add(idx);
        break;
      }
    }
  }
  // per-rate columns used by Tally-style registers: "Sales @18%", "CGST @9%"
  const rateTaxable = [], rateTax = [];
  hs.forEach((h, i) => {
    let m = /(cgst|sgst|utgst|igst)[^0-9]*?(\d{1,2}(?:\.\d+)?)\s*%/.exec(h);
    if (m) return rateTax.push({ idx: i, head: m[1] === "utgst" ? "sgst" : m[1], rate: Number(m[2]) * (m[1] === "igst" ? 1 : 2) });
    m = /(sales|purchase|taxable|supply|local|interstate|inter-state|intra-state|goods|services|b2b|b2c)[^0-9]*?(\d{1,2}(?:\.\d+)?)\s*%/.exec(h);
    if (m && !/tax|igst|cgst|sgst/.test(h.replace(/taxable/g, ""))) rateTaxable.push({ idx: i, rate: Number(m[2]) });
  });
  return { map, rateTaxable, rateTax };
}

function score(headers) {
  const { map, rateTaxable } = mapHeaders(headers);
  const keys = Object.keys(map);
  let s = keys.length;
  if (!(keys.includes("invno") || keys.includes("taxable") || rateTaxable.length)) s = 0;
  if (!(keys.includes("taxable") || keys.includes("value") || keys.includes("igst") || keys.includes("cgst") || rateTaxable.length)) s = 0;
  return s;
}

export async function readSheets(buffer, filename) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) {
    const ws = await wb.csv.read(Readable.from(buffer), { map: (v) => v });
    ws.name = "csv";
  } else {
    await wb.xlsx.load(buffer);
  }
  const sheets = [];
  wb.eachSheet((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals = [];
      for (let c = 1; c <= row.cellCount; c++) vals.push(cellValue(row.getCell(c).value));
      rows.push(vals);
    });
    sheets.push({ name: ws.name, rows });
  });
  return sheets;
}

const sectionOf = (sheetName) => {
  const s = String(sheetName).toLowerCase();
  if (/cdn/.test(s)) return /unreg|cdnur/.test(s) ? "cdnur" : "cdnr";
  if (/b2cs/.test(s)) return "b2cs";
  if (/b2cl/.test(s)) return "b2cl";
  if (/b2ba|b2b-?a/.test(s)) return "b2ba";
  if (/b2b/.test(s)) return "b2b";
  if (/exp/.test(s)) return "exp";
  if (/hsn|docs|exemp|nil|\bat\b|atadj/.test(s)) return "skip";
  if (/read ?me|summary|help|instruction/.test(s)) return "skip";
  return s.replace(/\s+/g, "_");
};

function slab(rate) {
  if (!Number.isFinite(rate) || rate < 0) return 0;
  let best = 0, d = 1e9;
  for (const s of SLABS) if (Math.abs(s - rate) < d) { d = Math.abs(s - rate); best = s; }
  return Math.abs(best - rate) <= 0.6 ? best : n2(rate);
}

/**
 * Parses a ledger / register / portal download into normalised rows.
 * opts: { kind: 'ledger'|'portal', clientGstin, ledgerKind: 'sales'|'purchase' }
 */
export async function parseSheetFile(buffer, filename, opts = {}) {
  const sheets = await readSheets(buffer, filename);
  const out = [];
  const used = [];
  for (const sh of sheets) {
    const sec = sectionOf(sh.name);
    if (sec === "skip") continue;
    let hIdx = -1, best = 0;
    for (let i = 0; i < Math.min(sh.rows.length, 20); i++) {
      const s = score(sh.rows[i]);
      if (s > best) { best = s; hIdx = i; }
    }
    if (hIdx < 0 || best < 2) continue;
    // portal workbooks sometimes carry a second header row with sub-labels: skip rows that are not data
    const { map, rateTaxable, rateTax } = mapHeaders(sh.rows[hIdx]);
    const get = (r, f) => (map[f] == null ? "" : r[map[f]]);
    let count = 0;
    for (let i = hIdx + 1; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      const first = norm(r[0]);
      if (/^(total|grand total|sub ?total)/.test(first) || r.every((c) => c === "" || c == null)) continue;
      const invNo = String(get(r, "invno") ?? "").trim();
      // a totals line such as "TOTAL" in the party column is not an entry
      if (!invNo && r.slice(0, 5).some((c) => /^(grand\s*)?(sub\s*)?total\b/i.test(String(c ?? "").trim()))) continue;
      let taxable = toNum(get(r, "taxable"));
      let igst = toNum(get(r, "igst")), cgst = toNum(get(r, "cgst")), sgst = toNum(get(r, "sgst")), cess = toNum(get(r, "cess"));
      const value = toNum(get(r, "value"));
      const typeTxt = norm(get(r, "type"));
      const sheetTxt = sh.name.toLowerCase();
      let type = "inv";
      if (sec === "cdnr" || sec === "cdnur" || /credit|debit|cdn/.test(sheetTxt) || /^(c|d)$/.test(typeTxt) || /credit|debit|cr note|dr note/.test(typeTxt)) {
        type = /^d$|debit|dr note/.test(typeTxt) ? "dn" : "cn";
        if (/debit/.test(sheetTxt) && !/credit/.test(sheetTxt)) type = "dn";
      }
      let rate = toNum(get(r, "rate"));
      const gstin = normGstin(get(r, "gstin"));
      const party = String(get(r, "party") ?? "").trim();
      const date = toDate(get(r, "date"));
      const pos = String(get(r, "pos") ?? "").trim();
      const rcmTxt = norm(get(r, "rcm"));
      const rcm = rcmTxt === "y" || rcmTxt === "yes" || rcmTxt === "true";
      const itcTxt = norm(get(r, "itc"));
      const itc = itcTxt ? !/^no|ineligible|n$/.test(itcTxt) : true;
      const base = { section: sec, type, gstin, party, inv_no: invNo, date, pos, rcm, itc, sheet: sh.name };

      const sub = [];
      if (rateTaxable.length) {
        for (const rt of rateTaxable) {
          const t = toNum(r[rt.idx]);
          if (!t) continue;
          const tx = rateTax.filter((x) => Math.abs(x.rate - rt.rate) < 0.01 || (x.head !== "igst" && Math.abs(x.rate - rt.rate) < 0.01));
          const row = { rate: rt.rate, taxable: t, igst: 0, cgst: 0, sgst: 0, cess: 0 };
          let hasTax = false;
          for (const x of rateTax) {
            if (Math.abs(x.rate - rt.rate) < 0.01) { row[x.head] += toNum(r[x.idx]); hasTax = true; }
          }
          if (!hasTax) {
            const totalTax = t * rt.rate / 100;
            if (igst > 0 && cgst + sgst === 0) row.igst = n2(totalTax);
            else { row.cgst = n2(totalTax / 2); row.sgst = n2(totalTax / 2); }
          }
          void tx;
          sub.push(row);
        }
      } else if (taxable || igst || cgst || sgst || value) {
        if (!taxable && value) taxable = n2(value - igst - cgst - sgst - cess);
        if (!(igst || cgst || sgst) && rate > 0 && taxable) {
          // portal sheets give only rate + taxable value: derive the tax split from place of supply vs client state
          const clientState = extractStateCode(opts.clientGstin);
          const posState = extractStateCode(pos) || extractStateCode(gstin);
          const total = taxable * rate / 100;
          const inter = opts.kind === "portal" && clientState && posState ? clientState !== posState : false;
          if (inter) igst = n2(total); else { cgst = n2(total / 2); sgst = n2(total / 2); }
        }
        if (!rate) rate = taxable ? slab(((igst + cgst + sgst) / taxable) * 100) : 0;
        sub.push({ rate, taxable, igst, cgst, sgst, cess });
      }
      for (const s of sub) {
        if (!s.taxable && !s.igst && !s.cgst && !s.sgst) continue;
        if (!invNo && !gstin && !party && !/b2cs|b2cl/.test(sec) && opts.kind === "ledger") continue;
        out.push({ ...base, ...s, rate: slab(s.rate), igst: n2(s.igst), cgst: n2(s.cgst), sgst: n2(s.sgst), cess: n2(s.cess), taxable: n2(s.taxable), value: n2(value) });
        count++;
      }
    }
    if (count) used.push(`${sh.name} (${count})`);
  }
  if (!out.length) throw new Error("No recognisable rows found. The file needs columns such as Invoice No, Date, GSTIN, Taxable Value, CGST/SGST/IGST (or rate-wise sales columns).");
  return { rows: out, sheets_used: used };
}
