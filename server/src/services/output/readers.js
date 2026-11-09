import path from "node:path";
import { readSheets, parseSheetFile, toNum, toDate, normGstin } from "../recon/sheetParser.js";
import { parseGstr3bPdf, parseGstr3bText } from "../recon/gstr3bParser.js";
import { emptyRow, findHeader, isTotalRow, norm } from "../itc/readers.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const SLABS = [0.25, 1, 1.5, 3, 5, 7.5, 12, 18, 28, 40];
const nearSlab = (x) => { const b = SLABS.reduce((a, s) => (Math.abs(s - x) < Math.abs(a - x) ? s : a), SLABS[0]); return Math.abs(b - x) <= 0.6 ? b : r2(x); };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

// ------------------------------------------------------------------ financial years and months
export const fyStartYear = (fy) => Number(String(fy).slice(0, 4));
export function monthsOfFy(fy) {
  const y = fyStartYear(fy);
  return Array.from({ length: 12 }, (_, i) => (i < 9 ? `${y}-${pad(i + 4)}` : `${y + 1}-${pad(i - 8)}`));
}
export const fyOfPeriod = (p) => { const [y, m] = String(p).split("-").map(Number); const s = m >= 4 ? y : y - 1; return `${s}-${pad((s + 1) % 100)}`; };
export const monthLabel = (p) => { if (!p || p === "undated") return "No month"; const [y, m] = String(p).split("-").map(Number); return `${Object.keys(MON)[m - 1].replace(/^./, (c) => c.toUpperCase())}-${String(y).slice(2)}`; };

/** The return month from a file name such as GSTR1_042026.xlsx, GSTR-3B Apr-2026.pdf or 2026-04.pdf. */
export function periodFromName(name) {
  const s = String(name || "").replace(/\.[a-z0-9]+$/i, "");
  let m = /(?:^|[^0-9])(0[1-9]|1[0-2])[-_ .]?(20\d{2})(?:[^0-9]|$)/.exec(s);
  if (m) return `${m[2]}-${m[1]}`;
  m = /(?:^|[^0-9])(20\d{2})[-_ .]?(0[1-9]|1[0-2])(?:[^0-9]|$)/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_ ,.]*(20\d{2}|\d{2})(?:[^0-9]|$)/i.exec(s);
  if (m) { const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]); return `${y}-${pad(MON[m[1].toLowerCase()])}`; }
  return null;
}
const monthOfDate = (d) => (d ? String(d).slice(0, 7) : "");
const stateCode = (v) => { const m = /^\s*(\d{2})/.exec(String(v || "")); return m ? m[1] : ""; };

// ------------------------------------------------------------------ GSTR-1 Excel (portal download or offline tool)
const G1 = {
  gstin: [/gstin\/uin of recipient/, /gstin.*recipient/, /receiver gstin/, /gstin/, /\buin\b/],
  party: [/receiver name/, /recipient name/, /party name|customer name|name of (the )?recipient/, /^name$/],
  invno: [/invoice number/, /invoice no/, /note number/, /note no/, /document number/, /^number$/],
  date: [/invoice date/, /note date/, /^date$/],
  value: [/invoice value/, /note value/],
  adv: [/gross advance/],
  pos: [/place of supply/],
  reverse: [/reverse charge/],
  invtype: [/^invoice type$/, /note supply type/, /supply type/],
  notetype: [/^note type$/, /^document type$/],
  urtype: [/^ur type$/],
  exptype: [/^export type$/],
  rate: [/^rate$/, /^rate ?%$/, /^tax rate$/],
  taxable: [/taxable value/, /^taxable/],
  igst: [/integrated tax/, /\bigst\b/],
  cgst: [/central tax/, /\bcgst\b/],
  sgst: [/state\/?ut tax/, /\bsgst\b/, /\butgst\b/],
  cess: [/cess amount/, /^cess/],
  hsn: [/^hsn( ?\/ ?sac)?( code)?$/, /^hsn(?!.*(type|section|table))/, /^sac/],
  desc: [/^description/],
  uqc: [/^uqc/],
  qty: [/total quantity/, /^quantity/],
  totval: [/total value/],
  nil: [/nil rated/],
  exempt: [/exempted/],
  nongst: [/non-?gst/],
};

