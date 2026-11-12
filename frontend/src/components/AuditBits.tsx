import { CheckCircle2, Clock, MinusCircle, Download, Trash2 } from "lucide-react";
import type { AuditFile, AuditGroup, AuditItem } from "@/lib/api";

/** Small pieces the audit checklist shares between the CA firm's page and the client's page. */

const STATUS: Record<AuditItem["status"], { text: string; cls: string; Icon: typeof Clock }> = {
  received: { text: "Uploaded", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: CheckCircle2 },
  pending: { text: "Pending", cls: "bg-amber-50 text-amber-700 border-amber-200", Icon: Clock },
  na: { text: "Not applicable", cls: "bg-slate-50 text-slate-500 border-slate-200", Icon: MinusCircle },
};

export function StatusChip({ status }: { status: AuditItem["status"] }) {
  const s = STATUS[status];
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] font-semibold ${s.cls}`}><s.Icon className="w-3 h-3" />{s.text}</span>;
}

export function Progress({ group }: { group: Pick<AuditGroup, "received" | "na" | "total" | "pending"> }) {
  const done = group.received + group.na;
  const pct = group.total ? Math.round((done / group.total) * 100) : 0;
  return (
    <div className="min-w-[110px]" aria-label={`${done} of ${group.total} uploaded`}>
      <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden"><div className={`h-full ${group.pending ? "bg-amber-500" : "bg-emerald-600"}`} style={{ width: `${pct}%` }} /></div>
      <p className="text-[10px] text-slate-500 mt-0.5">{done} of {group.total} uploaded</p>
    </div>
  );
}

/** The files uploaded against a document: a link to download each, and a bin to take one back where that is allowed. */
export function ItemFiles({ files, canDelete, onDownload, onDelete }: { files: AuditFile[]; canDelete: (f: AuditFile) => boolean; onDownload: (f: AuditFile) => void; onDelete: (f: AuditFile) => void }) {
  if (!files.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <li key={f.id} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-lg border border-slate-200 bg-white text-[11px] text-slate-700">
          <span className="max-w-[180px] truncate" title={f.name}>{f.name}</span>
          <button type="button" onClick={() => onDownload(f)} className="p-1 rounded text-slate-500 hover:bg-slate-100" title="Download" aria-label={`Download ${f.name}`}><Download className="w-3 h-3" /></button>
          {canDelete(f) && <button type="button" onClick={() => { if (window.confirm(`Remove ${f.name}?`)) onDelete(f); }} className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50" title="Remove" aria-label={`Remove ${f.name}`}><Trash2 className="w-3 h-3" /></button>}
        </li>
      ))}
    </ul>
  );
}
