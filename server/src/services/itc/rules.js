import { barredBy164, validGstin } from "../gstRules.js";

/**
 * Is the ITC on a purchase eligible, for this kind of business, and under which provision?
 *
 * Built on the CGST Act, 2017 and the CGST Rules, 2017: sections 16, 17(1)-(5), 18, 34, 38 and 9(3)/9(4), rules 36, 37, 37A, 38, 42, 43 and 86B,
 * the RCM notifications 13/2017-CT(R), 4/2017-CT(R), 10/2017-IT(R) and 5/2022-CT(R), Circular 135/05/2020-GST (ITC only on invoices in
 * GSTR-2A/2B), Circular 140/10/2020-GST (director's remuneration), and the Supreme Court decision in Safari Retreats (2024) with the
 * Finance Act 2025 amendment of section 17(5)(d). It is a working for the CA to review: it reads descriptions, not the paper bill, and
 * it does not follow notifications issued after it was written.
 */

export const BUSINESS = {
  trading: { label: "Trading in goods", exempt: null, goods: true },
  manufacturing: { label: "Manufacturing", exempt: null, goods: true },
  service_taxable: { label: "Taxable services / professional services", exempt: null },
  restaurant: { label: "Restaurant, caterer or food service", exempt: null, food: true },
  hotel: { label: "Hotel / hospitality", exempt: null, food: true },
  goods_transport: { label: "Goods transport (GTA / goods carriage)", exempt: null, goodsVehicle: true },
  passenger_transport: { label: "Passenger transport / rent-a-cab / bus operator", exempt: null, vehicle: true, cab: true },
  motor_dealer: { label: "Motor vehicle dealer", exempt: null, vehicle: true },
  driving_school: { label: "Driving school", exempt: null, vehicle: true },
  works_contract: { label: "Construction / works contractor", exempt: null, works: true },
  real_estate: { label: "Real estate developer (sells units)", exempt: "mixed", works: true },
  rental_property: { label: "Renting of immovable property", exempt: null, rental: true },
  healthcare: { label: "Healthcare services (exempt)", exempt: "all" },
  education: { label: "Education services (exempt)", exempt: "all" },
  banking: { label: "Banking / NBFC / financial services", exempt: "mixed", bank: true },
  insurance: { label: "Insurance", exempt: null, insurance: true },
  exempt_other: { label: "Other exempt supplier (agriculture, residential rent, etc.)", exempt: "all" },
  mixed: { label: "Both taxable and exempt supplies", exempt: "mixed" },
};
export const profileOf = (nature) => BUSINESS[nature] || { label: "Not set (treated as a taxable business)", exempt: null, unset: true };

const GOODS_VEHICLE = /\b(truck|lorry|tempo|trailer|goods vehicle|goods carriage|tanker|tractor|earth ?mover|excavator|crane|forklift|jcb|dumper|bus)\b/;

