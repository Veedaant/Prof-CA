import { r2, monthOf, monthsOfFy } from "../banking/common.js";
import { normInv } from "../recon/sheetParser.js";
import { validGstin, stateOf } from "../gstRules.js";
import { nameScore, tokensOf } from "../banking/parties.js";
import { matchRcm } from "../rcmRules.js";
import { rcmAmount } from "../itc/rcm.js";
import { BUSINESS, blockRule, profileOf, PROVISIONS } from "../itc/rules.js";

/**
 * The reverse-charge (RCM) working: the client's expense ledgers read line by line, each line tested against the reverse-charge
 * categories (section 9(3) and 9(4) CGST Act and the notifications behind them in rcmRules.js), with the client's nature of business
 * and constitution deciding which categories can apply to this recipient, and the ITC register and GSTR-2B deciding whether the
 * supplier has already charged GST (forward charge, so no RCM).
 */

const PAN_KIND = { C: "company", F: "firm", P: "individual", H: "HUF", A: "association of persons", B: "body of individuals", G: "government", J: "juridical person", L: "local authority", T: "trust" };
/** The constitution of the client from the fourth character of the PAN inside its GSTIN. */
export const constitutionOf = (gstin) => (validGstin(gstin) ? PAN_KIND[String(gstin).trim().toUpperCase()[5]] || "" : "");

/** Who the recipient has to be for a category to apply: by nature of business, or by constitution. */
const RECIPIENT = {
  insagent: { biz: ["insurance"], text: "an insurance company" },
  recovery: { biz: ["banking"], text: "a bank, financial institution or NBFC" },
  dsa: { biz: ["banking"], text: "a bank or NBFC" },
  director: { cons: ["company"], text: "a company (body corporate)" },
  sponsor: { cons: ["company", "firm"], text: "a body corporate or a partnership firm" },
  vehicle_rent: { cons: ["company"], text: "a body corporate" },
  author: { biz: ["publishing"], text: "a publisher, music company or producer" },
  tdr: { biz: ["real_estate"], text: "a real estate promoter" },
};

function recipientOk(rule, { business, constitution }) {
  const need = RECIPIENT[rule.key];
  if (!need) return { ok: true };
  if (need.biz && !need.biz.includes(business)) {
    return { ok: false, why: `${rule.name} is under reverse charge only when the recipient is ${need.text}. The client's nature of business is ${business ? `"${BUSINESS[business]?.label || business}"` : "not set"}.` };
  }
  if (need.cons && !need.cons.includes(constitution)) {
    return { ok: false, why: `${rule.name} is under reverse charge only when the recipient is ${need.text}. The client's constitution ${constitution ? `is "${constitution}"` : "cannot be read from its GSTIN"}.` };
  }
  return { ok: true };
}

const taxOf = (r) => (r.igst || 0) + (r.cgst || 0) + (r.sgst || 0) + (r.cess || 0);

/** Finds a supplier in the ITC register and GSTR-2B: its GSTIN, whether it has charged GST on the invoice or in the month, or reverse charge. */
function supplierIndex({ registerRows = [], g2bRows = [] }) {
  const rows = [
    ...registerRows.map((r) => ({ src: "the ITC register", party: r.party, gstin: r.gstin, no: r.no, month: r.month || monthOf(r.date), tax: taxOf(r), rcm: Boolean(r.rcmFlag) })),
    ...g2bRows.map((r) => ({ src: "GSTR-2B", party: r.party, gstin: r.gstin, no: r.no, month: monthOf(r.date) || r.month, tax: taxOf(r), rcm: Boolean(r.rcmFlag) })),
  ].map((r) => ({ ...r, tokens: tokensOf(r.party) }));
  const cache = new Map();
  return (e) => {
    const key = `${e.party}|${e.gstin}|${e.vchNo}|${monthOf(e.date)}`;
    if (cache.has(key)) return cache.get(key);
    const tokens = tokensOf(e.party);
    const same = rows.filter((r) => (validGstin(e.gstin) && r.gstin === e.gstin) || (tokens.size && r.tokens.size && nameScore({ tokens }, r.tokens) >= 0.6));
    const gstin = validGstin(e.gstin) ? e.gstin : same.find((r) => validGstin(r.gstin))?.gstin || "";
    const out = { gstin, forward: false, reverse: false, evidence: "" };
    const no = normInv(e.vchNo);
    const byNo = no ? same.filter((r) => normInv(r.no) === no) : [];
    const inMonth = same.filter((r) => r.month === monthOf(e.date));
    const pick = byNo.length ? byNo : inMonth;
    if (pick.some((r) => r.rcm)) { out.reverse = true; out.evidence = `${pick.find((r) => r.rcm).src} shows reverse charge for this supplier${byNo.length ? ` on invoice ${e.vchNo}` : " in the month"}`; }
    else if (pick.some((r) => r.tax > 0.005)) { const r = pick.find((x) => x.tax > 0.005); out.forward = true; out.evidence = `${r.src} shows GST charged by this supplier${byNo.length ? ` on invoice ${e.vchNo}` : " in the month"}`; }
    cache.set(key, out);
    return out;
  };
}

