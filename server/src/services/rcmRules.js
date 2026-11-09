/**
 * Supplies on which the recipient pays GST under reverse charge (RCM), with the provision for each.
 *
 * Sources: section 9(3) and 9(4) CGST Act, section 5(3) and 5(4) IGST Act, Notification 13/2017-CT(R) (services), Notification 4/2017-CT(R)
 * (goods), Notification 10/2017-IT(R) (import of services) and Notification 5/2022-CT(R) (residential dwelling), each as amended.
 * Entries marked `verify` depend on conditions that cannot be read from an invoice or on notifications that change often.
 *
 * The recipient's liability only arises when the supplier has charged no GST. A supplier who charges GST has paid it under forward
 * charge (FCM), the recipient takes the ITC from GSTR-2B and must not pay it again.
 */

const S = "Section 9(3) CGST Act and section 5(3) IGST Act; Notification 13/2017-CT(R)";

export const RCM_RULES = [
  {
    key: "gta", kind: "service", name: "Goods transport agency (GTA) service", ref: `${S}, entry 1`, rate: 5, rateNote: "5% (GTA without ITC); 18% if the GTA opts for forward charge",
    sac: /^9965/, words: /goods transport|transportation (charges|service)|transport charges|freight|lorry|truck hire|cartage|haulage|\bgta\b|consignment note|\blr no\b/,
    fcm: "A goods transport agency can opt to pay GST itself (forward charge, 18% with ITC) under the proviso to entry 1 of Notification 13/2017-CT(R) as amended. This supplier has done so and has charged GST",
    scope: "when the recipient is a factory, society, trust, partnership firm, body corporate, registered person or casual taxable person",
  },
  {
    key: "legal", kind: "service", name: "Legal service by an advocate or firm of advocates", ref: `${S}, entry 2`, rate: 18,
    sac: /^99821/, words: /advocate|legal (fee|fees|service|services|charges|opinion|retainer)|\bcounsel\b|law (firm|chambers)|solicitor|professional fee.*(court|litigation)/,
    scope: "to a business entity", fcm: null,
  },
  { key: "arbitral", kind: "service", name: "Service by an arbitral tribunal", ref: `${S}, entry 3`, rate: 18, sac: null, words: /arbitral|arbitrator|arbitration fee/, scope: "to a business entity", fcm: null },
  { key: "sponsor", kind: "service", name: "Sponsorship service", ref: `${S}, entry 4`, rate: 18, sac: /^99839/, words: /sponsorship/, scope: "by a person other than a body corporate, to a body corporate or partnership firm", fcm: null },
  {
    key: "govt", kind: "service", name: "Service by the Government or a local authority", ref: `${S}, entry 5 (with its exclusions: renting of immovable property is dealt with separately, postal, aircraft and vessel services, passenger and goods transport)`, rate: 18, sac: null,
    words: /(government|govt|municipal|panchayat|local authority|nagar (nigam|palika)|mahanagar|forest department|development authority|\bmidc\b|\bnhai\b|mining royalty|mining lease|forest (produce|right|lease)|licen[cs]e fee.*(government|govt)|royalty.*mining)/,
    scope: "to a business entity", fcm: null, verify: true,
  },
  { key: "director", kind: "service", name: "Director's fee, sitting fee or commission (non-employee director)", ref: `${S}, entry 6; Circular 140/10/2020-GST (a director who is an employee and receives salary is outside RCM)`, rate: 18, sac: null, words: /director'?s?\s*(fee|fees|sitting|remuneration|commission)|sitting fee/, scope: "to the company or body corporate", fcm: null },
  { key: "insagent", kind: "service", name: "Insurance agent's commission", ref: `${S}, entry 7`, rate: 18, sac: null, words: /insurance agent|agent'?s? commission.*insurance/, scope: "to an insurance company", fcm: null },
  { key: "recovery", kind: "service", name: "Recovery agent service", ref: `${S}, entry 8`, rate: 18, sac: null, words: /recovery agent/, scope: "to a bank, financial institution or NBFC", fcm: null },
  {
    key: "author", kind: "service", name: "Author, music composer, photographer or artist (copyright royalty)", ref: `${S}, entry 9`, rate: 18, sac: null,
    words: /\b(author|music composer|photographer|royalty for (a )?(book|copyright|music)|copyright (fee|royalty))\b/, scope: "to a publisher, music company or producer",
    fcm: "The author or artist can opt for forward charge by declaring so on the invoice. This supplier has charged GST", verify: true,
  },
  { key: "dsa", kind: "service", name: "Direct selling agent / business facilitator / business correspondent", ref: `${S}, entries 11 to 13`, rate: 18, sac: null, words: /direct selling agent|\bdsa\b|business facilitator|business correspondent/, scope: "to a bank or NBFC", fcm: null },
  { key: "security", kind: "service", name: "Security service (supply of security personnel)", ref: `${S}, entry 14`, rate: 18, sac: /^998525/, words: /security (service|services|guard|charges|personnel)|watchman|manpower security/, scope: "by a person other than a body corporate, to a registered person", fcm: null },
  {
    key: "vehicle_rent", kind: "service", name: "Renting of a motor vehicle with fuel cost included", ref: `${S}, as amended (renting of a motor vehicle designed to carry passengers to a body corporate)`, rate: 5,
    sac: null, words: /(cab|car|taxi|motor vehicle|vehicle) (hire|hiring|rental|rent)|renting of (a )?(motor )?vehicle|vehicle hire|cab service|taxi service/,
    scope: "by a person who is not a body corporate, to a body corporate", fcm: "The supplier has charged GST", verify: true,
  },
  { key: "rent_res", kind: "service", name: "Renting of a residential dwelling to a registered person", ref: "Section 9(3) CGST Act; Notification 5/2022-CT(R) (from 18 July 2022)", rate: 18, sac: null, words: /(residential|flat|apartment|bungalow|guest house).*(rent|lease|hire)|(rent|lease|hire).*(residential|flat|apartment|bungalow|guest house)/, scope: "to a registered person (other than a proprietor or partner renting for personal use)", fcm: null, verify: true },
  { key: "tdr", kind: "service", name: "Development rights, FSI or long-term lease of land to a promoter", ref: `${S}, as amended (promoter paying a landowner for development rights, floor space index or a long-term lease premium)`, rate: 18, sac: null, words: /development rights|\btdr\b|floor space index|\bfsi\b|long[- ]term lease|lease premium|upfront (amount|premium)/, scope: "to a promoter of a real estate project", fcm: null, verify: true },
  {
    key: "import", kind: "import", name: "Import of service from outside India", ref: "Section 5(3) IGST Act and Notification 10/2017-IT(R); the recipient pays IGST", rate: 18, sac: null,
    words: /import of service|\b(google (ireland|asia)|amazon web services|\baws\b|microsoft (ireland|corporation)|meta platforms|facebook ireland|linkedin|zoom video|atlassian|openai|anthropic)\b|foreign (consultant|service|vendor)|overseas (consultant|service|vendor)/,
    scope: "from a supplier located outside India", fcm: null, verify: true,
  },
  { key: "vessel", kind: "import", name: "Transport of imported goods by vessel from outside India", ref: "Section 5(3) IGST Act and Notification 10/2017-IT(R); the importer pays IGST", rate: 5, sac: null, words: /ocean freight|sea freight|bill of lading|\bvessel (charges|freight)/, scope: "the importer pays on freight billed by a foreign shipping line", fcm: null, verify: true },

  // goods: Notification 4/2017-CT(R) and section 9(4)
  { key: "cotton", kind: "goods", name: "Raw cotton from an agriculturist", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 5", rate: 5, words: /raw cotton|cotton (bale|bales)|\bkapas\b/, unregistered: true },
  { key: "cashew", kind: "goods", name: "Cashew nuts, not shelled or peeled, from an agriculturist", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 1", rate: 5, words: /raw cashew|cashew nuts? \(?(not|un)/, unregistered: true },
  { key: "tobacco", kind: "goods", name: "Tobacco leaves from an agriculturist", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 3", rate: 5, words: /tobacco leaves|tobacco leaf/, unregistered: true },
  { key: "tendu", kind: "goods", name: "Bidi wrapper leaves (tendu) from an agriculturist", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 2", rate: 18, words: /tendu|bidi wrapper/, unregistered: true },
  { key: "silk", kind: "goods", name: "Silk yarn from a manufacturer of silk yarn", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 4", rate: 5, words: /silk yarn/, unregistered: false, verify: true },
  { key: "lottery", kind: "goods", name: "Lottery supplied by a State Government or local authority", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 6", rate: 18, words: /lottery (ticket|tickets|distribution)/, unregistered: false, verify: true },
  { key: "govt_scrap", kind: "goods", name: "Used vehicles, seized goods, old and used goods, waste or scrap from the Government or a local authority", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), entry 7", rate: 18, words: /(auction|disposal|seized|confiscated).*(scrap|waste|used vehicle|old and used)|(scrap|waste|used vehicles?).*(auction|government|govt|railway|defence)/, unregistered: false, verify: true },
  { key: "pslc", kind: "goods", name: "Priority sector lending certificate", ref: "Section 9(3) CGST Act; Notification 4/2017-CT(R), as amended", rate: 18, words: /priority sector lending|\bpslc\b/, unregistered: false, verify: true },
  { key: "metal_scrap", kind: "goods", name: "Metal scrap from an unregistered supplier", ref: "Section 9(4) CGST Act; Notification 4/2017-CT(R) as amended (reverse charge on metal scrap supplied by an unregistered person)", rate: 18, words: /(metal|iron|steel|copper|aluminium|aluminum|brass|lead|zinc|ferrous) scrap|scrap (metal|iron|steel)/, unregistered: true, verify: true },
  { key: "promoter", kind: "goods", name: "Inward supply from an unregistered person to a real estate promoter", ref: "Section 9(4) CGST Act; Notification 7/2019-CT(R) (promoter's inward supplies from unregistered suppliers, cement in full and others under the 80% rule)", rate: 18, words: /\b(cement|tmt|steel bars?|sand|bricks?|aggregate|ready[- ]?mix)\b/, unregistered: true, promoter: true, verify: true },
];

const IMPORT_POS = /other country|outside india|foreign|^96\b|^96-/i;

/**
 * Finds the reverse-charge category a purchase falls in, from its description and supplier.
 * ctx: { sacs, registered (supplier has a valid GSTIN), promoter (the recipient is a real estate promoter), placeOfSupply }
 */
export function matchRcm(text, ctx = {}) {
  const t = String(text || "").toLowerCase();
  const sacs = (ctx.sacs || []).map(String);
  if (IMPORT_POS.test(String(ctx.placeOfSupply || ""))) return RCM_RULES.find((r) => r.key === "import");
  for (const r of RCM_RULES) {
    if (r.kind === "goods") {
      if (r.promoter && !ctx.promoter) continue;
      if (r.unregistered && ctx.registered) continue;
      if (r.words.test(t)) return r;
      continue;
    }
    if (r.key === "import" && ctx.registered) continue;
    if (r.key === "vessel" && ctx.registered) continue;
    if ((r.sac && sacs.some((c) => r.sac.test(c))) || r.words.test(t)) return r;
  }
  return null;
}
