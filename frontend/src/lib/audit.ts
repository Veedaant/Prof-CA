import type { AuditChecklist, AuditGroup, AuditPoint } from "@/lib/api";

/** Helpers the audit checklist pages share. */

export const maskAccount = (a: string) => (a.length > 4 ? `xxxx${a.slice(-4)}` : a);

/** The bank and account of a document, when it has them: "HDFC Bank xxxx6789". */
export const bankLine = (g: Pick<AuditGroup, "bank" | "account">) => [g.bank, g.account && maskAccount(g.account)].filter(Boolean).join(" ");

/** The documents of a checklist grouped under the headings of the sheet, in the order of the sheet. */
export function bySection(groups: AuditGroup[]): { section: string; groups: AuditGroup[] }[] {
  const out: { section: string; groups: AuditGroup[] }[] = [];
  for (const g of [...groups].sort((a, b) => a.reqNo - b.reqNo)) {
    const last = out[out.length - 1];
    if (last && last.section === g.section) last.groups.push(g);
    else out.push({ section: g.section, groups: [g] });
  }
  return out;
}

/** The points of the audit programme grouped under the headings of the sheet, in the order of the sheet. */
export function pointsBySection(points: AuditPoint[]): { section: string; points: AuditPoint[] }[] {
  const out: { section: string; points: AuditPoint[] }[] = [];
  for (const p of [...points].sort((a, b) => a.seq - b.seq)) {
    const last = out[out.length - 1];
    if (last && last.section === p.section) last.points.push(p);
    else out.push({ section: p.section, points: [p] });
  }
  return out;
}

/** The checklist as the client sees it: what the CA firm marked as not applicable is left out. */
export function clientView(c: AuditChecklist) {
  const states = c.states.filter((s) => s.status !== "na");
  const live = new Set(states.map((s) => s.id));
  const groups = c.summary.groups
    .map((g) => ({ ...g, itemIds: g.itemIds.filter((id) => live.has(id)), total: g.total - g.na, na: 0 }))
    .filter((g) => g.total > 0);
  const totals = {
    items: states.length,
    uploaded: states.filter((s) => s.status === "received").length,
    pending: states.filter((s) => s.status === "pending").length,
    documents: groups.length,
    documentsPending: groups.filter((g) => g.pending > 0).length,
  };
  return { states, groups, totals };
}

export const dayOf = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");
export const timeOf = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
