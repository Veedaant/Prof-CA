import { api } from "@/lib/api";

export interface SentGroup {
  client_id: string;
  client_name: string;
  tax_period: string;
  return_type: "gstr1" | "gstr3b";
  count: number;
  latest: string;
}

/** What clients have sent to the CA firm, grouped by client, month and return, newest first. */
export async function sentGroups(): Promise<SentGroup[]> {
  const { requests } = await api.invoices.requests();
  const map = new Map<string, SentGroup>();
  for (const r of requests) {
    if (!r.invoice_id || !r.tax_period) continue;
    const rt = r.return_type === "gstr3b" || (!r.return_type && r.invoice_type === "purchase") ? "gstr3b" : "gstr1";
    const key = `${r.client_id}|${r.tax_period}|${rt}`;
    const g = map.get(key) || { client_id: r.client_id, client_name: r.client_name, tax_period: r.tax_period, return_type: rt, count: 0, latest: r.uploaded_at };
    g.count++;
    if (r.uploaded_at > g.latest) g.latest = r.uploaded_at;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => (a.latest < b.latest ? 1 : -1));
}
