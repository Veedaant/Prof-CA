import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useRouter } from "@/lib/router";
import { BookOpen, Globe, Scale, Upload, FileText, Download, Trash2, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, inputReconApi, BusinessInfo, Client, FinalPair, FinalState, InputFile, InputKind, InputState, ItcHeads, RcmState, RecoState } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { currentFy, fyOptions, monthLabel, monthsOfFy } from "@/lib/fy";

type Tab = "books" | "portal" | "reco";

const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const input = "w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-60";
const label = "block text-xs font-semibold text-slate-600 mb-1.5";
const SHEETS = ".xlsx,.xlsm,.xls,.xlsb,.csv";
const PDF_SHEETS = ".pdf,.xlsx,.xlsm,.xls,.xlsb,.csv";

/** The two sub-sections and what each takes. A box is one kind of file; a sub-section can hold more than one box. */
const GROUPS: Record<Tab, { title: string; intro: string; icon: typeof BookOpen; sections: { title: string; hint: string; rcm?: boolean; combined?: { what: "itc" | "portal" | "work3b" | "rcm"; button: string; kinds: InputKind[] }; boxes: { kind: InputKind; title: string; hint: string; accept: string; monthly?: boolean }[] }[] }> = {
  books: {
    title: "Books", icon: BookOpen, intro: "Ledgers from the client's books for the year, as Excel or CSV.",
    sections: [
      { title: "Input ITC ledger", hint: "The input tax credit ledgers (IGST, CGST, SGST, cess).", combined: { what: "itc", button: "Download combined Excel", kinds: ["books_itc"] }, boxes: [{ kind: "books_itc", title: "Input ITC ledger", hint: "One file for the year, or one per ledger.", accept: SHEETS }] },
      { title: "Cash ledger", hint: "The ledger of GST paid in cash.", boxes: [{ kind: "books_cash", title: "Cash ledger", hint: "The cash ledger as kept in the books.", accept: SHEETS }] },
      { title: "TDS and TCS as per GST Act", hint: "TDS and TCS receivable under the GST Act (sections 51 and 52).", boxes: [{ kind: "books_tdstcs", title: "TDS and TCS ledgers", hint: "The ledgers of TDS and TCS under GST.", accept: SHEETS }] },
      {
        title: "RCM (reverse charge)", hint: "Upload the expense ledgers. The reverse charge is worked out on them for this client's nature of business.", rcm: true,
        combined: { what: "rcm", button: "Download RCM working (Excel)", kinds: ["books_rcm"] },
        boxes: [{ kind: "books_rcm", title: "Expense ledgers", hint: "The ledger of each expense (freight, legal fees, commission, rent, advertisement and the others), one file with a sheet for each ledger or several files.", accept: SHEETS }],
      },
    ],
  },
  portal: {
    title: "GST Portal", icon: Globe, intro: "What the GST portal shows for the same year.",
    sections: [
      { title: "GSTR-2B", hint: "The Excel downloaded from the portal, one for each month.", combined: { what: "portal", button: "Download combined GSTR-2B and 3B Excel", kinds: ["gstr2b", "gstr3b"] }, boxes: [{ kind: "gstr2b", title: "GSTR-2B", hint: "Excel with the B2B and B2B-CDNR sheets.", accept: SHEETS, monthly: true }] },
      { title: "GSTR-3B", hint: "The return for each month, as PDF or Excel.", combined: { what: "portal", button: "Download combined GSTR-2B and 3B Excel", kinds: ["gstr2b", "gstr3b"] }, boxes: [{ kind: "gstr3b", title: "GSTR-3B", hint: "PDF from the portal, or an Excel with the same layout.", accept: PDF_SHEETS, monthly: true }] },
      {
        title: "Cash and Credit Ledger", hint: "The electronic ledgers from the portal.",
        boxes: [
          { kind: "portal_cash", title: "Electronic cash ledger", hint: "PDF or Excel for the year.", accept: PDF_SHEETS },
          { kind: "portal_credit", title: "Electronic credit ledger", hint: "PDF or Excel for the year.", accept: PDF_SHEETS },
        ],
      },
    ],
  },
  reco: {
    title: "Input Reco", icon: Scale, intro: "Step 1 checks that the GSTR-3B workings agree with the GSTR-3B actually filed. Step 2 reconciles the books, GSTR-2B and the finalised GSTR-3B working month by month, party by party and document by document.",
    sections: [
      {
        title: "Step 1: GSTR-3B workings and the filed GSTR-3B", hint: "Upload the working of every month with the ITC claimed. The ITC of each working is matched with the GSTR-3B filed (uploaded under GST Portal).",
        boxes: [{ kind: "work3b", title: "GSTR-3B workings", hint: "One Excel for each month, with Table 4 (ITC). The month is read from the file.", accept: SHEETS, monthly: true }],
      },
      {
        title: "Step 2: Final reconciliation", hint: "After the GSTR-3B working is finalised, upload it here, then prepare the reconciliation.",
        boxes: [{ kind: "final3b", title: "Finalised GSTR-3B working (combined)", hint: "The combined 3B workings Excel from Step 1, after your corrections. It needs the ITC Documents sheet. If none is uploaded, the Step 1 workings are used.", accept: SHEETS }],
      },
    ],
  },
};

