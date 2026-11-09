/**
 * GST rules used when the GSTR-3B working is prepared from purchase-side documents.
 *
 * What is encoded here (the working is a draft for the CA to review, not legal advice, and it does not read
 * notifications issued after it was written):
 *  - Reverse charge (section 9(3)/5(3), Notification 13/2017-CT(R) for services, 4/2017-CT(R) for goods, 10/2017-IT(R) for
 *    import of services). Tax on an RCM purchase is worked out by the recipient: the supplier's bill carries no tax.
 *  - Section 16(2) conditions we can see in a document (tax invoice, valid supplier GSTIN, issued to this GSTIN).
 *  - Section 16(4) time limit (30 November after the financial year).
 *  - Section 17(5) blocked credits.
 */

import { matchRcm } from "./rcmRules.js";

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const validGstin = (g) => GSTIN_RE.test(String(g || "").trim().toUpperCase());
export const stateOf = (g) => (validGstin(g) ? String(g).trim().slice(0, 2) : "");

const text = (...parts) => parts.map((p) => String(p || "")).join(" ").toLowerCase();

/**
 * Is this purchase document under reverse charge, and why?
 * Returns { rcm, basis, rate, rate_assumed, import, key, ref }. The catalogue of notified supplies is in rcmRules.js.
 */
export function classifyRcm(inv, rows) {
  const all = text(inv.supplier_name, ...rows.map((r) => `${r.description} ${r.hsn}`));
  const sacs = rows.map((r) => String(r.hsn || ""));
  const noTax = rows.every((r) => !(r.igst || r.cgst || r.sgst || r.cess));
  const flagged = Boolean(inv.reverse_charge);
  const rule = matchRcm(all, { sacs, registered: validGstin(inv.supplier_gstin), placeOfSupply: inv.place_of_supply });

  if (rule?.kind === "import" && (flagged || noTax)) {
    return { rcm: true, basis: `${rule.name} - IGST on reverse charge (${rule.ref})`, rate: rule.rate, rate_assumed: rule.key === "import", import: true, key: rule.key, ref: rule.ref };
  }
  if (flagged) {
    return rule
      ? { rcm: true, basis: `Marked reverse charge on the invoice. ${rule.name} (${rule.ref})`, rate: rule.rate, rate_assumed: false, import: false, key: rule.key, ref: rule.ref }
      : { rcm: true, basis: "Marked reverse charge on the invoice", rate: 18, rate_assumed: true, import: false, key: null, ref: "" };
  }
  if (rule && noTax) {
    return { rcm: true, basis: `Detected from the description / SAC, supplier charged no GST. ${rule.name} (${rule.ref})`, rate: rule.rate, rate_assumed: false, import: rule.kind === "import", key: rule.key, ref: rule.ref };
  }
  return { rcm: false, basis: "", rate: 0, rate_assumed: false, import: false, key: null, ref: "" };
}

const BLOCKED = [
  { label: "Motor vehicle for carrying up to 13 persons - section 17(5)(a)", re: /\bmotor (car|vehicle)s?\b|\bpassenger (car|vehicle)\b|\b(car|cars) (purchase|hire|rental)\b|rent[- ]a[- ]cab|\bcab hire\b|taxi hire/ },
  { label: "Food, beverages, outdoor catering - section 17(5)(b)(i)", re: /\b(food|beverages?|outdoor catering|catering|canteen|restaurant|meals?|lunch|dinner|snacks)\b/ },
  { label: "Beauty treatment, health services, cosmetic / plastic surgery - section 17(5)(b)(i)", re: /beauty (treatment|service)|\bsalon\b|cosmetic|plastic surgery|health service|\bspa\b/ },
  { label: "Club membership, health and fitness centre - section 17(5)(b)(ii)", re: /club membership|health club|fitness (centre|center)|\bgym\b|membership fee/ },
  { label: "Life / health insurance - section 17(5)(b)", re: /life insurance|health insurance|mediclaim/ },
  { label: "Travel benefits to employees on vacation - section 17(5)(b)(iii)", re: /leave travel|\bltc\b|vacation travel/ },
  { label: "Works contract / construction of immovable property - section 17(5)(c)/(d)", re: /works contract|construction of (a )?(building|immovable)|civil (work|works)|building construction/ },
  { label: "Gifts, free samples, personal consumption - section 17(5)(h)", re: /\bgifts?\b|free samples?|personal (use|consumption)|donation/ },
];

/** Section 17(5) blocked credit, read from the description. Returns the matching reason or null. */
export function blockedReason(inv, rows) {
  const t = text(...rows.map((r) => r.description));
  const b = BLOCKED.find((x) => x.re.test(t));
  return b ? b.label : null;
}

/** Section 16(4): ITC on a document dated in a financial year can be claimed up to 30 November after that year. */
export function barredBy164(invDate, taxPeriod) {
  if (!invDate || !taxPeriod) return false;
  const d = new Date(invDate);
  if (Number.isNaN(d.getTime())) return false;
  const fyStart = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  // the return for October (filed by 20 November) is the last one that falls inside the 30 November limit
  return String(taxPeriod) > `${fyStart + 1}-10`;
}

/**
 * Pays outward tax from ITC in the statutory order (section 49(5) and rule 88A): IGST credit against IGST, then CGST, then SGST;
 * CGST credit against CGST, then IGST; SGST credit against SGST, then IGST; cess only against cess. Anything left is paid in cash.
 */
export function setOff(liability, itc) {
  const L = { igst: liability.igst || 0, cgst: liability.cgst || 0, sgst: liability.sgst || 0, cess: liability.cess || 0 };
  let I = itc.igst || 0, C = itc.cgst || 0, S = itc.sgst || 0, X = itc.cess || 0;
  const use = (avail, key) => { const u = Math.max(0, Math.min(avail, L[key])); L[key] -= u; return avail - u; };
  I = use(I, "igst"); I = use(I, "cgst"); I = use(I, "sgst");
  C = use(C, "cgst"); C = use(C, "igst");
  S = use(S, "sgst"); S = use(S, "igst");
  X = use(X, "cess");
  const left = { igst: I, cgst: C, sgst: S, cess: X };
  const used = {};
  for (const h of Object.keys(left)) used[h] = (itc[h] || 0) - left[h];
  const cash = {};
  for (const h of Object.keys(L)) cash[h] = Math.max(0, L[h]);
  return { used, cash, carry: left };
}
