import { normInv, normName } from "../recon/sheetParser.js";
import { stateOf, validGstin } from "../gstRules.js";
import { matchRcm } from "../rcmRules.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const tax = (o) => (o ? (o.igst || 0) + (o.cgst || 0) + (o.sgst || 0) + (o.cess || 0) : 0);
const heads = (o) => ({ igst: o?.igst || 0, cgst: o?.cgst || 0, sgst: o?.sgst || 0, cess: o?.cess || 0 });

/**
 * Is a purchase under reverse charge?
 *
 * mode "rcm": the recipient pays the tax in cash (the books say so, GSTR-2B says so, or the nature of the supply says so and
 *             the supplier has charged no GST).
 * mode "fcm": the supply is of a reverse-charge kind, but the supplier has charged GST (forward charge) and the ITC is in GSTR-2B.
 * mode "none": not a reverse-charge case.
 */
export function assessRcm({ b, g, promoter = false }) {
  const text = `${b?.nature || ""} ${b?.party || g?.party || ""}`;
  const gstin = b?.gstin || g?.gstin || "";
  const registered = validGstin(gstin);
  const rule = matchRcm(text, { registered, promoter, placeOfSupply: g?.pos && /other country|96/i.test(g.pos) ? g.pos : "" });
  const taxBooks = tax(b), tax2b = tax(g);
  const charged = taxBooks > 0.005 || tax2b > 0.005;
  const out = (mode, source, extra = {}) => ({ mode, source, rule, rate: rule?.rate ?? 18, rate_assumed: !rule, import: rule?.kind === "import", ...extra });

  if (g?.reverse) return out("rcm", "2b", { why: "GSTR-2B shows this supply as attracting reverse charge." });
  if (b?.charge === "RCM") {
    if (g && tax2b > 0.005) {
      return out("fcm", "books", {
        note: `The books treat this as reverse charge, but the supplier has charged GST and reported it normally in GSTR-1, so the ITC is reflected in GSTR-2B. Do not pay the tax again under reverse charge.`,
      });
    }
    return out("rcm", "books", { why: rule ? `${rule.name}.` : "Marked as reverse charge in the books." });
  }
  if (rule && !charged) {
    return out("rcm", "detected", { why: `${rule.name}: reverse charge applies ${rule.scope ? rule.scope : "to the recipient"}. The supplier has charged no GST and the books do not record the tax.` });
  }
  if (rule && charged && rule.kind !== "goods") {
    return out("fcm", "supplier", {
      note: `This is a reverse-charge kind of supply (${rule.name}), but the supplier has ${rule.fcm ? "opted for forward charge (FCM) and " : ""}charged GST, so the ITC is reflected in GSTR-2B and no RCM is payable. ${rule.fcm ? rule.fcm + "." : "If the supplier is an advocate, arbitral tribunal or other person named in the notification, the supply is under reverse charge by law; check the supplier."}`,
    });
  }
  return out("none", "");
}

/** The tax a recipient pays under reverse charge on a line, by head. */
export function rcmAmount({ b, g, ra, clientGstin }) {
  if (ra.source === "2b" && g && tax(g) > 0.005) return { h: heads(g), assumed: false, rate: null };
  if (ra.source === "books" && b) {
    if (tax(b) > 0.005) return { h: heads(b), assumed: false, rate: null };
    if (b.rcm > 0.005) return split(b.rcm, b.supply === "inter" || ra.import, null, b, g, clientGstin);
  }
  const taxable = b?.taxable || g?.taxable || 0;
  const booksRate = ra.source === "books" && b?.rate > 0 ? b.rate : 0;
  const rate = booksRate || ra.rate;
  const out = split(r2((taxable * rate) / 100), ra.import, rate, b, g, clientGstin);
  return { ...out, assumed: ra.rate_assumed && !booksRate, rate };
}

function split(amount, forceInter, rate, b, g, clientGstin) {
  const sup = stateOf(b?.gstin || g?.gstin);
  const me = stateOf(clientGstin);
  const inter = forceInter || (sup && me ? sup !== me : b?.supply === "inter");
  const h = inter ? { igst: amount, cgst: 0, sgst: 0, cess: 0 } : { igst: 0, cgst: r2(amount / 2), sgst: r2(amount - r2(amount / 2)), cess: 0 };
  return { h, assumed: false, rate };
}

/**
 * Reverse-charge cases found in the client's purchase ledger that are in neither the books register nor GSTR-2B:
 * an advocate's fee or a freight bill booked with no tax, for instance. The ledger names the party and the amount, not the
 * nature of the supply, so only the party and ledger name are read.
 */
export function ledgerRcmCases({ ledgerRows, lines, clientGstin, promoter }) {
  const known = lines.map((l) => ({ no: normInv(l.inv_no), party: normName(l.party), gstin: l.gstin, taxable: l.books?.taxable ?? l.g2b?.taxable ?? 0 }));
  const cases = [];
  for (const r of ledgerRows || []) {
    if (r.type === "cn" || r.type === "dn") continue;
    const text = `${r.party || ""} ${r.nature || ""}`;
    const registered = validGstin(r.gstin);
    const rule = matchRcm(text, { registered, promoter });
    const taxed = (r.igst || 0) + (r.cgst || 0) + (r.sgst || 0) + (r.cess || 0) > 0.005;
    const flagged = Boolean(r.rcm);
    if (!(rule || flagged) || taxed) continue;
    const dup = known.some((k) => (normInv(r.inv_no) && k.no === normInv(r.inv_no) && (k.party === normName(r.party) || (r.gstin && k.gstin === r.gstin))) || (k.party && k.party === normName(r.party) && Math.abs(k.taxable - (r.taxable || 0)) <= 1));
    if (dup) continue;
    const ra = { rate: rule?.rate ?? 18, rate_assumed: !rule, import: rule?.kind === "import", source: "detected" };
    const amt = rcmAmount({ b: { taxable: r.taxable, gstin: r.gstin, supply: "", rate: 0 }, g: null, ra, clientGstin });
    cases.push({
      source: "ledger", type: "inv", party: r.party || "", gstin: r.gstin || "", inv_no: r.inv_no || "", date: r.date || null, nature: "",
      taxable: r2(r.taxable || 0), rule: rule ? { key: rule.key, name: rule.name, ref: rule.ref, rate: rule.rate, verify: Boolean(rule.verify) } : null,
      mode: "rcm", rate: amt.rate, rate_assumed: ra.rate_assumed, tax: amt.h,
      why: rule ? `${rule.name}: reverse charge applies ${rule.scope || "to the recipient"}. The client's purchase ledger carries it with no GST.` : "The client's purchase ledger marks this entry as reverse charge.",
    });
  }
  return cases;
}