const inr = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const tot = (h: ItcHeads | null | undefined) => (h ? Math.round((h.igst + h.cgst + h.sgst + h.cess) * 100) / 100 : null);

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function FileRow({ f, monthly, fy, onChanged, onError }: { f: InputFile; monthly: boolean; fy: string; onChanged: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } };
  const i = f.info;
  const span = i.from && i.to ? `${i.from} to ${i.to}` : "";
  return (
    <li className="p-3 rounded-xl border border-slate-200 bg-white text-xs space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="min-w-0">
            <span className="block font-medium text-slate-800 truncate">{f.name}</span>
            <span className="block text-[10px] text-slate-400">{size(f.size)}</span>
          </span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {monthly && (
            <select aria-label={`Month of ${f.name}`} value={f.period || ""} disabled={busy} onChange={(e) => run(async () => { const r = await inputReconApi.setPeriod(f.id, e.target.value); if (r.outside) onError(`That month is outside ${fy}.`); onChanged(); })} className="px-2 py-1 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-medium">
              <option value="">Select month</option>
              {[...monthsOfFy(fy), ...(f.period && !monthsOfFy(fy).includes(f.period) ? [f.period] : [])].map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          )}
          <button type="button" disabled={busy} onClick={() => run(() => inputReconApi.download(f.id))} className="p-1.5 rounded-lg text-slate-600 hover:bg-slate-100" title="Download" aria-label={`Download ${f.name}`}><Download className="w-4 h-4" /></button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm("Delete this file?")) run(async () => { await inputReconApi.remove(f.id); onChanged(); }); }} className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" title="Delete" aria-label={`Delete ${f.name}`}><Trash2 className="w-4 h-4" /></button>
        </span>
      </div>
      <p className={`flex items-center gap-1.5 ${i.read ? "text-emerald-700" : "text-amber-700"}`}>
        {i.read ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
        {!i.read ? "Saved, but not read yet" : i.claimed ? `ITC claimed in this working: Rs ${inr(tot(i.claimed))} (IGST ${inr(i.claimed.igst)}, CGST ${inr(i.claimed.cgst)}, SGST ${inr(i.claimed.sgst)}, Cess ${inr(i.claimed.cess)})` : `${i.rows} line(s) read${span ? `, ${span}` : ""}${i.ledgers?.length ? `, ledgers: ${i.ledgers.slice(0, 6).join(", ")}${i.ledgers.length > 6 ? ` and ${i.ledgers.length - 6} more` : ""}` : ""}`}
      </p>
      {i.warnings.map((w, k) => <p key={k} className="text-[11px] text-amber-700">{w}</p>)}
    </li>
  );
}

