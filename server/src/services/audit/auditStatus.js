import { db } from "../../db/index.js";
import { monthLabel } from "../banking/common.js";
import { CATEGORIES } from "./requirementReader.js";

/**
 * Whether each document of an audit checklist is in hand. A document is in hand when the client has uploaded it against the checklist,
 * when the CA firm has marked it, or when the system already holds it from another section: a bank statement given under Banking,
 * a loan sanction letter or repayment schedule given under Banking, a GST return on file, the invoices uploaded for a month, Form 26AS.
 * It is worked out each time the checklist is read, so a document given anywhere shows as received.
 */

/** What the client has given elsewhere in the system, read once for a whole checklist. */
export async function loadAuditSources({ firmId, clientId }) {
  const [subs, recon, output, invoices, staff] = await Promise.all([
    db.query("select s.id, s.section, s.account_number, s.bank_name, s.fy, s.period_from, s.period_to, (select array_agg(f.kind) from banking_files f where f.submission_id=s.id) as kinds from banking_submissions s where s.firm_id=$1 and s.client_id=$2", [firmId, clientId]),
    db.query("select kind, period from input_recon_files where firm_id=$1 and client_id=$2 and kind in ('gstr3b','gstr2b') and period is not null", [firmId, clientId]),
    db.query("select kind, period from output_files where client_id=$1 and kind in ('gstr1','gstr3b') and period is not null", [clientId]),
    db.query("select invoice_type, tax_period, count(*)::int as n from invoices where firm_id=$1 and client_id=$2 and replaced_at is null and review_status <> 'rejected' and tax_period is not null group by invoice_type, tax_period", [firmId, clientId]),
    db.query("select kind, fy from banking_staff_files where firm_id=$1 and client_id=$2 and kind in ('form_26as','tis')", [firmId, clientId]),
  ]);
  return { subs: subs.map((s) => ({ ...s, kinds: s.kinds || [] })), recon, output, invoices, staff };
}

const accKey = (s) => String(s || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
/** Equal, or one is the tail of the other (a masked number such as xxxx1234 names the account by its last digits). */
const sameAccount = (a, b) => { a = accKey(a); b = accKey(b); return Boolean(a && b) && (a === b || (a.length >= 4 && b.endsWith(a)) || (b.length >= 4 && a.endsWith(b))); };
const sameBank = (a, b) => { a = String(a || "").toLowerCase().trim(); b = String(b || "").toLowerCase().trim(); return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a)); };
const mask = (a) => (String(a || "").length > 4 ? `xxxx${String(a).slice(-4)}` : String(a || ""));

/** Is the document already held? Returns { source, detail } or null. */
export function heldElsewhere(item, src) {
  const t = String(item.name || "").toLowerCase();
  const month = item.period_kind === "month" ? item.period : null;
  switch (item.category) {
    case "bank_statement": {
      if (!month) return null;
      const s = src.subs.find((x) => x.section === "statement" && x.kinds.includes("statement")
        && (item.account_number ? sameAccount(x.account_number, item.account_number) : item.bank_name ? sameBank(x.bank_name, item.bank_name) : true)
        && x.period_from && x.period_to && x.period_from <= month && month <= x.period_to);
      return s ? { source: "Banking", detail: `${s.bank_name} ${mask(s.account_number)}, ${monthLabel(s.period_from)} to ${monthLabel(s.period_to)}` } : null;
    }
    case "loan": {
      const need = /sanction/.test(t) ? ["sanction_letter"] : /repayment|emi/.test(t) ? ["repayment_schedule"] : [];
      const s = src.subs.find((x) => x.section === "loan" && x.fy === item.fy && need.every((k) => x.kinds.includes(k))
        && (item.account_number ? sameAccount(x.account_number, item.account_number) : item.bank_name ? sameBank(x.bank_name, item.bank_name) : true));
      return s ? { source: "Banking", detail: `${s.bank_name} loan ${mask(s.account_number)}` } : null;
    }
    case "gst_return": {
      if (!month) return null;
      if (/gstr[- ]?9|annual return|\b9c\b/.test(t)) return null;
      const named = [/gstr[- ]?1\b|gst[- ]?1\b/.test(t) && "gstr1", /3b/.test(t) && "gstr3b", /2b/.test(t) && "gstr2b"].filter(Boolean);
      const has = (k) => (k === "gstr1" ? src.output.some((o) => o.kind === "gstr1" && o.period === month)
        : k === "gstr3b" ? src.recon.some((o) => o.kind === "gstr3b" && o.period === month) || src.output.some((o) => o.kind === "gstr3b" && o.period === month)
          : src.recon.some((o) => o.kind === "gstr2b" && o.period === month));
      const names = { gstr1: "GSTR-1", gstr3b: "GSTR-3B", gstr2b: "GSTR-2B" };
      const kinds = named.length ? named : ["gstr3b", "gstr1"].filter(has).slice(0, 1);
      if (!kinds.length || !kinds.every(has)) return null;
      return { source: "GST returns on file", detail: `${kinds.map((k) => names[k]).join(" and ")} for ${monthLabel(month)}` };
    }
    case "invoices": {
      if (!month) return null;
      const types = /sales|outward/.test(t) ? ["sales"] : /purchase|inward/.test(t) ? ["purchase"] : null;
      const n = src.invoices.filter((i) => i.tax_period === month && (!types || types.includes(i.invoice_type))).reduce((a, i) => a + i.n, 0);
      return n ? { source: "Invoices uploaded", detail: `${n} invoice(s) for ${monthLabel(month)}` } : null;
    }
    case "form26as": {
      const kinds = /26as/.test(t) ? ["form_26as"] : /\btis\b|\bais\b|information/.test(t) ? ["tis"] : ["form_26as", "tis"];
      const f = src.staff.find((x) => x.fy === item.fy && kinds.includes(x.kind));
      return f ? { source: "Banking", detail: f.kind === "form_26as" ? "Form 26AS on file" : "TIS on file" } : null;
    }
    default:
      return null;
  }
}