function sectionOf(name) {
  const s = String(name).toLowerCase().replace(/[\s-]+/g, "");
  if (/^(b2ba|b2cla|b2csa|cdnra|cdnura|expa|ata|atadja|ecoa)/.test(s)) return "amend";
  if (/^atadj/.test(s)) return "atadj";
  if (/^at(?!adj)$|^advance/.test(s)) return "at";
  if (/^b2cl/.test(s)) return "b2cl";
  if (/^b2cs/.test(s)) return "b2cs";
  if (/^b2b/.test(s)) return "b2b";
  if (/^cdnur/.test(s)) return "cdnur";
  if (/^cdnr/.test(s)) return "cdnr";
  if (/^exp/.test(s) && !/^exemp/.test(s)) return "exp";
  if (/^exemp|^nil/.test(s)) return "exemp";
  if (/^hsn/.test(s)) return "hsn";
  return null;
}

const NEED = {
  b2b: (h) => h.includes("taxable") && (h.includes("invno") || h.includes("gstin")),
  b2cl: (h) => h.includes("taxable") && h.includes("invno"),
  b2cs: (h) => h.includes("taxable") && (h.includes("pos") || h.includes("rate")),
  cdnr: (h) => h.includes("taxable") && h.includes("invno"),
  cdnur: (h) => h.includes("taxable") && h.includes("invno"),
  exp: (h) => h.includes("taxable") && h.includes("invno"),
  at: (h) => h.includes("adv") || h.includes("taxable"),
  atadj: (h) => h.includes("adv") || h.includes("taxable"),
  exemp: (h) => h.includes("nil") || h.includes("exempt") || h.includes("nongst"),
  hsn: (h) => h.includes("hsn") && (h.includes("taxable") || h.includes("totval")),
};

