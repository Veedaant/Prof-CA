import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, Trash2, Upload } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, Client, OutCompareRow, OutFile, outputApi, OutState } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

const card = "bg-white border border-slate-200 rounded-2xl";
const input = "w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-black";
const inr = (n: number | undefined) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthName = (p: string) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[m - 1]}-${String(y).slice(2)}`; };

function currentFy() {
  const d = new Date();
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
}
const fyOptions = () => { const y0 = Number(currentFy().slice(0, 4)); return Array.from({ length: 10 }, (_, i) => { const y = y0 + 1 - i; return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; }); };

const KIND_INFO = {
  books: { no: 1, title: "GST ledgers as per books", hint: "Output CGST / SGST / IGST ledgers, the sales ledger or the sales register, in Excel. Upload as many files as you have; they are combined.", accept: ".xlsx,.xlsm,.xls,.xlsb,.csv" },
  gstr1: { no: 2, title: "GSTR-1 Excel files", hint: "The GSTR-1 Excel of each month, from the GST portal or the offline tool. Select all months together; the month is read from the file name.", accept: ".xlsx,.xlsm,.xls,.xlsb,.csv" },
  gstr3b: { no: 3, title: "GSTR-3B for all months", hint: "The GSTR-3B of each month as PDF (from the portal) or Excel. Select all months together.", accept: ".pdf,.xlsx,.xlsm,.xls,.xlsb,.csv" },
} as const;

function FileRow({ f, months, onPeriod, onRemove, busy }: { f: OutFile; months: string[]; onPeriod: (p: string) => void; onRemove: () => void; busy: boolean }) {
  const options = f.period && !months.includes(f.period) ? [f.period, ...months] : months;
  return (
    <li className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <div className="flex items-center gap-2 min-w-0">
        <FileSpreadsheet className="w-4 h-4 text-slate-500 shrink-0" />
        <span className="font-medium truncate" title={f.name}>{f.name}</span>
        {f.kind !== "books" && f.multi && <span className="ml-auto text-xs rounded-lg border border-sky-200 bg-sky-50 text-sky-800 px-2 py-1">Several months, by invoice date</span>}
        {f.kind !== "books" && !f.multi && (
          <select value={f.period || ""} disabled={busy} onChange={(e) => onPeriod(e.target.value)} className={`ml-auto text-xs rounded-lg border px-2 py-1 ${f.period ? "border-slate-300 bg-white" : "border-amber-400 bg-amber-50"}`} aria-label={`Month of ${f.name}`}>
            {!f.period && <option value="">Choose month</option>}
            {options.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        )}
        <button type="button" onClick={onRemove} disabled={busy} className={`p-1 text-slate-500 hover:text-rose-600 ${f.kind === "books" ? "ml-auto" : ""}`} aria-label={`Remove ${f.name}`}><Trash2 className="w-4 h-4" /></button>
      </div>
      <p className="text-xs text-slate-500 mt-0.5">{f.rows} {f.kind === "gstr3b" ? "figures" : "lines"} read{f.sheets?.length ? ` from ${f.sheets.join(", ")}` : ""}</p>
      {f.warnings.map((w, i) => <p key={i} className="text-xs text-amber-700 mt-0.5">{w}</p>)}
    </li>
  );
}

function UploadCard({ kind, files, months, busy, onUpload, onPeriod, onRemove, extra }: {
  kind: keyof typeof KIND_INFO; files: OutFile[]; months: string[]; busy: boolean; onUpload: (f: File[]) => void; onPeriod: (id: string, p: string) => void; onRemove: (id: string) => void; extra?: React.ReactNode;
}) {
  const info = KIND_INFO[kind];
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={`${card} p-5 flex flex-col gap-3`}>
      <div className="flex items-start gap-3">
        <span className="w-7 h-7 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center shrink-0">{info.no}</span>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">{info.title} <span className="text-slate-400 font-normal">({files.length})</span></h3>
          <p className="text-xs text-slate-500 mt-0.5">{info.hint}</p>
        </div>
      </div>
      {files.length > 0 && <ul className="space-y-2 max-h-72 overflow-y-auto">{files.map((f) => <FileRow key={f.id} f={f} months={months} busy={busy} onPeriod={(p) => onPeriod(f.id, p)} onRemove={() => onRemove(f.id)} />)}</ul>}
      <input ref={ref} type="file" multiple accept={info.accept} className="hidden" onChange={(e) => { const l = Array.from(e.target.files || []); e.target.value = ""; if (l.length) onUpload(l); }} />
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => ref.current?.click()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} {files.length ? "Add more files" : "Choose files"}
        </button>
        {extra}
      </div>
    </div>
  );
}

function CompareTable({ title, nameA, nameB, rows, total }: { title: string; nameA: string; nameB: string; rows: OutCompareRow[]; total: OutCompareRow }) {
  const all = [...rows, total];
  return (
    <div className={`${card} overflow-hidden`}>
      <div className="px-5 py-3 border-b border-slate-100">
        <h4 className="font-semibold text-sm">{title}</h4>
        <p className="text-xs text-slate-500">Difference = {nameA} less {nameB}. Months in grey are missing a file.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Month</th>
              <th className="px-3 py-2 text-right font-medium">{nameA} taxable</th>
              <th className="px-3 py-2 text-right font-medium">{nameB} taxable</th>
              <th className="px-3 py-2 text-right font-medium">Diff. taxable</th>
              <th className="px-3 py-2 text-right font-medium">Diff. IGST</th>
              <th className="px-3 py-2 text-right font-medium">Diff. CGST</th>
              <th className="px-3 py-2 text-right font-medium">Diff. SGST</th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => {
              const isT = r.month === "total";
              const missing = !isT && (!r.hasA || !r.hasB);
              const cell = (v: number) => <td className={`px-3 py-1.5 text-right tabular-nums ${Math.abs(v) > 1 ? "text-rose-700 font-semibold" : ""}`}>{inr(v)}</td>;
              return (
                <tr key={r.month} className={`border-t border-slate-100 ${isT ? "bg-slate-50 font-semibold" : ""} ${missing ? "text-slate-400" : ""}`}>
                  <td className="px-3 py-1.5">{r.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{inr(r.a.taxable)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{inr(r.b.taxable)}</td>
                  {cell(r.d.taxable)}{cell(r.d.igst)}{cell(r.d.cgst)}{cell(r.d.sgst)}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function OutputReconPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [fy, setFy] = useState(currentFy());
  const [data, setData] = useState<OutState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [partyTypes, setPartyTypes] = useState("");
  const [area, setArea] = useState("all");
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
      const d = await outputApi.state(clientId, fy);
      setData(d);
      setError(null);
      const key = `${clientId}|${fy}`;
      if (loadedKey.current !== key) { loadedKey.current = key; setPartyTypes(d.party_types || ""); }
    } catch (e: any) { setError(e.message); }
  }, [clientId, fy]);
  useEffect(() => { setData(null); loadedKey.current = ""; setProblems([]); load(); }, [load]);

  const run = async (label: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); if (done) setNotice(done); await load(); } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };
  const upload = (kind: "books" | "gstr1" | "gstr3b") => async (files: File[]) => {
    setBusy(kind); setError(null); setNotice(null); setProblems([]);
    try {
      const r = await outputApi.upload(clientId, fy, kind, files);
      const ok = r.results.filter((x) => x.ok).length;
      setProblems(r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`));
      if (ok) setNotice(`${ok} file(s) read.`);
      await load();
    } catch (e: any) { setError(e.message); } finally { setBusy(null); }
  };

  const cov = data?.coverage || [];
  const dl = (what: "combined/books" | "combined/gstr1" | "working") => run(what, () => outputApi.download(what, clientId, fy));
  const dlBtn = (what: "combined/books" | "combined/gstr1", label: string, enabled: boolean) => (
    <button type="button" disabled={!enabled || busy === what} onClick={() => dl(what)} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold hover:border-black disabled:opacity-40">
      <Download className="w-4 h-4" /> {busy === what ? "Preparing..." : label}
    </button>
  );
  const areas = data ? ["all", ...Array.from(new Set(data.differences.map((d) => d.area)))] : ["all"];
  const diffs = data ? data.differences.filter((d) => area === "all" || d.area === area) : [];
  const T = data?.totals;

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Output GST Reconciliation" subtitle="Books, GSTR-1 and GSTR-3B for the year, reconciled and prepared for GSTR-9 and GSTR-9C" />
        <div className="p-6 max-w-7xl mx-auto w-full space-y-6">
          <div className={`${card} p-6 space-y-4`}>
            <div className="flex flex-wrap items-end gap-4">
              <label className="block min-w-[16rem]">
                <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
                <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
                  {clients.map((cl) => <option key={cl.id} value={cl.id}>{cl.name} ({cl.gstin || "No GSTIN"})</option>)}
                </select>
              </label>
              <label className="block">
                <span className="block text-xs font-medium text-slate-600 mb-1">Financial year</span>
                <select value={fy} onChange={(e) => setFy(e.target.value)} className={input}>
                  {fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </label>
              <button type="button" disabled={!data?.ready || busy === "working"} onClick={() => dl("working")} className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
                <Download className="w-4 h-4" /> {busy === "working" ? "Preparing..." : "Download the full working (10 sheets)"}
              </button>
            </div>
            {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
            {notice && <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">{notice}</div>}
            {problems.length > 0 && (
              <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm space-y-1">
                <p className="font-semibold">These files could not be read:</p>
                {problems.map((p, i) => <p key={i}>{p}</p>)}
              </div>
            )}
          </div>

          {data && (
            <>
              <div className="grid md:grid-cols-3 gap-4">
                <UploadCard kind="books" files={data.files.books} months={data.months} busy={busy === "books"} onUpload={upload("books")} onPeriod={() => {}} onRemove={(id) => run("rm", () => outputApi.remove(id))}
                  extra={dlBtn("combined/books", "Download combined books", data.files.books.length > 0)} />
                <UploadCard kind="gstr1" files={data.files.gstr1} months={data.months} busy={busy === "gstr1"} onUpload={upload("gstr1")} onPeriod={(id, p) => run("period", () => outputApi.setPeriod(id, p))} onRemove={(id) => run("rm", () => outputApi.remove(id))}
                  extra={dlBtn("combined/gstr1", "Download combined GSTR-1", data.files.gstr1.length > 0)} />
                <UploadCard kind="gstr3b" files={data.files.gstr3b} months={data.months} busy={busy === "gstr3b"} onUpload={upload("gstr3b")} onPeriod={(id, p) => run("period", () => outputApi.setPeriod(id, p))} onRemove={(id) => run("rm", () => outputApi.remove(id))} />
              </div>

              <div className={`${card} p-6 space-y-3`}>
                <div>
                  <h3 className="font-semibold">Party classification (optional)</h3>
                  <p className="text-sm text-slate-500">GSTR-1 does not say whether a registered customer is a composition dealer or an EOU. Enter one GSTIN per line followed by composition, eou, sez or other, and the turnover classification will separate them.</p>
                </div>
                <textarea value={partyTypes} onChange={(e) => setPartyTypes(e.target.value)} rows={3} placeholder={"27ABCDE1234F1Z5 composition\n29PQRST1234K1Z5 eou"} className={`${input} font-mono`} />
                <button onClick={() => run("settings", () => outputApi.settings(clientId, fy, partyTypes), "Saved.")} disabled={busy === "settings"} className="px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">Save</button>
              </div>

              {data.ready && (
                <>
                  <div className={`${card} p-5`}>
                    <h3 className="font-semibold mb-3">What has been uploaded, month by month</h3>
                    <div className="overflow-x-auto">
                      <table className="text-sm">
                        <thead><tr className="text-xs text-slate-500"><th className="pr-4 text-left font-medium"></th>{cov.map((c) => <th key={c.month} className="px-2 font-medium">{c.label}</th>)}</tr></thead>
                        <tbody>
                          {([["books", "Books"], ["gstr1", "GSTR-1"], ["gstr3b", "GSTR-3B"]] as const).map(([k, label]) => (
                            <tr key={k}>
                              <td className="pr-4 py-1 font-medium">{label}</td>
                              {cov.map((c) => <td key={c.month} className="px-2 py-1 text-center">{c[k] ? <CheckCircle2 className="w-4 h-4 text-emerald-600 inline" /> : <span className="text-slate-300">-</span>}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {data.notes.map((n, i) => <p key={i} className="text-xs text-amber-700 mt-2 flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{n}</p>)}
                  </div>

                  {T && (
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {([["GSTR-1 taxable value", T.g1.taxable], ["GSTR-3B taxable value", T.b3.taxable], ["Books taxable value", T.books.taxable]] as [string, number][]).map(([l, v]) => (
                        <div key={l} className={`${card} p-4`}><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-semibold tabular-nums mt-1">₹{inr(v)}</div></div>
                      ))}
                      <div className={`${card} p-4`}><div className="text-xs text-slate-500">Differences to resolve</div><div className="text-xl font-semibold tabular-nums mt-1">{data.difference_count}</div><div className="text-xs text-slate-500">{data.parties.different} of {data.parties.total} parties differ</div></div>
                    </div>
                  )}

                  <div className="grid lg:grid-cols-3 gap-4">
                    <CompareTable title="GSTR-1 against GSTR-3B" nameA="GSTR-1" nameB="GSTR-3B" rows={data.compare.g1_vs_3b.rows} total={data.compare.g1_vs_3b.total} />
                    <CompareTable title="GSTR-1 against books" nameA="GSTR-1" nameB="Books" rows={data.compare.g1_vs_books.rows} total={data.compare.g1_vs_books.total} />
                    <CompareTable title="GSTR-3B against books" nameA="GSTR-3B" nameB="Books" rows={data.compare.b3_vs_books.rows} total={data.compare.b3_vs_books.total} />
                  </div>

                  <div className={`${card} overflow-hidden`}>
                    <div className="px-5 py-3 border-b border-slate-100">
                      <h3 className="font-semibold">Turnover and liability by classification</h3>
                      <p className="text-xs text-slate-500">From GSTR-1. The Excel adds capital assets, reverse charge on inward supplies, HSN and rate-wise summaries.</p>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-4 py-2 text-left font-medium">Classification</th><th className="px-3 py-2 text-right font-medium">Taxable value</th><th className="px-3 py-2 text-right font-medium">IGST</th><th className="px-3 py-2 text-right font-medium">CGST</th><th className="px-3 py-2 text-right font-medium">SGST</th><th className="px-3 py-2 text-right font-medium">Docs</th></tr></thead>
                        <tbody>
                          {data.classification.map((c) => (
                            <tr key={c.key} className="border-t border-slate-100"><td className="px-4 py-1.5">{c.name}</td><td className="px-3 py-1.5 text-right tabular-nums">{inr(c.taxable)}</td><td className="px-3 py-1.5 text-right tabular-nums">{inr(c.igst)}</td><td className="px-3 py-1.5 text-right tabular-nums">{inr(c.cgst)}</td><td className="px-3 py-1.5 text-right tabular-nums">{inr(c.sgst)}</td><td className="px-3 py-1.5 text-right tabular-nums">{c.docs}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className={`${card} overflow-hidden`}>
                    <div className="p-5 border-b border-slate-100 space-y-3">
                      <div>
                        <h3 className="font-semibold">Differences, reasons and recommended course of action</h3>
                        <p className="text-sm text-slate-500">The same list is sheet 10 of the Excel.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {areas.map((a) => (
                          <button key={a} onClick={() => setArea(a)} className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${area === a ? "bg-black text-white border-black" : "bg-white text-slate-700 border-slate-300 hover:border-black"}`}>
                            {a === "all" ? "All" : a} ({a === "all" ? data.differences.length : data.differences.filter((d) => d.area === a).length})
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-3 py-2.5 font-medium">Item</th><th className="px-3 py-2.5 font-medium text-right">Difference (taxable)</th><th className="px-3 py-2.5 font-medium">Reason and recommended action</th></tr></thead>
                        <tbody>
                          {diffs.map((d, i) => (
                            <tr key={i} className="border-t border-slate-100 align-top">
                              <td className="px-3 py-3 w-64"><div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{d.area}{d.period ? ` · ${monthName(d.period)}` : ""}</div><div className="font-medium break-words">{d.item}</div></td>
                              <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap">{d.d && typeof d.d.taxable === "number" ? <span className={Math.abs(d.d.taxable) > 1 ? "text-rose-700 font-semibold" : ""}>{inr(d.d.taxable)}</span> : "-"}</td>
                              <td className="px-3 py-3 min-w-[28rem]">
                                <p className="text-slate-800">{d.reason}</p>
                                <p className="text-slate-600 mt-1"><span className="font-medium">What to do: </span>{d.action}</p>
                                {d.ref && <p className="text-xs text-slate-400 mt-1">{d.ref}</p>}
                              </td>
                            </tr>
                          ))}
                          {!diffs.length && <tr><td colSpan={3} className="px-5 py-8 text-center text-slate-500">Nothing in this view.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
              {!data.ready && (
                <div className={`${card} p-10 text-center text-sm text-slate-500`}>
                  <FileSpreadsheet className="w-8 h-8 mx-auto mb-2 text-slate-400" />
                  Upload the books, the GSTR-1 files and the GSTR-3B of each month. The reconciliation and the Excel working appear here.
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
