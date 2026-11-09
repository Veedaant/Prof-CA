import React, { useCallback, useEffect, useState } from "react";
import { Link, useRouter } from "@/lib/router";
import { Download, FileSpreadsheet, AlertTriangle, ShieldCheck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, Client, ExportRecord, Gstr3bPreviewDoc } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { PeriodPicker } from "@/components/PeriodPicker";
import { currentPeriod, periodLabel } from "@/lib/period";
import { SentGroup, sentGroups } from "@/lib/sent";
import { SentShortcuts } from "@/components/SentShortcuts";

const card = "bg-white border border-slate-200 rounded-2xl";
const inr = (n: number | undefined) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HEADS: [string, string][] = [["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST"], ["cess", "Cess"]];

type Result = Awaited<ReturnType<typeof api.exports.generateGSTR3B>>;
type Preview = Awaited<ReturnType<typeof api.exports.preview3B>>;

function SummaryTable({ summary }: { summary: Preview["summary"] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-4 font-medium">Figure</th>
            {HEADS.map(([, l]) => <th key={l} className="py-2 px-3 font-medium text-right">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {([
            ["Outward tax (3.1a)", summary.outward_tax],
            ["Net ITC available (4C)", summary.itc_net],
            ["Payable in cash", summary.cash_payable],
            ["ITC carried forward", summary.carry_forward],
          ] as [string, Record<string, number>][]).map(([label, row]) => (
            <tr key={label} className="border-b border-slate-100 last:border-0">
              <td className="py-2.5 pr-4 font-medium">{label}</td>
              {HEADS.map(([k]) => <td key={k} className="py-2.5 px-3 text-right tabular-nums">{inr(row[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DocTable({ title, note, docs, empty }: { title: string; note: string; docs: Gstr3bPreviewDoc[]; empty: string }) {
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="font-semibold">{title} ({docs.length})</h3>
        <p className="text-xs text-slate-500 mt-0.5">{note}</p>
      </div>
      {docs.length === 0 ? (
        <p className="p-6 text-sm text-slate-500">{empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-5 py-2.5 font-medium">Document</th>
                <th className="px-2 py-2.5 font-medium">Date</th>
                <th className="px-2 py-2.5 font-medium">Party</th>
                <th className="px-2 py-2.5 font-medium text-right">Taxable</th>
                <th className="px-2 py-2.5 font-medium text-right">Tax</th>
                <th className="px-5 py-2.5 font-medium text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id} className="border-t border-slate-100">
                  <td className="px-5 py-2.5">{d.type} <span className="font-medium">{d.number || "(no number)"}</span>{d.reverse_charge && <span className="ml-2 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-slate-100">RCM</span>}</td>
                  <td className="px-2 py-2.5 whitespace-nowrap">{d.date || "-"}</td>
                  <td className="px-2 py-2.5">{d.party || "-"}<div className="text-xs text-slate-400">{d.gstin}</div></td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{inr(d.taxable)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{inr(d.tax)}</td>
                  <td className="px-5 py-2.5 text-right tabular-nums font-medium">{inr(d.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Exports3bPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState<ExportRecord[]>([]);
  const [groups, setGroups] = useState<SentGroup[] | null>(null);
  const defaulted = React.useRef(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  const loadHistory = () => api.exports.history().then((h) => setHistory(h.filter((e) => e.export_type === "gstr3b"))).catch(() => {});
  useEffect(() => {
    if (!user) return;
    api.clients.list().then((c) => setClients(c)).catch(() => {});
    sentGroups().then(setGroups).catch(() => setGroups([]));
    loadHistory();
  }, [user]);

  useEffect(() => {
    if (defaulted.current || !clients.length || groups === null) return;
    defaulted.current = true;
    const g = groups.find((x) => x.return_type === "gstr3b") || groups[0];
    if (g) { setClientId(g.client_id); setPeriod(g.tax_period); } else setClientId(clients[0].id);
  }, [clients, groups]);

  const loadPreview = useCallback(() => {
    if (!clientId) return;
    api.exports.preview3B(clientId, period).then((p) => { setPreview(p); setError(null); }).catch((e) => { setPreview(null); setError(e.message); });
  }, [clientId, period]);
  useEffect(() => { setResult(null); setPreview(null); loadPreview(); }, [loadPreview]);

  const generate = async () => {
    if (!clientId) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.exports.generateGSTR3B(clientId, period);
      setResult(r);
      loadHistory();
      await api.exports.downloadFile(r.download_url, r.file_name);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
      loadPreview();
    }
  };

  const total = preview ? preview.outward.length + preview.inward.length : 0;
  const blocked = Boolean(preview && !preview.gate.ok);

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="GSTR-3B Export" subtitle="A GSTR-3B working in Excel, built from what the client has verified and sent" />
        <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
          <div className={`${card} p-6 space-y-5`}>
            <div className="flex items-start gap-3">
              <span className="w-10 h-10 rounded-xl bg-black text-white flex items-center justify-center shrink-0"><FileSpreadsheet className="w-5 h-5" /></span>
              <div>
                <h3 className="font-semibold">Generate GSTR-3B Excel</h3>
                <p className="text-sm text-slate-500">
                  Table 3.1 comes from the documents sent for GSTR-1 (sales and debit notes, less credit notes). Table 4 comes from the documents sent for GSTR-3B (purchases and debit notes, less credit notes).
                  Tax payable is worked out after setting off ITC. The file can be downloaded once the month has been verified against the client's ledger.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block min-w-[16rem]">
                <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
                <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-black">
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
                </select>
              </label>
              <div>
                <span className="block text-xs font-medium text-slate-600 mb-1">Return period</span>
                <PeriodPicker value={period} onChange={setPeriod} />
              </div>
              <button disabled={busy || !clientId || blocked || total === 0} onClick={generate} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
                <Download className="w-4 h-4" /> {busy ? "Preparing..." : "Generate & Download GSTR-3B Excel"}
              </button>
            </div>
            <SentShortcuts groups={groups} clientId={clientId} period={period} onPick={(g) => { setClientId(g.client_id); setPeriod(g.tax_period); }} />
            {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
            {blocked && preview && (
              <div className="p-4 rounded-xl border border-amber-200 bg-amber-50 text-amber-900 text-sm flex flex-wrap items-center justify-between gap-3">
                <span className="flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {preview.gate.message}</span>
                <Link href="/verify-3b" className="inline-flex items-center gap-1.5 font-semibold underline underline-offset-4"><ShieldCheck className="w-4 h-4" /> Open GSTR-3B Verification</Link>
              </div>
            )}
            {preview && !blocked && <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">Verified. The report can be generated.</div>}
          </div>

          {preview && (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-slate-600">
                <span><span className="font-semibold text-slate-900">{total}</span> document(s) sent by the client for {periodLabel(period)}</span>
                {preview.unsent > 0 && <span className="text-amber-700">{preview.unsent} more uploaded but not yet sent by the client</span>}
                {preview.duplicates > 0 && <span>{preview.duplicates} duplicate(s) left out</span>}
              </div>

              <div className={`${card} p-6 space-y-3`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">Draft figures - {periodLabel(period)}</h3>
                  <span className="text-xs text-slate-500">{blocked ? "Draft - not verified yet" : "Verified"}</span>
                </div>
                <SummaryTable summary={preview.summary} />
              </div>

              <DocTable title="Purchase side - documents sent for GSTR-3B" note="Feeds Table 4 (eligible ITC): purchase invoices and debit notes add, credit notes reduce." docs={preview.inward} empty="The client has not sent any purchase invoices, credit notes or debit notes for GSTR-3B in this month." />
              <DocTable title="Sales side - documents sent for GSTR-1" note="Feeds Table 3.1 (outward supplies): sales invoices and debit notes add, credit notes reduce." docs={preview.outward} empty="The client has not sent any sales documents for GSTR-1 in this month." />
            </>
          )}

          {result && (
            <div className={`${card} p-6 space-y-4`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold">Generated: {result.file_name}</h3>
                <span className="text-xs text-slate-500">{result.outward_documents} GSTR-1 document(s) · {result.inward_documents} GSTR-3B document(s)</span>
              </div>
              {result.warning && (
                <div className="flex gap-2 p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-sm"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {result.warning}</div>
              )}
              <p className="text-xs text-slate-500">This is a working, not the filed return. Zero-rated supplies, blocked credits and opening ITC are not captured; see the Notes sheet in the file.</p>
            </div>
          )}

          <div className={`${card} p-6`}>
            <h3 className="font-semibold mb-3">Generated GSTR-3B files</h3>
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">No GSTR-3B files generated yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {history.map((h) => (
                  <li key={h.id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{h.file_name}</p>
                      <p className="text-xs text-slate-500">{h.client_name} · {periodLabel(h.tax_period)} · {h.invoice_count} document(s) · {new Date(h.created_at).toLocaleString()}</p>
                    </div>
                    <button onClick={() => h.download_url && api.exports.downloadFile(h.download_url, h.file_name).catch((e) => setError(e.message))} className="inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-4">
                      <Download className="w-4 h-4" /> Download .xlsx
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