// Each rule: a pattern on the description, and when the business makes it eligible after all.
const BLOCKS = [
  {
    id: "vehicle", re: /\b(motor ?car|cars?|suv|jeep|motor ?vehicle|two ?wheeler|scooter|motor ?cycle|bike|passenger vehicle|vehicle (insurance|servicing|repair|maintenance)|motor insurance|car (insurance|servicing|repair))\b/, not: GOODS_VEHICLE,
    ok: (p) => p.vehicle, kind: "Ineligible",
    provision: "Section 17(5)(a) and (ab) CGST Act: ITC on motor vehicles for carrying 13 persons or fewer (including the driver), and on their insurance, servicing and repair, is blocked, unless the vehicle is used for further supply of vehicles, transport of passengers or driving training.",
  },
  {
    id: "hire_vehicle", re: /rent[- ]a[- ]cab|cab (hire|service|charges|rental)|\btaxi\b|(car|vehicle|motor vehicle) (hire|hiring|rental|lease)|(hiring|renting|leasing) of (a )?(motor )?(vehicle|car)/, not: GOODS_VEHICLE,
    ok: (p) => p.cab || p.vehicle, kind: "Ineligible",
    provision: "Section 17(5)(b)(i) CGST Act: ITC on renting, hiring or leasing of motor vehicles (13 persons or fewer) is blocked, except where the outward supply is of the same category (for example passenger transport) or the vehicle is used for the purposes in section 17(5)(a).",
  },
  {
    id: "food", re: /\b(food|beverages?|outdoor catering|catering|canteen|restaurant|meals?|lunch|dinner|snacks|tiffin|banquet)\b/,
    ok: (p, t) => p.food || (p.goods && !/(catering|canteen|restaurant|meals?|lunch|dinner|snacks|tiffin|banquet)/.test(t)), kind: "Ineligible",
    provision: "Section 17(5)(b)(i) CGST Act: ITC on food and beverages and outdoor catering is blocked, except where the outward supply is of the same category (a restaurant, caterer or hotel) or the Government has notified the service as one an employer must provide under law.",
  },
  {
    id: "beauty_health", re: /beauty (treatment|service|parlour)|\bsalon\b|\bspa\b|cosmetic (surgery|treatment)|plastic surgery|health (check|checkup|services?)|massage/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(b)(i) CGST Act: ITC on beauty treatment, health services, and cosmetic and plastic surgery is blocked, except where the outward supply is of the same category or the Government has notified it as obligatory for an employer.",
  },
  {
    id: "club", re: /club (membership|fee|subscription)|membership of (a )?club|health club|fitness (centre|center)|\bgym(nasium)?\b/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(b)(ii) CGST Act: ITC on membership of a club, health and fitness centre is blocked.",
  },
  {
    id: "insurance", re: /life insurance|health insurance|mediclaim|term (plan|insurance)|group (health|life|mediclaim)/,
    ok: (p) => p.insurance, kind: "Ineligible",
    provision: "Section 17(5)(b)(i) CGST Act: ITC on life insurance and health insurance is blocked, except where the outward supply is of the same category or the Government has notified it as obligatory for an employer.",
  },
  {
    id: "travel", re: /leave travel|\bltc\b|home travel concession|vacation travel/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(b)(iii) CGST Act: ITC on travel benefits given to employees on vacation (leave or home travel concession) is blocked.",
  },
  {
    id: "works", re: /works contract/,
    ok: (p) => p.works, kind: "Ineligible",
    provision: "Section 17(5)(c) CGST Act: ITC on works contract services for construction of an immovable property (other than plant and machinery) is blocked, except where the input service is used for a further works contract supply.",
  },
  {
    id: "construction", re: /construction (of|service|work|material)|civil (work|works)|building (work|material|construction)|\bcement\b|\bbricks?\b|\bsand\b|\brcc\b|architect/,
    ok: () => false, conditional: (p) => p.works, kind: "Ineligible",
    provision: "Section 17(5)(d) CGST Act (as amended retrospectively by the Finance Act 2025, after the Supreme Court's decision in Safari Retreats): ITC on goods or services for construction of an immovable property on own account, other than plant and machinery, is blocked even if used in business. Plant and machinery excludes land, buildings and civil structures. For a developer selling units or a contractor, check the 17(5)(c) exception and the property's status.",
  },
  {
    id: "repairs_capital", re: /renovation|alteration|addition to (the )?(building|premises)|interior (work|decoration)/,
    ok: () => false, conditional: () => true, kind: "Check",
    provision: "Section 17 Explanation CGST Act: \"construction\" includes renovation, additions, alterations and repairs to the extent of capitalisation. ITC is blocked if the spend is capitalised in the books under section 17(5)(d); it is allowed if it is charged to the profit and loss account as repairs and maintenance.",
  },
  {
    id: "gift", re: /\bgifts?\b|free samples?|complimentary|freebies/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(h) CGST Act: ITC on goods lost, stolen, destroyed, written off or disposed of by way of gift or free samples is blocked.",
  },
  {
    id: "lost", re: /\b(lost|stolen|destroyed|written off|pilferage|theft)\b/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(h) CGST Act: ITC on goods lost, stolen, destroyed or written off is blocked.",
  },
  {
    id: "personal", re: /personal (use|consumption|expenses)|owner'?s? (house|family|residence)|director'?s? (house|residence)|wedding|marriage/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 17(5)(g) CGST Act: ITC on goods or services used for personal consumption is blocked, and section 16(1) allows ITC only for use in the course or furtherance of business.",
  },
  {
    id: "csr", re: /\bcsr\b|corporate social responsibility/,
    ok: () => false, kind: "Ineligible",
    provision: "Section 16(1) CGST Act: ITC is allowed only on supplies used in the course or furtherance of business. Spending on CSR activities is generally treated as not being for business, so the ITC is not available.",
  },
];

