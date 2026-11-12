import { db } from "../../db/index.js";
import { normName } from "../recon/sheetParser.js";
import { readStatement } from "../banking/statementReader.js";
import { parsedFile } from "../banking/data.js";
import { nameScore, tokensOf } from "../banking/parties.js";

/**
 * The nature of the services or goods bought from a party, worked out from every document the system holds for that party:
 * what the register says, the descriptions on the party's invoices, the party's other register lines, the bank ledger and the
 * bank statements, and, last, the party's name. Each answer says where it came from.
 */

// words that point to a kind of expense; the first that matches names the nature
const NATURES = [
  ["Goods transport / freight", /freight|transport|roadways|roadlines|logistic|cargo|courier|carrier|lorry|truck|tempo|cartage/i],
  ["Rent", /\brent\b|\blease\b|rental/i],
  ["Professional / legal / consultancy fees", /professional|advocate|legal|audit|consult|retainer|chartered|solicitor|counsel/i],
  ["Repairs and maintenance", /repair|maintenance|\bamc\b|servicing|service charges/i],
  ["Insurance", /insurance|premium/i],
  ["Advertisement and promotion", /advertis|marketing|promotion|hoarding|branding/i],
  ["Telephone and internet", /telephone|mobile bill|broadband|internet|airtel|jio|vodafone|bsnl|\bvi\b/i],
  ["Electricity", /electricity|power bill|msedcl|bescom|tata power|adani electricity/i],
  ["Travel and conveyance", /travel|taxi|\bcab\b|flight|airline|hotel|ticket|makemytrip|uber|\bola\b/i],
  ["Stationery and printing", /stationery|printing|printers|paper/i],
  ["Software and IT services", /software|\bit services|cloud|hosting|saas|subscription|licen[cs]e|infotech|technolog/i],
  ["Manpower, security and housekeeping", /security|manpower|housekeeping|labour|contractor|staffing/i],
  ["Commission / brokerage", /commission|brokerage|broker/i],
  ["Packing material", /packing|packaging|carton|\bbox\b/i],
  ["Construction / works contract", /construction|civil|works contract|builders|contractors/i],
  ["Food and catering", /food|catering|canteen|restaurant|caterer/i],
  ["Fuel", /fuel|petrol|diesel|\bhp\b|bpcl|iocl|petroleum/i],
  ["Raw material and goods", /steel|cement|chemical|fabric|yarn|metal|plastics?/i],
];
export const classifyNature = (text) => NATURES.find(([, re]) => re.test(String(text || "")))?.[0] || null;

// the first four digits of a SAC code
const SAC = {
  9954: "Construction services", 9965: "Goods transport services", 9966: "Rental of transport vehicles", 9967: "Supporting transport services (warehousing, cargo handling)",
  9971: "Financial and related services", 9972: "Real estate services", 9973: "Leasing or rental services", 9981: "Research and development services",
  9982: "Legal and accounting services", 9983: "Other professional, technical and business services", 9984: "Telecommunication and IT services",
  9985: "Support services (manpower, security, travel agency)", 9986: "Support services to agriculture", 9987: "Maintenance and repair services", 9988: "Job work (manufacturing services on physical inputs)",
  9989: "Other manufacturing services", 9992: "Education services", 9993: "Health care services", 9995: "Services of membership organisations", 9996: "Recreational and cultural services",
};

const tidy = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const top = (counts, n = 1) => [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, n).map(([, v]) => v.text);

/** The purchase invoices and bank entries held for the client, read once for a whole workbook. */
export async function loadNatureSources({ firmId, clientId }) {
  const invoices = await db.query(
    `select i.supplier_name, i.supplier_gstin, i.invoice_number, l.description, l.hsn_sac
       from invoices i left join line_items l on l.invoice_id=i.id
      where i.firm_id=$1 and i.client_id=$2 and i.replaced_at is null and i.review_status <> 'rejected' and i.invoice_type in ('purchase','debit_note','credit_note')`,
    [firmId, clientId],
  );
  const narrations = [];
  const files = await db.query(
    "select f.* from banking_files f join banking_submissions s on s.id=f.submission_id where s.firm_id=$1 and s.client_id=$2 and f.kind='statement'",
    [firmId, clientId],
  );
  for (const f of files) {
    const r = await parsedFile(f, readStatement);
    for (const t of r.parsed?.txns || []) if (t.narration) narrations.push({ text: t.narration, from: "the bank statements" });
  }
  const ledgers = await db.query("select parsed from banking_staff_files where firm_id=$1 and client_id=$2 and kind='bank_ledger'", [firmId, clientId]);
  for (const l of ledgers) for (const e of l.parsed?.entries || []) narrations.push({ text: `${e.party} ${e.narration}`, from: "the bank ledger" });
  return { invoices, narrations };
}

