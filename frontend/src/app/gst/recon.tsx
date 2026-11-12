import React, { useCallback, useEffect, useState } from "react";
import { api, Client, OutputStatus, ReconColumn, ReconFile, ReconKind, ReconReport, ReconSection } from "@/lib/api";
import { PeriodPicker } from "@/components/PeriodPicker";
import { BatchPicker } from "@/components/BatchPicker";
import { currentPeriod, periodLabel } from "@/lib/period";
import { Upload, Download, Trash2, ChevronDown, ChevronUp, FileText, Pencil } from "lucide-react";

const input = "w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black";
const card = "bg-white border border-slate-200 rounded-2xl shadow-sm";
const btn = "inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800 disabled:opacity-40";
const btn2 = "inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40";
const num = (n: any) => Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function fyStart(period: string) {
  const [y, m] = period.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

const KIND_LABEL: Record<string, string> = { gstr1_portal: "GSTR-1 (portal Excel)", gstr2b: "GSTR-2B (portal Excel)", gstr3b: "GSTR-3B (PDF)", sales_ledger: "Sales ledger", purchase_ledger: "Purchase ledger" };
const HEAD_FILES: Record<string, ReconKind[]> = {
  gstr3b: ["gstr3b"],
  output: ["gstr1_portal", "gstr3b"],
  input: ["gstr3b", "gstr2b"],
  gstr9: ["gstr1_portal", "gstr3b", "gstr2b"],
  gstr9c: ["gstr1_portal", "gstr3b", "gstr2b"],
};
const HEAD_INFO: Record<string, string> = {
  gstr3b: "GSTR-3B working compiled from the client's approved sales, purchases and ledgers, month by month.",
  output: "Books (approved invoices + client sales ledgers) are matched with the GSTR-1 downloaded from the portal, then with GSTR-3B Table 3.1, month-wise, rate-wise and party-wise.",
  input: "Purchase books are compiled to ITC, matched with the GSTR-3B PDF, then with GSTR-2B (month-wise and party-wise).",
  gstr9: "Annual return working for the financial year, built from books, GSTR-1, GSTR-3B and GSTR-2B.",
  gstr9c: "Reconciliation statement working for the financial year: turnover, taxable turnover, rate-wise liability and ITC.",
};

/* ---------------------------------------------------------------- tables */

function Cell({ c, v }: { c: ReconColumn; v: any }) {
  if (v === null || v === undefined || v === "") return <span className="text-slate-300">{c.type === "money" ? "-" : ""}</span>;
  if (c.type === "money") {
    const n = Number(v);
    return <span className={c.diff && Math.abs(n) > 1 ? "text-rose-600 font-semibold" : ""}>{num(n)}</span>;
  }
  if (c.type === "status") {
    const good = ["Matched", "Yes", "low"].includes(String(v));
    const bad = ["Difference", "high"].includes(String(v));
    const cls = bad ? "bg-rose-50 text-rose-700 border-rose-200" : good ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-600 border-slate-200";
    return <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>{String(v)}</span>;
  }
  if (c.type === "period") return <span className="whitespace-nowrap">{/^\d{4}-\d{2}$/.test(String(v)) ? periodLabel(String(v)) : String(v)}</span>;
  if (c.type === "long") return <span className="block min-w-[18rem] max-w-md text-xs text-slate-600 whitespace-normal">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function SectionTable({ s, defaultOpen }: { s: ReconSection; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={card}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="font-semibold text-sm">{s.title}</span>
        <span className="flex items-center gap-2 text-xs text-slate-500">{s.rows.length} rows {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</span>
      </button>
      {open && (
        <div className="border-t border-slate-100">
          {s.note && <p className="px-4 pt-3 text-xs text-slate-500">{s.note}</p>}
          {s.rows.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">No data for this section.</p>
          ) : (
            <div className="overflow-x-auto max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                    {s.columns.map((c) => <th key={c.key} className={`px-3 py-2.5 font-medium whitespace-nowrap ${c.type === "money" || c.type === "int" ? "text-right" : ""}`}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {s.rows.slice(0, 1000).map((r, i) => (
                    <tr key={i} className={`border-b border-slate-100 last:border-0 align-top ${r._total ? "font-semibold bg-slate-50" : ""}`}>
                      {s.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${c.type === "money" || c.type === "int" ? "text-right tabular-nums" : ""}`}><Cell c={c} v={r[c.key]} /></td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------ GSTR-3B figures */

const OUT_ROWS: [string, string][] = [["a", "3.1(a) Outward taxable"], ["b", "3.1(b) Zero rated"], ["c", "3.1(c) Nil / exempt"], ["d", "3.1(d) Inward RCM"], ["e", "3.1(e) Non-GST"]];
const ITC_ROWS: [string, string][] = [["import_goods", "4A(1) Import of goods"], ["import_services", "4A(2) Import of services"], ["rcm", "4A(3) RCM"], ["isd", "4A(4) ISD"], ["other", "4A(5) All other ITC"], ["reversed_rules", "4B(1) Reversed - rules 38,42,43"], ["reversed_others", "4B(2) Reversed - others"]];

function FiguresEditor({ file, onClose, onSaved }: { file: ReconFile; onClose: () => void; onSaved: () => void }) {
  const [fig, setFig] = useState<any>(JSON.parse(JSON.stringify(file.figures)));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (grp: string, k: string, f: string, v: string) => setFig((p: any) => ({ ...p, [grp]: { ...p[grp], [k]: { ...p[grp][k], [f]: v } } }));
  const save = async () => {
    setBusy(true);
    try { await api.recon.saveFigures(file.id, fig); onSaved(); onClose(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const cell = (grp: string, k: string, f: string) => (
    <td key={f} className="px-1 py-1"><input type="number" step="0.01" value={fig[grp][k][f] ?? 0} onChange={(e) => set(grp, k, f, e.target.value)} className="w-28 px-2 py-1 rounded border border-slate-300 text-sm text-right" /></td>
  );
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-auto p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <h3 className="font-semibold">GSTR-3B figures - {file.tax_period && periodLabel(file.tax_period)}</h3>
          <p className="text-xs text-slate-500">Read automatically from the PDF - please check against the return and correct any figure.</p>
        </div>
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-500 text-left"><th className="py-1">3.1 Outward / inward</th>{["Taxable", "IGST", "CGST", "SGST", "Cess"].map((h) => <th key={h} className="text-right px-2">{h}</th>)}</tr></thead>
          <tbody>{OUT_ROWS.map(([k, l]) => <tr key={k}><td>{l}</td>{["taxable", "igst", "cgst", "sgst", "cess"].map((f) => cell("outward", k, f))}</tr>)}</tbody>
        </table>
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-slate-500 text-left"><th className="py-1">4. ITC</th>{["IGST", "CGST", "SGST", "Cess"].map((h) => <th key={h} className="text-right px-2">{h}</th>)}</tr></thead>
          <tbody>{ITC_ROWS.map(([k, l]) => <tr key={k}><td>{l}</td>{["igst", "cgst", "sgst", "cess"].map((f) => cell("itc", k, f))}</tr>)}</tbody>
        </table>
        {err && <p className="text-sm text-rose-600">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className={btn2}>Cancel</button>
          <button onClick={save} disabled={busy} className={btn}>{busy ? "Saving..." : "Save figures"}</button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- file panel */

function FilesPanel({ clientId, kinds, defaultPeriod, periods, onChanged }: { clientId: string; kinds: ReconKind[]; defaultPeriod: string; periods: string[]; onChanged: () => void }) {
  const [files, setFiles] = useState<ReconFile[]>([]);
  const [kind, setKind] = useState<ReconKind>(kinds[0]);
  const [period, setPeriod] = useState(defaultPeriod);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [edit, setEdit] = useState<ReconFile | null>(null);
  const load = useCallback(() => { if (clientId) api.recon.files(clientId).then(setFiles).catch((e) => setMsg({ ok: false, text: e.message })); }, [clientId]);
  useEffect(load, [load]);
  useEffect(() => setPeriod(defaultPeriod), [defaultPeriod]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;
    setBusy(true); setMsg(null);
    try {
      const res = await api.recon.upload(list, kind, clientId, period);
      const warn = res.map((r) => r.warning).filter(Boolean).join(" ");
      setMsg({ ok: !warn, text: `Uploaded ${res.map((r) => `${r.original_filename} (${r.tax_period ? periodLabel(r.tax_period) : "all periods"}, ${r.row_count} ${kind === "gstr3b" ? "lines read" : "rows"})`).join(", ")}.${warn ? " " + warn : ""}` });
      load(); onChanged();
    } catch (er: any) {
      setMsg({ ok: false, text: er.message });
    } finally { setBusy(false); }
  };
  const remove = async (id: string) => { await api.recon.remove(id); load(); onChanged(); };
  const inRange = files.filter((f) => ["gstr1_portal", "gstr2b", "gstr3b"].includes(f.kind) && f.tax_period && periods.includes(f.tax_period) && kinds.includes(f.kind as ReconKind));

  return (
    <div className={`${card} p-5 space-y-4`}>
      <div>
        <h3 className="font-semibold text-sm">Portal files</h3>
        <p className="text-xs text-slate-500">Upload one file per month. GSTR-1 and GSTR-2B Excel files are as downloaded from the GST portal; GSTR-3B is the PDF. A new upload for the same month replaces the old one.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-slate-600 mb-1">File type</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ReconKind)} className={input}>{kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </label>
        <div>
          <span className="block text-xs font-medium text-slate-600 mb-1">Month{kind === "gstr3b" ? " (read from PDF if blank)" : ""}</span>
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
        <label className={`${btn} cursor-pointer ${busy ? "opacity-40 pointer-events-none" : ""}`}>
          <Upload className="w-4 h-4" /> {busy ? "Uploading..." : "Choose file"}
          <input type="file" className="hidden" accept=".xlsx,.xlsm,.xls,.xlsb,.csv" multiple={kind === "gstr3b"} onChange={pick} />
        </label>
      </div>
      {kind === "gstr3b" && <p className="text-xs text-slate-500">For GSTR-3B the month is read from the PDF itself; the month selected above is used only if it cannot be read.</p>}
      {msg && <p className={`text-sm rounded-lg px-3 py-2 border ${msg.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800"}`}>{msg.text}</p>}
      {inRange.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-2 pr-3 font-medium">Month</th><th className="pr-3 font-medium">Type</th><th className="pr-3 font-medium">File</th><th className="pr-3 font-medium text-right">Rows / lines</th><th /></tr></thead>
            <tbody>
              {inRange.sort((a, b) => (a.tax_period! + a.kind).localeCompare(b.tax_period! + b.kind)).map((f) => (
                <tr key={f.id} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap">{periodLabel(f.tax_period!)}</td>
                  <td className="pr-3 whitespace-nowrap">{KIND_LABEL[f.kind]}</td>
                  <td className="pr-3 truncate max-w-[16rem]"><FileText className="inline w-3.5 h-3.5 mr-1 text-slate-400" />{f.original_filename}</td>
                  <td className="pr-3 text-right">{f.kind === "gstr3b" ? `${f.meta?.found ?? "?"}/${f.meta?.expected ?? 10}${f.meta?.edited ? " edited" : ""}` : f.row_count}</td>
                  <td className="text-right whitespace-nowrap">
                    {f.kind === "gstr3b" && <button onClick={() => setEdit(f)} className="p-1.5 hover:text-black text-slate-500" title="Check / edit figures"><Pencil className="w-4 h-4" /></button>}
                    <button onClick={() => remove(f.id)} className="p-1.5 text-slate-500 hover:text-rose-600" title="Delete"><Trash2 className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <FiguresEditor file={edit} onClose={() => setEdit(null)} onSaved={() => { load(); onChanged(); }} />}
    </div>
  );
}

/* ------------------------------------------------------------ main head */

export function ReconHead(props: { head: string; clients: Client[]; clientId: string; setClientId: (v: string) => void }) {
  return props.head === "output" ? <OutputHead {...props} /> : <ReconHeadGeneric {...props} />;
}

function ReconHeadGeneric({ head, clients, clientId, setClientId }: { head: string; clients: Client[]; clientId: string; setClientId: (v: string) => void }) {
  const annual = head === "gstr9" || head === "gstr9c";
  const cur = currentPeriod();
  const [from, setFrom] = useState(`${fyStart(cur)}-04`);
  const [to, setTo] = useState(cur);
  const [fy, setFy] = useState(String(fyStart(cur)));
  const [fin, setFin] = useState("");
  const [report, setReport] = useState<ReconReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const params = (): Record<string, string> => {
    const p: Record<string, string> = { client_id: clientId };
    if (annual) p.fy = fy; else { p.from = from; p.to = to; }
    if (head === "gstr9c" && fin) p.fin_turnover = fin;
    return p;
  };
  const periods = annual ? Array.from({ length: 12 }, (_, i) => { const m = ((i + 3) % 12) + 1; const y = Number(fy) + (m < 4 ? 1 : 0); return `${y}-${String(m).padStart(2, "0")}`; }) : (() => {
    const out: string[] = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
    while ((y < ty || (y === ty && m <= tm)) && out.length < 60) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
    return out;
  })();

  const run = async () => {
    if (!clientId) return;
    setBusy(true); setError(null);
    try { setReport(await api.recon.report(head, params())); } catch (e: any) { setReport(null); setError(e.message); } finally { setBusy(false); }
  };
  const download = async () => { try { await api.recon.exportReport(head, params()); } catch (e: any) { setError(e.message); } };
  useEffect(() => { setReport(null); }, [clientId, from, to, fy, fin, tick]);

  const fyOptions = Array.from({ length: 6 }, (_, i) => fyStart(cur) - i);
  return (
    <div className="p-6 max-w-6xl mx-auto w-full space-y-5">
      <p className="text-sm text-slate-600">{HEAD_INFO[head]}</p>
      <div className={`${card} p-5 flex flex-wrap items-end gap-4`}>
        <label className="block min-w-[16rem]">
          <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
          </select>
        </label>
        {annual ? (
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Financial year</span>
            <select value={fy} onChange={(e) => setFy(e.target.value)} className={input}>{fyOptions.map((y) => <option key={y} value={y}>FY {y}-{String(y + 1).slice(2)}</option>)}</select>
          </label>
        ) : (
          <>
            <div><span className="block text-xs font-medium text-slate-600 mb-1">From</span><PeriodPicker value={from} onChange={(p) => { setFrom(p); if (p > to) setTo(p); }} /></div>
            <div><span className="block text-xs font-medium text-slate-600 mb-1">To</span><PeriodPicker value={to} onChange={(p) => { setTo(p); if (p < from) setFrom(p); }} /></div>
          </>
        )}
        {head === "gstr9c" && (
          <label className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">Turnover per audited financials (optional)</span>
            <input type="number" value={fin} onChange={(e) => setFin(e.target.value)} placeholder="defaults to books" className={input} />
          </label>
        )}
        <button onClick={run} disabled={busy || !clientId} className={btn}>{busy ? "Preparing..." : "Prepare working"}</button>
        {report && <button onClick={download} className={btn2}><Download className="w-4 h-4" /> Download Excel</button>}
      </div>

      {head !== "gstr3b" && clientId && (
        <FilesPanel clientId={clientId} kinds={HEAD_FILES[head]} defaultPeriod={annual ? `${fy}-04` : to} periods={periods} onChanged={() => setTick((t) => t + 1)} />
      )}

      {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}

      {!report && !busy && !error && <div className={`${card} p-8 text-center text-sm text-slate-500`}>Choose the client and period, upload the portal files, then press "Prepare working".</div>}

      {report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[["Discrepancies", report.summary.total], ["High", report.summary.high], ["Medium", report.summary.medium], ["Low", report.summary.low]].map(([k, v]) => (
              <div key={k as string} className={`${card} p-4`}><p className="text-xs text-slate-500">{k}</p><p className="text-xl font-semibold mt-1">{v}</p></div>
            ))}
          </div>
          {report.pending_approval > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">{report.pending_approval} document(s) in this range are waiting for the client's approval and are not included in the books.</div>
          )}
          {report.missing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">
              <p className="font-medium">Not yet available for the comparison:</p>
              <ul className="list-disc ml-5 mt-1">{report.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            </div>
          )}
          <div className="space-y-3">
            {report.sections.map((s, i) => <SectionTable key={s.key} s={s} defaultOpen={i < 3} />)}
          </div>
          <DiscrepancyList items={report.discrepancies} />
        </>
      )}
    </div>
  );
}

function DiscrepancyList({ items }: { items: ReconReport["discrepancies"] }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={card}>
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-3">
        <span className="font-semibold text-sm">Discrepancy report - reasons and recommended action ({items.length})</span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 divide-y divide-slate-100 max-h-[40rem] overflow-y-auto">
          {items.length === 0 && <p className="p-6 text-center text-sm text-slate-500">No discrepancies found for the data available.</p>}
          {items.slice(0, 300).map((d, i) => (
            <div key={i} className="p-4 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${d.severity === "high" ? "bg-rose-50 text-rose-700 border-rose-200" : d.severity === "medium" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-slate-100 text-slate-600 border-slate-200"}`}>{d.severity}</span>
                <span className="font-medium">{d.issue}</span>
                <span className="text-slate-500">{d.area}{d.period ? ` · ${/^\d{4}-\d{2}$/.test(d.period) ? periodLabel(d.period) : d.period}` : ""}</span>
                {d.amount ? <span className="ml-auto font-semibold tabular-nums">{num(d.amount)}</span> : null}
              </div>
              {(d.party || d.ref) && <p className="text-xs text-slate-500">{[d.party, d.gstin, d.ref].filter(Boolean).join(" · ")}</p>}
              <p><span className="text-slate-500">Possible reason: </span>{d.reason}</p>
              <p><span className="text-slate-500">Recommended action: </span>{d.action}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- client ledgers */

export function LedgerPanel({ clientId }: { clientId: string }) {
  const [files, setFiles] = useState<ReconFile[]>([]);
  const [kind, setKind] = useState<"sales_ledger" | "purchase_ledger" | "gstr1_portal">("sales_ledger");
  const [period, setPeriod] = useState(currentPeriod());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => { api.recon.files().then((f) => setFiles(f.filter((x) => x.kind === "sales_ledger" || x.kind === "purchase_ledger" || x.kind === "gstr1_portal"))).catch((e) => setMsg({ ok: false, text: e.message })); }, []);
  useEffect(load, [load]);

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (!list.length) return;
    setBusy(true); setMsg(null);
    try {
      const res = await api.recon.upload(list, kind, clientId, kind === "gstr1_portal" ? period : undefined);
      setMsg({ ok: true, text: `Uploaded ${res.map((r) => `${r.original_filename}${r.tax_period ? ` for ${periodLabel(r.tax_period)}` : ""} (${r.row_count} entries)`).join(", ")}` });
      load();
    } catch (er: any) { setMsg({ ok: false, text: er.message }); } finally { setBusy(false); }
  };
  const uploadBatch = async (list: File[], merge: boolean) => {
    setBusy(true); setMsg(null);
    try {
      const res = await api.recon.upload(list, kind, clientId, undefined, merge);
      const r0 = res[0];
      setMsg({
        ok: true,
        text: merge && r0.batch
          ? `Merged ${r0.batch.length} files into one ledger with ${r0.row_count} entries (${r0.batch.map((b) => `${b.name}: ${b.added}`).join(", ")}). ${r0.warning || ""}`
          : `Uploaded ${res.map((r) => `${r.original_filename} (${r.row_count} entries)`).join(", ")}. ${res.find((r) => r.warning)?.warning || ""}`,
      });
      load();
      return true;
    } catch (er: any) { setMsg({ ok: false, text: er.message }); return false; } finally { setBusy(false); }
  };
  const remove = async (id: string) => { await api.recon.remove(id); load(); };

  return (
    <div className="space-y-4">
      <div className={`${card} p-6 space-y-4`}>
        <div>
          <h3 className="font-semibold">Upload ledgers and GSTR-1</h3>
          <p className="text-sm text-slate-500">Upload your sales ledger (all tax rates) or purchase ledger, including credit and debit notes, as Excel or CSV. Each entry is placed in the month of its date. For GSTR-1, choose the month and upload the Excel downloaded from the GST portal. Your CA uses these for the reconciliations - no approval step is needed.</p>
        </div>
        <div className="flex gap-1.5">
          {([["sales_ledger", "Sales ledger"], ["purchase_ledger", "Purchase ledger"], ["gstr1_portal", "GSTR-1 (portal Excel)"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setKind(k)} className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${kind === k ? "bg-black text-white border-black" : "bg-white text-slate-600 border-slate-200 hover:border-black"}`}>{l}</button>
          ))}
        </div>
        {kind === "gstr1_portal" && <div><span className="block text-xs font-medium text-slate-600 mb-1">Return month</span><PeriodPicker value={period} onChange={setPeriod} /></div>}
        {kind === "gstr1_portal" ? (
          <div className="flex gap-2 flex-wrap">
            <label className={`${btn} cursor-pointer ${busy ? "opacity-40 pointer-events-none" : ""}`}>
              <Upload className="w-4 h-4" /> {busy ? "Uploading..." : "Upload GSTR-1 file"}
              <input type="file" className="hidden" accept=".xlsx,.xlsm,.xls,.xlsb,.csv" multiple onChange={pick} />
            </label>
          </div>
        ) : (
          <BatchPicker
            accept=".xlsx,.xlsm,.xls,.xlsb,.csv,.pdf,.png,.jpg,.jpeg"
            busy={busy}
            noun={kind === "sales_ledger" ? "sales ledger" : "purchase ledger"}
            onUpload={uploadBatch}
            extra={<button onClick={() => api.recon.template(kind).catch((e) => setMsg({ ok: false, text: e.message }))} className={btn2}><Download className="w-4 h-4" /> Sample format</button>}
          />
        )}
        {msg && <p className={`text-sm rounded-lg px-3 py-2 border ${msg.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>{msg.text}</p>}
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold text-sm">Uploaded files</h3>
        {files.length === 0 ? (
          <div className={`${card} p-8 text-center text-sm text-slate-500`}>Nothing uploaded yet.</div>
        ) : files.map((f) => (
          <div key={f.id} className={`${card} p-4 flex items-center justify-between gap-3`}>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{f.original_filename}</p>
              <p className="text-xs text-slate-500">{KIND_LABEL[f.kind]}{f.tax_period ? ` · ${periodLabel(f.tax_period)}` : ""} · {f.row_count} entries · {new Date(f.created_at).toLocaleString()}</p>
            </div>
            <button onClick={() => remove(f.id)} className="p-2 text-slate-500 hover:text-rose-600" aria-label="Delete ledger"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------- output reconciliation */

function monthsBetween(from: string, to: string) {
  const out: string[] = []; let [y, m] = from.split("-").map(Number); const [ty, tm] = to.split("-").map(Number);
  while ((y < ty || (y === ty && m <= tm)) && out.length < 60) { out.push(`${y}-${String(m).padStart(2, "0")}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}

function StepCard({ n, title, text, children }: { n: number; title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className={`${card} p-5 space-y-3`}>
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 shrink-0 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center">{n}</span>
        <div><h3 className="font-semibold text-sm">{title}</h3><p className="text-xs text-slate-500 mt-0.5">{text}</p></div>
      </div>
      {children}
    </div>
  );
}

function Chip({ ok, label }: { ok: boolean; label: string }) {
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-slate-100 text-slate-500 border-slate-200"}`}>{label}</span>;
}

function OutputHead({ clients, clientId, setClientId }: { clients: Client[]; clientId: string; setClientId: (v: string) => void }) {
  const cur = currentPeriod();
  const [from, setFrom] = useState(`${fyStart(cur)}-04`);
  const [to, setTo] = useState(cur);
  const [status, setStatus] = useState<OutputStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const periods = monthsBetween(from, to);
  const params = (): Record<string, string> => ({ client_id: clientId, from, to });

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    api.recon.outputStatus(params()).then((s) => { if (live) { setStatus(s); setError(null); } }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [clientId, from, to, tick]);

  const get = async (name: string) => {
    setBusy(name); setError(null);
    try { await api.recon.outputExport(name, params()); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const dl = (name: string, label: string) => (
    <button onClick={() => get(name)} disabled={busy !== null || !clientId} className={btn}><Download className="w-4 h-4" /> {busy === name ? "Preparing..." : label}</button>
  );
  const count = (n: string) => status?.reports[n];
  const recons: [string, string, string][] = [
    ["g1_3b", "GSTR-1 (portal) vs GSTR-3B compiled from PDF", "Month-wise taxable value, IGST, CGST, SGST."],
    ["working_g1", "GSTR-1 working compiled vs GSTR-1 (portal)", "Month, tax-rate, party-wise (with GSTIN) and document-level."],
    ["books_working", "Books vs GSTR-1 working", "Sales ledgers and notes against the invoice-based working."],
    ["books_3b", "Books vs GSTR-3B", "Month-wise tie-out of books to the filed return."],
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto w-full space-y-5">
      <p className="text-sm text-slate-600">All working is prepared as Excel files only - nothing is displayed on screen. Each workbook contains the summaries, pivots and a discrepancy sheet with reasons and recommended actions.</p>
      <div className={`${card} p-5 flex flex-wrap items-end gap-4`}>
        <label className="block min-w-[16rem]">
          <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
          </select>
        </label>
        <div><span className="block text-xs font-medium text-slate-600 mb-1">From</span><PeriodPicker value={from} onChange={(p) => { setFrom(p); if (p > to) setTo(p); }} /></div>
        <div><span className="block text-xs font-medium text-slate-600 mb-1">To</span><PeriodPicker value={to} onChange={(p) => { setTo(p); if (p < from) setFrom(p); }} /></div>
      </div>

      {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
      {status && status.pending_approval > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">{status.pending_approval} invoice(s) in this range are awaiting client approval and are not in the working.</div>}

      <StepCard n={1} title="Books data working" text="Compiled from the sales ledgers and credit / debit note entries uploaded by the client - month by month, rate-wise, every entry - and matched with the sales invoices in the system.">
        <div className="flex flex-wrap items-center gap-3">
          {dl("books", "Download Books working (Excel)")}
          {status && <span className="text-xs text-slate-500">{status.ledger_entries} ledger entries in range</span>}
        </div>
        {status && status.ledger_entries === 0 && <p className="text-xs text-amber-700">The client has not uploaded a sales ledger for this period (client login, GST Details, Ledgers tab).</p>}
      </StepCard>

      <StepCard n={2} title="GSTR-1 working" text="Compiled month by month from the client-approved sales invoices, credit notes and debit notes.">
        <div className="flex flex-wrap items-center gap-3">
          {dl("g1working", "Download GSTR-1 working (Excel)")}
          {status && <span className="text-xs text-slate-500">{status.invoice_rows} invoice lines in range</span>}
        </div>
      </StepCard>

      <StepCard n={3} title="GSTR-1 downloaded from portal" text="Upload the GSTR-1 Excel for each month.">
        {clientId && <FilesPanel clientId={clientId} kinds={["gstr1_portal"]} defaultPeriod={to} periods={periods} onChanged={() => setTick((t) => t + 1)} />}
      </StepCard>

      <StepCard n={4} title="GSTR-3B PDFs" text="Upload the filed GSTR-3B PDFs. The month is read from each PDF and the figures can be checked and corrected.">
        {clientId && <FilesPanel clientId={clientId} kinds={["gstr3b"]} defaultPeriod={to} periods={periods} onChanged={() => setTick((t) => t + 1)} />}
      </StepCard>

      <StepCard n={5} title="Reconciliations" text="Each downloads as one Excel workbook.">
        {status && (
          <div className="flex flex-wrap gap-1.5">
            {status.periods.map((p) => (
              <div key={p.period} className="border border-slate-200 rounded-lg px-2 py-1.5 text-[11px] space-y-1">
                <p className="font-medium text-slate-700">{periodLabel(p.period)}</p>
                <div className="flex gap-1"><Chip ok={p.ledger} label="Ledger" /><Chip ok={p.invoices} label="Invoices" /><Chip ok={p.gstr1} label="GSTR-1" /><Chip ok={p.gstr3b} label="3B" /></div>
              </div>
            ))}
          </div>
        )}
        <div className="divide-y divide-slate-100">
          {recons.map(([name, title, text]) => (
            <div key={name} className="py-3 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-slate-500">{text}</p>
                {count(name)?.missing.map((m) => <p key={m} className="text-xs text-amber-700 mt-0.5">{m}</p>)}
              </div>
              <div className="flex items-center gap-3">
                {count(name) && <span className="text-xs text-slate-500">{count(name)!.discrepancies} discrepancies</span>}
                <button onClick={() => get(name)} disabled={busy !== null || !clientId} className={btn2}><Download className="w-4 h-4" /> {busy === name ? "Preparing..." : "Download Excel"}</button>
              </div>
            </div>
          ))}
        </div>
      </StepCard>
    </div>
  );
}