/** Finds the blocked-credit rule, if any, that applies to the description. */
export function blockRule(text, profile) {
  const t = String(text || "").toLowerCase();
  for (const b of BLOCKS) {
    if (!b.re.test(t)) continue;
    if (b.not && b.not.test(t)) continue;
    if (b.ok(profile, t)) return { exempted: true, rule: b };
    if (b.conditional && b.conditional(profile)) return { conditional: true, rule: b };
    return { blocked: true, rule: b };
  }
  return null;
}

const TWOB_REASON = [
  [/30th november|financial year/i, "Section 16(4) CGST Act: ITC cannot be claimed after 30 November following the end of the financial year to which the invoice belongs."],
  [/pos provision|place of supply/i, "Sections 10 and 12 IGST Act: the supplier charged the wrong tax head for the place of supply. The recipient can claim ITC only on the correct head; the supplier must correct it (section 77 CGST Act, section 19 IGST Act)."],
  [/37a|not paid/i, "Rule 37A CGST Rules: the supplier has not paid the tax by 30 September following the financial year, so the recipient must reverse the ITC."],
];
export const twoBProvision = (reason) => (TWOB_REASON.find(([re]) => re.test(reason || "")) || [null, `Section 38 CGST Act (GSTR-2B): the portal marks this ITC as not available${reason ? ` - reason given: ${reason}` : ""}.`])[1];

const P16 = "Section 16(1) and 16(2) CGST Act: ITC is allowed for a registered person on a tax invoice, when the goods or services are received, the tax is paid to the Government, and the invoice appears in GSTR-2B (section 16(2)(aa)).";
export const PROVISIONS = {
  eligible: P16,
  not_in_2b: "Section 16(2)(aa) CGST Act with rule 36(4): from 1 January 2022 ITC can be claimed only on invoices that appear in the recipient's GSTR-2B. The supplier has not reported this invoice for the month (circular 135/05/2020-GST first tied ITC to the supplier's filing). Claim it in the month it appears; see rule 37A if the supplier never pays the tax.",
  not_in_books: "Section 16(1) CGST Act: ITC is claimed on supplies used in the course or furtherance of business, so the purchase has to be recorded and be genuine. Section 16(4) allows the claim up to 30 November after the end of the financial year.",
  rcm: "Section 9(3)/9(4) CGST Act and section 5(3)/5(4) IGST Act: the recipient pays tax on reverse charge in cash (notifications 13/2017-CT(R) for services, 4/2017-CT(R) for goods, 10/2017-IT(R) for imports of services, 5/2022-CT(R) for residential rent). The ITC is claimed in 4(A)(3) after the cash payment (section 16(1) and the proviso to section 49(4)), so it can be used from the next month.",
  no_tax: "Section 16(1) CGST Act: ITC exists only where tax has been charged. Exempt, nil-rated, composition-dealer and unregistered-supplier purchases carry none, and are reported in Table 5 of GSTR-3B.",
  cn: "Section 34(2) and section 16(1) CGST Act: ITC is reversed in the month a credit note is received or issued by the supplier (GSTR-3B Table 4(B)(2)).",
  exempt_all: "Section 17(2) CGST Act and rule 42: ITC on inputs used wholly for exempt supplies is not available. Healthcare, education and similar exempt services cannot claim ITC. If this business also makes taxable supplies, set it to \"taxable and exempt supplies\" so the ITC is apportioned under rule 42.",
  exempt_mixed: "Section 17(1), 17(2) and 17(3) CGST Act with rules 42 and 43: for a business making both taxable and exempt supplies, ITC on common inputs, input services and capital goods is apportioned, and the part relating to exempt supplies is reversed (GSTR-3B Table 4(B)(1)). Banks and financial companies may instead take 50% under section 17(4) and rule 38.",
  no_gstin: "Section 16(2)(a) CGST Act: ITC needs a tax invoice or debit note issued by a registered person. There is no valid GSTIN for this supplier.",
  not_to_us: "Section 16(2)(a) CGST Act: ITC is allowed only on a tax invoice issued to the recipient who is claiming it.",
};

