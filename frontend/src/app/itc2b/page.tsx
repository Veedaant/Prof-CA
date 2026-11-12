import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, Loader2, RefreshCw, Trash2, Upload } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, Client, Itc4, ItcLine, ItcRcmCase, itc2bApi, ItcState, ItcSummary, ItcUpload } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { PeriodPicker } from "@/components/PeriodPicker";
import { currentPeriod, periodLabel } from "@/lib/period";

const card = "bg-white border border-slate-200 rounded-2xl";
const input = "w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-black";
const inr = (n: number | undefined) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const HEADS: [keyof Itc4, string][] = [["igst", "IGST"], ["cgst", "CGST"], ["sgst", "SGST"], ["cess", "Cess"]];
const taxOf = (s: { igst: number; cgst: number; sgst: number; cess: number } | null) => (s ? s.igst + s.cgst + s.sgst + s.cess : 0);

const BADGE: Record<string, { short: string; cls: string }> = {
  eligible: { short: "Eligible", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  rcm: { short: "Eligible on RCM payment", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  conditional: { short: "Eligible - check", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  hold: { short: "Not now - hold", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  not_booked: { short: "Eligible once booked", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  ineligible: { short: "Ineligible", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  ineligible_16_4: { short: "Ineligible", cls: "bg-rose-50 text-rose-700 border-rose-200" },
  reversal: { short: "ITC reversal", cls: "bg-slate-100 text-slate-700 border-slate-200" },
  no_tax: { short: "No ITC", cls: "bg-slate-100 text-slate-700 border-slate-200" },
};
const CAT: Record<string, string> = {
  matched: "Matches", rounding: "Rounding", amount: "Amount differs", head: "Wrong tax head", gstin: "GSTIN differs", invno: "Invoice no. differs", date: "Date differs",
  rcm: "Reverse charge", unavailable: "ITC not available", books_only: "Not in GSTR-2B", g2b_only: "Not in books", no_tax: "No tax",
};

type Filter = "all" | "different" | "books_only" | "g2b_only" | "ineligible" | "rcm" | "matched";
const FILTERS: [Filter, string][] = [["all", "All"], ["different", "Differences"], ["books_only", "In books, not in 2B"], ["g2b_only", "In 2B, not in books"], ["ineligible", "Ineligible"], ["rcm", "Reverse charge"], ["matched", "Matching"]];
const inFilter = (l: ItcLine, f: Filter) =>
  f === "all" ? true : f === "different" ? l.status === "different" : f === "books_only" ? l.status === "books_only" && l.cat === "books_only" : f === "g2b_only" ? l.status === "g2b_only"
    : f === "ineligible" ? l.code === "ineligible" || l.code === "ineligible_16_4" : f === "rcm" ? l.code === "rcm" : l.status === "matched";

function UploadCard({ no, title, hint, accept, file, busy, onPick, onRemove, extra }: {
  no: number; title: string; hint: string; accept: string; file: ItcUpload | null; busy: boolean; onPick: (f: File) => void; onRemove: () => void; extra?: React.ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const reading = file?.status === "reading";
  return (
    <div className={`${card} p-5 flex flex-col gap-3`}>
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center shrink-0">{no}</span>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-xs text-slate-500 mt-0.5">{hint}</p>
        </div>
      </div>
      {file ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            {reading ? <Loader2 className="w-4 h-4 animate-spin text-slate-500 shrink-0" /> : file.status === "failed" ? <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" /> : <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
            <span className="font-medium truncate">{file.name}</span>
            <button type="button" onClick={onRemove} disabled={busy} className="ml-auto p-1 text-slate-500 hover:text-rose-600" aria-label={`Remove ${title}`}><Trash2 className="w-4 h-4" /></button>
          </div>
          <p className="text-xs text-slate-500">
            {reading ? "Reading the PDF... this takes about half a minute." : file.status === "failed" ? file.error || "Could not read the PDF." : file.rows != null ? `${file.rows} lines read${file.sheets?.length ? ` from ${file.sheets.join(", ")}` : ""}.` : `Read${file.return_period ? ` (${file.return_period})` : ""}.`}
          </p>
          {file.warnings?.map((w, i) => <p key={i} className="text-xs text-amber-700">{w}</p>)}
          {file.columns && file.columns.length > 0 && (
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer underline underline-offset-4">Columns read</summary>
              <ul className="mt-1 space-y-0.5">{file.columns.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </details>
          )}
          {extra}
        </div>
      ) : (
        <p className="text-xs text-slate-500">Not uploaded yet.</p>
      )}
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onPick(f); }} />
      <button type="button" disabled={busy || reading} onClick={() => ref.current?.click()} className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
        <Upload className="w-4 h-4" /> {file ? "Replace file" : "Choose file"}
      </button>
    </div>
  );
}

function FourTable({ title, rows, strong }: { title: string; rows: [string, Itc4 | null | undefined][]; strong?: number }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-slate-500 border-b border-slate-200">
            <th className="py-2 pr-4 font-medium">{title}</th>
            {HEADS.map(([, l]) => <th key={l} className="py-2 px-3 font-medium text-right">{l}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, v], i) => (
            <tr key={label} className={`border-b border-slate-100 ${i === strong ? "font-semibold bg-slate-50" : ""}`}>
              <td className="py-2 pr-4">{label}</td>
              {HEADS.map(([k]) => <td key={k} className="py-2 px-3 text-right tabular-nums">{inr(v?.[k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Gstr3bSummary({ s, hasGstr1 }: { s: ItcSummary; hasGstr1: boolean }) {
  const p = s.payment;
  return (
    <div className={`${card} p-6 space-y-6`}>
      <div>
        <h3 className="font-semibold">GSTR-3B summary</h3>
        <p className="text-sm text-slate-500">Outward tax is taken from the GSTR-1 PDF. The eligible ITC from the reconciliation below is set off against it, and the reverse-charge tax is added in cash.</p>
      </div>
      {s.warnings.map((w, i) => <div key={i} className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />{w}</div>)}
      <div className="grid sm:grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-500">Outward tax (GSTR-1)</div>
          <div className="text-xl font-semibold tabular-nums mt-1">₹{inr(taxOf(p.liability))}</div>
          <div className="text-xs text-slate-500 mt-1">{s.outward ? `Taxable value ₹${inr(s.outward.taxable)}` : "GSTR-1 not read"}</div>
        </div>
        <div className="rounded-xl border border-slate-200 p-4">
          <div className="text-xs text-slate-500">ITC used now</div>
          <div className="text-xl font-semibold tabular-nums mt-1">₹{inr(p.total_itc_used)}</div>
          <div className="text-xs text-slate-500 mt-1">Net ITC available ₹{inr(taxOf(s.itc.net_now) + taxOf(s.itc.opening))}</div>
        </div>
        <div className="rounded-xl border-2 border-black p-4">
          <div className="text-xs text-slate-500">Net payment in cash</div>
          <div className="text-xl font-semibold tabular-nums mt-1">₹{inr(p.total_cash)}</div>
          <div className="text-xs text-slate-500 mt-1">includes reverse charge ₹{inr(taxOf(p.rcm_cash))}</div>
        </div>
      </div>
      <FourTable title="Table 4 - Input tax credit" strong={6} rows={[
        ["(A)(3) Reverse charge - usable from next month", s.itc.a3],
        ["(A)(5) All other ITC (matched with GSTR-2B)", s.itc.a5],
        ["(B)(1) Reversed - section 17(5) blocked / exempt business", s.itc.b1],
        [`(B)(1) Reversed - rule 42 (estimate${s.itc.rule42_ratio ? `, ${s.itc.rule42_ratio}%` : ""})`, s.itc.rule42],
        ["(B)(2) Reversed - credit notes", s.itc.b2],
        ["Opening ITC balance entered", s.itc.opening],
        ["(C) Net ITC available now", Object.fromEntries(HEADS.map(([k]) => [k, s.itc.net_now[k] + (s.itc.opening[k] || 0)])) as unknown as Itc4],
        ["Net ITC including reverse-charge credit", s.itc.net],
      ]} />
      <FourTable title="Table 6.1 - Payment of tax" strong={4} rows={[
        ["Outward tax payable", p.liability],
        ["Paid through ITC (statutory order)", p.itc_used],
        ["Outward tax payable in cash", p.cash_outward],
        ["Reverse-charge tax payable in cash", p.rcm_cash],
        ["Net payment in cash", p.cash],
        ["ITC carried forward", p.carry_forward],
      ]} />
      <FourTable title="ITC not claimed above" rows={[
        ["Not in GSTR-2B yet, or booked higher than GSTR-2B", s.not_claimed.hold],
        ["Marked not available / barred (section 16(4), rule 37A, place of supply)", s.not_claimed.barred],
        ["In GSTR-2B but not booked (claim after booking)", s.not_claimed.unbooked],
      ]} />
      {!hasGstr1 && <p className="text-xs text-slate-500">Upload the GSTR-1 PDF to see the outward tax and the payment.</p>}
    </div>
  );
}

const RCM_SOURCE: Record<string, string> = { books: "Books register", detected: "Books register (tax not recorded)", "2b": "GSTR-2B", supplier: "Books and GSTR-2B", ledger: "Client's purchase ledger" };

function RcmCheck({ cases, ledgerRows, s }: { cases: ItcRcmCase[]; ledgerRows: number; s: ItcSummary }) {
  const payable = cases.filter((c) => c.mode === "rcm");
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="p-5 border-b border-slate-100 space-y-2">
        <h3 className="font-semibold">Reverse charge (RCM) check</h3>
        <p className="text-sm text-slate-500">
          Every purchase is checked against the services and goods notified for reverse charge (advocate, goods transport agency, director, security, import of services, scrap and so on), whether or not the books show it.
          The books usually leave RCM blank, so the tax is worked out here. Where the supplier has charged GST (forward charge) a note is shown instead, and no RCM is payable.
          {ledgerRows ? ` The client's purchase ledger (${ledgerRows} entries for the month) was also scanned.` : " No purchase ledger from the client was found for this month."}
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span><span className="font-semibold">{payable.length}</span> case(s) with RCM payable in cash: <span className="font-semibold tabular-nums">₹{inr(taxOf(s.rcm))}</span></span>
          {taxOf(s.rcm_ledger) > 0 && <span className="text-slate-500">of which only in the client's ledger ₹{inr(taxOf(s.rcm_ledger))}</span>}
          <span><span className="font-semibold">{cases.length - payable.length}</span> RCM-type case(s) where the supplier charged GST</span>
        </div>
      </div>
      {cases.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-slate-500">No reverse-charge case was found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2.5 font-medium">Where found</th>
                <th className="px-3 py-2.5 font-medium">Supplier and invoice</th>
                <th className="px-3 py-2.5 font-medium text-right">Taxable</th>
                <th className="px-3 py-2.5 font-medium">Category and provision</th>
                <th className="px-3 py-2.5 font-medium">Treatment</th>
                <th className="px-3 py-2.5 font-medium text-right">RCM tax</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c, i) => (
                <tr key={i} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-3 w-40 text-xs text-slate-600">{RCM_SOURCE[c.source] || c.source}</td>
                  <td className="px-3 py-3 w-52">
                    <div className="font-medium break-words">{c.party || "-"}</div>
                    <div className="text-xs text-slate-500">{c.inv_no}{c.date ? ` · ${c.date.split("-").reverse().join("-")}` : ""}</div>
                    {c.nature && <div className="text-xs text-slate-400">{c.nature}</div>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">{inr(c.taxable)}</td>
                  <td className="px-3 py-3 min-w-[18rem]">
                    <div className="font-medium">{c.rule ? c.rule.name : "Marked as reverse charge"}</div>
                    <p className="text-xs text-slate-600 mt-0.5">{c.rule ? c.rule.ref : "Section 9(3) / 9(4) CGST Act"}{c.rule?.verify ? " (verify the current notification)" : ""}</p>
                    <p className="text-xs text-slate-500 mt-1">{c.note}</p>
                  </td>
                  <td className="px-3 py-3 w-48">
                    <span className={`inline-block text-xs font-semibold px-2 py-1 rounded-lg border ${c.mode === "fcm" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-sky-50 text-sky-900 border-sky-200"}`}>
                      {c.mode === "fcm" ? "Supplier opted FCM - ITC in GSTR-2B" : c.source === "detected" ? "RCM payable - not in books" : c.source === "ledger" ? "RCM payable - ledger only" : "RCM payable"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">
                    {c.mode === "fcm" || !c.tax ? <span className="text-slate-400">-</span> : <><div>₹{inr(taxOf(c.tax))}</div>{c.rate != null && <div className="text-xs text-slate-500">at {c.rate}%</div>}</>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ l }: { l: ItcLine }) {
  const b = BADGE[l.code] || { short: l.eligibility, cls: "bg-slate-100 text-slate-700 border-slate-200" };
  const type = l.type === "cn" ? "Credit note" : l.type === "dn" ? "Debit note" : "Invoice";
  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-3 w-56">
        <div className="font-medium break-words">{l.party || "-"}</div>
        <div className="text-xs text-slate-500">{type} {l.inv_no}{l.date ? ` · ${l.date.split("-").reverse().join("-")}` : ""}</div>
        <div className="text-xs text-slate-400">{l.gstin}</div>
      </td>
      <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">
        {l.books ? <><div>{inr(l.books.taxable)}</div><div className="text-xs text-slate-500">tax {inr(taxOf(l.books))}</div></> : <span className="text-slate-400">-</span>}
      </td>
      <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">
        {l.g2b ? <><div>{inr(l.g2b.taxable)}</div><div className="text-xs text-slate-500">tax {inr(taxOf(l.g2b))}</div></> : <span className="text-slate-400">-</span>}
      </td>
      <td className="px-3 py-3 min-w-[22rem]">
        <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border mb-1 ${l.status === "matched" ? "bg-emerald-50 text-emerald-800 border-emerald-200" : l.status === "different" ? "bg-amber-50 text-amber-800 border-amber-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>{CAT[l.cat] || l.cat}</span>
        <p className="text-slate-800">{l.remark}</p>
        {l.status !== "matched" || l.cat === "rounding" ? <p className="text-slate-600 mt-1"><span className="font-medium">What to do: </span>{l.action}</p> : null}
        {l.rcm && l.rcm.mode !== "none" && (
          <p className={`mt-2 text-xs rounded-lg border px-2 py-1.5 ${l.rcm.mode === "fcm" ? "bg-amber-50 border-amber-200 text-amber-900" : "bg-sky-50 border-sky-200 text-sky-900"}`}>
            <span className="font-semibold">{l.rcm.mode === "fcm" ? "RCM kind, supplier opted FCM" : "Reverse charge"}{l.rcm.category ? `: ${l.rcm.category}` : ""}.</span>{" "}
            {l.rcm.ref}
          </p>
        )}
      </td>
      <td className="px-3 py-3 min-w-[16rem]">
        <span title={l.eligibility} className={`inline-block text-xs font-semibold px-2 py-1 rounded-lg border ${b.cls}`}>{b.short}</span>
        {l.reason && <p className="text-xs text-slate-600 mt-1">{l.reason}</p>}
        <details className="mt-1">
          <summary className="text-xs text-slate-500 cursor-pointer underline underline-offset-4">Relevant provision</summary>
          <p className="text-xs text-slate-600 mt-1">{l.provision}</p>
        </details>
      </td>
    </tr>
  );
}

export default function Itc2bPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState<ItcState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [nature, setNature] = useState("");
  const [detail, setDetail] = useState("");
  const [opening, setOpening] = useState<Record<string, string>>({ igst: "", cgst: "", sgst: "", cess: "" });
  const loadedKey = useRef("");

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    if (!loading && user && user.role === "client") router.push("/gst");
  }, [user, loading, router]);
  useEffect(() => {
    if (!user || user.role === "client") return;
    api.clients.list().then((c) => { setClients(c); if (c.length) setClientId((id) => id || c[0].id); }).catch(() => {});
  }, [user]);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const d = await itc2bApi.state(clientId, period);
      setData(d);
      setError(null);
      const key = `${clientId}|${period}`;
      if (loadedKey.current !== key) {
        loadedKey.current = key;
        setNature(d.client.business_nature || "");
        setDetail(d.client.business_detail || "");
        setOpening({ igst: String(d.opening_itc.igst || ""), cgst: String(d.opening_itc.cgst || ""), sgst: String(d.opening_itc.sgst || ""), cess: String(d.opening_itc.cess || "") });
      }
    } catch (e: any) { setError(e.message); }
  }, [clientId, period]);
  useEffect(() => { setData(null); loadedKey.current = ""; load(); }, [load]);

  // the GSTR-1 PDF is read in the background
  const reading = data?.uploads.gstr1?.status === "reading";
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [reading, load]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); if (done) setNotice(done); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const pick = (kind: "books" | "gstr2b" | "gstr1") => (f: File) =>
    run(kind, () => itc2bApi.upload(clientId, period, kind, f), kind === "gstr1" ? "GSTR-1 PDF uploaded. It is being read." : "File read.");
  const saveSettings = () =>
    run("settings", async () => {
      const num = (v: string) => Number(v) || 0;
      const d = await itc2bApi.settings({ client_id: clientId, tax_period: period, business_nature: nature, business_detail: detail, opening_itc: { igst: num(opening.igst), cgst: num(opening.cgst), sgst: num(opening.sgst), cess: num(opening.cess) } });
      setData(d);
    }, "Saved. The eligibility has been worked out again.");

  const res = data?.result || null;
  const lines = res ? res.lines.filter((l) => inFilter(l, filter)) : [];
  const c = res?.counts;

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="GSTR-2B Reconciliation" subtitle="ITC as per books against GSTR-2B, ITC eligibility, and the GSTR-3B summary with the net payment" />
        <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
          <div className={`${card} p-6 space-y-5`}>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block min-w-[16rem]">
                <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
                <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
                  {clients.map((cl) => <option key={cl.id} value={cl.id}>{cl.name} ({cl.gstin || "No GSTIN"})</option>)}
                </select>
              </label>
              <div>
                <span className="block text-xs font-medium text-slate-600 mb-1">Return period</span>
                <PeriodPicker value={period} onChange={setPeriod} />
              </div>
              {res && (
                <button onClick={() => run("excel", () => itc2bApi.excel(clientId, period))} disabled={busy === "excel"} className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
                  <Download className="w-4 h-4" /> {busy === "excel" ? "Preparing..." : "Download the Excel"}
                </button>
              )}
            </div>
            {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
            {notice && <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">{notice}</div>}
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                <UploadCard no={1} title="ITC as per books" hint="The ITC register from the books in Excel: party, GSTIN, invoice no., date, taxable value, IGST, CGST, SGST and so on." accept=".xlsx,.xlsm,.xls,.xlsb,.csv"
                  file={data.uploads.books} busy={busy === "books"} onPick={pick("books")} onRemove={() => run("books", () => itc2bApi.remove(clientId, period, "books"))} />
                <UploadCard no={2} title="GSTR-2B Excel" hint={`The Excel downloaded from the GST portal for ${periodLabel(period)} (B2B and B2B-CDNR sheets).`} accept=".xlsx,.xlsm,.xls,.xlsb,.csv"
                  file={data.uploads.gstr2b} busy={busy === "gstr2b"} onPick={pick("gstr2b")} onRemove={() => run("gstr2b", () => itc2bApi.remove(clientId, period, "gstr2b"))} />
                <UploadCard no={3} title="GSTR-1 PDF" hint="The filed GSTR-1 (summary or full return) for the same month. The outward tax liability is read from it." accept=".pdf"
                  file={data.uploads.gstr1} busy={busy === "gstr1"} onPick={pick("gstr1")} onRemove={() => run("gstr1", () => itc2bApi.remove(clientId, period, "gstr1"))}
                  extra={data.uploads.gstr1?.status === "failed" ? <button type="button" onClick={() => run("reread", () => itc2bApi.reread(clientId, period))} className="inline-flex items-center gap-1.5 text-xs font-semibold underline underline-offset-4"><RefreshCw className="w-3.5 h-3.5" /> Read again</button> : null} />
              </div>

              <div className={`${card} p-6 space-y-4`}>
                <div>
                  <h3 className="font-semibold">Nature of the client's business</h3>
                  <p className="text-sm text-slate-500">ITC eligibility depends on what the client does: a restaurant can claim ITC on food, a trader cannot; a hospital cannot claim ITC at all. Choose the closest one.</p>
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-600 mb-1">Nature of business</span>
                    <select value={nature} onChange={(e) => setNature(e.target.value)} className={input}>
                      <option value="">Not set (treated as a normal taxable business)</option>
                      {data.natures.map((n) => <option key={n.value} value={n.value}>{n.label}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="block text-xs font-medium text-slate-600 mb-1">Notes about the business (optional)</span>
                    <input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="e.g. also runs a canteen, rents out a shop" className={input} />
                  </label>
                </div>
                <div>
                  <span className="block text-xs font-medium text-slate-600 mb-1">Opening ITC balance in the credit ledger (optional)</span>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-2xl">
                    {HEADS.map(([k, l]) => (
                      <label key={k} className="block">
                        <span className="block text-[11px] text-slate-500 mb-0.5">{l}</span>
                        <input type="number" min="0" step="0.01" value={opening[k]} onChange={(e) => setOpening({ ...opening, [k]: e.target.value })} className={input} />
                      </label>
                    ))}
                  </div>
                </div>
                <button onClick={saveSettings} disabled={busy === "settings"} className="px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">{busy === "settings" ? "Saving..." : "Save and work out again"}</button>
              </div>

              {!res && (
                <div className={`${card} p-10 text-center text-sm text-slate-500`}>
                  <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                  Upload the ITC as per books and the GSTR-2B Excel to reconcile them. Add the GSTR-1 PDF for the GSTR-3B summary.
                </div>
              )}

              {res && c && (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {([
                      ["Lines compared", c.total, "all"], ["Matching", c.matched, "matched"], ["Differences", c.different, "different"],
                      ["In books, not in 2B", c.books_only, "books_only"], ["In 2B, not in books", c.g2b_only, "g2b_only"],
                    ] as [string, number, Filter][]).map(([label, n, f]) => (
                      <button key={label} onClick={() => setFilter(f)} className={`text-left ${card} p-4 hover:border-black ${filter === f ? "border-black" : ""}`}>
                        <div className="text-xs text-slate-500">{label}</div>
                        <div className="text-2xl font-semibold tabular-nums mt-1">{n}</div>
                      </button>
                    ))}
                  </div>

                  <Gstr3bSummary s={res.summary} hasGstr1={Boolean(data.uploads.gstr1?.status === "ready")} />

                  <RcmCheck cases={res.rcm_cases} ledgerRows={res.ledger_rows} s={res.summary} />

                  <div className={`${card} overflow-hidden`}>
                    <div className="p-5 border-b border-slate-100 space-y-3">
                      <div>
                        <h3 className="font-semibold flex items-center gap-2"><FileText className="w-4 h-4" /> ITC reconciliation - {res.profile.label}</h3>
                        <p className="text-sm text-slate-500">Each line shows the difference, what to do about it, and whether the ITC is eligible, with the provision of the GST Act.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {FILTERS.map(([f, label]) => (
                          <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${filter === f ? "bg-black text-white border-black" : "bg-white text-slate-700 border-slate-300 hover:border-black"}`}>
                            {label} ({res.lines.filter((l) => inFilter(l, f)).length})
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs text-slate-500">
                          <tr>
                            <th className="px-3 py-2.5 font-medium">Supplier and invoice</th>
                            <th className="px-3 py-2.5 font-medium text-right">As per books</th>
                            <th className="px-3 py-2.5 font-medium text-right">As per GSTR-2B</th>
                            <th className="px-3 py-2.5 font-medium">Remark and recommended action</th>
                            <th className="px-3 py-2.5 font-medium">ITC eligibility</th>
                          </tr>
                        </thead>
                        <tbody>
                          {lines.map((l) => <Row key={l.no} l={l} />)}
                          {!lines.length && <tr><td colSpan={5} className="px-5 py-8 text-center text-slate-500">Nothing in this view.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
