import { Fragment, useRef, useState, type ChangeEvent } from "react";
import { Upload, RefreshCw, ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";

import { auditApi, AuditChecklist, AuditGroup, AuditItem } from "@/lib/api";
import { ItemFiles, Progress, StatusChip } from "@/components/AuditBits";
import { bankLine, bySection, clientView, dayOf } from "@/lib/audit";

const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const ACCEPT = ".pdf,.xlsx,.xlsm,.xls,.xlsb,.csv,.doc,.docx,.png,.jpg,.jpeg,.heic,.heif,.zip";

/** One period of one document: its name, whether it is uploaded or pending and, beside them, the upload. */
function ItemRow({ item, preview, onChanged, onError }: { item: AuditItem; preview: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); onChanged(); } catch (e: any) { onError(e.message); } finally { setBusy(false); } };
  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length) run(async () => {
      const r = await auditApi.uploadItem(item.id, files);
      if (r.skipped) onError(`${r.skipped} file(s) were already uploaded here and were not added again.`);
    });
  };
  const mine = item.status === "received" && item.source === "Audit Documents";
  const canUpload = !preview && (item.status === "pending" || mine);
  return (
    <li className="px-3 py-2 flex flex-wrap items-center gap-3 border-t border-slate-100">
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-xs font-medium text-slate-800">{item.periodLabel}</p>
        {item.status === "received" && !mine && <p className="text-[10px] text-slate-400">{item.source}{item.detail ? `: ${item.detail}` : ""}</p>}
      </div>
      <StatusChip status={item.status} />
      <ItemFiles files={item.files} canDelete={(f) => !preview && f.role === "client"} onDownload={(f) => run(() => auditApi.downloadFile(f.id))} onDelete={(f) => run(() => auditApi.deleteFile(f.id))} />
      {canUpload && (
        <>
          <button type="button" disabled={busy} onClick={() => ref.current?.click()} aria-label={`Upload ${item.name} ${item.periodLabel}`}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 ${item.status === "pending" ? "bg-slate-900 hover:bg-slate-800 text-white" : "border border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
            {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} {item.status === "pending" ? "Upload" : "Add another"}
          </button>
          <input ref={ref} type="file" multiple accept={ACCEPT} onChange={pick} className="hidden" aria-label={`File for ${item.name} ${item.periodLabel}`} />
        </>
      )}
      {preview && item.status === "pending" && <span className="text-[10px] text-slate-400">The client uploads here</span>}
    </li>
  );
}

function DocumentGroup({ g, items, preview, onChanged, onError }: { g: AuditGroup; items: AuditItem[]; preview: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(g.pending > 0 && g.total <= 14);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full p-3 flex flex-wrap items-center gap-3 text-left hover:bg-slate-50">
        <Chevron className="w-4 h-4 text-slate-500 shrink-0" />
        <span className="min-w-0 flex-1 basis-60">
          <span className="block text-xs font-semibold text-slate-800">{g.name}{bankLine(g) ? ` (${bankLine(g)})` : ""}</span>
          {g.note && <span className="block text-[11px] text-slate-500 mt-0.5">{g.note}</span>}
          {g.pending > 0 ? <span className="block text-[11px] text-amber-700 mt-0.5">Pending for: {g.pendingText}</span> : <span className="block text-[11px] text-emerald-700 mt-0.5">All uploaded</span>}
        </span>
        <Progress group={g} />
      </button>
      {open && <ul>{items.map((s) => <ItemRow key={s.id} item={s} preview={preview} onChanged={onChanged} onError={onError} />)}</ul>}
    </li>
  );
}

/**
 * The documents the audit needs, as the client sees them: each document with its periods, uploaded or pending, and an upload beside it.
 * In preview the CA firm sees exactly this list, without the uploads, before sending it.
 */
export function AuditDocumentList({ checklist: c, preview = false, onChanged = () => {}, onError = () => {} }: { checklist: AuditChecklist; preview?: boolean; onChanged?: () => void; onError?: (m: string) => void }) {
  const v = clientView(c);
  const t = v.totals;
  const groups = [...v.groups].sort((a, b) => Number(a.pending === 0) - Number(b.pending === 0) || a.reqNo - b.reqNo);
  const sections = bySection(groups);
  const byId = new Map(v.states.map((s) => [s.id, s]));
  if (!t.items) return <p className="text-xs text-slate-500">No documents are asked for.</p>;
  return (
    <div className="space-y-4">
      <section aria-label="Progress" className={`${card} p-5 space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-800">Documents for financial year {c.fy}</h2>
          {!preview && c.sentAt && <span className="text-[11px] text-slate-400">Sent by your CA firm on {dayOf(c.sentAt)}</span>}
        </div>
        <div className="h-2 rounded-full bg-slate-200 overflow-hidden"><div className="h-full bg-emerald-600" style={{ width: `${Math.round((t.uploaded / t.items) * 100)}%` }} /></div>
        <p className="text-xs text-slate-600">{t.uploaded} of {t.items} items are uploaded. {t.pending > 0 ? `${t.pending} still pending, across ${t.documentsPending} document${t.documentsPending === 1 ? "" : "s"}.` : "Nothing is pending."}</p>
        {!preview && <p className="text-[11px] text-slate-400">A document you have already given under Banking or another section shows as uploaded here without uploading it again.</p>}
      </section>
      {t.pending === 0 && !preview && <p className="flex items-center gap-2 text-xs text-emerald-700"><CheckCircle2 className="w-4 h-4" /> Every document asked for is uploaded. Thank you.</p>}
      {sections.map((sec) => (
        <Fragment key={sec.section || "none"}>
          {sec.section && <h3 className="text-xs font-bold text-slate-700 pt-1">{sec.section}</h3>}
          <ul className="space-y-2">
            {sec.groups.map((g) => <DocumentGroup key={g.key} g={g} items={g.itemIds.map((id) => byId.get(id)).filter((s): s is AuditItem => Boolean(s))} preview={preview} onChanged={onChanged} onError={onError} />)}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}