const GENERIC_RULE = { key: "as_2b", kind: "service", name: "Reverse charge as shown in GSTR-2B or the books", ref: "Section 9(3) / 9(4) CGST Act", rate: 18, scope: "", verify: true };

/**
 * The working. files: the books_rcm files (each with data.entries); client: { gstin, business_nature }.
 * Returns { lines (RCM applicable), held (a category matched but does not apply), ledgers, months, categories, business, warnings }.
 */
export function buildRcm({ files, client, registerRows = [], g2bRows = [], fy }) {
  const business = client.business_nature || "";
  const constitution = constitutionOf(client.gstin);
  const profile = profileOf(business);
  const promoter = business === "real_estate";
  const find = supplierIndex({ registerRows, g2bRows });

  // the same ledger entry in two overlapping exports counts once
  const seen = new Set();
  const entries = [];
  let duplicates = 0;
  for (const f of files.filter((x) => x.data?.entries)) {
    const here = new Set();
    for (const e of f.data.entries) {
      const key = `${e.ledger}|${e.date}|${e.party}|${e.vchNo}|${e.amount}`;
      if (seen.has(key) && !here.has(key)) { duplicates++; continue; }
      here.add(key);
      entries.push({ ...e, file: f.name });
    }
    for (const k of here) seen.add(k);
  }

  const lines = [], held = [];
  const ledgers = new Map();
  const months = new Map();
  const bucket = (m) => months.get(m) || months.set(m, { month: m, entries: 0, expense: 0, rcmEntries: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, tot: 0, itc: 0 }).get(m);
  let stateAssumed = 0, rateAssumed = 0;

  for (const e of entries) {
    const month = monthOf(e.date);
    const lg = ledgers.get(e.ledger) || ledgers.set(e.ledger, { ledger: e.ledger, entries: 0, amount: 0, rcmEntries: 0, tax: 0, heldEntries: 0 }).get(e.ledger);
    lg.entries++; lg.amount = r2(lg.amount + e.amount);
    const mb = bucket(month);
    mb.entries++; mb.expense = r2(mb.expense + e.amount);

    const sup = find(e);
    const registered = validGstin(sup.gstin);
    const text = `${e.ledger} ${e.party} ${e.narration}`;
    let rule = matchRcm(text, { registered, promoter });
    if (!rule && sup.reverse) rule = GENERIC_RULE;
    if (!rule) continue;
    const base = { month, date: e.date, ledger: e.ledger, party: e.party, gstin: sup.gstin, vchNo: e.vchNo, narration: e.narration, amount: e.amount, category: rule.name, ref: rule.ref, file: e.file };

    const who = recipientOk(rule, { business, constitution });
    if (!who.ok) { held.push({ ...base, reason: who.why }); lg.heldEntries++; continue; }
    if (sup.forward && !sup.reverse && rule.kind !== "import") {
      held.push({ ...base, reason: `${sup.evidence}, so the supply is under forward charge and no RCM is payable. ${rule.fcm ? `${rule.fcm}.` : "The recipient takes the ITC from GSTR-2B."}` });
      lg.heldEntries++;
      continue;
    }
    if (e.igst + e.cgst + e.sgst > 0.005 && rule.kind !== "import") {
      held.push({ ...base, reason: "The ledger shows GST charged on this entry, so the supply is under forward charge and no RCM is payable." });
      lg.heldEntries++;
      continue;
    }

    const ra = { rate: rule.rate, rate_assumed: rule === GENERIC_RULE, import: rule.kind === "import", source: "detected" };
    const amt = rcmAmount({ b: { taxable: e.amount, gstin: sup.gstin, supply: "", rate: 0 }, g: null, ra, clientGstin: client.gstin });
    const h = amt.h;
    const tax = r2(h.igst + h.cgst + h.sgst + h.cess);
    const noState = rule.kind !== "import" && !(stateOf(sup.gstin) && stateOf(client.gstin));
    if (noState) stateAssumed++;
    if (rule === GENERIC_RULE) rateAssumed++;

    // is the ITC on this RCM available to this business?
    let itc = "Eligible", itcNote = "", itcTax = tax;
    const block = blockRule(text, profile);
    if (profile.exempt === "all") { itc = "Not available"; itcNote = PROVISIONS.exempt_all; itcTax = 0; }
    else if (block?.blocked) { itc = "Ineligible"; itcNote = block.rule.provision; itcTax = 0; }
    else if (block?.conditional) { itc = "Check"; itcNote = block.rule.provision; itcTax = 0; }
    else if (profile.exempt === "mixed") { itc = "Apportion"; itcNote = PROVISIONS.exempt_mixed; itcTax = 0; }

    const basis = [
      sup.reverse ? `${sup.evidence}.` : `${rule.name}${rule.scope ? `: reverse charge applies ${rule.scope}` : ""}. No GST charged by the supplier was found in the ITC register or GSTR-2B.`,
      noState ? "The supplier's state is not known, so the tax is taken as CGST and SGST; for a supplier in another state it is IGST." : "",
      rule.verify ? "Depends on conditions that cannot be read from the ledger: confirm before paying." : "",
      rule.kind === "goods" && !registered ? "The supplier's GSTIN is not known, so the supplier is taken as unregistered." : "",
    ].filter(Boolean).join(" ");

    lines.push({
      ...base, key: rule.key, taxable: r2(e.amount), rate: amt.rate ?? rule.rate, rateAssumed: Boolean(amt.assumed), stateAssumed: noState,
      igst: h.igst, cgst: h.cgst, sgst: h.sgst, cess: h.cess, tax, itc, itcNote, itcTax, scope: rule.scope || "", verify: Boolean(rule.verify), basis,
    });
    lg.rcmEntries++; lg.tax = r2(lg.tax + tax);
    mb.rcmEntries++; mb.taxable = r2(mb.taxable + e.amount); mb.igst = r2(mb.igst + h.igst); mb.cgst = r2(mb.cgst + h.cgst); mb.sgst = r2(mb.sgst + h.sgst); mb.tot = r2(mb.tot + tax); mb.itc = r2(mb.itc + itcTax);
  }

  lines.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  held.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const fyMonths = fy ? monthsOfFy(fy) : [];
  const keys = [...new Set([...fyMonths, ...months.keys()])].filter((m) => fyMonths.includes(m) || months.has(m)).sort();
  const monthRows = keys.map((m) => months.get(m) || { month: m, entries: 0, expense: 0, rcmEntries: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, tot: 0, itc: 0 });
  const categories = [...lines.reduce((acc, l) => {
    const c = acc.get(l.category) || acc.set(l.category, { category: l.category, ref: l.ref, entries: 0, taxable: 0, tax: 0 }).get(l.category);
    c.entries++; c.taxable = r2(c.taxable + l.taxable); c.tax = r2(c.tax + l.tax);
    return acc;
  }, new Map()).values()].sort((a, b) => b.tax - a.tax);

  const warnings = [];
  if (!files.some((f) => f.data?.entries)) warnings.push("No expense ledger could be read, so there is nothing to work out.");
  if (!business) warnings.push("The client's nature of business is not set. Categories that depend on it (insurance agent, recovery agent, direct selling agent, real estate promoter and others) are left out, and the ITC on the RCM is not tested for exempt or mixed supplies. Set it above.");
  if (duplicates) warnings.push(`${duplicates} entr${duplicates === 1 ? "y" : "ies"} appear in more than one file (same ledger, date, party, voucher no and amount) and are counted once.`);
  if (stateAssumed) warnings.push(`${stateAssumed} entr${stateAssumed === 1 ? "y has" : "ies have"} a supplier whose state is not known: the tax is taken as CGST and SGST.`);
  if (rateAssumed) warnings.push(`${rateAssumed} entr${rateAssumed === 1 ? "y is" : "ies are"} reverse charge on the strength of GSTR-2B alone: the rate is taken as 18%.`);

  const total = (k) => r2(lines.reduce((s, l) => s + l[k], 0));
  return {
    business, businessLabel: BUSINESS[business]?.label || "", constitution, lines, held, ledgers: [...ledgers.values()], months: monthRows, categories, warnings,
    totals: { entries: entries.length, rcmEntries: lines.length, expense: r2(entries.reduce((s, e) => s + e.amount, 0)), taxable: total("taxable"), igst: total("igst"), cgst: total("cgst"), sgst: total("sgst"), tot: total("tax"), itc: total("itcTax") },
    have: entries.length > 0,
  };
}
