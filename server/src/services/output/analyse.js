import { normInv } from "../recon/sheetParser.js";
import { fyStartYear, monthLabel, monthsOfFy } from "./readers.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const KEYS = ["taxable", "igst", "cgst", "sgst", "cess"];
const blank = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
const add = (a, b, sign = 1) => { for (const k of KEYS) a[k] += sign * (b[k] || 0); return a; };
const rnd = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? r2(v) : v]));
const diff = (a, b) => Object.fromEntries(KEYS.map((k) => [k, r2((a[k] || 0) - (b[k] || 0))]));
const tax = (o) => (o.igst || 0) + (o.cgst || 0) + (o.sgst || 0) + (o.cess || 0);
const TOL = 1;          // a difference up to this is not shown
const ROUND = 10;       // up to this it is called rounding
const OTHER_KEY = "B2C";

const CAPITAL_RE = /fixed assets?|capital (asset|goods)|plant (and|&) machinery|sale of (an? )?(asset|machinery|vehicle|car|plant|furniture|computer|laptop|equipment|building|property)|old (machinery|vehicle|car|furniture|computer)|disposal of (assets?|machinery|vehicle)|asset sale/i;

/** "GSTIN type" lines the CA staff enter: composition, eou, sez or other. */
export function parsePartyTypes(text) {
  const map = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /([0-9]{2}[A-Z0-9]{13})\s*[,;:\t ]\s*([A-Za-z ]+)/.exec(line.trim().toUpperCase());
    if (!m) continue;
    const t = m[2].toLowerCase();
    map.set(m[1], /compos/.test(t) ? "composition" : /eou|export oriented/.test(t) ? "eou" : /sez/.test(t) ? "sez" : "other");
  }
  return map;
}

const latestPerPeriod = (files) => {
  const by = new Map();
  for (const f of files) if (f.period) by.set(f.period, f);   // files come oldest first, so the newest wins
  return by;
};

/**
 * Books, GSTR-1 and GSTR-3B of a financial year, brought together for the GSTR-9 and GSTR-9C workings.
 * books: [{name, rows}], gstr1: [{name, period, rows, hsn, exemp, warnings}], gstr3b: [{name, period, figures}]
 */
