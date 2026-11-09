import { normInv, normName } from "../recon/sheetParser.js";
import { gstinReason } from "../recon/verifyExplain.js";
import { setOff } from "../gstRules.js";
import { judge, profileOf, PROVISIONS } from "./rules.js";
import { assessRcm, ledgerRcmCases, rcmAmount } from "./rcm.js";

const TOL = 1;
const H = ["igst", "cgst", "sgst", "cess"];
const HEAD = { igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess" };
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs((a || 0) - (b || 0)) <= TOL;
const zero = (v) => Math.abs(v || 0) <= TOL;
const inr = (v) => `₹${Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const heads = (o) => ({ igst: o?.igst || 0, cgst: o?.cgst || 0, sgst: o?.sgst || 0, cess: o?.cess || 0 });
const zeroHeads = () => ({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
const addInto = (a, b, sign = 1) => { for (const h of H) a[h] += sign * (b[h] || 0); };
const tax = (o) => (o ? o.igst + o.cgst + o.sgst + o.cess : 0);
const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || "")); return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || ""); };
const TYPE = { inv: "invoice", cn: "credit note", dn: "debit note" };

const keyOf = (r) => `${r.type}|${r.gstin && r.gstin !== "IMPORT" ? r.gstin : "N:" + normName(r.party)}|${normInv(r.inv_no)}`;

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** Pairs each line of the books with the line of GSTR-2B it belongs to. */
export function matchRows(books, g2b) {
  const pairs = [];
  const bLeft = new Set(books.map((_, i) => i)), gLeft = new Set(g2b.map((_, i) => i));
  const pair = (bi, gi, how) => { pairs.push({ b: bi, g: gi, how }); bLeft.delete(bi); gLeft.delete(gi); };

  // 1. same supplier, same document number
  const gKey = new Map();
  g2b.forEach((g, i) => { const k = keyOf(g); (gKey.get(k) || gKey.set(k, []).get(k)).push(i); });
  for (const bi of [...bLeft]) {
    const hit = (gKey.get(keyOf(books[bi])) || []).find((gi) => gLeft.has(gi));
    if (hit != null) pair(bi, hit, "exact");
  }
  // 2. same document number, supplier GSTIN typed differently
  for (const bi of [...bLeft]) {
    const b = books[bi];
    const nb = normInv(b.inv_no);
    if (!nb) continue;
    const hit = [...gLeft].find((gi) => {
      const g = g2b[gi];
      return g.type === b.type && normInv(g.inv_no) === nb && g.gstin !== "IMPORT" && ((normName(g.party) && normName(g.party) === normName(b.party)) || (near(g.taxable, b.taxable) && near(tax(g), tax(b))));
    });
    if (hit != null) pair(bi, hit, "gstin");
  }
  // 3. same supplier, same amounts, document number typed differently
  for (const bi of [...bLeft]) {
    const b = books[bi];
    if (!b.gstin) continue;
    const hit = [...gLeft].find((gi) => { const g = g2b[gi]; return g.type === b.type && g.gstin === b.gstin && near(g.taxable, b.taxable) && near(tax(g), tax(b)) && tax(b) > 0; });
    if (hit != null) pair(bi, hit, "invno");
  }
  // 4. same supplier, document numbers almost the same
  for (const bi of [...bLeft]) {
    const b = books[bi];
    const nb = normInv(b.inv_no);
    if (!b.gstin || nb.length < 4) continue;
    const hit = [...gLeft].find((gi) => { const g = g2b[gi]; const ng = normInv(g.inv_no); return g.type === b.type && g.gstin === b.gstin && ng.length >= 4 && (lev(nb, ng) <= 2 || ng.endsWith(nb) || nb.endsWith(ng)); });
    if (hit != null) pair(bi, hit, "invno");
  }
  return { pairs, booksOnly: [...bLeft], gOnly: [...gLeft] };
}

// ------------------------------------------------------------------ what the difference is, in plain words
function headWords(L, W, whoW) {
  const t = (d) => ["igst", "cgst", "sgst"].filter((k) => d[k] > TOL).map((k) => `${HEAD[k]} ${inr(d[k])}`).join(" + ") || "no tax";
  const act = "Check the supplier's state against the client's GSTIN. Intra-state purchases carry CGST + SGST and inter-state purchases carry IGST. Correct the books if they are wrong; if the supplier charged the wrong head, ask the supplier to amend it, because the ITC follows the head shown in GSTR-2B.";
  if (L.igst > TOL && zero(W.igst) && near(L.igst, W.cgst + W.sgst) && zero(L.cgst) && zero(L.sgst)) return { text: `The books have IGST (${t(L)}) but ${whoW} shows CGST and SGST (${t(W)}).`, action: act };
  if (W.igst > TOL && zero(L.igst) && near(W.igst, L.cgst + L.sgst) && zero(W.cgst) && zero(W.sgst)) return { text: `The books have CGST and SGST (${t(L)}) but ${whoW} shows IGST (${t(W)}).`, action: act };
  if (!near(L.cgst, W.cgst) && !near(L.sgst, W.sgst) && near(L.cgst, W.sgst) && near(L.sgst, W.cgst)) return { text: `CGST and SGST are interchanged: the books have CGST ${inr(L.cgst)} and SGST ${inr(L.sgst)}, ${whoW} has CGST ${inr(W.cgst)} and SGST ${inr(W.sgst)}.`, action: "Correct the books so that CGST and SGST are under the right heads." };
  for (const x of ["cgst", "sgst", "igst"]) {
    for (const y of ["cgst", "sgst", "igst"]) {
      if (x !== y && zero(L[y]) && W[y] > TOL && near(L[x], W[x] + W[y])) {
        return { text: `The ${HEAD[y]} amount (${inr(W[y])}) has been entered under ${HEAD[x]} in the books (${HEAD[x]} ${inr(L[x])} against ${inr(W[x])} in ${whoW}, ${HEAD[y]} nil).`, action: `Move ${inr(W[y])} from ${HEAD[x]} to ${HEAD[y]} in the books.` };
      }
    }
  }
  return null;
}

/** Remark and recommended action for a pair or a lone line. */
function explain(b, g, how, ctx, ra) {
  const r = explainBase(b, g, how, ctx, ra);
  if (ra.mode === "fcm") r.remark += ` RCM note: ${ra.note}`;
  return r;
}

function explainBase(b, g, how, ctx, ra) {
  const who = "GSTR-2B";
  if (b && !g) {
    if (ra.mode === "rcm") {
      return ra.source === "detected"
        ? { cat: "rcm", remark: `Reverse charge applies and is not recorded in the books. ${ra.why} It is not expected in GSTR-2B.`, action: "Pay the tax in cash under reverse charge in GSTR-3B (Table 3.1(d)), raise a self-invoice and payment voucher, and claim the ITC in Table 4(A)(3); it can be used from next month." }
        : { cat: "rcm", remark: "Reverse-charge purchase: not expected in GSTR-2B.", action: "Pay the tax in cash in GSTR-3B (Table 3.1(d)) and claim the ITC in Table 4(A)(3); it can be used from next month. Keep the supplier's bill and the self-invoice." };
    }
    if (tax(b) <= 0.005) return { cat: "no_tax", remark: "No tax charged in the books. Not expected in GSTR-2B.", action: "Report it in Table 5 of GSTR-3B (nil-rated / exempt / composition / unregistered purchase). Check that the supplier really is exempt or unregistered." };
    const others = ctx.gLeftByGstin.get(b.gstin) || [];
    const hint = others.length ? ` GSTR-2B has other invoice(s) of this supplier that are not in the books: ${others.slice(0, 3).map((x) => x.inv_no).join(", ")}. The supplier may have reported this one under a different number.` : "";
    if (b.type === "cn") return { cat: "books_only", remark: `Credit note in the books but not in GSTR-2B.${hint}`, action: "Reverse the ITC as per the credit note and ask the supplier to report it in GSTR-1." };
    return {
      cat: "books_only", remark: `In the books but not in GSTR-2B. The supplier has not reported this ${TYPE[b.type]} for the month.${hint}`,
      action: "Do not claim the ITC this month. Ask the supplier to file the invoice in GSTR-1 (or IFF), and claim it in the month it shows up in GSTR-2B. If the supplier never pays the tax, rule 37A requires the ITC to be reversed.",
    };
  }
  if (g && !b) {
    const rcmNote = g.reverse ? " The supplier has reported it under reverse charge, so the client must pay the tax in cash." : "";
    if (g.avail === "No") return { cat: "g2b_only", remark: `In GSTR-2B but not in the books. GSTR-2B also marks the ITC as not available${g.reason ? ` (${g.reason})` : ""}.${rcmNote}`, action: "Do not claim. Check whether the purchase is genuine; if so, ask the supplier to correct the reason GSTR-2B shows." };
    return {
      cat: "g2b_only", remark: `In GSTR-2B but not in the books. The supplier has reported ${/^[aeiou]/.test(TYPE[g.type]) ? "an" : "a"} ${TYPE[g.type]} of ${inr(g.value)} that has not been booked.${rcmNote}`,
      action: g.reverse ? "Book the purchase and pay the reverse-charge tax in cash; claim the ITC next month." : "Check whether the goods or services were received. If yes, book the invoice and claim the ITC (it is in GSTR-2B). If not, ask the supplier to correct or reject the invoice.",
    };
  }

  const parts = [];
  let cat = "matched", action = "";
  const act = [];
  const note = (c) => { if (cat === "matched" || cat === "rounding") cat = c; };

  if (how === "gstin") {
    const r = gstinReason(b.gstin, g.gstin, who);
    parts.push(r.reason);
    act.push(/two different taxpayers/.test(r.reason) ? r.action : "Check the GSTIN on the paper invoice. If GSTR-2B is right, correct the supplier GSTIN in the books; if the books are right, ask the supplier to amend it in GSTR-1. ITC is allowed only against the GSTIN reported in GSTR-2B.");
    note("gstin");
  }
  if (how === "invno") {
    parts.push(`The invoice number is ${b.inv_no} in the books but ${g.inv_no} in GSTR-2B.`);
    act.push("Check the number on the paper invoice and correct the books, or ask the supplier to amend GSTR-1 if the supplier's number is wrong. ITC is allowed only against the number reported in GSTR-2B.");
    note("invno");
  }
  const hw = headWords(heads(b), heads(g), who);
  const taxableOff = !near(b.taxable, g.taxable);
  const headOff = H.filter((h) => !near(b[h], g[h]));
  if (hw) { parts.push(hw.text); act.push(hw.action); note("head"); }
  else {
    if (taxableOff) {
      const tot = tax(b) > tax(g) ? "higher" : tax(b) < tax(g) ? "lower" : "";
      parts.push(`Taxable value is ${inr(b.taxable)} in the books but ${inr(g.taxable)} in GSTR-2B${headOff.length ? `, so the tax differs too (the books are ${inr(Math.abs(tax(b) - tax(g)))} ${tot})` : ""}.`);
      note("amount");
    }
    for (const h of headOff) {
      if (taxableOff && headOff.length > 1) continue;
      if (zero(b[h]) && g[h] > TOL) parts.push(`${HEAD[h]} of ${inr(g[h])} is in GSTR-2B but has not been entered in the books.`);
      else if (zero(g[h]) && b[h] > TOL) parts.push(`The books show ${HEAD[h]} of ${inr(b[h])} but GSTR-2B has none.`);
      else parts.push(`${HEAD[h]} is ${inr(b[h])} in the books and ${inr(g[h])} in GSTR-2B (the books are ${inr(Math.abs(b[h] - g[h]))} ${b[h] > g[h] ? "higher" : "lower"}).`);
      note("amount");
    }
    if ((taxableOff || headOff.length) && cat === "amount") {
      act.push(tax(b) > tax(g) + TOL
        ? `Claim the ITC only up to the ${inr(tax(g))} shown in GSTR-2B. Check the paper invoice: if the books are right, ask the supplier to amend the invoice in GSTR-1; if GSTR-2B is right, correct the books.`
        : `The books are lower than GSTR-2B, and the ITC claim is limited to what is booked. Check the paper invoice: if GSTR-2B is right, correct the books and claim the balance of ${inr(tax(g) - tax(b))}.`);
    }
  }
  if (b.date && g.date && b.date !== g.date) {
    const sameMonth = b.date.slice(0, 7) === g.date.slice(0, 7);
    parts.push(`The invoice is dated ${fmtDate(b.date)} in the books and ${fmtDate(g.date)} in GSTR-2B${sameMonth ? " (same month)" : ""}.`);
    act.push(sameMonth ? "Correct the date in the books; the return month is not affected." : "Check the date on the paper invoice. The 30 November time limit in section 16(4) runs from the invoice date.");
    note("date");
  }
  if (g.reverse && b.charge !== "RCM") {
    parts.push("GSTR-2B shows this supply under reverse charge, but the books treat it as a normal purchase.");
    act.push("Pay the tax in cash under reverse charge (Table 3.1(d)) and claim the ITC in Table 4(A)(3).");
    note("rcm");
  }
  if (ra.mode === "fcm") act.push("No RCM is payable. Treat it as a normal purchase and claim the ITC from GSTR-2B.");
  if (g.avail === "No") {
    parts.push(`GSTR-2B marks the ITC as not available${g.reason ? ` (${g.reason})` : ""}.`);
    act.push("Do not claim this ITC. Resolve the reason with the supplier before claiming it in a later month, if the law still allows.");
    note("unavailable");
  }

  // up to a rupee is paise rounding
  const diffs = ["taxable", ...H].filter((k) => Math.abs((b[k] || 0) - (g[k] || 0)) > 0.005);
  if (cat === "matched" && diffs.length) {
    cat = "rounding";
    parts.push(`Matches GSTR-2B apart from paise rounding (${diffs.map((k) => `${k === "taxable" ? "taxable value" : HEAD[k]} ${inr(Math.abs(b[k] - g[k]))}`).join(", ")}).`);
    act.push("No correction needed.");
  }
  if (cat === "matched") { parts.push("Matches GSTR-2B."); act.push("No action."); }
  action = [...new Set(act)].join(" ");
  return { cat, remark: parts.join(" "), action };
}

// ------------------------------------------------------------------ the whole reconciliation
/**
 * Books against GSTR-2B, line by line, with the remark, the action and the ITC eligibility for each.
 * gstr1 is the liability read from the GSTR-1 PDF (or null).
 */
export function analyse({ books, g2b, gstr1, businessNature, period, clientGstin, opening = {}, ledgerRows = [] }) {
  const profile = profileOf(businessNature);
  const promoter = businessNature === "real_estate";
  const { pairs, booksOnly, gOnly } = matchRows(books, g2b);
  const gLeftByGstin = new Map();
  for (const gi of gOnly) { const g = g2b[gi]; (gLeftByGstin.get(g.gstin) || gLeftByGstin.set(g.gstin, []).get(g.gstin)).push(g); }
  const ctx = { gLeftByGstin };

  const lines = [];
  const build = (b, g, how) => {
    const ra = assessRcm({ b, g, promoter });
    const ex = explain(b, g, how, ctx, ra);
    const doc = b || g;
    const elig = judge({ book: b, g2b: g, profile, period, rcm: ra.mode === "rcm", rcmRule: ra.rule });
    const line = {
      type: doc.type, src: g?.src || "books", gstin: (b?.gstin || g?.gstin || ""), party: b?.party || g?.party || "", inv_no: b?.inv_no || g?.inv_no || "",
      date: b?.date || g?.date || null, nature: b?.nature || "",
      books: b ? { taxable: b.taxable, igst: b.igst, cgst: b.cgst, sgst: b.sgst, cess: b.cess, value: b.value, charge: b.charge, inv_no: b.inv_no, gstin: b.gstin, date: b.date } : null,
      g2b: g ? { taxable: g.taxable, igst: g.igst, cgst: g.cgst, sgst: g.sgst, cess: g.cess, value: g.value, reverse: g.reverse, avail: g.avail, reason: g.reason, inv_no: g.inv_no, gstin: g.gstin, date: g.date, period: g.period } : null,
      status: b && g ? (ex.cat === "matched" || ex.cat === "rounding" ? "matched" : "different") : b ? "books_only" : "g2b_only",
      cat: ex.cat, remark: ex.remark, action: ex.action,
      eligibility: elig.label, code: elig.code, provision: elig.provision, reason: elig.reason,
      rcm: { mode: ra.mode, source: ra.source, category: ra.rule ? ra.rule.name : null, ref: ra.rule ? ra.rule.ref : null, verify: Boolean(ra.rule?.verify), note: ra.note || ra.why || "" },
    };
    // the ITC amounts that go into the GSTR-3B summary
    const claim = zeroHeads(), blocked = zeroHeads(), blockedRcm = zeroHeads(), barred = zeroHeads(), hold = zeroHeads(), reversal = zeroHeads(), rcm = zeroHeads(), rcmClaim = zeroHeads(), unbooked = zeroHeads();
    if (elig.code === "reversal") addInto(reversal, heads(g || b));
    else if (ra.mode === "rcm") {
      const t = rcmAmount({ b, g, ra, clientGstin });
      addInto(rcm, t.h);
      if (elig.code === "rcm") addInto(rcmClaim, t.h);
      else addInto(blockedRcm, t.h);
      if (t.rate != null) {
        line.remark += ` The tax is worked out at ${t.rate}% of the taxable value${t.assumed ? " (rate assumed - check it)" : ""}.`;
        line.rcm.rate = t.rate;
      }
      line.rcm.tax = { ...t.h };
    } else if (b && g) {
      // the total tax agrees but sits under the wrong heads: the claim follows GSTR-2B, as the books are to be corrected
      const avail = near(tax(b), tax(g)) ? heads(g) : Object.fromEntries(H.map((h) => [h, Math.max(0, Math.min(b[h], g[h]))]));
      if (elig.code === "eligible" || elig.code === "conditional") addInto(claim, avail);
      else if (elig.code === "ineligible") addInto(blocked, avail);
      else if (elig.code === "ineligible_16_4") addInto(barred, avail);
      if (!near(tax(b), tax(g))) for (const h of H) if (b[h] > g[h] + TOL) hold[h] += b[h] - g[h];
    } else if (b && !g) {
      if (elig.code === "hold") addInto(hold, heads(b));
    } else if (g && !b) {
      if (elig.code === "not_booked") addInto(unbooked, heads(g));
      else if (elig.code === "ineligible") addInto(barred, heads(g));
    }
    line.amounts = { claim, blocked, blocked_rcm: blockedRcm, barred, hold, reversal, rcm, rcm_claim: rcmClaim, unbooked };
    lines.push(line);
  };

  for (const p of pairs) build(books[p.b], g2b[p.g], p.how);
  for (const bi of booksOnly) build(books[bi], null, "");
  for (const gi of gOnly) build(null, g2b[gi], "");

  const order = { books_only: 0, g2b_only: 1, different: 2, matched: 3 };
  lines.sort((a, b) => order[a.status] - order[b.status] || String(a.party).localeCompare(String(b.party)) || String(a.inv_no).localeCompare(String(b.inv_no), undefined, { numeric: true }));
  lines.forEach((l, i) => { l.no = i + 1; });

  const ledgerCases = ledgerRcmCases({ ledgerRows, lines, clientGstin, promoter });
  const rcmCases = [];
  for (const l of lines) {
    if (l.rcm.mode === "none") continue;
    rcmCases.push({
      source: l.rcm.source, line: l.no, type: l.type, party: l.party, gstin: l.gstin, inv_no: l.inv_no, date: l.date, nature: l.nature,
      taxable: (l.books || l.g2b)?.taxable || 0, rule: l.rcm.category ? { name: l.rcm.category, ref: l.rcm.ref, verify: l.rcm.verify } : null, mode: l.rcm.mode,
      rate: l.rcm.rate ?? null, tax: l.rcm.tax || null, note: l.rcm.note, recorded: l.rcm.source === "books",
    });
  }
  for (const c of ledgerCases) rcmCases.push({ ...c, note: c.why, recorded: false });
  rcmCases.sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "rcm" ? -1 : 1));

  return { lines, rcm_cases: rcmCases, counts: countLines(lines), summary: summarize(lines, gstr1, profile, opening, ledgerCases), profile: { nature: businessNature || null, label: profile.label } };
}

function countLines(lines) {
  const c = { total: lines.length, matched: 0, rounding: 0, different: 0, books_only: 0, g2b_only: 0, rcm: 0, no_tax: 0, ineligible: 0, hold: 0 };
  const sum = { books: zeroHeads(), g2b: zeroHeads() };
  for (const l of lines) {
    if (l.status === "matched") c.matched++;
    if (l.cat === "rounding") c.rounding++;
    if (l.status === "different") c.different++;
    if (l.status === "books_only" && l.cat === "books_only") c.books_only++;
    if (l.status === "g2b_only") c.g2b_only++;
    if (l.cat === "rcm" || l.code === "rcm") c.rcm++;
    if (l.code === "no_tax") c.no_tax++;
    if (l.code === "ineligible" || l.code === "ineligible_16_4") c.ineligible++;
    if (l.code === "hold") c.hold++;
    const sg = l.type === "cn" ? -1 : 1;
    if (l.books) addInto(sum.books, l.books, sg);
    if (l.g2b) addInto(sum.g2b, l.g2b, sg);
  }
  c.tax_books = Object.fromEntries(H.map((h) => [h, r2(sum.books[h])]));
  c.tax_2b = Object.fromEntries(H.map((h) => [h, r2(sum.g2b[h])]));
  return c;
}

/** GSTR-3B: outward tax from GSTR-1, ITC from the reconciliation, reverse charge in cash, and what is left to pay. */
export function summarize(lines, gstr1, profile, opening = {}, ledgerCases = []) {
  const tot = (k) => { const t = zeroHeads(); for (const l of lines) addInto(t, l.amounts[k]); return t; };
  const claim = tot("claim"), blocked = tot("blocked"), blockedRcm = tot("blocked_rcm"), barred = tot("barred"), hold = tot("hold"), reversal = tot("reversal"), rcm = tot("rcm"), rcmClaim = tot("rcm_claim"), unbooked = tot("unbooked");
  const ledgerRcm = zeroHeads();
  for (const c of ledgerCases) addInto(ledgerRcm, c.tax);
  addInto(rcm, ledgerRcm);
  addInto(rcmClaim, ledgerRcm);
  const out = gstr1?.liability ? { taxable: gstr1.liability.taxable, ...heads(gstr1.liability) } : null;

  // blocked credits are claimed in 4(A) and reversed in 4(B)(1); rcm credit is shown separately in 4(A)(3)
  const a5 = zeroHeads(); addInto(a5, claim); addInto(a5, blocked);
  const a3 = zeroHeads(); addInto(a3, rcmClaim); addInto(a3, blockedRcm);
  const b1 = zeroHeads(); addInto(b1, blocked); addInto(b1, blockedRcm);

  // rule 42 estimate for a business with taxable and exempt supplies
  let rule42 = zeroHeads(), ratio = 0;
  if (profile.exempt === "mixed" && gstr1) {
    const exempt = (gstr1.exempt?.nil || 0) + (gstr1.exempt?.exempt || 0) + (gstr1.exempt?.non_gst || 0);
    const total = (gstr1.liability?.taxable || 0) + exempt;
    ratio = total > 0 ? exempt / total : 0;
    for (const h of H) rule42[h] = r2(claim[h] * ratio);
  }
  const netNow = zeroHeads(), netRcm = zeroHeads(), openB = heads(opening);
  for (const h of H) {
    netNow[h] = Math.max(0, claim[h] - rule42[h] - reversal[h]);
    netRcm[h] = rcmClaim[h];
  }
  const available = zeroHeads();
  for (const h of H) available[h] = netNow[h] + (openB[h] || 0);

  const liability = out ? { igst: out.igst, cgst: out.cgst, sgst: out.sgst, cess: out.cess } : zeroHeads();
  const so = setOff(liability, available);
  const cash = zeroHeads(), carry = zeroHeads();
  for (const h of H) { cash[h] = so.cash[h] + rcm[h]; carry[h] = so.carry[h] + netRcm[h]; }
  const sumH = (o) => H.reduce((a, h) => a + (o[h] || 0), 0);
  const warnings = [];
  if (!out) warnings.push("The GSTR-1 PDF has not been read yet, so the outward tax is shown as nil. Upload it to get the net payment.");
  // rule 86B: at least 1% of the output tax in cash when taxable outward supplies exceed 50 lakh in a month
  const rule86b = out && out.taxable > 5000000 ? { applies: true, minimum: r2(sumH(liability) * 0.01), cash: r2(sumH(so.cash)) } : { applies: false };
  if (rule86b.applies) warnings.push(`Rule 86B: outward taxable supplies are above ₹50 lakh, so at least 1% of the output tax (${inr(rule86b.minimum)}) has to be paid in cash unless an exception applies. Cash paid on outward tax after set-off is ${inr(rule86b.cash)}.`);
  if (profile.unset) warnings.push("The nature of the business is not set, so the ITC is judged as for a normal taxable business. Set it to apply the rules for food, vehicles, construction, exempt supplies and so on.");

  const R = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  return {
    outward: out ? { ...R({ taxable: out.taxable, ...heads(out) }), source: gstr1.source } : null,
    exempt: gstr1?.exempt || null,
    itc: { a3: R(a3), a5: R(a5), b1: R(b1), rule42: R(rule42), rule42_ratio: r2(ratio * 100), b2: R(reversal), net_now: R(netNow), net_rcm: R(netRcm), net: R(Object.fromEntries(H.map((h) => [h, netNow[h] + netRcm[h]]))), opening: R(openB) },
    not_claimed: { hold: R(hold), barred: R(barred), unbooked: R(unbooked) },
    rcm: R(rcm),
    rcm_ledger: R(ledgerRcm),
    payment: { liability: R(liability), itc_used: R(so.used), cash_outward: R(so.cash), rcm_cash: R(rcm), cash: R(cash), carry_forward: R(carry), total_cash: r2(sumH(cash)), total_itc_used: r2(sumH(so.used)) },
    rule86b, warnings, provisions: { rcm: PROVISIONS.rcm },
  };
}

