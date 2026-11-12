import { r2, money, daysBetween } from "./common.js";

/**
 * The parties a client deals with, built from the invoices in the system (and the 26AS deductors), and the matching of
 * a bank narration or a ledger name to one of them, and of an amount to that party's invoices.
 */

const STOP = new Set(["PVT", "PRIVATE", "LTD", "LIMITED", "LLP", "THE", "AND", "CO", "COMPANY", "CORP", "CORPORATION", "INDIA", "INDIAN", "OF", "MS", "SHRI", "SMT", "MR", "MRS", "M", "S"]);
export const tokensOf = (name) => new Set(String(name || "").toUpperCase().replace(/&/g, " ").split(/[^A-Z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t)));

/** How well a text (a narration or a ledger name) names a party: the share of the party's words found, 0 when too little matches. */
export function nameScore(party, text) {
  const pt = party.tokens ?? tokensOf(party.name);
  if (!pt.size) return 0;
  const tt = text instanceof Set ? text : tokensOf(text);
  let hit = 0, long = 0;
  for (const t of pt) if (tt.has(t) || [...tt].some((x) => x.length >= 5 && t.length >= 5 && (x.startsWith(t) || t.startsWith(x)))) { hit++; if (t.length >= 5) long++; }
  if (!hit) return 0;
  if (pt.size === 1) return long ? 1 : 0;
  if (hit < 2 && !long) return 0;
  const ratio = hit / pt.size;
  return ratio >= 0.6 ? ratio : 0;
}

const sideOf = (inv) => {
  if (inv.invoice_type === "sales") return "sales";
  if (inv.invoice_type === "purchase") return "purchase";
  if (inv.invoice_type === "credit_note" || inv.invoice_type === "debit_note") return inv.return_type === "gstr3b" ? "purchase" : "sales";
  return null;
};

export function buildParties(invoices, deductors = []) {
  const map = new Map();
  const add = (name) => {
    const clean = String(name || "").replace(/\s+/g, " ").trim();
    if (!clean) return null;
    const k = [...tokensOf(clean)].sort().join("|") || clean.toUpperCase();
    if (!map.has(k)) map.set(k, { name: clean, tokens: tokensOf(clean), gstin: "", docs: [], tds: [] });
    return map.get(k);
  };
  for (const inv of invoices || []) {
    const side = sideOf(inv);
    if (!side) continue;
    const name = side === "sales" ? inv.buyer_name : inv.supplier_name;
    const p = add(name);
    if (!p) continue;
    p.gstin ||= (side === "sales" ? inv.buyer_gstin : inv.supplier_gstin) || "";
    const sign = inv.invoice_type === "credit_note" ? -1 : 1;
    p.docs.push({
      side, kind: inv.invoice_type, no: inv.invoice_number || "(no number)", date: String(inv.invoice_date || "").slice(0, 10),
      total: r2(sign * Number(inv.invoice_total || 0)), taxable: r2(sign * Number(inv.total_taxable_value || 0)),
    });
  }
  for (const d of deductors) {
    const p = add(d.name);
    if (p) p.tds.push(...(d.txns?.length ? d.txns.map((t) => ({ ...t, tan: d.tan })) : [{ section: "", date: null, amount: d.amount, tds: d.tds, tan: d.tan }]));
  }
  return [...map.values()];
}

export function findParty(parties, text, minScore = 0.6) {
  const tt = tokensOf(text);
  let best = null, bestScore = 0;
  for (const p of parties) {
    const s = nameScore(p, tt);
    if (s >= minScore && s > bestScore) { best = p; bestScore = s; }
  }
  return best;
}

const kindName = (d) => ({ sales: "sales invoice", purchase: "purchase invoice" }[d.side] || "invoice") + (d.kind === "credit_note" ? " (credit note)" : d.kind === "debit_note" ? " (debit note)" : "");
const dmy = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`; };
export const docText = (d) => `${kindName(d)} ${d.no} dt ${dmy(d.date)} (Rs ${money(d.total)})`;

const TDS_RATES = [0.001, 0.01, 0.02, 0.05, 0.1];

/** Which invoice(s) of a party an amount settles: one invoice, one net of TDS, or up to three together. */
export function matchDocs(party, side, amount, date) {
  const docs = party.docs.filter((d) => d.side === side && d.total > 0);
  if (!docs.length) return null;
  const near = [...docs].filter((d) => !d.date || !date || daysBetween(d.date, date) <= 45).sort((a, b) => Math.abs(daysBetween(a.date || date, date)) - Math.abs(daysBetween(b.date || date, date))).slice(0, 14);
  for (const d of near) if (Math.abs(d.total - amount) <= 1) return { docs: [d], how: "exact" };
  if (side === "sales") {
    for (const d of near) for (const rate of TDS_RATES) {
      const tds = r2(d.taxable * rate);
      if (tds > 0 && Math.abs(d.total - tds - amount) <= 1) return { docs: [d], how: "tds", tds, rate };
    }
  }
  for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
    if (Math.abs(near[i].total + near[j].total - amount) <= 1) return { docs: [near[i], near[j]], how: "sum" };
    for (let k = j + 1; k < near.length; k++) if (Math.abs(near[i].total + near[j].total + near[k].total - amount) <= 1) return { docs: [near[i], near[j], near[k]], how: "sum" };
  }
  return null;
}