export function analyseOutput({ fy, books = [], gstr1 = [], gstr3b = [], partyTypesText = "" }) {
  const months = monthsOfFy(fy);
  const inFy = new Set(months);
  const notes = [];
  const partyTypes = parsePartyTypes(partyTypesText);

  // ------------------------------------------------------------------ books
  const bm = Object.fromEntries(months.map((m) => [m, { reg: blank(), led: blank(), hasReg: false }]));
  const ledgerHeads = new Set();
  let outside = 0, otherLedgerRows = 0;
  const regRows = [], ledRows = [];
  const regType = new Map();
  for (const f of books) {
    for (let r of f.rows || []) {
      if (r.kind === "register") {
        // registers saved before the taxable value was worked out from the invoice value
        const taxSum = (r.igst || 0) + (r.cgst || 0) + (r.sgst || 0) + (r.cess || 0);
        if (!r.taxable && r.value > taxSum) r = { ...r, taxable: r2(r.value - taxSum) };
        regRows.push({ ...r, file: f.name });
        if (r.gstin && r.regtype) regType.set(r.gstin, r.regtype.toLowerCase());
        if (!inFy.has(r.month)) { outside++; continue; }
        const b = bm[r.month];
        b.hasReg = true;
        add(b.reg, { taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess }, r.sign);
      } else {
        ledRows.push({ ...r, file: f.name });
        if (!inFy.has(r.month)) { outside++; continue; }
        const net = r.credit - r.debit;
        const key = r.head === "sales" ? "taxable" : r.head;
        if (KEYS.includes(key)) { bm[r.month].led[key] += net; ledgerHeads.add(key); }
        else otherLedgerRows++;
      }
    }
  }
  if (outside) notes.push(`${outside} books line(s) are dated outside ${fy} and were left out.`);
  if (otherLedgerRows) notes.push(`${otherLedgerRows} ledger line(s) could not be linked to sales, IGST, CGST, SGST or cess from the ledger name and were left out.`);

  const booksMonthly = {};
  const booksTotalReg = blank(), booksTotalLed = blank();
  for (const m of months) {
    const b = bm[m];
    const o = blank();
    o.taxable = b.hasReg ? b.reg.taxable : b.led.taxable;
    for (const h of ["igst", "cgst", "sgst", "cess"]) o[h] = ledgerHeads.has(h) ? b.led[h] : b.reg[h];
    booksMonthly[m] = o;
    add(booksTotalReg, b.reg); add(booksTotalLed, b.led);
  }
  const hasBooks = (m) => bm[m].hasReg || KEYS.some((k) => bm[m].led[k] !== 0);

  // ------------------------------------------------------------------ GSTR-1
  const monthlyFiles = gstr1.filter((f) => !f.multi);
  const multiFiles = gstr1.filter((f) => f.multi);
  const g1By = latestPerPeriod(monthlyFiles);
  const dupG1 = monthlyFiles.filter((f) => f.period).length - g1By.size;
  if (dupG1 > 0) notes.push(`${dupG1} GSTR-1 file(s) were for a month that has a later file; only the latest file of each month is used.`);
  const newG1 = () => ({ liab: blank(), zero: blank(), rcm: blank(), advance: blank(), notes: blank(), exempt: 0, hasFile: false });
  const g1 = Object.fromEntries(months.map((m) => [m, newG1()]));
  const g1Undated = newG1();
  const g1Rows = [];
  const hsnAll = [];
  const exempAll = [];
  let outsideG1 = 0;
  const ingest = (f, monthOf) => {
    for (const r of f.rows || []) {
      const m = monthOf(r);
      if (m === null) { outsideG1++; continue; }
      const g = m ? g1[m] : g1Undated;
      g.hasFile = true;
      g1Rows.push({ ...r, month: m, file: f.name });
      const amt = { taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess };
      if (r.cls === "rcm") add(g.rcm, amt, r.sign);
      else if (r.cls === "sez_nopay" || r.cls === "export_nopay") add(g.zero, amt, r.sign);
      else add(g.liab, amt, r.sign);
      if (r.cls === "advance") add(g.advance, amt, r.sign);
      if (r.sec === "cdnr" || r.sec === "cdnur") add(g.notes, amt, r.sign);
    }
  };
  for (const [p, f] of g1By) {
    if (!inFy.has(p)) { notes.push(`GSTR-1 file "${f.name}" is for ${p}, outside ${fy}, and was left out.`); continue; }
    ingest(f, () => p);
    for (const e of f.exemp || []) { g1[p].exempt += e.nil + e.exempt + e.non_gst; exempAll.push({ month: p, file: f.name, ...e }); }
    for (const h of f.hsn || []) hsnAll.push({ ...h, month: p });
  }
  // a file that covers several months: each line goes to the month of its own date; lines with no date stay under "No month"
  for (const f of multiFiles) {
    ingest(f, (r) => { const m = r.date ? String(r.date).slice(0, 7) : ""; return m && !inFy.has(m) ? null : m; });
    for (const e of f.exemp || []) { g1Undated.exempt += e.nil + e.exempt + e.non_gst; exempAll.push({ month: "", file: f.name, ...e }); }
    for (const h of f.hsn || []) hsnAll.push({ ...h, month: "" });
  }
  if (outsideG1) notes.push(`${outsideG1} GSTR-1 line(s) are dated outside ${fy} and were left out.`);
  const undatedCount = g1Rows.filter((r) => !r.month).length;
  if (undatedCount) notes.push(`${undatedCount} GSTR-1 line(s) (B2CS and similar) carry no date, so they cannot be placed in a month. They are shown under "No month" and are in the totals.`);
  const g1Monthly = {};
  for (const m of months) { const o = blank(); add(o, g1[m].liab); o.taxable += g1[m].zero.taxable; g1Monthly[m] = o; }
  const g1UndatedAmt = blank(); add(g1UndatedAmt, g1Undated.liab); g1UndatedAmt.taxable += g1Undated.zero.taxable;

  // ------------------------------------------------------------------ GSTR-3B
  const b3By = latestPerPeriod(gstr3b);
  const dup3 = gstr3b.filter((f) => f.period).length - b3By.size;
  if (dup3 > 0) notes.push(`${dup3} GSTR-3B file(s) were for a month that has a later file; only the latest file of each month is used.`);
  const b3 = Object.fromEntries(months.map((m) => [m, { a: blank(), b: blank(), c: blank(), d: blank(), e: blank(), hasFile: false }]));
  for (const [p, f] of b3By) {
    if (!inFy.has(p)) { notes.push(`GSTR-3B file "${f.name}" is for ${p}, outside ${fy}, and was left out.`); continue; }
    const o = f.figures.outward;
    b3[p] = { a: { ...blank(), ...o.a }, b: { ...blank(), ...o.b }, c: { ...blank(), ...o.c }, d: { ...blank(), ...o.d }, e: { ...blank(), ...o.e }, hasFile: true };
  }
  const b3Monthly = {};
  for (const m of months) { const o = blank(); add(o, b3[m].a); add(o, b3[m].b); b3Monthly[m] = o; }

  // ------------------------------------------------------------------ month-wise comparisons
  const has = { books: Object.fromEntries(months.map((m) => [m, hasBooks(m)])), g1: Object.fromEntries(months.map((m) => [m, g1[m].hasFile])), b3: Object.fromEntries(months.map((m) => [m, b3[m].hasFile])) };
  const compare = (A, B, hasA, hasB, undated) => {
    const rows = months.map((m) => ({ month: m, label: monthLabel(m), a: rnd(A[m]), b: rnd(B[m]), d: diff(A[m], B[m]), hasA: hasA[m], hasB: hasB[m] }));
    if (undated && KEYS.some((k) => Math.abs(undated[k]) > 0.005)) rows.push({ month: "undated", label: "No month (undated lines)", a: rnd(undated), b: rnd(blank()), d: diff(undated, blank()), hasA: true, hasB: true, undated: true });
    const tot = (k) => rows.reduce((o, r) => add(o, r[k]), blank());
    const total = { month: "total", label: "Total", a: rnd(tot("a")), b: rnd(tot("b")), d: rnd(tot("d")), hasA: true, hasB: true };
    return { rows, total };
  };
  const compareSet = {
    g1_vs_3b: compare(g1Monthly, b3Monthly, has.g1, has.b3, g1UndatedAmt),
    g1_vs_books: compare(g1Monthly, booksMonthly, has.g1, has.books, g1UndatedAmt),
    b3_vs_books: compare(b3Monthly, booksMonthly, has.b3, has.books),
  };

  // ------------------------------------------------------------------ capital assets sold (from the books), and where they were reported
  const g1ByInv = new Map();
  for (const r of g1Rows) if (r.inv_no) { const k = normInv(r.inv_no); (g1ByInv.get(k) || g1ByInv.set(k, []).get(k)).push(r); }
  const capital = [];
  for (const r of regRows) {
    if (!CAPITAL_RE.test(`${r.desc} ${r.party} ${r.sheet}`)) continue;
    const hit = (g1ByInv.get(normInv(r.inv_no)) || [])[0];
    capital.push({ source: "register", month: r.month, date: r.date, party: r.party, gstin: r.gstin, inv_no: r.inv_no, text: r.desc || r.party, taxable: r.taxable * r.sign, igst: r.igst * r.sign, cgst: r.cgst * r.sign, sgst: r.sgst * r.sign, cess: r.cess * r.sign, g1_month: hit ? hit.month : "", g1_section: hit ? hit.sec : "" });
  }
  for (const r of ledRows) {
    if (r.head !== "sales" || !CAPITAL_RE.test(`${r.party} ${r.sheet} ${r.file}`)) continue;
    capital.push({ source: "ledger", month: r.month, date: r.date, party: r.party, gstin: "", inv_no: r.inv_no, text: r.sheet, taxable: r.credit - r.debit, igst: 0, cgst: 0, sgst: 0, cess: 0, g1_month: "", g1_section: "" });
  }
  const capInv = new Set(capital.filter((c) => c.source === "register").map((c) => normInv(c.inv_no)));
  for (const r of g1Rows) r.capital = Boolean(r.inv_no) && capInv.has(normInv(r.inv_no));

  // ------------------------------------------------------------------ party-wise: books register against GSTR-1
  const parties = new Map();
  const part = (key, gstin, name) => { let p = parties.get(key); if (!p) { p = { key, gstin, party: name, books: blank(), g1: blank(), bDocs: 0, gDocs: 0 }; parties.set(key, p); } if (!p.party && name) p.party = name; return p; };
  const keyFor = (gstin) => (gstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(gstin) ? gstin : OTHER_KEY);
  for (const r of regRows) {
    if (!inFy.has(r.month)) continue;
    const key = keyFor(r.gstin);
    const p = part(key, key === OTHER_KEY ? "" : key, key === OTHER_KEY ? "B2C / unregistered (no GSTIN)" : r.party);
    add(p.books, { taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess }, r.sign);
    p.bDocs++;
  }
  for (const r of g1Rows) {
    if (r.sec === "at" || r.sec === "atadj") { const p = part(OTHER_KEY, "", "B2C / unregistered (no GSTIN)"); add(p.g1, r, r.sign); p.gDocs++; continue; }
    const key = keyFor(r.gstin);
    const p = part(key, key === OTHER_KEY ? "" : key, key === OTHER_KEY ? "B2C / unregistered (no GSTIN)" : r.party);
    add(p.g1, r, r.sign);
    p.gDocs++;
  }
  const partyRows = [...parties.values()].map((p) => {
    const d = diff(p.books, p.g1);
    const dt = Math.abs(d.taxable), dx = Math.abs(d.igst) + Math.abs(d.cgst) + Math.abs(d.sgst);
    const status = !p.bDocs ? "gstr1_only" : !p.gDocs ? "books_only" : dt <= TOL && dx <= TOL ? "matched" : "different";
    return { ...p, books: rnd(p.books), g1: rnd(p.g1), d, status, type: partyTypes.get(p.gstin) || (/compos/.test(regType.get(p.gstin) || "") ? "composition" : /eou/.test(regType.get(p.gstin) || "") ? "eou" : "") };
  }).sort((a, b) => (a.key === OTHER_KEY) - (b.key === OTHER_KEY) || String(a.party).localeCompare(String(b.party)));

  // ------------------------------------------------------------------ classification of turnover and liability
  const cl = (name) => ({ name, ...blank(), docs: 0 });
  const C = {
    regular: cl("B2B - regular registered persons"), composition: cl("B2B - composition dealers"), sez_pay: cl("B2B - SEZ, with payment of tax"), sez_nopay: cl("B2B - SEZ, without payment of tax (LUT / bond)"),
    deemed: cl("B2B - deemed exports"), other_reg: cl("B2B - other registered persons (EOU, UIN holders and so on)"),
    b2cl: cl("B2C - large (inter-state, invoice value above the limit)"), b2cs: cl("B2C - small"),
    export_pay: cl("Exports with payment of tax"), export_nopay: cl("Exports without payment of tax (LUT / bond)"),
    cn: cl("Credit notes (net, all recipients)"), dn: cl("Debit notes (all recipients)"), advance: cl("Advances received, net of advances adjusted"), rcm: cl("Outward supplies on which the recipient pays tax under reverse charge"),
  };
  const monthCls = Object.fromEntries(months.map((m) => [m, Object.fromEntries(Object.keys(C).map((k) => [k, blank()]))]));
  for (const r of g1Rows) {
    let key;
    if (r.sec === "cdnr" || r.sec === "cdnur") key = r.sign < 0 ? "cn" : "dn";
    else if (r.cls === "advance") key = "advance";
    else if (r.cls === "rcm") key = "rcm";
    else if (r.cls === "b2c") key = r.sec === "b2cl" ? "b2cl" : "b2cs";
    else if (r.cls === "regular" || r.cls === "regular_igst") {
      const t = partyTypes.get(r.gstin) || (/compos/.test(regType.get(r.gstin) || "") ? "composition" : /eou/.test(regType.get(r.gstin) || "") ? "eou" : "");
      key = t === "composition" ? "composition" : t === "eou" || t === "other" ? "other_reg" : t === "sez" ? "sez_pay" : "regular";
    } else key = r.cls;
    if (!C[key]) continue;
    const sign = key === "cn" || key === "dn" ? 1 : r.sign;       // credit notes are kept as signed amounts on their own line
    const amt = { taxable: r.taxable * (key === "cn" ? -1 : 1), igst: r.igst * (key === "cn" ? -1 : 1), cgst: r.cgst * (key === "cn" ? -1 : 1), sgst: r.sgst * (key === "cn" ? -1 : 1), cess: r.cess * (key === "cn" ? -1 : 1) };
    add(C[key], amt, key === "cn" || key === "dn" ? 1 : sign);
    C[key].docs++;
    if (monthCls[r.month]) add(monthCls[r.month][key], amt, key === "cn" || key === "dn" ? 1 : sign);
  }
  const exemptTotals = { nil: 0, exempt: 0, non_gst: 0 };
  for (const e of exempAll) { exemptTotals.nil += e.nil; exemptTotals.exempt += e.exempt; exemptTotals.non_gst += e.non_gst; }
  const inwardRcm = blank();
  for (const m of months) add(inwardRcm, b3[m].d);

  // ------------------------------------------------------------------ rate-wise
  const rates = new Map();
  const RCLS = { regular: "regular", regular_igst: "regular", b2c: "regular", sez_pay: "special", sez_nopay: "special", deemed: "special", export_pay: "special", export_nopay: "special", rcm: "rcm", advance: "advance" };
  for (const r of g1Rows) {
    const cls = r.sec === "cdnr" || r.sec === "cdnur" ? "notes" : r.capital ? "capital" : RCLS[r.cls] || "regular";
    const k = String(r.rate || 0);
    let o = rates.get(k);
    if (!o) { o = { rate: Number(k), regular: blank(), capital: blank(), special: blank(), rcm: blank(), notes: blank(), advance: blank(), total: blank(), books: 0 }; rates.set(k, o); }
    add(o[cls], r, r.sign);
    if (cls !== "rcm") add(o.total, r, r.sign);
  }
  for (const r of regRows) {
    if (!inFy.has(r.month)) continue;
    const k = String(r.rate || 0);
    let o = rates.get(k);
    if (!o) { o = { rate: Number(k), regular: blank(), capital: blank(), special: blank(), rcm: blank(), notes: blank(), advance: blank(), total: blank(), books: 0 }; rates.set(k, o); }
    o.books += r.taxable * r.sign;
  }
  const rateRows = [...rates.values()].sort((a, b) => a.rate - b.rate);

  // ------------------------------------------------------------------ HSN
  const hsnMap = new Map();
  for (const h of hsnAll) {
    const k = `${h.hsn}|${h.rate || 0}|${h.uqc}`;
    let o = hsnMap.get(k);
    if (!o) { o = { hsn: h.hsn, desc: h.desc, uqc: h.uqc, rate: h.rate || 0, qty: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, months: new Set() }; hsnMap.set(k, o); }
    o.qty += h.qty; o.value += h.value; o.taxable += h.taxable; o.igst += h.igst; o.cgst += h.cgst; o.sgst += h.sgst; o.cess += h.cess; o.months.add(h.month);
    if (!o.desc && h.desc) o.desc = h.desc;
  }
  const hsnRows = [...hsnMap.values()].map((o) => ({ ...o, months: o.months.size, qty: r2(o.qty), value: r2(o.value), taxable: r2(o.taxable), igst: r2(o.igst), cgst: r2(o.cgst), sgst: r2(o.sgst), cess: r2(o.cess) })).sort((a, b) => String(a.hsn).localeCompare(String(b.hsn), undefined, { numeric: true }) || a.rate - b.rate);

  // ------------------------------------------------------------------ GSTR-9 Tables 4 and 5, from the GSTR-1 rows
  const T = Object.fromEntries(["4A", "4B", "4C", "4D", "4E", "4F", "4G", "4I", "4J", "5A", "5B", "5C", "5D", "5E", "5F", "5H", "5I"].map((k) => [k, blank()]));
  for (const r of g1Rows) {
    const s = r.sign;
    const notes_ = r.sec === "cdnr" || r.sec === "cdnur";
    if (r.cls === "b2c" && !notes_) add(T["4A"], r, s);
    else if (r.cls === "b2c" && notes_) add(T["4A"], r, s);                     // credit and debit notes to unregistered persons are netted in 4A
    else if (r.cls === "regular" || r.cls === "regular_igst") add(notes_ ? T[s < 0 ? "4I" : "4J"] : T["4B"], r, s);
    else if (r.cls === "export_pay") add(notes_ ? T[s < 0 ? "4I" : "4J"] : T["4C"], r, s);
    else if (r.cls === "sez_pay") add(notes_ ? T[s < 0 ? "4I" : "4J"] : T["4D"], r, s);
    else if (r.cls === "deemed") add(notes_ ? T[s < 0 ? "4I" : "4J"] : T["4E"], r, s);
    else if (r.cls === "advance") add(T["4F"], r, s);
    else if (r.cls === "export_nopay") add(notes_ ? T[s < 0 ? "5H" : "5I"] : T["5A"], r, s);
    else if (r.cls === "sez_nopay") add(notes_ ? T[s < 0 ? "5H" : "5I"] : T["5B"], r, s);
    else if (r.cls === "rcm") add(T["5C"], r, s);
  }
  T["4G"] = { ...inwardRcm };
  T["5D"].taxable = exemptTotals.exempt; T["5E"].taxable = exemptTotals.nil; T["5F"].taxable = exemptTotals.non_gst;
  const sub = (keys) => keys.reduce((o, k) => add(o, T[k]), blank());
  const T4H = sub(["4A", "4B", "4C", "4D", "4E", "4F", "4G"]);
  const T4M = blank(); add(T4M, T["4I"]); add(T4M, T["4J"]);       // credit notes are already negative
  const T4N = add(add(blank(), T4H), T4M);
  const T5G = sub(["5A", "5B", "5C", "5D", "5E", "5F"]);
  const T5L = blank(); add(T5L, T["5H"]); add(T5L, T["5I"]);
  const T5M = add(add(blank(), T5G), T5L);
  const T5N = add(add(blank(), T4N), T5M); add(T5N, T["4G"], -1);

  const gstr9 = { T, T4H, T4M, T4N, T5G, T5L, T5M, T5N };

  // ------------------------------------------------------------------ totals for the headline figures
  const totals = {
    books: rnd(Object.values(booksMonthly).reduce((o, v) => add(o, v), blank())),
    g1: rnd(add(Object.values(g1Monthly).reduce((o, v) => add(o, v), blank()), g1UndatedAmt)),
    b3: rnd(Object.values(b3Monthly).reduce((o, v) => add(o, v), blank())),
    exempt: exemptTotals,
  };
  const coverage = months.map((m) => ({ month: m, label: monthLabel(m), books: has.books[m], gstr1: has.g1[m], gstr3b: has.b3[m] }));

  const ctx = { fy, months, g1Undated, g1UndatedAmt, exemp: exempAll, booksMonthly, g1, g1Monthly, b3, b3Monthly, has, compare: compareSet, parties: partyRows, capital, notes, totals, booksTotalReg, booksTotalLed, ledgerHeads, exemptTotals, gstr1Files: gstr1, regRows, ledRows, g1Rows, hsnRows, rateRows, C, monthCls, inwardRcm, gstr9, partyTypes: [...partyTypes.entries()], coverage };
  ctx.differences = buildDifferences(ctx);
  return ctx;
}