/** Reverse charge: the books say so, or the supplier reported it as reverse charge in GSTR-1. A supplier who charged tax and reported it normally has not used reverse charge. */
export function isRcm(book, g2b) {
  if (g2b?.reverse) return true;
  if (book?.charge !== "RCM") return false;
  const tax2b = g2b ? g2b.igst + g2b.cgst + g2b.sgst + g2b.cess : 0;
  return !(g2b && tax2b > 0.005);
}

/**
 * Decides eligibility for one reconciled line.
 * @returns {{code, label, provision, reason}}
 *   code: eligible | conditional | ineligible | ineligible_16_4 | hold | rcm | not_booked | no_tax | reversal
 */
export function judge({ book, g2b, profile, period, rcm: rcmFlag, rcmRule }) {
  const doc = book || g2b;
  const text = `${book?.nature || ""} ${book?.party || g2b?.party || ""}`;
  const date = book?.date || g2b?.date;
  const taxBooks = book ? book.igst + book.cgst + book.sgst + book.cess : 0;
  const tax2b = g2b ? g2b.igst + g2b.cgst + g2b.sgst + g2b.cess : 0;
  const out = (code, label, provision, reason = "") => ({ code, label, provision, reason });

  if (doc.type === "cn") return out("reversal", "ITC reversal (credit note)", PROVISIONS.cn, "The supplier has reduced the invoice, so the ITC on it is reduced by the same tax.");

  const rcm = rcmFlag === undefined ? isRcm(book, g2b) : rcmFlag;
  if (rcm) {
    const blk = blockRule(text, profile);
    if (blk?.blocked) return out("ineligible", "Ineligible (blocked credit)", `${PROVISIONS.rcm} ${blk.rule.provision}`, `Reverse-charge tax must still be paid in cash, but the ITC on it is blocked.`);
    return out("rcm", "Eligible after RCM payment", rcmRule ? `${PROVISIONS.rcm} Applicable here: ${rcmRule.ref}.` : PROVISIONS.rcm, "Not expected in GSTR-2B. Tax is paid in cash and the credit is used from next month.");
  }

  if (!book) {
    // in GSTR-2B but not in the books
    if (g2b.avail === "No") return out("ineligible", "Ineligible (GSTR-2B says ITC not available)", twoBProvision(g2b.reason), g2b.reason || "");
    return out("not_booked", "Eligible once booked", PROVISIONS.not_in_books, "ITC is shown in GSTR-2B but the purchase is not in the books. If it is a genuine purchase, book it and claim; if not, ask the supplier to correct.");
  }

  if (taxBooks <= 0.005 && tax2b <= 0.005) return out("no_tax", "No ITC (no tax charged)", PROVISIONS.no_tax);

  if (!g2b) return out("hold", "Not claimable this month (not in GSTR-2B)", PROVISIONS.not_in_2b, "The supplier has not reported this invoice in GSTR-1 for the month.");

  if (g2b.avail === "No") return out("ineligible_16_4", "Ineligible (GSTR-2B says ITC not available)", twoBProvision(g2b.reason), g2b.reason || "");
  if (barredBy164(date, period)) return out("ineligible_16_4", "Ineligible (time limit passed)", twoBProvision("30th November"), "The invoice is dated in a financial year whose 30 November limit has passed.");
  if (!validGstin(book.gstin) && !validGstin(g2b.gstin)) return out("ineligible_16_4", "Ineligible (no valid supplier GSTIN)", PROVISIONS.no_gstin);

  if (profile.exempt === "all") return out("ineligible", "Ineligible (exempt business)", PROVISIONS.exempt_all, `${profile.label}: the outward supplies are exempt.`);

  const blk = blockRule(text, profile);
  if (blk?.blocked) return out("ineligible", "Ineligible (blocked credit)", blk.rule.provision, `Matched on "${(text.toLowerCase().match(blk.rule.re) || [""])[0]}" in the description.`);
  if (blk?.conditional) return out("conditional", "Eligible - check the condition", blk.rule.provision, `Matched on "${(text.toLowerCase().match(blk.rule.re) || [""])[0]}" in the description.`);
  if (blk?.exempted) return out("eligible", "Eligible (exception applies to this business)", `${blk.rule.provision} For ${profile.label} the exception applies.`, "");
  if (profile.exempt === "mixed") return out("eligible", "Eligible - common credit, apportion under rule 42", PROVISIONS.exempt_mixed);
  return out("eligible", "Eligible", PROVISIONS.eligible);
}