function Box({ kind, title, hint, accept, monthly, fy, clientId, files, onChanged }: {
  kind: InputKind; title: string; hint: string; accept: string; monthly?: boolean; fy: string; clientId: string; files: InputFile[]; onChanged: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const send = async (list: File[]) => {
    if (!list.length) return;
    setBusy(true); setProblems([]);
    try {
      const r = await inputReconApi.upload(clientId, fy, kind, list);
      setProblems(r.results.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`));
      onChanged();
    } catch (e: any) { setProblems([e.message]); } finally { setBusy(false); }
  };
  const pick = (e: ChangeEvent<HTMLInputElement>) => { const l = Array.from(e.target.files || []); e.target.value = ""; send(l); };
  const drop = (e: DragEvent) => { e.preventDefault(); setDrag(false); send(Array.from(e.dataTransfer.files)); };
  const months = monthly ? monthsOfFy(fy) : [];
  return (
    <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}
      className={`rounded-xl border-2 border-dashed p-4 space-y-3 transition ${drag ? "border-blue-500 bg-blue-50/50" : "border-slate-300"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-800">{title}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{hint} You can drop several files here.</p>
        </div>
        <button type="button" disabled={busy} onClick={() => ref.current?.click()} className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Choose files
        </button>
        <input ref={ref} type="file" multiple accept={accept} onChange={pick} className="hidden" aria-label={title} />
      </div>
      {monthly && (
        <div className="flex flex-wrap gap-1.5" aria-label={`Months uploaded for ${title}`}>
          {months.map((m) => {
            const n = files.filter((f) => f.period === m).length;
            return <span key={m} title={n ? `${n} file(s)` : "Not uploaded"} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${n ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-50 border-slate-200 text-slate-400"}`}>{monthLabel(m)}</span>;
          })}
        </div>
      )}
      {problems.map((p, i) => <p key={i} role="alert" className="text-[11px] text-rose-700">{p}</p>)}
      {files.length > 0 && <ul className="space-y-2">{files.map((f) => <FileRow key={f.id} f={f} monthly={Boolean(monthly)} fy={fy} onChanged={onChanged} onError={(m) => setProblems([m])} />)}</ul>}
    </div>
  );
}

/** One Excel of every file of the sub-section, with the details and the monthly workings. */
function CombinedButton({ what, label: text, clientId, fy, ready }: { what: "itc" | "portal" | "work3b" | "reco" | "final" | "rcm"; label: string; clientId: string; fy: string; ready: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => { setBusy(true); setError(null); try { await inputReconApi.combined(what, clientId, fy); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return (
    <div className="flex flex-col items-end gap-1 max-w-sm">
      <button type="button" onClick={go} disabled={!ready || busy} title={ready ? "All the uploaded files of this sub-section in one Excel" : "Upload a file that can be read first"}
        className="px-3.5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
        {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} {text}
      </button>
      {error && <p role="alert" className="text-[11px] text-rose-700 text-right">{error}</p>}
    </div>
  );
}

const STATUS: Record<RecoState["rows"][number]["status"], string> = {
  Matches: "bg-emerald-50 text-emerald-700 border-emerald-200", "Does not match": "bg-rose-50 text-rose-700 border-rose-200",
  "No working": "bg-amber-50 text-amber-700 border-amber-200", "No GSTR-3B": "bg-amber-50 text-amber-700 border-amber-200", "Not uploaded": "bg-slate-50 text-slate-400 border-slate-200",
};

/** Books, RCM: the client's nature of business, and the reverse charge worked out on the expense ledgers uploaded. */
function RcmPanel({ business, clientId, fy, files, onChanged }: { business: BusinessInfo; clientId: string; fy: string; files: InputFile[]; onChanged: () => void }) {
  const [rcm, setRcm] = useState<RcmState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stamp = files.filter((f) => ["books_rcm", "books_itc", "gstr2b"].includes(f.kind)).map((f) => f.id).join(",");
  useEffect(() => {
    let live = true;
    inputReconApi.rcm(clientId, fy).then((r) => { if (live) { setRcm(r); setError(null); } }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [clientId, fy, stamp, business.nature]);
  const choose = async (nature: string) => { setBusy(true); setError(null); try { await inputReconApi.setBusiness(clientId, nature); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };

  const t = rcm?.totals;
  const tiles: [string, string][] = t ? [["Entries reviewed", String(t.entries)], ["RCM entries", String(t.rcmEntries)], ["Taxable value", inr(t.taxable)], ["Total RCM", inr(t.tot)], ["ITC available on RCM", inr(t.itc)]] : [];
  const months = (rcm?.months || []).filter((m) => m.entries > 0);
  return (
    <div className="space-y-4" aria-label="RCM working">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
        <div>
          <label className={label} htmlFor="rcm-business">Nature of business of this client</label>
          <select id="rcm-business" value={business.nature} disabled={busy} onChange={(e) => choose(e.target.value)} className={input}>
            <option value="">Not set</option>
            {business.options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </div>
        <p className="text-[11px] text-slate-500">It decides which reverse-charge categories apply, for example insurance agent's commission applies to an insurance company only, and the ITC on the RCM for exempt supplies.{business.constitution ? ` Constitution, from the GSTIN: ${business.constitution}.` : ""}</p>
      </div>
      {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
      {!business.nature && <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">The nature of business is not set. Categories that depend on it are left out until it is.</p>}
      {rcm && !rcm.have && <p className="text-xs text-slate-500">Upload the expense ledgers above. The RCM is worked out on them as soon as they are read.</p>}
      {rcm?.have && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {tiles.map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5"><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>)}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr><th className="text-left p-2">Month</th><th className="text-right p-2">Expenses as per ledgers</th><th className="text-right p-2">RCM entries</th><th className="text-right p-2">Taxable value</th><th className="text-right p-2">IGST</th><th className="text-right p-2">CGST</th><th className="text-right p-2">SGST</th><th className="text-right p-2">Total RCM</th></tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month} className="border-t border-slate-100">
                    <td className="p-2 font-medium">{monthLabel(m.month)}</td><td className="p-2 text-right">{inr(m.expense)}</td><td className="p-2 text-right">{m.rcmEntries}</td><td className="p-2 text-right">{inr(m.taxable)}</td>
                    <td className="p-2 text-right">{inr(m.igst)}</td><td className="p-2 text-right">{inr(m.cgst)}</td><td className="p-2 text-right">{inr(m.sgst)}</td><td className="p-2 text-right font-semibold">{inr(m.tot)}</td>
                  </tr>
                ))}
                {t && <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold"><td className="p-2">Total</td><td className="p-2 text-right">{inr(t.expense)}</td><td className="p-2 text-right">{t.rcmEntries}</td><td className="p-2 text-right">{inr(t.taxable)}</td><td className="p-2 text-right">{inr(t.igst)}</td><td className="p-2 text-right">{inr(t.cgst)}</td><td className="p-2 text-right">{inr(t.sgst)}</td><td className="p-2 text-right">{inr(t.tot)}</td></tr>}
              </tbody>
            </table>
          </div>
          {rcm.categories.length > 0 && (
            <ul className="text-[11px] text-slate-600 space-y-0.5">
              {rcm.categories.map((c) => <li key={c.category}>{c.category}: {c.entries} entr{c.entries === 1 ? "y" : "ies"}, taxable Rs {inr(c.taxable)}, RCM Rs {inr(c.tax)}</li>)}
            </ul>
          )}
          {rcm.held > 0 && <p className="text-[11px] text-slate-500">{rcm.held} entr{rcm.held === 1 ? "y matched" : "ies matched"} a reverse-charge category but RCM is not payable (the supplier charged GST, or the category does not apply to this client). They are on sheet 3 of the Excel, with the reason.</p>}
          {rcm.warnings.filter((w) => !w.startsWith("The client's nature of business is not set")).map((w, i) => <p key={i} className="text-[11px] text-amber-700">{w}</p>)}
        </>
      )}
    </div>
  );
}

type BoxCfg = (typeof GROUPS)["reco"]["sections"][number]["boxes"][number];

/** The ITC of each month's working against the ITC of the GSTR-3B filed, with the months that do not match explained. */
function MatchTable({ reco, error }: { reco: RecoState | null; error: string | null }) {
  const s = reco?.summary;
  const stats: [string, number | undefined, boolean?][] = [["Months compared", s?.compared], ["Match", s?.matching], ["Do not match", s?.differing, Boolean(s?.differing)], ["Working missing", s?.noWorking], ["GSTR-3B missing", s?.noPortal]];
  const rows = (reco?.rows || []).filter((r) => !r.outsideYear || r.working || r.portal);
  return (
    <div className="space-y-4" aria-label="Match with the actual GSTR-3B">
      {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
      {reco && !reco.have.working && <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">Upload the GSTR-3B workings above to start.</p>}
      {reco && reco.have.working && !reco.have.portal && <p className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">No GSTR-3B has been uploaded under GST Portal yet, so there is nothing to match with. Upload the filed GSTR-3B of each month there.</p>}
      {reco && reco.have.working && (
        <>
          <p className="text-xs text-slate-500">The ITC each working claims (Table 4: all of 4(A) less 4(B)) against the same figure in the GSTR-3B filed.</p>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {stats.map(([k, v, bad]) => (
              <div key={k} className={`rounded-xl border p-2.5 ${bad ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"}`}><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full text-xs">
              <thead className="bg-slate-100 text-slate-600">
                <tr><th className="text-left p-2">Month</th><th className="text-right p-2">ITC as per 3B working</th><th className="text-right p-2">ITC as per GSTR-3B filed</th><th className="text-right p-2">Difference</th><th className="text-left p-2">Status</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.month}>
                    <tr className={`border-t border-slate-100 ${r.status === "Does not match" ? "bg-rose-50/40" : ""}`}>
                      <td className="p-2 font-medium">{r.label}</td>
                      <td className="p-2 text-right">{inr(tot(r.working?.net))}</td>
                      <td className="p-2 text-right">{inr(tot(r.portal?.net))}</td>
                      <td className="p-2 text-right font-semibold">{inr(r.diffTotal)}</td>
                      <td className="p-2"><span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-semibold ${STATUS[r.status]}`}>{r.status}</span></td>
                    </tr>
                    {r.status === "Does not match" && <tr className="bg-rose-50/40"><td colSpan={5} className="px-2 pb-2 text-[11px] text-rose-800">{r.remark}</td></tr>}
                  </Fragment>
                ))}
                {s && s.compared > 0 && (
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold"><td className="p-2">Total of months compared</td><td className="p-2 text-right">{inr(s.workingTotal)}</td><td className="p-2 text-right">{inr(s.portalTotal)}</td><td className="p-2 text-right">{inr(s.diffTotal)}</td><td className="p-2" /></tr>
                )}
              </tbody>
            </table>
          </div>
          {reco.replaced.map((f) => <p key={f.name} className="text-[11px] text-slate-500">{f.name} is not used: a later {f.side === "working" ? "working" : "GSTR-3B"} for the same month was uploaded.</p>)}
          {reco.unplaced.map((f) => <p key={f.name} className="text-[11px] text-amber-700">{f.name} is not used: its month is not set. Choose the month on the list.</p>)}
        </>
      )}
    </div>
  );
}

/** Step 1: upload every month's working, download them combined, download the match with the filed GSTR-3B, and see it. */
function Step1({ cfg, clientId, fy, files, onChanged }: { cfg: { title: string; hint: string; box: BoxCfg }; clientId: string; fy: string; files: InputFile[]; onChanged: () => void }) {
  const [reco, setReco] = useState<RecoState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stamp = files.map((f) => `${f.id}:${f.period}`).join(",");
  useEffect(() => {
    let live = true;
    inputReconApi.reco(clientId, fy).then((r) => { if (live) { setReco(r); setError(null); } }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [clientId, fy, stamp]);
  const mine = files.filter((f) => f.kind === "work3b");
  return (
    <section aria-label={cfg.title} className={`${card} p-6 space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{cfg.title}</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-xl">{cfg.hint}</p>
        </div>
        <div className="flex flex-wrap items-start justify-end gap-2">
          <CombinedButton what="work3b" label="Download combined 3B workings Excel" clientId={clientId} fy={fy} ready={mine.some((f) => f.info.read)} />
          <CombinedButton what="reco" label="Download match with filed GSTR-3B (Excel)" clientId={clientId} fy={fy} ready={Boolean(reco?.have.working)} />
        </div>
      </div>
      <Box key={`${cfg.box.kind}-${fy}-${clientId}`} {...cfg.box} fy={fy} clientId={clientId} files={mine} onChanged={onChanged} />
      <MatchTable reco={reco} error={error} />
    </section>
  );
}

const rs = (n: number | null | undefined) => (n == null ? "" : inr(n));

function PairCard({ p }: { p: FinalPair }) {
  const s = p.summary;
  const bad = s.monthsDiffering + s.partiesDiffering + s.documentsDiffering > 0;
  const tiles: [string, string][] = [["Months differing", `${s.monthsDiffering} of ${s.monthsCompared}`], ["Parties differing", `${s.partiesDiffering} of ${s.parties}`], ["Documents differing", String(s.documentsDiffering)]];
  const months = p.months.filter((m) => m.a || m.b);
  return (
    <div className="rounded-xl border border-slate-200 p-4 space-y-3" aria-label={`${p.a} against ${p.b}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-800">{p.a} against {p.b}</h3>
        <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${bad ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>{bad ? "Differences found" : "Agrees"}</span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 bg-slate-50 p-2.5"><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>)}
      </div>
      {months.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 text-slate-600"><tr><th className="text-left p-2">Month</th><th className="text-right p-2">{p.a}</th><th className="text-right p-2">{p.b}</th><th className="text-right p-2">Difference</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.label} className={`border-t border-slate-100 ${m.both && Math.abs(m.diff.tot) > 2 ? "bg-rose-50/40" : ""}`}>
                  <td className="p-2 font-medium">{m.label}</td><td className="p-2 text-right">{rs(m.a?.tot)}</td><td className="p-2 text-right">{rs(m.b?.tot)}</td><td className="p-2 text-right font-semibold">{m.both ? rs(m.diff.tot) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {p.diffs.length > 0 && (
        <ul className="space-y-1.5">
          {p.diffs.map((d, i) => (
            <li key={i} className="text-[11px] text-slate-700 p-2 rounded-lg bg-slate-50 border border-slate-100">
              <span className="font-semibold">{d.party || "No party name"}</span>{d.gstin ? ` (${d.gstin})` : ""} · {d.no} · {d.type}{d.diff ? ` · Rs ${inr(d.diff)}` : ""}
              <span className="block text-slate-500 mt-0.5">{d.remark}</span>
            </li>
          ))}
          {s.documentsDiffering > p.diffs.length && <li className="text-[11px] text-slate-500">...and {s.documentsDiffering - p.diffs.length} more in the Excel.</li>}
        </ul>
      )}
    </div>
  );
}

/** The reverse charge month by month: worked out on the expense ledgers, booked, paid in GSTR-3B 3.1(d) and the ITC claimed in 4(A)(3). */
function RcmRecoCard({ rcm }: { rcm: FinalState["rcm"] }) {
  const s = rcm.summary;
  const bad = s.differing > 0;
  const months = rcm.months.filter((m) => m.ledger || m.books || m.paid || m.claimed);
  return (
    <div className="rounded-xl border border-slate-200 p-4 space-y-3" aria-label="RCM reconciliation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold text-slate-800">RCM reconciliation</h3>
        <span className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${!months.length ? "bg-slate-50 text-slate-500 border-slate-200" : bad ? "bg-rose-50 text-rose-700 border-rose-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>{!months.length ? "Nothing to compare" : bad ? `${s.differing} month(s) differ` : "Agrees"}</span>
      </div>
      {!rcm.have && <p className="text-[11px] text-amber-700">No expense ledger is uploaded under Books &gt; RCM, so the RCM on the expenses is not in this comparison. The tax paid and the ITC claimed are still shown.</p>}
      {months.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 text-slate-600"><tr><th className="text-left p-2">Month</th><th className="text-right p-2">RCM on ledgers</th><th className="text-right p-2">Booked</th><th className="text-right p-2">Paid in 3B (3.1(d))</th><th className="text-right p-2">ITC claimed (4(A)(3))</th><th className="text-left p-2">Status</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <Fragment key={m.label}>
                  <tr className={`border-t border-slate-100 ${m.status === "Differs" ? "bg-rose-50/40" : ""}`}>
                    <td className="p-2 font-medium">{m.label}</td><td className="p-2 text-right">{rs(m.ledger?.tot)}</td><td className="p-2 text-right">{rs(m.books?.tot)}</td><td className="p-2 text-right">{rs(m.paid?.tot)}</td><td className="p-2 text-right">{rs(m.claimed?.tot)}</td><td className="p-2">{m.status}</td>
                  </tr>
                  {m.status === "Differs" && <tr className="bg-rose-50/40"><td colSpan={6} className="px-2 pb-2 text-[11px] text-rose-800">{m.remark}</td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="text-[11px] text-slate-500">No RCM on the ledgers, in the books, or in GSTR-3B for the year.</p>}
      <p className="text-[11px] text-slate-500">Also carried into the GSTR-9 and 9C draft (Table 4G, 6C and 6D). GSTR-3B is {s.filedMonths ? `the filed return for ${s.filedMonths} month(s)` : "the 3B working"}{s.filedMonths && s.workingMonths ? ` and the 3B working for ${s.workingMonths}` : ""}.</p>
    </div>
  );
}

/** Step 2: the finalised working is uploaded, the reconciliation is prepared, and the final Excel is downloaded. */
function Step2({ cfg, clientId, fy, files, onChanged }: { cfg: { title: string; hint: string; box: BoxCfg }; clientId: string; fy: string; files: InputFile[]; onChanged: () => void }) {
  const [prepared, setPrepared] = useState<{ key: string; data: FinalState } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const has = (kind: InputKind) => files.some((f) => f.kind === kind && f.info.read);
  const final = has("final3b"), work = has("work3b");
  // the result belongs to the files it was prepared from: once they change, it is out of date and is not shown
  const key = `${clientId}|${fy}|${files.filter((f) => ["books_itc", "books_tdstcs", "books_rcm", "gstr2b", "gstr3b", "work3b", "final3b"].includes(f.kind)).map((f) => `${f.id}:${f.period}`).join(",")}`;
  const result = prepared && prepared.key === key ? prepared.data : null;
  const checks: { text: string; done: boolean; note?: string }[] = [
    { text: "Input ITC register under Books", done: has("books_itc") },
    { text: "GSTR-2B of the months under GST Portal", done: has("gstr2b") },
    { text: "GSTR-3B working", done: final || work, note: final ? "finalised file uploaded" : work ? "no finalised file: the Step 1 workings will be used" : "" },
    { text: "TDS and TCS ledgers under Books, if the client has any", done: has("books_tdstcs"), note: "optional" },
    { text: "Expense ledgers under Books > RCM, for the RCM reconciliation", done: has("books_rcm"), note: "optional" },
  ];
  const canStart = has("books_itc") && has("gstr2b") && (final || work);
  const prepare = async () => { setBusy(true); setError(null); try { setPrepared({ key, data: await inputReconApi.final(clientId, fy) }); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return (
    <section aria-label={cfg.title} className={`${card} p-6 space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{cfg.title}</h2>
          <p className="text-xs text-slate-500 mt-1 max-w-xl">{cfg.hint}</p>
        </div>
        <CombinedButton what="final" label="Download final reconciliation (Excel)" clientId={clientId} fy={fy} ready={canStart} />
      </div>
      <Box key={`${cfg.box.kind}-${fy}-${clientId}`} {...cfg.box} fy={fy} clientId={clientId} files={files.filter((f) => f.kind === "final3b")} onChanged={onChanged} />
      <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" aria-label="Files needed">
        {checks.map((c) => (
          <li key={c.text} className={`text-[11px] flex items-start gap-1.5 ${c.done ? "text-emerald-700" : c.note === "optional" ? "text-slate-500" : "text-amber-700"}`}>
            {c.done ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />}
            <span>{c.text}{c.note ? ` (${c.note})` : ""}</span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={prepare} disabled={!canStart || busy} className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
          {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} {result ? "Prepare again" : "Start final reconciliation"}
        </button>
        {!canStart && <span className="text-[11px] text-slate-500">Upload the files marked above to start.</span>}
      </div>
      {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
      {result && (
        <div className="space-y-4" aria-label="Result of the final reconciliation">
          <p className="text-xs text-slate-500">{result.source.tb === "final" ? `GSTR-3B working used: ${result.source.name}.` : result.source.tb === "workings" ? "GSTR-3B working used: the latest monthly workings of Step 1." : "No GSTR-3B working available."} The Excel has the full detail: 12 sheets with the combined ledgers, month-wise tables, party pivots (filter on Category for TDS, TCS, RCM and normal ITC), the differences with remarks, GSTR-9 and 9C, and the RCM reconciliation.</p>
          {result.warnings.map((w, i) => <p key={i} className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-[11px] text-amber-800">{w}</p>)}
          {result.pairs.map((p) => <PairCard key={p.id} p={p} />)}
          <RcmRecoCard rcm={result.rcm} />

          {result.tdsTcs.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 text-slate-600"><tr><th className="text-left p-2">TDS / TCS</th><th className="text-right p-2">Books</th><th className="text-right p-2">GSTR-2B</th><th className="text-right p-2">GSTR-3B working</th></tr></thead>
                <tbody>{result.tdsTcs.map((r) => <tr key={r.category} className="border-t border-slate-100"><td className="p-2 font-medium">{r.category}</td><td className="p-2 text-right">{rs(r.books.tot)}</td><td className="p-2 text-right">{rs(r.gstr2b.tot)}</td><td className="p-2 text-right">{rs(r.tb.tot)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default function InputReconPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [fy, setFy] = useState(currentFy());
  const [tab, setTab] = useState<Tab>("books");
  const [state, setState] = useState<InputState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!authLoading && !user) router.push("/login"); }, [user, authLoading, router]);
  useEffect(() => {
    if (!user) return;
    if (user.role === "client") { router.push("/dashboard"); return; }
    api.clients.list().then((cls) => { setClients(cls); setClientId(cls[0]?.id || ""); }).catch((e) => setError(e.message));
  }, [user, router]);

  const load = useCallback(() => {
    if (!clientId) return;
    inputReconApi.state(clientId, fy).then((s) => { setState(s); setError(null); }).catch((e) => setError(e.message));
  }, [clientId, fy]);
  useEffect(() => { load(); }, [load]);

  const count = (t: Tab) => (state?.files || []).filter((f) => GROUPS[t].sections.some((s) => s.boxes.some((b) => b.kind === f.kind))).length;
  const years = [...new Set([fy, ...fyOptions()])].sort().reverse();

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Input Reconciliation" subtitle="Books and GST portal records for the year, kept together for the reconciliation" />
        <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
          <div className={`${card} p-5 grid grid-cols-1 sm:grid-cols-2 gap-4`}>
            <div>
              <label className={label} htmlFor="ir-client">Client</label>
              <select id="ir-client" value={clientId} onChange={(e) => { setClientId(e.target.value); setState(null); }} className={input}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="ir-fy">Financial year</label>
              <select id="ir-fy" value={fy} onChange={(e) => { setFy(e.target.value); setState(null); }} className={input}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>

          <div role="tablist" className="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200">
            {(Object.keys(GROUPS) as Tab[]).map((t) => {
              const Icon = GROUPS[t].icon;
              return (
                <button key={t} role="tab" aria-selected={tab === t} type="button" onClick={() => setTab(t)}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 ${tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                  <Icon className="w-4 h-4" /> {GROUPS[t].title}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${tab === t ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>{count(t)}</span>
                </button>
              );
            })}
          </div>

          {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
          <p className="text-xs text-slate-500">{GROUPS[tab].intro}</p>

          {state && clientId ? (
            <div className="space-y-5">
              {tab === "reco" && GROUPS.reco.sections.map((s, i) => {
                const Step = i === 0 ? Step1 : Step2;
                return <Step key={s.title} cfg={{ title: s.title, hint: s.hint, box: s.boxes[0] }} clientId={clientId} fy={fy} files={state.files} onChanged={load} />;
              })}
              {tab !== "reco" && GROUPS[tab].sections.map((s) => (
                <section key={s.title} aria-label={s.title} className={`${card} p-6 space-y-4`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{s.title}</h2>
                      <p className="text-xs text-slate-500 mt-1">{s.hint}</p>
                    </div>
                    {s.combined && <CombinedButton what={s.combined.what} label={s.combined.button} clientId={clientId} fy={fy} ready={state.files.some((f) => s.combined!.kinds.includes(f.kind) && f.info.read)} />}
                  </div>
                  {s.boxes.map((b) => (
                    <Box key={`${b.kind}-${fy}-${clientId}`} {...b} fy={fy} clientId={clientId} files={state.files.filter((f) => f.kind === b.kind)} onChanged={load} />
                  ))}
                  {s.rcm && <RcmPanel business={state.business} clientId={clientId} fy={fy} files={state.files} onChanged={load} />}
                </section>
              ))}
            </div>
          ) : !error && <p className="text-xs text-slate-500">Loading...</p>}

          {tab !== "reco" && <p className="text-[11px] text-slate-400">The files are saved for the year. The reconciliation of the books with the GST portal is in the Input Reco tab.</p>}
        </div>
      </main>
    </div>
  );
}
