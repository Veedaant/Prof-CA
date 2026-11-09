import React, { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, FileSpreadsheet, Trash2, Upload } from "lucide-react";
import { api, gstr3bApi, Gstr3bFeedback, Gstr3bFeedbackItem, Gstr3bStatus, ReconFile } from "@/lib/api";
import { periodLabel } from "@/lib/period";
import { BatchPicker } from "@/components/BatchPicker";

const card = "bg-white border border-slate-200 rounded-2xl";

/** What the CA firm has said about this client's GSTR-3B documents for the period. */
export function Gstr3bFeedbackCard({ period }: { period: string }) {
  const [data, setData] = useState<{ status: Gstr3bStatus; verified_at?: string | null; feedback: Gstr3bFeedback[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    gstr3bApi.clientReview(period).then((r) => setData({ status: r.review.status, verified_at: r.review.verified_at, feedback: r.feedback })).catch(() => {});
  }, [period]);
  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return null;
  const latest = data.feedback[0];

  if (data.status === "verified") {
    return (
      <div className={`${card} p-4 border-emerald-300 bg-emerald-50 flex gap-3 items-start`}>
        <CheckCircle2 className="w-5 h-5 text-emerald-700 shrink-0 mt-0.5" />
        <div className="text-sm text-emerald-900">
          <p className="font-semibold">Verified by your CA</p>
          <p>Your GSTR-3B documents for {periodLabel(period)} match your purchase ledger{data.verified_at ? ` (checked ${new Date(data.verified_at).toLocaleString()})` : ""}.</p>
        </div>
      </div>
    );
  }

  if (data.status === "feedback_sent" && latest) {
    const respond = async () => {
      setBusy(true);
      setError(null);
      try { await gstr3bApi.resubmit(latest.id); load(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
    };
    return (
      <div className={`${card} p-5 border-amber-300 bg-amber-50 space-y-4`}>
        <div className="flex gap-3 items-start">
          <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold text-amber-900">Your CA found problems with your GSTR-3B documents for {periodLabel(period)}</p>
            <p className="text-xs text-amber-800 mt-0.5">Sent {new Date(latest.created_at).toLocaleString()}{latest.sent_by_name ? ` by ${latest.sent_by_name}` : ""}</p>
          </div>
        </div>
        <p className="text-sm text-amber-900 whitespace-pre-line">{latest.message}</p>
        {latest.items.length > 0 && (
          <ul className="space-y-2">
            {latest.items.map((it, i) => (
              <li key={i} className="bg-white border border-amber-200 rounded-xl p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${it.severity === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{it.severity === "error" ? "Must fix" : "Please check"}</span>
                  {it.doc_ref && <span className="font-medium">{it.doc_ref}</span>}
                  {it.field_label && <span className="text-slate-500">· {it.field_label}</span>}
                </div>
                <p className="mt-1.5 text-slate-700">{it.message}</p>
                {(it.ledger_value || it.document_value) && (
                  <p className="mt-1 text-xs text-slate-500">Ledger: <span className="font-medium text-slate-700">{it.ledger_value || "-"}</span> · Document: <span className="font-medium text-slate-700">{it.document_value || "-"}</span></p>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-rose-700">{error}</p>}
        <button disabled={busy} onClick={respond} className="px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 disabled:opacity-40">
          I have uploaded the corrections - ask my CA to re-check
        </button>
      </div>
    );
  }

  if (data.status === "resubmitted") {
    return (
      <div className={`${card} p-4 flex gap-3 items-start`}>
        <Clock className="w-5 h-5 text-slate-600 shrink-0 mt-0.5" />
        <div className="text-sm">
          <p className="font-semibold">Waiting for your CA to re-check</p>
          <p className="text-slate-500">You told your CA the corrections are uploaded. You will see the result here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`${card} p-4 text-sm text-slate-600`}>
      <p className="font-semibold text-slate-900">How GSTR-3B is checked</p>
      <p className="mt-1">Upload your purchase invoices, credit notes and debit notes, and upload your purchase ledger under <span className="font-medium">Other Documents</span>. Your CA checks every document against the ledger and tells you here if anything is missing or different.</p>
    </div>
  );
}

/** The CA firm's feedback about one document, shown right under it, with the way to put it right. */
export function DocFeedback({ items, status, sentAt, busy, onReupload }: {
  items: Gstr3bFeedbackItem[]; status: Gstr3bStatus; sentAt: string; busy: boolean; onReupload: (file: File) => void;
}) {
  const waiting = status === "resubmitted";
  return (
    <div className="mx-4 mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 space-y-3" role="note" aria-label="CA feedback on this document">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-amber-900">Your CA firm's feedback on this document</p>
          <p className="text-xs text-amber-800">Sent {new Date(sentAt).toLocaleString()}</p>
        </div>
      </div>
      <ul className="space-y-1.5">
        {items.map((it, i) => (
          <li key={i} className="bg-white border border-amber-200 rounded-lg px-3 py-2 text-sm">
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full mr-2 ${it.severity === "error" ? "bg-rose-100 text-rose-700" : "bg-amber-100 text-amber-800"}`}>{it.severity === "error" ? "Must fix" : "Please check"}</span>
            {it.field_label && <span className="font-medium">{it.field_label}: </span>}
            <span className="text-slate-700">{it.message}</span>
            {(it.ledger_value || it.document_value) && <span className="block text-xs text-slate-500 mt-0.5">Ledger: <b className="text-slate-700">{it.ledger_value || "-"}</b> · This document: <b className="text-slate-700">{it.document_value || "-"}</b></span>}
          </li>
        ))}
      </ul>
      {waiting ? (
        <p className="text-xs text-amber-900">You have asked your CA to re-check. You will be told when they have.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <label className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800 cursor-pointer ${busy ? "opacity-40 pointer-events-none" : ""}`}>
            <Upload className="w-4 h-4" /> {busy ? "Uploading..." : "Re-upload the corrected document"}
            <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.heic,.heif" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onReupload(f); }} />
          </label>
          <span className="text-xs text-amber-900">The new file replaces this one. Check it, send it to your CA, then ask for a re-check at the top of this page.</span>
        </div>
      )}
    </div>
  );
}

/** "Other documents" under GSTR-3B is where the purchase ledger goes. */
export function Gstr3bLedgerUpload({ clientId, period }: { clientId: string; period: string }) {
  const [files, setFiles] = useState<ReconFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api.recon.files().then((f) => setFiles(f.filter((x) => x.kind === "purchase_ledger" && x.tax_period === period))).catch((e) => setMsg({ ok: false, text: e.message }));
  }, [period]);
  useEffect(load, [load]);

  const upload = async (list: File[], merge: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.recon.upload(list, "purchase_ledger", clientId, period, merge);
      const r0 = res[0];
      const tail = res.find((r) => r.warning)?.warning || "Your CA will check your documents against it.";
      setMsg({
        ok: true,
        text: merge && r0.batch
          ? `Merged ${r0.batch.length} files into one ledger with ${r0.row_count} entries (${r0.batch.map((b) => `${b.name}: ${b.added}`).join(", ")}). ${tail}`
          : `${res.map((r) => `${r.original_filename} (${r.row_count} entries read)`).join(", ")} uploaded. ${tail}`,
      });
      load();
      return true;
    } catch (er: any) {
      setMsg({ ok: false, text: er.message });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={`${card} p-6 space-y-4`}>
        <div>
          <h3 className="font-semibold">Upload your purchase ledger</h3>
          <p className="text-sm text-slate-500">
            For {periodLabel(period)}. The ledger should list every purchase invoice, credit note and debit note. Your CA compares each of your uploaded documents with it, and tells you about anything missing or different.
            Excel or CSV is read directly; a PDF or a clear photo is read with AI.
          </p>
        </div>
        <BatchPicker accept=".xlsx,.xlsm,.csv,.pdf,.png,.jpg,.jpeg" busy={busy} noun="purchase ledger" onUpload={upload} />
        {msg && <p className={`text-sm rounded-lg px-3 py-2 border ${msg.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-700"}`}>{msg.text}</p>}
      </div>
      <div className="space-y-2">
        <h3 className="font-semibold text-sm">Ledger files - {periodLabel(period)}</h3>
        {files.length === 0 ? (
          <div className={`${card} p-8 text-center text-sm text-slate-500`}>No ledger uploaded for this period yet.</div>
        ) : files.map((f) => (
          <div key={f.id} className={`${card} p-4 flex items-center justify-between gap-3`}>
            <div className="flex items-center gap-3 min-w-0">
              <FileSpreadsheet className="w-5 h-5 text-slate-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{f.original_filename}</p>
                <p className="text-xs text-slate-500">{f.row_count} entries · {new Date(f.created_at).toLocaleString()}</p>
              </div>
            </div>
            <button onClick={() => api.recon.remove(f.id).then(load)} className="p-2 text-slate-500 hover:text-rose-600" aria-label="Delete ledger"><Trash2 className="w-4 h-4" /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
