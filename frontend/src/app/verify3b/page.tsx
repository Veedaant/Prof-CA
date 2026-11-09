import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useRouter } from "@/lib/router";
import { AlertTriangle, CheckCircle2, Clock, Download, FileSpreadsheet, MessageSquare, RefreshCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { api, Client, gstr3bApi, Gstr3bReview, Gstr3bReviewRow, Gstr3bStatus } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { PeriodPicker } from "@/components/PeriodPicker";
import { currentPeriod, periodLabel } from "@/lib/period";
import { SentGroup, sentGroups } from "@/lib/sent";
import { SentShortcuts } from "@/components/SentShortcuts";

const card = "bg-white border border-slate-200 rounded-2xl";
const input = "w-full px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-black";
const TYPE_LABEL: Record<string, string> = { inv: "Purchase invoice", cn: "Credit note", dn: "Debit note" };
const STATUS: Record<Gstr3bStatus, { label: string; cls: string }> = {
  pending: { label: "Not reviewed yet", cls: "bg-slate-100 text-slate-700 border-slate-200" },
  feedback_sent: { label: "Feedback sent - waiting for the client", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  resubmitted: { label: "Client says it is corrected - please re-check", cls: "bg-black text-white border-black" },
  verified: { label: "Verified", cls: "bg-emerald-50 text-emerald-800 border-emerald-200" },
};
const MISSING_KINDS = ["missing_document", "missing_all", "missing_ledger", "not_in_ledger", "unsent", "type_mismatch"];
const FIELDS = ["Taxable value", "IGST", "CGST", "SGST", "Invoice value", "Date", "Supplier GSTIN", "Supplier name", "Document type", "Other"];

export default function Verify3bPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState<Gstr3bReview | null>(null);
  const [attention, setAttention] = useState<Gstr3bReviewRow[]>([]);
  const [selF, setSelF] = useState<Set<string>>(new Set());
  const [selN, setSelN] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [groups, setGroups] = useState<SentGroup[] | null>(null);
  const defaulted = useRef(false);
  const [note, setNote] = useState({ invoice_id: "", doc_ref: "", field_label: FIELDS[0], ledger_value: "", document_value: "", message: "", severity: "error" as "error" | "warning" });
  const ctx = useRef("");
  const preselect = useRef(false);
  const autoTried = useRef(new Set<string>());
  const [stepBusy, setStepBusy] = useState<"excel" | "check" | null>(null);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
    if (!loading && user && user.role === "client") router.push("/gst");
  }, [user, loading, router]);

  useEffect(() => {
    if (!user || user.role === "client") return;
    api.clients.list().then((c) => setClients(c)).catch(() => {});
    sentGroups().then(setGroups).catch(() => setGroups([]));
  }, [user]);

  // open on the client and month that most recently sent GSTR-3B documents, not on whichever client is first in the list
  useEffect(() => {
    if (defaulted.current || !clients.length || groups === null) return;
    defaulted.current = true;
    const g = groups.find((x) => x.return_type === "gstr3b");
    if (g) { setClientId(g.client_id); setPeriod(g.tax_period); } else setClientId(clients[0].id);
  }, [clients, groups]);

  const loadAttention = useCallback(() => {
    gstr3bApi.reviews().then((r) => setAttention(r.filter((x) => x.status === "resubmitted"))).catch(() => {});
  }, []);
  useEffect(() => { if (user && user.role !== "client") loadAttention(); }, [user, loadAttention]);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      const d = await gstr3bApi.review(clientId, period);
      setData(d);
      setError(null);
      const key = `${clientId}|${period}`;
      const open = d.verification.findings.filter((f) => !f.dismissed);
      const openNotes = d.notes.filter((n) => !n.resolved);
      if (ctx.current !== key) {
        ctx.current = key;
        setSelF(new Set(d.run.current ? open.filter((f) => f.severity === "error").map((f) => f.key) : []));
        setSelN(new Set(openNotes.map((n) => n.id)));
        setMessage("");
        setNotice(null);
      } else {
        const fk = new Set(open.map((f) => f.key)), nk = new Set(openNotes.map((n) => n.id));
        setSelF((s) => new Set([...s].filter((k) => fk.has(k))));
        setSelN((s) => new Set([...s].filter((k) => nk.has(k))));
      }
      if (preselect.current) {
        preselect.current = false;
        setSelF(new Set(open.filter((f) => f.severity === "error").map((f) => f.key)));
      }
    } catch (e: any) {
      setData(null);
      setError(e.message);
    }
  }, [clientId, period]);
  useEffect(() => { load(); }, [load]);
  // the client may correct or send things at any time: keep this page current
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "hidden" || busy || stepBusy) return;
      load();
      loadAttention();
      sentGroups().then(setGroups).catch(() => {});
    }, 10000);
    return () => clearInterval(t);
  }, [load, loadAttention, busy, stepBusy]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(null);
    try { await fn(); if (done) setNotice(done); await load(); loadAttention(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, k: string) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); setter(n); };

  const v = data?.verification;
  const open = v?.findings.filter((f) => !f.dismissed) || [];
  const deletedCount = v?.findings.filter((f) => f.hidden).length || 0;
  const visible = (v?.findings || []).filter((f) => showDeleted || !f.hidden);
  const remove = (f: { key: string; severity: string; dismissed: boolean }) => {
    const warn = f.severity === "error" && !f.dismissed
      ? "This issue is still present in the documents or ledger. Delete it anyway? It will stop blocking verification."
      : "Delete this finding?";
    if (window.confirm(warn)) act(() => gstr3bApi.deleteFinding(clientId, period, f.key), "Finding deleted.");
  };
  const selectedCount = selF.size + selN.size;
  const missingList = visible.filter((f) => MISSING_KINDS.includes(f.kind));
  const changedList = visible.filter((f) => f.kind === "value_mismatch");
  const openMissing = open.filter((f) => MISSING_KINDS.includes(f.kind)).length;
  const openChanged = open.filter((f) => f.kind === "value_mismatch").length;
  const ex = data?.excel;

  // the Excel is prepared by itself as soon as documents are sent; this catches the ones sent before this was in place or changed since
  useEffect(() => {
    if (!data || !ex || ex.counts.total === 0 || (ex.prepared && !ex.stale)) return;
    const k = `${clientId}|${period}|${ex.id || "none"}|${ex.counts.total}|${ex.stale}`;
    if (autoTried.current.has(k)) return;
    autoTried.current.add(k);
    gstr3bApi.prepareExcel(clientId, period).then(() => load()).catch(() => {});
  }, [data]);

  const refreshExcel = async () => {
    setStepBusy("excel"); setError(null);
    try { await gstr3bApi.prepareExcel(clientId, period); await load(); setNotice("The Excel was prepared again from the documents the client has sent."); }
    catch (e: any) { setError(e.message); } finally { setStepBusy(null); }
  };
  const verifyWithLedger = async () => {
    setStepBusy("check"); setError(null); setNotice(null);
    try {
      preselect.current = true;
      const r = await gstr3bApi.runCheck(clientId, period);
      await load();
      setNotice(`Checked against the ledger: ${r.counts.missing} missing, ${r.counts.changed} changed value(s), ${r.counts.matched} document(s) agree.`);
    } catch (e: any) { preselect.current = false; setError(e.message); } finally { setStepBusy(null); }
  };

  const findingsTable = (list: typeof visible, empty: string) => list.length === 0 ? (
    <div className="p-6 text-center text-sm text-emerald-700 flex items-center justify-center gap-2"><CheckCircle2 className="w-4 h-4" /> {empty}</div>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs text-slate-500">
          <tr>
            <th className="px-4 py-2.5 w-8"></th>
            <th className="px-2 py-2.5 font-medium">Detail</th>
            <th className="px-2 py-2.5 font-medium">Document</th>
            <th className="px-2 py-2.5 font-medium">Value</th>
            <th className="px-2 py-2.5 font-medium text-right">Ledger</th>
            <th className="px-2 py-2.5 font-medium text-right">Excel</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {list.map((f) => (
            <tr key={f.key} className={`border-t border-slate-100 align-top ${f.dismissed ? "opacity-50" : ""}`}>
              <td className="px-4 py-3"><input type="checkbox" disabled={f.dismissed} checked={selF.has(f.key)} onChange={() => toggle(selF, setSelF, f.key)} className="accent-black w-4 h-4" /></td>
              <td className="px-2 py-3 max-w-md">
                <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full mb-1 ${f.severity === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{f.severity === "error" ? "Must fix" : "Check"}</span>
                <p>{f.message}</p>
                {f.hidden ? <p className="text-xs text-slate-500 mt-1">Deleted</p> : f.dismissed && <p className="text-xs text-slate-500 mt-1">Accepted: {f.dismissed_reason || "no reason given"}</p>}
              </td>
              <td className="px-2 py-3 whitespace-nowrap">{f.doc_type ? TYPE_LABEL[f.doc_type] : "-"}<div className="text-xs text-slate-500">{f.doc_ref}{f.party ? ` · ${f.party}` : ""}</div></td>
              <td className="px-2 py-3 whitespace-nowrap">{f.field_label}</td>
              <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums">{f.ledger_value || "-"}</td>
              <td className="px-2 py-3 text-right whitespace-nowrap tabular-nums">{f.document_value || "-"}</td>
              <td className="px-4 py-3 text-right whitespace-nowrap space-x-3">
                {f.dismissed ? (
                  <button disabled={busy} onClick={() => act(() => gstr3bApi.restore(clientId, period, f.key))} className="text-xs underline underline-offset-4">Restore</button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => { const reason = window.prompt("Why is this acceptable? (required)"); if (reason && reason.trim()) act(() => gstr3bApi.dismiss(clientId, period, f.key, reason.trim())); }}
                    className="text-xs underline underline-offset-4"
                  >Accept</button>
                )}
                {!f.hidden && <button disabled={busy} onClick={() => remove(f)} aria-label="Delete finding" title="Delete this finding" className="text-slate-500 hover:text-rose-600 align-middle"><Trash2 className="w-4 h-4 inline" /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const addNote = () => {
    if (!data) return;
    const doc = v!.docs.find((d) => d.invoice_id === note.invoice_id);
    act(async () => {
      await gstr3bApi.addNote({ client_id: clientId, tax_period: period, invoice_id: doc?.invoice_id || null, doc_ref: doc ? doc.number : note.doc_ref, field_label: note.field_label, ledger_value: note.ledger_value, document_value: note.document_value, message: note.message, severity: note.severity });
      setNote({ ...note, doc_ref: "", ledger_value: "", document_value: "", message: "" });
    });
  };

  const send = () => act(async () => {
    await gstr3bApi.sendFeedback({ client_id: clientId, tax_period: period, message, finding_keys: [...selF], note_ids: [...selN] });
    setMessage("");
  }, "Feedback sent to the client. They will see it on their GSTR-3B screen.");

  const stat = (label: string, value: string, sub?: string) => (
    <div className={`${card} p-4`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="font-semibold mt-1 text-lg">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="GSTR-3B Verification" subtitle="Check the client's purchase invoices, credit notes and debit notes against their purchase ledger, and send feedback" />
        <div className="p-6 max-w-6xl mx-auto w-full space-y-5">
          <div className={`${card} p-5 flex flex-wrap items-end gap-4`}>
            <label className="block min-w-[16rem]">
              <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
              </select>
            </label>
            <div><span className="block text-xs font-medium text-slate-600 mb-1">Return period</span><PeriodPicker value={period} onChange={setPeriod} /></div>
          </div>

          <SentShortcuts groups={groups} ret="gstr3b" clientId={clientId} period={period} onPick={(g) => { setClientId(g.client_id); setPeriod(g.tax_period); }} />

          {attention.length > 0 && (
            <div className="rounded-xl bg-black text-white px-5 py-3 text-sm flex flex-wrap items-center gap-3">
              <span className="font-medium">Clients say they have corrected their documents:</span>
              {attention.map((a) => (
                <button key={a.id} onClick={() => { setClientId(a.client_id); setPeriod(a.tax_period); }} className="underline underline-offset-4">{a.client_name} · {periodLabel(a.tax_period)}</button>
              ))}
            </div>
          )}

          {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
          {notice && <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">{notice}</div>}

          {data && v && (<>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`text-sm font-medium px-3 py-1.5 rounded-full border ${STATUS[data.review.status].cls}`}>{STATUS[data.review.status].label}</span>
              {data.review.status === "verified" && <Link href="/exports-3b" className="text-sm font-medium underline underline-offset-4">Generate the GSTR-3B report →</Link>}
              {data.review.status === "verified" && data.review.verified_at && <span className="text-xs text-slate-500">Verified {new Date(data.review.verified_at).toLocaleString()}</span>}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              {stat("Ledger entries", String(v.ledger.entries), v.ledger.files.length ? `${v.ledger.documents} documents in ${v.ledger.files.length} file(s)` : "No ledger uploaded")}
              {stat("Purchase invoices", `${v.documents.sent.inv || 0} / ${v.ledger.by_type.inv || 0}`, "sent / in ledger")}
              {stat("Credit notes", `${v.documents.sent.cn || 0} / ${v.ledger.by_type.cn || 0}`, "sent / in ledger")}
              {stat("Debit notes", `${v.documents.sent.dn || 0} / ${v.ledger.by_type.dn || 0}`, "sent / in ledger")}
              {stat("Matching", String(v.matched), "agree with the ledger")}
              {stat("Not sent yet", String(v.documents.unsent_total), "uploaded, client has not sent")}
            </div>

            <section className={`${card} p-5 space-y-3`} aria-label="Step 1: the Excel">
              <div className="flex items-start gap-3">
                <span className="w-7 h-7 shrink-0 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center">1</span>
                <div className="min-w-0">
                  <h3 className="font-semibold flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" /> Excel prepared from the client's documents</h3>
                  <p className="text-xs text-slate-500">Made from the purchase invoices, credit notes and debit notes the client has sent for GSTR-3B. It is prepared automatically when the client sends a document.</p>
                </div>
              </div>
              {!ex || ex.counts.total === 0 ? (
                <p className="text-sm text-slate-500 ml-10">Nothing has been sent for GSTR-3B in this month yet.</p>
              ) : (
                <div className="ml-10 flex flex-wrap items-center gap-x-4 gap-y-2">
                  <span className="text-sm">{ex.counts.purchase} purchase invoice(s) · {ex.counts.credit_note} credit note(s) · {ex.counts.debit_note} debit note(s)</span>
                  {ex.prepared && !ex.stale && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">Ready{ex.prepared_at ? ` · ${new Date(ex.prepared_at).toLocaleString()}` : ""}</span>}
                  {(!ex.prepared || ex.stale) && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{stepBusy === "excel" ? "Preparing..." : ex.prepared ? "Out of date - refreshing" : "Preparing..."}</span>}
                  <button disabled={!ex.prepared || !ex.download_url} onClick={() => ex.download_url && api.exports.downloadFile(ex.download_url, ex.file_name).catch((e) => setError(e.message))} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-black text-white text-xs font-semibold hover:bg-neutral-800 disabled:opacity-40"><Download className="w-3.5 h-3.5" /> Download Excel</button>
                  <button disabled={stepBusy !== null} onClick={refreshExcel} className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg border border-slate-300 text-xs font-medium hover:border-black disabled:opacity-40"><RefreshCw className="w-3.5 h-3.5" /> Prepare again</button>
                </div>
              )}
            </section>

            <section className={`${card} overflow-hidden`} aria-label="Step 2: verify with the ledger">
              <div className="p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <span className="w-7 h-7 shrink-0 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center">2</span>
                  <div className="min-w-0">
                    <h3 className="font-semibold">Verify the Excel with the ledger</h3>
                    <p className="text-xs text-slate-500">Compares every document in the Excel with the client's purchase ledger and lists what is missing and which values have changed.</p>
                  </div>
                </div>
                <div className="ml-10 flex flex-wrap items-center gap-3">
                  <button disabled={stepBusy !== null || !ex || ex.counts.total === 0 || !ex.prepared} onClick={verifyWithLedger} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
                    <ShieldCheck className="w-4 h-4" /> {stepBusy === "check" ? "Checking..." : data.run.current ? "Verify again" : "Verify with ledger"}
                  </button>
                  {v.ledger.files.length === 0 ? <span className="text-xs text-amber-700">No purchase ledger has been uploaded for this month yet.</span> : <span className="text-xs text-slate-500">Ledger: {v.ledger.files.map((f) => f.filename).join(", ")} · {v.ledger.documents} document(s)</span>}
                  {data.run.current && <button onClick={() => gstr3bApi.downloadCheck(clientId, period).catch((e) => setError(e.message))} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 text-xs font-medium hover:border-black"><Download className="w-3.5 h-3.5" /> Download the check as Excel</button>}
                </div>
                {!data.run.current && (
                  <p className={`ml-10 text-sm rounded-lg px-3 py-2 ${data.run.at ? "bg-amber-50 border border-amber-200 text-amber-900" : "bg-slate-50 border border-slate-200 text-slate-600"}`}>
                    {data.run.at ? "The documents or the ledger changed since the last check. Verify again to see the current result." : "Not checked yet. The missing and changed values appear here once you verify with the ledger."}
                  </p>
                )}
              </div>

              {data.run.current && (
                <div className="border-t border-slate-100">
                  <div className="px-5 py-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">Result</h3>
                      <p className="text-xs text-slate-500">Checked {data.run.at ? new Date(data.run.at).toLocaleString() : ""} · {openMissing} missing · {openChanged} changed value(s) · {v.matched} document(s) agree · tick what to send to the client</p>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <button onClick={() => setSelF(new Set(open.filter((f) => f.severity === "error").map((f) => f.key)))} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:border-black">Select all errors</button>
                      <button onClick={() => setSelF(new Set(open.map((f) => f.key)))} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:border-black">Select all</button>
                      <button onClick={() => setSelF(new Set())} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:border-black">Clear</button>
                      {deletedCount > 0 && <button onClick={() => setShowDeleted((x) => !x)} className="px-3 py-1.5 rounded-lg border border-slate-300 hover:border-black">{showDeleted ? "Hide deleted" : `Show deleted (${deletedCount})`}</button>}
                    </div>
                  </div>
                  <div className="px-5 py-2 bg-slate-50 border-y border-slate-100 text-sm font-semibold">Missing ({openMissing})</div>
                  {findingsTable(missingList, "Nothing is missing.")}
                  <div className="px-5 py-2 bg-slate-50 border-y border-slate-100 text-sm font-semibold">Changed values ({openChanged})</div>
                  {findingsTable(changedList, "No values have changed: every document agrees with the ledger.")}
                </div>
              )}
            </section>

            <section className={`${card} p-5 space-y-4`}>
              <div>
                <h3 className="font-semibold flex items-center gap-2"><MessageSquare className="w-4 h-4" /> Point out a value yourself</h3>
                <p className="text-xs text-slate-500">Add anything the system could not see, such as a value that is wrong or unreadable. Tick it below to send it to the client.</p>
              </div>
              <div className="grid md:grid-cols-4 gap-3">
                <label className="block md:col-span-2">
                  <span className="block text-xs font-medium text-slate-600 mb-1">Document</span>
                  <select value={note.invoice_id} onChange={(e) => setNote({ ...note, invoice_id: e.target.value })} className={input}>
                    <option value="">Not one of the sent documents (type a reference)</option>
                    {v.docs.map((d) => <option key={d.invoice_id} value={d.invoice_id}>{TYPE_LABEL[d.type]} {d.number || "(no number)"} · {d.party}</option>)}
                  </select>
                </label>
                {!note.invoice_id && (
                  <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1">Reference</span><input value={note.doc_ref} onChange={(e) => setNote({ ...note, doc_ref: e.target.value })} placeholder="e.g. Invoice 214" className={input} /></label>
                )}
                <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1">Value</span>
                  <select value={note.field_label} onChange={(e) => setNote({ ...note, field_label: e.target.value })} className={input}>{FIELDS.map((f) => <option key={f}>{f}</option>)}</select>
                </label>
                <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1">Should be (ledger)</span><input value={note.ledger_value} onChange={(e) => setNote({ ...note, ledger_value: e.target.value })} className={input} /></label>
                <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1">Found in document</span><input value={note.document_value} onChange={(e) => setNote({ ...note, document_value: e.target.value })} className={input} /></label>
                <label className="block"><span className="block text-xs font-medium text-slate-600 mb-1">Importance</span>
                  <select value={note.severity} onChange={(e) => setNote({ ...note, severity: e.target.value as "error" | "warning" })} className={input}><option value="error">Must fix</option><option value="warning">Please check</option></select>
                </label>
                <label className="block md:col-span-4"><span className="block text-xs font-medium text-slate-600 mb-1">What is wrong</span><input value={note.message} onChange={(e) => setNote({ ...note, message: e.target.value })} placeholder="Explain it so the client knows what to correct" className={input} /></label>
              </div>
              <button disabled={busy || note.message.trim().length < 3} onClick={addNote} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40">Add this point</button>

              {data.notes.length > 0 && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100">
                  {data.notes.map((n) => (
                    <li key={n.id} className={`py-3 flex items-start gap-3 ${n.resolved ? "opacity-50" : ""}`}>
                      <input type="checkbox" disabled={n.resolved} checked={selN.has(n.id)} onChange={() => toggle(selN, setSelN, n.id)} className="accent-black w-4 h-4 mt-1" />
                      <div className="min-w-0 flex-1 text-sm">
                        <p><span className="font-medium">{n.doc_ref || "General"}</span>{n.field_label ? ` · ${n.field_label}` : ""} <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${n.severity === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{n.severity === "error" ? "Must fix" : "Check"}</span></p>
                        <p className="text-slate-700">{n.message}</p>
                        {(n.ledger_value || n.document_value) && <p className="text-xs text-slate-500">Should be: {n.ledger_value || "-"} · Found: {n.document_value || "-"}</p>}
                      </div>
                      <div className="flex gap-3 text-xs shrink-0">
                        <button onClick={() => act(() => gstr3bApi.resolveNote(n.id, !n.resolved))} className="underline underline-offset-4">{n.resolved ? "Reopen" : "Mark resolved"}</button>
                        <button onClick={() => act(() => gstr3bApi.deleteNote(n.id))} aria-label="Delete point" className="text-slate-500 hover:text-rose-600"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={`${card} p-5 space-y-3`}>
              <h3 className="font-semibold flex items-center gap-2"><span className="w-7 h-7 shrink-0 rounded-full bg-black text-white text-sm font-semibold flex items-center justify-center">3</span> <Send className="w-4 h-4" /> Send the missing and changed values to the client</h3>
              <p className="text-sm text-slate-500">{selectedCount} issue(s) ticked above will be sent. If any of them must be fixed, the client is also told that the GSTR-3B report cannot be generated and that they must upload the documents again carefully.</p>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Add a short message (optional)" className={input} />
              <div className="flex flex-wrap items-center gap-3">
                <button disabled={busy || (selectedCount === 0 && !message.trim())} onClick={send} className="px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">Send feedback to client</button>
                <button disabled={busy || !data.can_verify} onClick={() => act(() => gstr3bApi.verify(clientId, period), "Marked as verified. The GSTR-3B report can now be generated.")} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg border border-black text-sm font-semibold hover:bg-slate-100 disabled:opacity-40 disabled:border-slate-300">
                  <ShieldCheck className="w-4 h-4" /> Mark as verified
                </button>
                {!data.can_verify && <span className="text-xs text-slate-500 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> {!data.run.current ? "Verify the Excel with the ledger first" : `${data.blockers} error(s) and ${data.open_notes} open point(s) must be cleared or accepted first`}</span>}
              </div>
            </section>

            <section className={`${card} overflow-hidden`}>
              <div className="px-5 py-4 border-b border-slate-100"><h3 className="font-semibold">Documents the client sent ({v.docs.length})</h3></div>
              {v.docs.length === 0 ? <p className="p-6 text-sm text-slate-500">No GSTR-3B documents have been sent for this period.</p> : (
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr><th className="px-5 py-2.5 font-medium">Document</th><th className="px-2 py-2.5 font-medium">Supplier</th><th className="px-2 py-2.5 font-medium text-right">Taxable</th><th className="px-2 py-2.5 font-medium text-right">Total</th><th className="px-5 py-2.5 font-medium text-right">Against ledger</th></tr></thead>
                  <tbody>
                    {v.docs.map((d) => (
                      <React.Fragment key={d.invoice_id}>
                      <tr className="border-t border-slate-100">
                        <td className="px-5 py-2.5">{TYPE_LABEL[d.type]} <span className="font-medium">{d.number || "(no number)"}</span></td>
                        <td className="px-2 py-2.5">{d.party || "-"}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{d.taxable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{d.total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}</td>
                        <td className="px-5 py-2.5 text-right">
                          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${d.status === "matched" ? "bg-emerald-100 text-emerald-800" : d.status === "mismatch" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{d.status === "matched" ? "Matches" : d.status === "mismatch" ? "Differs" : "Check"}</span>
                        </td>
                      </tr>
                      {d.alert && (
                        <tr>
                          <td colSpan={5} className="px-5 pb-3 pt-0">
                            <div className="rounded-lg border border-black bg-slate-50 px-3 py-2 text-xs flex flex-wrap items-center justify-between gap-2">
                              <span><span className="font-semibold">Corrected by the client:</span> {d.alert} Verify with the ledger again to see the effect.</span>
                              <button disabled={busy} onClick={() => act(() => api.invoices.ackAlert(d.invoice_id))} className="px-3 py-1 rounded-lg border border-slate-300 bg-white font-medium hover:border-black">Mark as reviewed</button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {(data.feedback[0]?.items || []).filter((it) => it.invoice_id === d.invoice_id).length > 0 && (
                        <tr>
                          <td colSpan={5} className="px-5 pb-3 pt-0">
                            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                              <p className="font-semibold mb-1">Feedback sent to the client on {new Date(data.feedback[0].created_at).toLocaleString()} {data.feedback[0].status === "resubmitted" ? "- client says it is corrected" : "- waiting for the client"}</p>
                              <ul className="space-y-0.5">
                                {data.feedback[0].items.filter((it) => it.invoice_id === d.invoice_id).map((it, i) => <li key={i}>• {it.message}</li>)}
                              </ul>
                            </div>
                          </td>
                        </tr>
                      )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            {data.feedback.length > 0 && (
              <section className={`${card} p-5 space-y-3`}>
                <h3 className="font-semibold">Feedback history</h3>
                <ul className="space-y-3">
                  {data.feedback.map((f) => (
                    <li key={f.id} className="border border-slate-200 rounded-xl p-4 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">{new Date(f.created_at).toLocaleString()}{f.sent_by_name ? ` · ${f.sent_by_name}` : ""} · {f.items.length} item(s)</span>
                        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${f.status === "resubmitted" ? "bg-black text-white" : "bg-amber-100 text-amber-800"}`}>
                          {f.status === "resubmitted" ? `Client re-submitted${f.resubmitted_at ? " " + new Date(f.resubmitted_at).toLocaleString() : ""}` : "Waiting for the client"}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-line text-slate-700">{f.message}</p>
                      {f.items.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs text-slate-600">
                          {f.items.map((it, i) => <li key={i}>• {it.doc_ref ? `${it.doc_ref}: ` : ""}{it.message}</li>)}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>)}
          {!data && !error && <div className={`${card} p-8 text-center text-sm text-slate-500 flex items-center justify-center gap-2`}><Clock className="w-4 h-4" /> Loading...</div>}
        </div>
      </main>
    </div>
  );
}