/** The state of every item: { ...item, status: received | pending | na, source, detail, files }. */
export function itemStates({ items, files, src, fy }) {
  return items.map((it) => {
    const mine = files.filter((f) => f.item_id === it.id);
    const base = { ...it, fy, files: mine };
    if (it.manual === "na") return { ...base, status: "na", source: "Not applicable", detail: "Marked by the CA firm" };
    if (mine.length) return { ...base, status: "received", source: "Audit Documents", detail: `${mine.length} file(s) uploaded` };
    if (it.manual === "received") return { ...base, status: "received", source: "CA firm", detail: "Marked as received by the CA firm" };
    const held = heldElsewhere(base, src);
    if (held) return { ...base, status: "received", source: held.source, detail: held.detail };
    return { ...base, status: "pending", source: "", detail: "" };
  });
}

/**
 * The audit programme: each point with its status (pending, checked, query) and the thread of queries and replies kept against it.
 * awaiting says who has to act on a point that has a query: the client when the CA firm asked last, the CA firm when the client replied last.
 */
export function programmeStates(points, queries) {
  const byPoint = new Map();
  for (const q of queries) {
    if (!q.point_id) continue;
    if (!byPoint.has(q.point_id)) byPoint.set(q.point_id, []);
    byPoint.get(q.point_id).push({ id: q.id, role: q.author_role, by: q.author_name, body: q.body, at: q.created_at });
  }
  return points.map((p) => {
    const thread = byPoint.get(p.id) || [];
    const last = thread[thread.length - 1];
    return {
      id: p.id, seq: p.seq, ref: p.ref || "", section: p.section || "", name: p.name, detail: p.detail || "", status: p.status, statusBy: p.status_by || null, statusAt: p.status_at || null,
      queries: thread, awaiting: p.status === "query" ? (last ? (last.role === "client" ? "staff" : "client") : "staff") : null,
    };
  });
}

export function programmeTotals(points) {
  const count = (f) => points.filter(f).length;
  return {
    points: points.length, checked: count((p) => p.status === "checked"), pending: count((p) => p.status === "pending"), query: count((p) => p.status === "query"),
    awaitingClient: count((p) => p.awaiting === "client"), awaitingStaff: count((p) => p.awaiting === "staff" && p.queries.length > 0),
  };
}

/** Consecutive months as ranges: Apr-25 to Jun-25, Aug-25. */
export function monthRanges(periods) {
  const idx = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1;
  const out = [];
  let run = [];
  const flush = () => { if (run.length) out.push(run.length === 1 ? monthLabel(run[0]) : run.length === 2 ? `${monthLabel(run[0])}, ${monthLabel(run[1])}` : `${monthLabel(run[0])} to ${monthLabel(run[run.length - 1])}`); run = []; };
  for (const m of [...new Set(periods.filter(Boolean))].sort()) {
    if (run.length && idx(m) === idx(run[run.length - 1]) + 1) run.push(m);
    else { flush(); run = [m]; }
  }
  flush();
  return out;
}

/** The checklist by document: how many periods of each are asked for, in hand and pending, and which periods remain. */
export function summarise(states) {
  const groups = new Map();
  for (const s of states) {
    const key = `${s.req_no}|${s.account_number || ""}|${s.bank_name || ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, reqNo: s.req_no, section: s.section, name: s.name, category: s.category, categoryLabel: CATEGORIES[s.category] || CATEGORIES.other, account: s.account_number || "", bank: s.bank_name || "", periodKind: s.period_kind, note: s.note || "", total: 0, received: 0, pending: 0, na: 0, pendingPeriods: [], pendingLabels: [], itemIds: [] };
      groups.set(key, g);
    }
    g.total++; g[s.status === "received" ? "received" : s.status === "na" ? "na" : "pending"]++;
    g.itemIds.push(s.id);
    if (s.status === "pending") { g.pendingPeriods.push(s.period); g.pendingLabels.push(s.period_label); }
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    pendingText: g.pending ? (g.periodKind === "month" ? monthRanges(g.pendingPeriods).join(", ") : g.pendingLabels.join(", ")) : "",
    state: g.pending === 0 ? "complete" : g.received + g.na > 0 ? "partial" : "pending",
  }));
  const count = (k) => states.filter((s) => s.status === k).length;
  const bySource = {};
  for (const s of states.filter((x) => x.status === "received")) bySource[s.source] = (bySource[s.source] || 0) + 1;
  return { groups: list, totals: { items: states.length, received: count("received"), pending: count("pending"), na: count("na"), documents: list.length, documentsPending: list.filter((g) => g.pending > 0).length }, bySource };
}