/** The GSTR-1 of one month, from the Excel the portal or the offline tool produces. */
export async function readGstr1Excel(buffer, filename, { clientGstin = "" } = {}) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  const rows = [], hsn = [], exemp = [], used = [];
  const clientState = stateCode(clientGstin);

  for (const sh of sheets) {
    const sec = sectionOf(sh.name);
    if (!sec) continue;
    if (sec === "amend") {
      if (sh.rows.length > 4) warnings.push(`The amendment sheet "${sh.name}" is not read. Check it for amendments to GSTR-9 Table 4K / 4L.`);
      continue;
    }
    const h = findHeader(sh.rows, G1, NEED[sec]);
    if (!h) continue;
    used.push(sh.name);
    const m = h.map;
    const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
    const hasTax = ["igst", "cgst", "sgst"].some((k) => m[k] != null);

    for (let i = h.row + h.span; i < sh.rows.length; i++) {
      const r = sh.rows[i];
      if (emptyRow(r) || isTotalRow(r)) continue;

      if (sec === "exemp") {
        const desc = String(get(r, "desc") ?? "").trim();
        if (!desc) continue;
        exemp.push({ desc, nil: toNum(get(r, "nil")), exempt: toNum(get(r, "exempt")), non_gst: toNum(get(r, "nongst")) });
        continue;
      }
      if (sec === "hsn") {
        const code = String(get(r, "hsn") ?? "").trim();
        if (!code) continue;
        hsn.push({
          hsn: code, desc: String(get(r, "desc") ?? "").trim(), uqc: String(get(r, "uqc") ?? "").trim(), qty: toNum(get(r, "qty")), value: toNum(get(r, "totval")),
          taxable: toNum(get(r, "taxable")), rate: toNum(get(r, "rate")), igst: toNum(get(r, "igst")), cgst: toNum(get(r, "cgst")), sgst: toNum(get(r, "sgst")), cess: toNum(get(r, "cess")),
          table: /b2c/i.test(sh.name) ? "b2c" : /b2b/i.test(sh.name) ? "b2b" : "all",
        });
        continue;
      }

      const gstin = normGstin(get(r, "gstin"));
      const invNo = String(get(r, "invno") ?? "").trim();
      if (sec !== "b2cs" && sec !== "at" && sec !== "atadj" && !invNo) continue;
      const pos = String(get(r, "pos") ?? "").trim();
      const rate = toNum(get(r, "rate"));
      const invType = norm(get(r, "invtype"));
      const noteTxt = norm(get(r, "notetype"));
      const reverse = /^y/.test(norm(get(r, "reverse")));
      let cls = "regular", sign = 1;
      if (sec === "b2b") {
        cls = /sez/.test(invType) && /without/.test(invType) ? "sez_nopay" : /sez/.test(invType) ? "sez_pay" : /deemed/.test(invType) ? "deemed" : /attracting igst/.test(invType) ? "regular_igst" : "regular";
        if (reverse) cls = "rcm";
      } else if (sec === "b2cl" || sec === "b2cs") cls = "b2c";
      else if (sec === "cdnr") { cls = /sez/.test(invType) && /without/.test(invType) ? "sez_nopay" : /sez/.test(invType) ? "sez_pay" : /deemed/.test(invType) ? "deemed" : "regular"; sign = /^c|credit/.test(noteTxt) ? -1 : 1; }
      else if (sec === "cdnur") { const u = norm(get(r, "urtype")); cls = /wopay|without/.test(u) ? "export_nopay" : /expwp|with pay/.test(u) ? "export_pay" : "b2c"; sign = /^c|credit/.test(noteTxt) ? -1 : 1; }
      else if (sec === "exp") cls = /wopay|without/.test(norm(get(r, "exptype"))) ? "export_nopay" : "export_pay";
      else if (sec === "at") cls = "advance";
      else if (sec === "atadj") { cls = "advance"; sign = -1; }

      let taxable = toNum(get(r, "taxable"));
      let igst = 0, cgst = 0, sgst = 0, cess = toNum(get(r, "cess"));
      const gross = toNum(get(r, "adv"));
      if (sec === "at" || sec === "atadj") {
        // an advance is a gross figure that includes the tax
        if (!taxable && gross) taxable = r2((gross * 100) / (100 + rate));
      }
      if (hasTax) { igst = toNum(get(r, "igst")); cgst = toNum(get(r, "cgst")); sgst = toNum(get(r, "sgst")); }
      else if (cls !== "sez_nopay" && cls !== "export_nopay") {
        const t = r2((taxable * rate) / 100);
        const ps = stateCode(pos);
        const inter = ["sez_pay", "export_pay", "regular_igst", "deemed"].includes(cls) || (ps && clientState && ps !== clientState);
        if (inter) igst = t; else { cgst = r2(t / 2); sgst = r2(t - cgst); }
      }
      if (!taxable && !igst && !cgst && !sgst) continue;
      rows.push({
        sec, cls, gstin, party: String(get(r, "party") ?? "").trim(), inv_no: invNo, date: toDate(get(r, "date")), value: toNum(get(r, "value")) || gross, pos, rate,
        taxable: r2(taxable), igst: r2(igst), cgst: r2(cgst), sgst: r2(sgst), cess: r2(cess), sign, reverse, note_type: sec.startsWith("cdn") ? (sign < 0 ? "Credit" : "Debit") : "",
        inv_type: String(get(r, "invtype") ?? "").trim(),
      });
    }
  }
  if (!used.length) throw new Error("Could not find GSTR-1 sheets (b2b, b2cs, cdnr, exp and so on) in this file. Upload the Excel downloaded from the GST portal or the offline tool.");
  const named = periodFromName(filename);
  const dated = rows.filter((x) => x.sec !== "at" && x.sec !== "atadj" && x.date).map((x) => monthOfDate(x.date));
  const counts = new Map();
  for (const m of dated) counts.set(m, (counts.get(m) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  // a summary for a whole year has invoices of every month in it: each line then belongs to the month of its own date
  const multi = !named && counts.size >= 2 && top[1] / dated.length < 0.8;
  const period = multi ? null : named || (top ? top[0] : null);
  if (multi) warnings.push(`This file covers ${counts.size} months. Each line is placed in the month of its invoice or note date. Lines with no date (B2CS, Table 8) are shown under "No month".`);
  else if (!period) warnings.push("The return month could not be found from the file name or the invoice dates. Choose it on the list.");
  return { kind: "gstr1", period, multi, rows, hsn, exemp, sheets: used, warnings };
}

// ------------------------------------------------------------------ books: sales register / sales ledger / GST ledgers
const BK = {
  party: [/^party'?s? name/, /party name/, /customer name|buyer name|receiver name|recipient name|name of (the )?(customer|buyer)/, /^name of (the )?(party|customer)/, /^particulars$/, /^party$/, /^customer$/, /^buyer$/, /^ledger$/, /^name$/],
  gstin: [/gstin/, /gst no/, /\buin\b/],
  invno: [/invoice (no|number)/, /inv(oice)? ?no/, /bill (no|number)/, /document (no|number)/, /(credit|debit) note (no|number)/, /note (no|number)/, /voucher (no|number)/, /vch\.? ?no/, /^invoice$/, /^bill$/, /^voucher$/],
  date: [/invoice date/, /inv(oice)? date/, /bill date/, /document date/, /^date$/],
  desc: [/nature of (services|supply|goods)/, /^nature/, /description/, /item/],
  hsn: [/^hsn/, /hsn\/sac/, /^sac/],
  rate: [/gst rate/, /^rate/, /tax rate/],
  taxable: [/taxable/, /^sales value$/, /^basic value$/, /^sales$/, /sales (amount|value)/, /^net (amount|sales|value)/, /^amount before tax/, /basic (amount|value)/, /assessable/],
  igst: [/\bigst\b/, /integrated/],
  cgst: [/\bcgst\b/, /central tax/],
  sgst: [/\bsgst\b/, /state\/?ut tax/, /state tax/, /\butgst\b/],
  cess: [/cess/],
  value: [/invoice value/, /^total/, /gross/, /^value$/],
  type: [/document type/, /^type$/],
  regtype: [/registration type/, /gst registration/, /party type/, /dealer type/, /supply type/],
};
const LG = {
  date: [/^date$/],
  particulars: [/particulars/, /narration/, /account/, /ledger name/, /party/],
  vchtype: [/vch\.? ?type|voucher type/],
  vchno: [/vch\.? ?no|voucher (no|number)|document (no|number)|invoice (no|number)/],
  debit: [/^debit/, /^dr\b/],
  credit: [/^credit/, /^cr\b/],
};

function headOf(text) {
  const t = String(text).toLowerCase();
  if (/integrated|\bigst\b/.test(t)) return "igst";
  if (/central|\bcgst\b/.test(t)) return "cgst";
  if (/state|utgst|\bsgst\b/.test(t)) return "sgst";
  if (/\bcess\b/.test(t)) return "cess";
  if (/sales|revenue|turnover|income|supply/.test(t)) return "sales";
  return "other";
}

/** Books: invoice registers (one line per invoice) and ledger accounts (Tally style date / particulars / debit / credit). */
export async function readBooksOutput(buffer, filename) {
  const sheets = await readSheets(buffer, filename);
  const warnings = [];
  const rows = [], used = [], seen = [];
  for (const sh of sheets) {
    if (/read ?me|instruction|help/i.test(sh.name)) continue;

    const reg = findHeader(sh.rows, BK, (h) => h.includes("invno") && (h.includes("taxable") || h.includes("igst") || h.includes("cgst") || h.includes("value")));
    if (reg) {
      const before = rows.length;
      const m = reg.map;
      // the document number column can be mapped to a column that is empty: look for another one that holds numbers
      const under = sh.rows.slice(reg.row + reg.span, reg.row + reg.span + 40);
      const filled = (col) => col != null && under.some((r) => String(r[col] ?? "").trim() !== "");
      if (!filled(m.invno)) {
        const taken = new Set(Object.values(m));
        const alt = reg.cands.findIndex((hs, i) => !taken.has(i) && hs.some((h) => /(^|\s)(no\.?|number|ref|vch|voucher|bill|inv)(\s|$)/.test(h)) && filled(i));
        if (alt >= 0) m.invno = alt;
      }
      const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
      const sheetCn = /credit|return/i.test(sh.name);
      for (let i = reg.row + reg.span; i < sh.rows.length; i++) {
        const r = sh.rows[i];
        if (emptyRow(r) || isTotalRow(r)) continue;
        let inv = String(get(r, "invno") ?? "").trim();
        const date0 = toDate(get(r, "date"));
        // a line with no document number is still a sale if it has a party or a date
        if (!inv && !(date0 || String(get(r, "party") ?? "").trim())) continue;
        if (!inv) inv = "(no number)";
        const tx = norm(get(r, "type"));
        const cn = sheetCn || /credit|return/.test(tx);
        const date = toDate(get(r, "date"));
        const igst = toNum(get(r, "igst")), cgst = toNum(get(r, "cgst")), sgst = toNum(get(r, "sgst")), cess = toNum(get(r, "cess")), value = toNum(get(r, "value"));
        const taxSum = igst + cgst + sgst + cess;
        let taxable = toNum(get(r, "taxable"));
        // many registers show only the invoice value and the tax: the taxable value is what is left
        if (!taxable && value > taxSum) taxable = r2(value - taxSum);
        let rate = toNum(get(r, "rate"));
        if (!rate && taxable > 0 && taxSum > 0) rate = nearSlab((taxSum / taxable) * 100);
        rows.push({
          kind: "register", sheet: sh.name, head: "", date, month: monthOfDate(date), party: String(get(r, "party") ?? "").trim(), gstin: normGstin(get(r, "gstin")), inv_no: inv,
          taxable, igst, cgst, sgst, cess, value,
          rate, regtype: String(get(r, "regtype") ?? "").trim(), desc: String(get(r, "desc") ?? "").trim(), hsn: String(get(r, "hsn") ?? "").trim(), sign: cn ? -1 : 1, debit: 0, credit: 0,
        });
      }
      if (rows.length > before) { used.push(`${sh.name} (register)`); continue; }
      // a heading was found but no line could be read from under it: keep what was found, so it can be reported
      seen.push(`${sh.name}: columns read were ${Object.entries(m).map(([k, i]) => `${k} = "${reg.cands[i][0]}"`).join(", ")}; first lines under the heading: ${JSON.stringify(sh.rows.slice(reg.row + reg.span, reg.row + reg.span + 2).map((r) => r.map((c) => String(c ?? "").slice(0, 20))))}`);
    }

    const lg = findHeader(sh.rows, LG, (h) => h.includes("date") && (h.includes("debit") || h.includes("credit")));
    if (lg) {
      used.push(`${sh.name} (ledger)`);
      const m = lg.map;
      const get = (r, f) => (m[f] == null ? "" : r[m[f]]);
      const head = headOf(`${sh.name} ${path.basename(filename, path.extname(filename))} ${sh.rows.slice(0, Math.max(lg.row, 1)).map((r) => r.join(" ")).join(" ")}`);
      for (let i = lg.row + lg.span; i < sh.rows.length; i++) {
        const r = sh.rows[i];
        if (emptyRow(r)) continue;
        const part = String(get(r, "particulars") ?? "").trim();
        if (/^(opening|closing|carried|brought|grand total|total|by closing|to closing)/i.test(part) || isTotalRow(r)) continue;
        const date = toDate(get(r, "date"));
        if (!date) continue;
        const debit = toNum(get(r, "debit")), credit = toNum(get(r, "credit"));
        if (!debit && !credit) continue;
        rows.push({
          kind: "ledger", sheet: sh.name, head, date, month: monthOfDate(date), party: part, gstin: "", inv_no: String(get(r, "vchno") ?? "").trim(), vch_type: String(get(r, "vchtype") ?? "").trim(),
          taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, value: 0, rate: 0, regtype: "", desc: "", hsn: "", sign: 1, debit, credit,
        });
      }
    }
  }
  if (!rows.length) {
    // the general register reader has its own way of finding the columns
    const alt = await generalBooks(buffer, filename);
    if (alt.length) { warnings.push("The register was not in the usual layout, so it was read with the general reader. Check the figures on the Books Combined sheet."); return { kind: "books", rows: alt, sheets: ["general reader"], warnings }; }
  }
  if (!used.length) throw new Error(seen.length ? `A heading row was found but no invoice lines could be read from under it. ${seen.join(" ")}` : "Could not find a sales register or a GST / sales ledger in this file. A register needs Invoice No, Date, Taxable Value and tax columns; a ledger needs Date, Particulars, Debit and Credit.");
  const regs = rows.filter((x) => x.kind === "register").length;
  if (regs && !rows.some((x) => x.kind === "register" && (x.igst || x.cgst || x.sgst))) warnings.push("No tax amount was found in the register lines. Check that IGST, CGST and SGST columns are present.");
  return { kind: "books", rows, sheets: used, warnings };
}

async function generalBooks(buffer, filename) {
  try {
    const parsed = await parseSheetFile(buffer, filename, { kind: "ledger", ledgerKind: "sales" });
    return parsed.rows.filter((r) => r.inv_no || r.taxable || r.cgst || r.igst).map((r) => ({
      kind: "register", sheet: r.sheet || "", head: "", date: r.date, month: monthOfDate(r.date), party: r.party || "", gstin: r.gstin || "", inv_no: r.inv_no || "",
      taxable: r.taxable || 0, igst: r.igst || 0, cgst: r.cgst || 0, sgst: r.sgst || 0, cess: r.cess || 0, value: r.value || 0, rate: r.rate || 0, regtype: "", desc: "", hsn: "",
      sign: r.type === "cn" || /credit|return/i.test(r.sheet || "") ? -1 : 1, debit: 0, credit: 0,
    }));
  } catch { return []; }
}

// ------------------------------------------------------------------ GSTR-3B, PDF or Excel
export async function readGstr3bFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  let parsed;
  if (ext === ".pdf") parsed = await parseGstr3bPdf(new Uint8Array(buffer));
  else if ([".xlsx", ".xlsm", ".csv"].includes(ext)) {
    const sheets = await readSheets(buffer, filename);
    // each row becomes one line of text: the label followed by its figures, as in the PDF
    const text = sheets.map((sh) => sh.rows.map((r) => r.filter((c) => c !== "" && c != null).map((c) => (typeof c === "number" ? String(c) : String(c))).join(" ")).join("\n")).join("\n");
    parsed = parseGstr3bText(text);
  } else throw new Error("Upload the GSTR-3B as a PDF or an Excel file.");
  const o = parsed.figures.outward;
  const any = ["a", "b", "c", "d", "e"].some((k) => o[k].taxable || o[k].igst || o[k].cgst || o[k].sgst);
  if (!parsed.found || !any) throw new Error("Could not find Table 3.1 in this GSTR-3B. Upload the PDF downloaded from the portal, or an Excel with the same layout.");
  const warnings = [];
  const period = parsed.period || periodFromName(filename);
  if (!period) warnings.push("The return month could not be read. Choose it on the list.");
  if (!(o.a.taxable || o.a.igst || o.a.cgst || o.a.sgst)) warnings.push("Table 3.1(a) was read as nil. Check it against the return.");
  return { kind: "gstr3b", period, figures: parsed.figures, found: parsed.found, warnings };
}
