import { Fragment, useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { useRouter } from "@/lib/router";
import { ClipboardCheck, Upload, FileText, Download, Trash2, Send, RefreshCw, ChevronDown, ChevronRight, AlertTriangle, CheckCircle2, Eye, EyeOff } from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, auditApi, AuditChecklist, AuditGroup, AuditState, Client } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { ItemFiles, Progress, StatusChip } from "@/components/AuditBits";
import { AuditDocumentList } from "@/components/AuditDocuments";
import { ProgrammeTracker } from "@/components/AuditProgramme";
import { bankLine, bySection, dayOf } from "@/lib/audit";
import { currentFy, fyOptions } from "@/lib/fy";

const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const input = "w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-60";
const label = "block text-xs font-semibold text-slate-600 mb-1.5";
const SHEETS = ".xlsx,.xlsm,.xls,.xlsb,.csv";
const ROLE_TEXT = { programme: "Audit programme", documents: "Documents required", skipped: "Not used" } as const;

/** Step 1: the audit checklist workbook is uploaded, or replaced. */
function SheetBox({ clientId, fy, checklist, onChanged }: { clientId: string; fy: string; checklist: AuditChecklist | null; onChanged: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (file?: File) => {
    if (!file) return;
    if (checklist && !window.confirm("Replace the checklist? Documents the client has uploaded, your marks on the documents and points, and the queries all stay with their lines.")) return;
    setBusy(true); setError(null);
    try { await auditApi.uploadSheet(clientId, fy, file); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  const pick = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ""; send(f); };
  const drop = (e: DragEvent) => { e.preventDefault(); setDrag(false); send(e.dataTransfer.files[0]); };
  const remove = async () => {
    if (!window.confirm("Delete this checklist, its queries and every file the client uploaded against it? This cannot be undone.")) return;
    setBusy(true);
    try { await auditApi.remove(clientId, fy); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Step 1: audit checklist" className={`${card} p-6 space-y-4`}>
      <div>
        <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Step 1: Audit checklist</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">Upload the audit checklist workbook, as Excel (any version) or CSV. The first sheet is the audit programme: the points to check, such as the opening balances. The second sheet is the documents required. The system reads both, checks which documents the client has already given (banking, GST returns, invoices, Form 26AS), and lists what is still pending month by month.</p>
      </div>
      <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={drop}
        className={`rounded-xl border-2 border-dashed p-4 flex flex-wrap items-center justify-between gap-3 transition ${drag ? "border-blue-500 bg-blue-50/50" : "border-slate-300"}`}>
        {checklist ? (
          <div className="flex items-center gap-2 min-w-0">
            <FileText className="w-4 h-4 text-slate-500 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-800 truncate">{checklist.sourceName}</p>
              <p className="text-[10px] text-slate-400">Read {dayOf(checklist.updatedAt)}{checklist.uploadedBy ? ` by ${checklist.uploadedBy}` : ""}: {checklist.points.length} audit points, {checklist.summary.totals.documents} documents ({checklist.summary.totals.items} items)</p>
            </div>
          </div>
        ) : <p className="text-xs text-slate-500">Choose the audit checklist workbook for this client and year, or drop it here.</p>}
        <div className="flex items-center gap-2">
          <button type="button" disabled={busy} onClick={() => ref.current?.click()} className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} {checklist ? "Replace checklist" : "Choose checklist"}
          </button>
          {checklist && <button type="button" disabled={busy} onClick={remove} className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" title="Delete checklist" aria-label="Delete checklist"><Trash2 className="w-4 h-4" /></button>}
          <input ref={ref} type="file" accept={SHEETS} onChange={pick} className="hidden" aria-label="Audit checklist workbook" />
        </div>
      </div>
      {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
      {checklist && checklist.readInfo.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-600 mb-1">How the workbook was read</p>
          <ul className="space-y-0.5">
            {checklist.readInfo.map((s) => (
              <li key={s.name} className="text-[11px] text-slate-600">
                <span className="font-medium text-slate-800">{s.name}</span>: {ROLE_TEXT[s.role]}{s.role !== "skipped" ? `, ${s.lines} line${s.lines === 1 ? "" : "s"} read from ${s.column ? (s.headed ? `the "${s.column}" column` : s.column) : "no column"}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {checklist?.warnings.map((w, i) => <p key={i} className="text-[11px] text-amber-700">{w}</p>)}
    </section>
  );
}

function GroupRow({ g, c, clientId, fy, onChanged, onError }: { g: AuditGroup; c: AuditChecklist; clientId: string; fy: string; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); onChanged(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } };
  const items = c.states.filter((s) => g.itemIds.includes(s.id));
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-xl border border-slate-200 bg-white">
      <div className="p-3 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} periods of ${g.name}`} className="p-1 rounded-lg text-slate-500 hover:bg-slate-100"><Chevron className="w-4 h-4" /></button>
        <div className="min-w-0 flex-1 basis-60">
          <p className="text-xs font-semibold text-slate-800">{g.name}{bankLine(g) ? ` (${bankLine(g)})` : ""}</p>
          <p className="text-[10px] text-slate-400">{g.categoryLabel}{g.note ? ` · ${g.note}` : ""}</p>
          {g.pending > 0 && <p className="text-[11px] text-amber-700 mt-0.5">Pending for: {g.pendingText}</p>}
        </div>
        <Progress group={g} />
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${g.state === "complete" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : g.state === "partial" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-rose-50 text-rose-700 border-rose-200"}`}>
          {g.state === "complete" ? "Complete" : g.state === "partial" ? `${g.pending} pending` : "None uploaded"}
        </span>
        {g.pending > 0 && (
          <span className="flex items-center gap-1">
            <button type="button" disabled={busy} onClick={() => run(() => auditApi.markDocument(clientId, fy, g.reqNo, g.account, "received"))} className="text-[11px] px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="Mark every pending period of this document as received (you have it outside the system)">Mark received</button>
            <button type="button" disabled={busy} onClick={() => run(() => auditApi.markDocument(clientId, fy, g.reqNo, g.account, "na"))} className="text-[11px] px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" title="This document does not apply to the client, so the client is not asked for it">Not applicable</button>
          </span>
        )}
      </div>
      {open && (
        <div className="border-t border-slate-100 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="text-left p-2">Period</th><th className="text-left p-2">Status</th><th className="text-left p-2">From</th><th className="text-left p-2">Files</th><th className="p-2" /></tr></thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id} className="border-t border-slate-100 align-top">
                  <td className="p-2 font-medium whitespace-nowrap">{s.periodLabel}</td>
                  <td className="p-2"><StatusChip status={s.status} /></td>
                  <td className="p-2 text-slate-600">{s.source}{s.detail ? <span className="block text-[10px] text-slate-400">{s.detail}</span> : null}</td>
                  <td className="p-2"><ItemFiles files={s.files} canDelete={() => true} onDownload={(f) => run(() => auditApi.downloadFile(f.id))} onDelete={(f) => run(() => auditApi.deleteFile(f.id))} /></td>
                  <td className="p-2 text-right whitespace-nowrap">
                    {s.status === "pending" && <>
                      <button type="button" disabled={busy} onClick={() => run(() => auditApi.mark(s.id, "received"))} className="text-[11px] px-2 py-0.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 mr-1">Mark received</button>
                      <button type="button" disabled={busy} onClick={() => run(() => auditApi.mark(s.id, "na"))} className="text-[11px] px-2 py-0.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Not applicable</button>
                    </>}
                    {s.manual && <button type="button" disabled={busy} onClick={() => run(() => auditApi.mark(s.id, null))} className="text-[11px] px-2 py-0.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50">Undo mark</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

export default function AuditCompliancePage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [fy, setFy] = useState(currentFy());
  const [state, setState] = useState<AuditState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyPending, setOnlyPending] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [previewed, setPreviewed] = useState(false);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { if (!authLoading && !user) router.push("/login"); }, [user, authLoading, router]);
  useEffect(() => {
    if (!user) return;
    if (user.role === "client") { router.push("/audit-documents"); return; }
    api.clients.list().then((cls) => { setClients(cls); setClientId(cls[0]?.id || ""); }).catch((e) => setError(e.message));
  }, [user, router]);

  const load = useCallback(() => {
    if (!clientId) return;
    auditApi.state(clientId, fy).then((s) => { setState(s); setError(null); }).catch((e) => setError(e.message));
  }, [clientId, fy]);
  useEffect(() => { load(); }, [load]);

  const c = state?.checklist || null;
  const t = c?.summary.totals;
  const years = [...new Set([fy, ...fyOptions()])].sort().reverse();
  const shown = c ? bySection(c.summary.groups.filter((g) => !onlyPending || g.pending > 0)) : [];
  const reset = () => { setState(null); setNotice(null); setPreviewing(false); setPreviewed(false); };
  const togglePreview = () => { setPreviewing(!previewing); setPreviewed(true); };
  const send = async () => {
    setSending(true); setError(null); setNotice(null);
    try { await auditApi.send(clientId, fy); setNotice("Sent. The client sees the documents under Audit Documents, has been notified, and can now see and answer your queries."); setPreviewing(false); load(); } catch (e: any) { setError(e.message); } finally { setSending(false); }
  };
  const exportList = async () => { setExporting(true); setError(null); try { await auditApi.exportList(clientId, fy); } catch (e: any) { setError(e.message); } finally { setExporting(false); } };
  const canSend = Boolean(c && t && (t.items > 0 || c.points.length > 0));

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Audit Compliance" subtitle="Upload the audit checklist, send the documents required to the client, and track every point of the audit" />
        <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
          <div className={`${card} p-5 grid grid-cols-1 sm:grid-cols-2 gap-4`}>
            <div>
              <label className={label} htmlFor="ac-client">Client</label>
              <select id="ac-client" value={clientId} onChange={(e) => { setClientId(e.target.value); reset(); }} className={input}>
                {clients.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.gstin || "No GSTIN"})</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="ac-fy">Financial year</label>
              <select id="ac-fy" value={fy} onChange={(e) => { setFy(e.target.value); reset(); }} className={input}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          </div>

          {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
          {notice && <div role="status" className="p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">{notice}</div>}

          {state && clientId ? (
            <>
              <SheetBox key={`${clientId}-${fy}`} clientId={clientId} fy={fy} checklist={c} onChanged={() => { setNotice(null); setPreviewed(false); load(); }} />

              {c && t && (
                <section aria-label="Step 2: documents required" className={`${card} p-6 space-y-4`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Step 2: Documents required, preview and send</h2>
                      <p className="text-xs text-slate-500 mt-1 max-w-2xl">Worked out from the second sheet, the client's uploads here, and what the client has given under Banking and the other sections. It updates by itself. Mark a document not applicable to leave it out of what the client sees.</p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} /> Show only what is pending</label>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[["Items asked for", t.items, false], ["Uploaded", t.received, false], ["Pending", t.pending, t.pending > 0], ["Not applicable", t.na, false]].map(([k, v, bad]) => (
                      <div key={String(k)} className={`rounded-xl border p-2.5 ${bad ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{String(v)}</p></div>
                    ))}
                  </div>
                  {Object.keys(c.summary.bySource).length > 0 && (
                    <p className="text-[11px] text-slate-500">Uploaded from: {Object.entries(c.summary.bySource).map(([k, v]) => `${k} (${v})`).join(", ")}.</p>
                  )}
                  {t.items === 0 ? (
                    <p className="text-xs text-amber-700">No documents were read from the workbook. Check the second sheet (see how the workbook was read above) and replace the checklist.</p>
                  ) : shown.length === 0 ? (
                    <p className="flex items-center gap-2 text-xs text-emerald-700"><CheckCircle2 className="w-4 h-4" /> {onlyPending ? "Nothing is pending: every document is uploaded." : "The sheet has no documents."}</p>
                  ) : shown.map((sec) => (
                    <Fragment key={sec.section || "none"}>
                      {sec.section && <h3 className="text-xs font-bold text-slate-700 pt-1">{sec.section}</h3>}
                      <ul className="space-y-2">{sec.groups.map((g) => <GroupRow key={g.key} g={g} c={c} clientId={clientId} fy={fy} onChanged={load} onError={setError} />)}</ul>
                    </Fragment>
                  ))}

                  <div className="border-t border-slate-100 pt-4 space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <button type="button" onClick={togglePreview} className="px-4 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-slate-800 text-xs font-semibold flex items-center gap-2">
                        {previewing ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />} {previewing ? "Close preview" : "Preview what the client will see"}
                      </button>
                      <button type="button" onClick={send} disabled={sending || !canSend || (!previewed && c.status !== "sent")} className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
                        {sending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {c.status === "sent" ? "Send again" : "Send to client"}
                      </button>
                      <button type="button" onClick={exportList} disabled={exporting} className="px-3.5 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold flex items-center gap-2 disabled:opacity-50">
                        {exporting ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} Download Excel
                      </button>
                      {c.status === "sent"
                        ? <span className="text-[11px] text-emerald-700 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Sent on {dayOf(c.sentAt)}{c.sentBy ? ` by ${c.sentBy}` : ""}</span>
                        : <span className="text-[11px] text-amber-700 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {previewed ? "Not sent to the client yet" : "Preview it before sending to the client"}</span>}
                    </div>
                    {previewing && (
                      <div className="rounded-2xl border-2 border-dashed border-slate-300 p-4 space-y-3 bg-slate-50/60" aria-label="Preview of what the client will see">
                        <p className="text-[11px] font-semibold text-slate-600">Preview: this is what {state.client.name} will see under Audit Documents. {t.pending > 0 ? `${t.pending} of ${t.items} items are pending and the client is notified.` : "Nothing is pending, so the client is told that queries may follow."}</p>
                        <AuditDocumentList checklist={c} preview />
                      </div>
                    )}
                  </div>
                </section>
              )}

              {c && <ProgrammeTracker checklist={c} onChanged={load} onError={setError} />}
              {c && c.points.length === 0 && <p className="text-xs text-slate-500">The workbook has no audit programme, so there are no points to check. Put the audit checklist on its first sheet and replace the checklist.</p>}

              {!c && <p className="flex items-center gap-2 text-xs text-slate-500"><ClipboardCheck className="w-4 h-4" /> No checklist for {fy} yet. Upload the audit checklist above to start.</p>}
            </>
          ) : !error && <p className="text-xs text-slate-500">Loading...</p>}
        </div>
      </main>
    </div>
  );
}