// ------------------------------------------------------------------ differences, reasons and what to do
const REF = {
  g37: "Section 37 and rule 59 (GSTR-1)",
  g39: "Section 39 and rule 61 (GSTR-3B)",
  g44: "Section 44 and rule 80 (annual return GSTR-9 and reconciliation statement GSTR-9C)",
  g34: "Section 34 (credit and debit notes)",
  g50: "Section 50 (interest) and rule 142(2) / form DRC-03",
};
const money = (v) => `₹${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function buildDifferences(x) {
  const out = [];
  const push = (o) => out.push({ area: "", period: "", item: "", a_label: "", a: null, b_label: "", b: null, d: null, reason: "", action: "", ref: "", ...o });
  const { months } = x;

  // 1. months with no file
  const any = (k) => months.some((m) => x.has[k][m]);
  for (const m of months) {
    const present = ["books", "g1", "b3"].filter((k) => x.has[k][m]);
    if (!present.length) continue;
    const missing = [];
    if (any("g1") && !x.has.g1[m]) missing.push("GSTR-1");
    if (any("b3") && !x.has.b3[m]) missing.push("GSTR-3B");
    if (any("books") && !x.has.books[m]) missing.push("books / ledgers");
    for (const what of missing) {
      push({
        area: "Missing month", period: m, item: `${what} not uploaded for ${monthLabel(m)}`,
        reason: `Other data for ${monthLabel(m)} has been uploaded, but there is nothing for ${what}. Every difference for this month is overstated until it is added.`,
        action: what === "books / ledgers" ? "Upload the sales register or the GST ledgers for the month." : `Upload the ${what} for ${monthLabel(m)}. If the return was not filed, file it (late fee under section 47 and interest under section 50 apply) before filing GSTR-9.`,
        ref: what === "GSTR-1" ? REF.g37 : what === "GSTR-3B" ? REF.g39 : "Books of account",
      });
    }
  }

  // 2. month-wise differences
  const diagnose = (setKey, m, d) => {
    const tot = Math.abs(d.taxable);
    const idx = months.indexOf(m);
    const near = (a, b) => Math.abs(a) > 0 && Math.abs(a + b) <= Math.max(ROUND, Math.abs(a) * 0.02);
    for (const adj of [months[idx + 1], months[idx - 1]]) {
      if (!adj) continue;
      const other = x.compare[setKey].rows.find((r) => r.month === adj);
      if (other && near(d.taxable, other.d.taxable) && Math.abs(d.taxable) > ROUND) {
        return { reason: `Timing difference: ${monthLabel(m)} is ${d.taxable > 0 ? "higher" : "lower"} by ${money(Math.abs(d.taxable))} and ${monthLabel(adj)} is ${other.d.taxable > 0 ? "higher" : "lower"} by about the same amount, so the two months net out. The invoices were reported (or booked) in a different month.`, action: `Match the invoices of ${monthLabel(m)} and ${monthLabel(adj)}. No tax is lost for the year, but state the month-wise reason in the GSTR-9C reconciliation. If the return reported the invoice late, interest under section 50 may apply on the tax.`, ref: `${REF.g37}; ${REF.g50}` };
      }
    }
    const g = x.g1[m];
    const noteAmt = Math.abs(g.notes.taxable), exAmt = g.exempt, advAmt = Math.abs(g.advance.taxable), rcmAmt = Math.abs(g.rcm.taxable);
    const eq = (v) => v > ROUND && Math.abs(tot - v) <= Math.max(ROUND, v * 0.02);
    if (Math.abs(d.taxable) <= ROUND && Math.abs(tax(d)) <= ROUND) return { reason: "Rounding only.", action: "No action needed.", ref: "" };
    if (eq(noteAmt)) return { reason: `The difference equals the credit and debit notes of the month in GSTR-1 (${money(noteAmt)}): one side shows sales gross of the notes and the other net.`, action: "Check how the notes were treated in the books and in GSTR-3B. Credit notes are deducted in the month they are issued (section 34); show them in GSTR-9 Table 4I / 4J.", ref: REF.g34 };
    if (eq(exAmt)) return { reason: `The difference equals the nil-rated, exempt and non-GST supplies of the month (${money(exAmt)}), which are reported in 3.1(c) and (e) of GSTR-3B and in Table 8 of GSTR-1, not in the taxable lines.`, action: "No tax impact. Show them in GSTR-9 Table 5D / 5E / 5F and in the turnover reconciliation of GSTR-9C.", ref: REF.g44 };
    if (eq(advAmt)) return { reason: `The difference equals the advances received in the month (${money(advAmt)}). Tax is due on an advance when it is received, but the books show the sale only when the invoice is raised.`, action: "Check that the advance was adjusted against the later invoice and not taxed twice. Show it in GSTR-9 Table 4F.", ref: "Section 13 and section 31(3)(d)" };
    if (eq(rcmAmt)) return { reason: `The difference equals outward supplies on which the recipient pays tax under reverse charge (${money(rcmAmt)}), which are in table 4B of GSTR-1 but not in the taxable lines of GSTR-3B.`, action: "No tax impact for the supplier. Show it in GSTR-9 Table 5C.", ref: REF.g44 };
    // same taxable value, different tax: a rate, a tax head or an entry that is not a sale
    if (Math.abs(d.taxable) <= TOL && tax(d) !== 0) {
      const heads = ["igst", "cgst", "sgst"].filter((h) => Math.abs(d[h]) > TOL).map((h) => `${h.toUpperCase()} ${money(d[h])}`).join(", ");
      return setKey === "g1_vs_3b"
        ? { reason: `The taxable values agree but the tax differs (${heads}). GSTR-1 and GSTR-3B carry a different rate or tax head for the same supplies, or tax was adjusted in GSTR-3B without a matching invoice.`, action: "Check the rate and the IGST / CGST / SGST split of the invoices of the month. Pay any short tax with interest (DRC-03); an excess can be adjusted in a later return.", ref: `${REF.g39}; ${REF.g50}` }
        : { reason: `The taxable values agree but the tax differs (${heads}). The output tax in the books includes entries that are not sales (interest, journals, advances, reversals), or a different rate or tax head was booked.`, action: "Open the tax ledger for the month and list the entries that are not invoices. Correct a wrong head or rate in the books; keep the non-sale entries as reconciling items in GSTR-9C Table 9.", ref: "Books of account; GSTR-9C Table 9" };
    }
    if (setKey !== "g1_vs_3b" && d.taxable < 0) {
      const cap = x.capital.filter((c) => c.month === m).reduce((a, c) => a + c.taxable, 0);
      if (cap > ROUND && Math.abs(Math.abs(d.taxable) - cap) <= Math.max(ROUND, cap * 0.02)) {
        return { reason: `The difference equals the sale of capital assets in the books for the month (${money(cap)}). A fixed asset was sold and booked, but the sale is not in the return.`, action: "Report the sale in GSTR-1 (amendment) and pay the tax with interest (DRC-03) before GSTR-9. GST is payable on the sale of a capital asset (Schedule II). The ITC taken on the asset must be reversed or limited to the tax on the sale price (section 18(6)).", ref: `Section 7 and Schedule II; section 18(6); ${REF.g50}` };
      }
    }
    if (setKey === "g1_vs_3b") {
      return d.taxable > 0 || tax(d) > 0
        ? { reason: `GSTR-1 shows more than GSTR-3B (taxable ${money(d.taxable)}). Some invoices were declared in GSTR-1 but not carried to GSTR-3B, so the tax on them may be unpaid.`, action: "Compare the invoices month-wise. Pay the short tax with interest through form DRC-03 (cause: GSTR-1 vs GSTR-3B), or adjust it in the next GSTR-3B before filing GSTR-9. GSTR-9 Table 4 takes the higher figure.", ref: `${REF.g39}; ${REF.g50}` }
        : { reason: `GSTR-3B shows more than GSTR-1 (taxable ${money(Math.abs(d.taxable))}). Some sales were paid for in GSTR-3B but were not uploaded to GSTR-1, or the GSTR-1 has been amended.`, action: "Find the invoices missing from GSTR-1 and report them through an amendment or in the GSTR-1 of a later month, before the time limit in section 37(3). Show the difference in the GSTR-9C reconciliation.", ref: REF.g37 };
    }
    const nameA = setKey === "g1_vs_books" ? "GSTR-1" : "GSTR-3B";
    return d.taxable > 0 || tax(d) > 0
      ? { reason: `${nameA} shows more than the books (taxable ${money(d.taxable)}). Sales were declared in the return but are not in the sales register / ledgers uploaded, or were booked in another month, or the books are net of credit notes the return does not show.`, action: "Check that the sales register uploaded is complete. Pass any missing sales entries, or reverse the extra declaration through a credit note if the sale did not happen. Explain the difference in GSTR-9C Table 5.", ref: REF.g44 }
      : { reason: `The books show more than ${nameA} (taxable ${money(Math.abs(d.taxable))}). Sales were booked but not declared in the return: an unbilled invoice, a missed invoice, a sale of a capital asset, or other income on which tax is due.`, action: "Identify the entries. If tax is due, pay it with interest under section 50 through form DRC-03 before filing GSTR-9, and report it in GSTR-9 Table 10 / 11 only if it relates to the previous year. List the item in GSTR-9C Table 5 if it is not a supply.", ref: `${REF.g44}; ${REF.g50}` };
  };
  const SETS = [["g1_vs_3b", "GSTR-1 vs GSTR-3B", "GSTR-1", "GSTR-3B"], ["g1_vs_books", "GSTR-1 vs books", "GSTR-1", "Books"], ["b3_vs_books", "GSTR-3B vs books", "GSTR-3B", "Books"]];
  for (const [key, label, la, lb] of SETS) {
    for (const r of x.compare[key].rows) {
      if (!r.hasA || !r.hasB || r.undated) continue;
      const big = Math.abs(r.d.taxable) > TOL || ["igst", "cgst", "sgst"].some((h) => Math.abs(r.d[h]) > TOL);
      if (!big) continue;
      const dg = diagnose(key, r.month, r.d);
      push({ area: label, period: r.month, item: `${label}: ${monthLabel(r.month)}`, a_label: la, a: r.a, b_label: lb, b: r.b, d: r.d, ...dg });
    }
  }

  // 3. party-wise
  const bigParties = x.parties.filter((p) => p.status !== "matched").sort((a, b) => Math.abs(b.d.taxable) - Math.abs(a.d.taxable)).slice(0, 300);
  for (const p of bigParties) {
    const name = `${p.party || "(no name)"}${p.gstin ? ` (${p.gstin})` : ""}`;
    let reason, action;
    if (p.status === "books_only") { reason = "The party is in the books but not in GSTR-1. The sales may have been reported to a different GSTIN, as B2C, or not reported at all."; action = "Check whether the invoices were uploaded under another GSTIN or party name. If they were left out, report them through a GSTR-1 amendment and pay the tax with interest (DRC-03). If the party is unregistered, confirm the invoices are in B2CL / B2CS."; }
    else if (p.status === "gstr1_only") { reason = "The party is in GSTR-1 but not in the books uploaded. The sales may be booked under another name or GSTIN, or the sales register is incomplete."; action = "Search the books for the invoice numbers. If they are not booked, pass the entry (or cancel the invoice with a credit note if the sale did not happen)."; }
    else { reason = `Taxable value ${p.d.taxable > 0 ? "is higher in the books" : "is higher in GSTR-1"} by ${money(Math.abs(p.d.taxable))}: invoices missing on one side, credit notes treated differently, rate or amount keyed differently, or a different party name.`; action = "Compare the invoice lists of this party. Correct the books, or amend GSTR-1 for wrong values or GSTIN. Credit notes need an amendment in GSTR-1 (section 34)."; }
    push({ area: "Party-wise", item: name, a_label: "Books", a: p.books, b_label: "GSTR-1", b: p.g1, d: p.d, reason, action, ref: `${REF.g37}; ${REF.g44}` });
  }

  // 4. other checks
  const lh = [...x.ledgerHeads];
  if (lh.length && x.regRows.length) {
    const L = x.booksTotalLed, R = x.booksTotalReg;
    for (const h of lh) {
      const d = r2((L[h] || 0) - (R[h] || 0));
      if (Math.abs(d) > ROUND && x.regRows.length) push({ area: "Books", item: `${h.toUpperCase()} ledger against the sales register`, a_label: `${h.toUpperCase()} ledger`, a: { [h]: r2(L[h]) }, b_label: "Sales register", b: { [h]: r2(R[h]) }, d: { [h]: d }, reason: `The ${h.toUpperCase()} ledger and the tax in the sales register differ by ${money(d)}. The ledger may carry tax on advances, debit notes, journal entries or other items that are not in the register.`, action: "Open the ledger and the register for the months with a difference and list the journal / non-sales entries. The ledger is taken for the tax figures in the comparison.", ref: "Books of account" });
    }
  }
  if (x.hsnRows.length) {
    const hs = x.hsnRows.reduce((a, h) => a + h.taxable, 0);
    const gl = Object.values(x.g1Monthly).reduce((a, v) => a + v.taxable, 0);
    if (Math.abs(hs - gl) > ROUND) push({ area: "GSTR-1", item: "HSN summary against the invoices", a_label: "HSN summary", a: { taxable: r2(hs) }, b_label: "GSTR-1 sections", b: { taxable: r2(gl) }, d: { taxable: r2(hs - gl) }, reason: "The total taxable value of the HSN tables (Table 12) differs from the total of the invoice sections. The HSN table must cover all outward supplies, and a month's HSN table may be missing or wrong.", action: "Check the HSN sheet of each month. GSTR-9 Tables 17 and 18 are filled from it, so correct the HSN summary of the month in GSTR-1 where it is incomplete.", ref: "Rule 59(6); GSTR-9 Table 17" });
  }
  if (x.capital.length) {
    const t = x.capital.reduce((o, c) => add(o, c), blank());
    const unreported = x.capital.filter((c) => c.source === "register" && !c.g1_month);
    push({ area: "Capital assets", item: `Sale of capital assets found in the books (${x.capital.length})`, a_label: "Books", a: rnd(t), reason: `${x.capital.length} sale(s) of fixed assets were identified from the descriptions. GST is payable on the sale of a capital asset (Schedule II) and it is part of turnover, but it is easily missed.${unreported.length ? ` ${unreported.length} of them were not found in GSTR-1 by invoice number.` : ""}`, action: "Confirm each sale is in GSTR-1 and GSTR-3B. Show it in GSTR-9 Table 4 and in the GSTR-9C turnover reconciliation. ITC taken on the asset has to be reversed or limited to the tax on the sale price (section 18(6)).", ref: "Section 7 and Schedule II; section 18(6); rule 44(6)" });
  }
  if (x.exemptTotals.nil + x.exemptTotals.exempt + x.exemptTotals.non_gst > 0) {
    push({ area: "Exempt supplies", item: "Nil rated, exempt and non-GST supplies", a_label: "GSTR-1 Table 8", a: { taxable: r2(x.exemptTotals.nil + x.exemptTotals.exempt + x.exemptTotals.non_gst) }, reason: "The client has outward supplies without tax. ITC attributable to them has to be reversed (section 17(2), rules 42 and 43), and they go to GSTR-9 Table 5D / 5E / 5F.", action: "Check the rule 42 working and report the exempt turnover in GSTR-9C. Compare it with 3.1(c) and (e) of GSTR-3B month by month.", ref: "Section 17(2); rules 42, 43; GSTR-9 Table 5" });
  }
  const z = x.C.export_nopay.taxable + x.C.sez_nopay.taxable;
  if (Math.abs(z) > TOL) push({ area: "Zero-rated", item: "Exports and SEZ supplies without payment of tax", a_label: "GSTR-1", a: { taxable: r2(z) }, reason: "Supplies were made without payment of tax under a letter of undertaking or bond.", action: "Check that the LUT was valid for the year (rule 96A), that export proceeds were received within the time allowed, and that the shipping bills match. Show in GSTR-9 Table 5A / 5B. A refund of ITC may be due under section 54.", ref: "Section 16 IGST Act; rule 96A; section 54" });
  if (Math.abs(x.C.rcm.taxable) > TOL) push({ area: "Reverse charge", item: "Outward supplies on which the recipient pays tax", a_label: "GSTR-1 table 4B", a: rnd(x.C.rcm), reason: "These supplies are reported in table 4B of GSTR-1. The recipient pays the tax, so it is not in the supplier's liability.", action: "Show the value in GSTR-9 Table 5C and make sure it is not in the taxable lines of GSTR-3B.", ref: "Section 9(3), 9(4)" });
  if (Math.abs(tax(x.inwardRcm)) > TOL || x.inwardRcm.taxable > TOL) push({ area: "Reverse charge", item: "Inward supplies liable to reverse charge (GSTR-3B 3.1(d))", a_label: "GSTR-3B", a: rnd(x.inwardRcm), reason: "The client has paid tax on inward supplies under reverse charge during the year.", action: "Show it in GSTR-9 Table 4G (paid in cash, with the ITC in Table 6C / 6D). Reconcile it with the RCM tax in the books and with the ITC reconciliation of GSTR-2B.", ref: "Section 9(3), 9(4); GSTR-9 Table 4G" });
  for (const f of x.gstr1Files) for (const w of f.warnings || []) push({ area: "Files", period: f.period || "", item: f.name, reason: w, action: "Check the sheet in the original file and add the figures by hand in the GSTR-9 working if needed.", ref: "GSTR-9 Table 4K / 4L" });
  for (const n of x.notes) push({ area: "Files", item: "Note", reason: n, action: "Check the files uploaded.", ref: "" });
  if (!out.length) push({ area: "Result", item: "No difference found", reason: "The returns and the books agree for the months uploaded.", action: "Proceed to GSTR-9 and GSTR-9C using sheets 6 to 9.", ref: REF.g44 });
  return out;
}

export { monthLabel, fyStartYear };