/**
 * Returns resolve(party, gstin, own) -> { nature, source }. `own` is the nature the register itself gives, if any;
 * a "nature" that is only the party's name is not a nature and is ignored.
 */
export function makeNatureResolver({ sources, registerRows = [] }) {
  const invoices = sources.invoices.map((i) => ({ ...i, tokens: tokensOf(i.supplier_name) }));
  const narrations = sources.narrations.map((n) => ({ ...n, tokens: tokensOf(n.text) }));
  const samePartyNature = new Map(); // party key -> Map(nature -> {text, n})
  const keyOf = (party, gstin) => (gstin ? `G${gstin}` : `N${normName(party)}`);
  for (const r of registerRows) {
    const nat = tidy(r.nature);
    if (!nat || normName(nat) === normName(r.party)) continue;
    const k = keyOf(r.party, r.gstin);
    const m = samePartyNature.get(k) || samePartyNature.set(k, new Map()).get(k);
    const e = m.get(nat.toLowerCase()) || m.set(nat.toLowerCase(), { text: nat, n: 0 }).get(nat.toLowerCase());
    e.n++;
  }
  const cache = new Map();

  return function resolve(party, gstin, own) {
    const ownText = tidy(own);
    const key = `${keyOf(party, gstin)}|${ownText}`;
    if (cache.has(key)) return cache.get(key);
    const done = (nature, source) => { const out = { nature, source }; cache.set(key, out); return out; };

    if (ownText && normName(ownText) !== normName(party)) return done(ownText, "As per the register");

    const p = { tokens: tokensOf(party) };
    // 1. the party's invoices in the system
    const inv = invoices.filter((i) => (gstin && i.supplier_gstin === gstin) || (p.tokens.size && nameScore(p, i.tokens) >= 0.6));
    if (inv.length) {
      const desc = new Map();
      for (const i of inv) {
        const d = tidy(i.description);
        if (d.length < 3 || /^[\d\s.,/-]+$/.test(d)) continue;
        const e = desc.get(d.toLowerCase()) || desc.set(d.toLowerCase(), { text: d.length > 70 ? `${d.slice(0, 67)}...` : d, n: 0 }).get(d.toLowerCase());
        e.n++;
      }
      const nos = [...new Set(inv.map((i) => i.invoice_number).filter(Boolean))].slice(0, 3).join(", ");
      if (desc.size) return done(top(desc, 2).join("; "), `Invoices in the system${nos ? ` (${nos})` : ""}`);
      const sac = new Map();
      for (const i of inv) { const label = SAC[String(i.hsn_sac || "").slice(0, 4)]; if (label) { const e = sac.get(label) || sac.set(label, { text: label, n: 0 }).get(label); e.n++; } }
      if (sac.size) return done(top(sac)[0], `SAC code on the invoices in the system${nos ? ` (${nos})` : ""}`);
    }
    // 2. the same party's other lines in the ITC register
    const others = samePartyNature.get(keyOf(party, gstin));
    if (others?.size) return done(top(others)[0], "Other lines of this party in the ITC register");
    // 3. bank ledger and bank statements that name the party
    const heard = new Map();
    const from = new Set();
    if (p.tokens.size) {
      for (const n of narrations) {
        if (nameScore(p, n.tokens) < 0.6) continue;
        const label = classifyNature(n.text.replace(new RegExp(party.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " "));
        if (!label) continue;
        const e = heard.get(label) || heard.set(label, { text: label, n: 0 }).get(label);
        e.n++; from.add(n.from);
      }
    }
    if (heard.size) return done(top(heard)[0], `Entries naming this party in ${[...from].join(" and ")}`);
    // 4. the party's own name
    const named = classifyNature(party);
    if (named) return done(named, "Inferred from the party's name");
    return done("", "Not available in the system");
  };
}
