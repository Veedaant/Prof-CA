import { Fragment, useState } from "react";
import { CheckCircle2, Clock, MessageSquare, RefreshCw, Send, Trash2, ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";

import { auditApi, AuditChecklist, AuditPoint, AuditQueryMsg } from "@/lib/api";
import { pointsBySection, timeOf } from "@/lib/audit";

const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const area = "w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-60";

type Status = AuditPoint["status"];
const OPTIONS: { value: Status; text: string; Icon: LucideIcon; on: string }[] = [
  { value: "checked", text: "Checked", Icon: CheckCircle2, on: "bg-emerald-600 text-white border-emerald-600" },
  { value: "pending", text: "Pending", Icon: Clock, on: "bg-slate-800 text-white border-slate-800" },
  { value: "query", text: "Query", Icon: MessageSquare, on: "bg-amber-500 text-white border-amber-500" },
];

/** Every query of the CA firm and every reply of the client on a point, oldest first. */
function Thread({ messages, onDelete }: { messages: AuditQueryMsg[]; onDelete?: (m: AuditQueryMsg) => void }) {
  if (!messages.length) return null;
  return (
    <ul className="space-y-2" aria-label="Queries and replies">
      {messages.map((m) => (
        <li key={m.id} className={`rounded-xl border p-3 text-xs ${m.role === "client" ? "bg-emerald-50/60 border-emerald-200" : "bg-slate-50 border-slate-200"}`}>
          <div className="flex items-center justify-between gap-2 mb-1">
            <p className="text-[11px] font-semibold text-slate-600">{m.role === "client" ? "Client" : "CA firm"}{m.by ? ` · ${m.by}` : ""} <span className="font-normal text-slate-400">· {timeOf(m.at)}</span></p>
            {onDelete && m.role === "staff" && <button type="button" onClick={() => { if (window.confirm("Take back this query?")) onDelete(m); }} className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-rose-50" title="Take back this query" aria-label="Take back this query"><Trash2 className="w-3 h-3" /></button>}
          </div>
          <p className="text-slate-800 whitespace-pre-wrap break-words">{m.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** A box to write in, and the button that sends it. */
function Compose({ label, button, disabled, hint, onSend }: { label: string; button: string; disabled?: boolean; hint?: string; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => { setBusy(true); try { await onSend(text.trim()); setText(""); } catch { /* the page shows the error */ } finally { setBusy(false); } };
  return (
    <div className="space-y-2">
      <label className="block text-[11px] font-semibold text-slate-600">{label}
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} disabled={disabled || busy} className={`${area} mt-1 font-normal`} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={send} disabled={disabled || busy || !text.trim()} className="px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} {button}
        </button>
        {hint && <span className="text-[11px] text-amber-700">{hint}</span>}
      </div>
    </div>
  );
}

function Waiting({ p }: { p: AuditPoint }) {
  if (p.awaiting === "client") return <span className="px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-[11px] font-semibold text-amber-700">Waiting for the client</span>;
  if (p.awaiting === "staff" && p.queries.length) return <span className="px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-[11px] font-semibold text-blue-700">Client replied: review it</span>;
  if (p.status === "query") return <span className="px-2 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">Write the query</span>;
  return null;
}

function PointRow({ p, sent, onChanged, onError }: { p: AuditPoint; sent: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(p.status === "query");
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); onChanged(); } catch (e: any) { onError(e.message); throw e; } finally { setBusy(false); } };
  const choose = (value: Status) => { if (value === p.status) return; run(() => auditApi.setPoint(p.id, value)).then(() => { if (value === "query") setOpen(true); }).catch(() => {}); };
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-xl border border-slate-200 bg-white">
      <div className="p-3 flex flex-wrap items-start gap-3">
        <span className="w-7 shrink-0 text-[11px] font-semibold text-slate-400 pt-1">{p.ref || p.seq}</span>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-xs font-medium text-slate-800">{p.name}</p>
          {p.detail && <p className="text-[11px] text-slate-500 mt-0.5">{p.detail}</p>}
          <div className="flex flex-wrap items-center gap-2 mt-1.5"><Waiting p={p} />{p.statusBy && p.status !== "pending" && <span className="text-[10px] text-slate-400">{p.status === "checked" ? "Checked" : "Marked"} by {p.statusBy}{p.statusAt ? `, ${timeOf(p.statusAt)}` : ""}</span>}</div>
        </div>
        <div role="radiogroup" aria-label={`Status of point ${p.ref || p.seq}`} className="flex items-center gap-1">
          {OPTIONS.map((o) => (
            <button key={o.value} type="button" role="radio" aria-checked={p.status === o.value} disabled={busy} onClick={() => choose(o.value)}
              className={`px-2.5 py-1 rounded-lg border text-[11px] font-semibold flex items-center gap-1 disabled:opacity-60 ${p.status === o.value ? o.on : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
              <o.Icon className="w-3 h-3" /> {o.text}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} queries on point ${p.ref || p.seq}`} className="px-2 py-1 rounded-lg border border-slate-200 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 flex items-center gap-1">
          <Chevron className="w-3 h-3" /> <MessageSquare className="w-3 h-3" /> {p.queries.length}
        </button>
      </div>
      {open && (
        <div className="border-t border-slate-100 p-3 space-y-3 bg-slate-50/40">
          <Thread messages={p.queries} onDelete={(m) => run(() => auditApi.deleteQuery(m.id)).catch(() => {})} />
          <Compose label="Write a query to the client about this point" button="Send query" disabled={!sent} hint={sent ? undefined : "Send the checklist to the client first (Step 2) so the client can see the query."}
            onSend={(text) => run(() => auditApi.postQuery(p.id, text)).then(() => undefined)} />
        </div>
      )}
    </li>
  );
}

type Filter = "all" | Status;

/** Step 3 for the CA firm: every point of the audit programme with Checked, Pending and Query, and the thread of queries and replies on each. */
export function ProgrammeTracker({ checklist: c, onChanged, onError }: { checklist: AuditChecklist; onChanged: () => void; onError: (m: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const p = c.programme;
  if (!p || !c.points.length) return null;
  const shown = c.points.filter((x) => filter === "all" || x.status === filter);
  const tabs: { value: Filter; text: string; n: number }[] = [{ value: "all", text: "All", n: p.points }, { value: "pending", text: "Pending", n: p.pending }, { value: "query", text: "Query", n: p.query }, { value: "checked", text: "Checked", n: p.checked }];
  return (
    <section aria-label="Step 3: audit programme" className={`${card} p-6 space-y-4`}>
      <div>
        <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">Step 3: Audit programme</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-2xl">Mark each point Checked, Pending, or Query. A query is written against the point; the client answers it under Audit Documents, and the whole thread stays here.</p>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[["Points", p.points, false], ["Checked", p.checked, false], ["Pending", p.pending, false], ["Query open", p.query, p.query > 0]].map(([k, v, bad]) => (
          <div key={String(k)} className={`rounded-xl border p-2.5 ${bad ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{String(v)}</p></div>
        ))}
      </div>
      {(p.awaitingClient > 0 || p.awaitingStaff > 0) && <p className="text-[11px] text-slate-600">{p.awaitingClient > 0 && `${p.awaitingClient} waiting for the client. `}{p.awaitingStaff > 0 && `${p.awaitingStaff} where the client has replied and you have to review.`}</p>}
      <div role="tablist" aria-label="Filter the points" className="flex flex-wrap gap-1.5">
        {tabs.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={filter === t.value} onClick={() => setFilter(t.value)}
            className={`px-3 py-1 rounded-lg border text-[11px] font-semibold ${filter === t.value ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{t.text} ({t.n})</button>
        ))}
      </div>
      {shown.length === 0 ? <p className="text-xs text-slate-500">No point is {filter}.</p> : pointsBySection(shown).map((sec) => (
        <Fragment key={sec.section || "none"}>
          {sec.section && <h3 className="text-xs font-bold text-slate-700 pt-1">{sec.section}</h3>}
          <ul className="space-y-2">{sec.points.map((x) => <PointRow key={x.id} p={x} sent={c.status === "sent"} onChanged={onChanged} onError={onError} />)}</ul>
        </Fragment>
      ))}
    </section>
  );
}

function QueryCard({ p, onChanged, onError }: { p: AuditPoint; onChanged: () => void; onError: (m: string) => void }) {
  const open = p.status === "query";
  return (
    <li className={`rounded-xl border bg-white p-4 space-y-3 ${p.awaiting === "client" ? "border-amber-300" : "border-slate-200"}`}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs font-semibold text-slate-800">{p.ref ? `${p.ref}. ` : ""}{p.name}</p>
          {p.awaiting === "client" && <span className="px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-[11px] font-semibold text-amber-700">Your reply is needed</span>}
          {p.awaiting === "staff" && <span className="px-2 py-0.5 rounded-full border border-blue-200 bg-blue-50 text-[11px] font-semibold text-blue-700">With your CA firm</span>}
          {!open && p.status === "checked" && <span className="px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-[11px] font-semibold text-emerald-700">Closed: checked</span>}
        </div>
        {p.detail && <p className="text-[11px] text-slate-500 mt-0.5">{p.detail}</p>}
      </div>
      <Thread messages={p.queries} />
      {open && <Compose label={p.awaiting === "client" ? "Your reply" : "Add to your reply"} button="Send reply" onSend={async (text) => { try { await auditApi.postQuery(p.id, text); onChanged(); } catch (e: any) { onError(e.message); throw e; } }} />}
    </li>
  );
}

/** The client's side: the points of the audit the CA firm has queried, with the thread on each and a box to answer in. */
export function QueriesPanel({ checklist: c, onChanged, onError }: { checklist: AuditChecklist; onChanged: () => void; onError: (m: string) => void }) {
  const open = c.points.filter((p) => p.status === "query");
  const closed = c.points.filter((p) => p.status !== "query");
  if (!c.points.length) return null;
  const waiting = open.filter((p) => p.awaiting === "client").length;
  return (
    <section aria-label="Queries from your CA firm" className={`${card} p-5 space-y-4`}>
      <div>
        <h2 className="text-sm font-bold text-slate-800">Queries from your CA firm</h2>
        <p className="text-xs text-slate-500 mt-1">{waiting > 0 ? `${waiting} need${waiting === 1 ? "s" : ""} your reply. ` : "Nothing needs your reply right now. "}Answer each query beside it; your explanation is kept with the point of the audit it is about.</p>
      </div>
      {open.length > 0 && <ul className="space-y-3">{open.map((p) => <QueryCard key={p.id} p={p} onChanged={onChanged} onError={onError} />)}</ul>}
      {closed.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-semibold text-slate-600">Closed queries ({closed.length})</summary>
          <ul className="space-y-3 mt-3">{closed.map((p) => <QueryCard key={p.id} p={p} onChanged={onChanged} onError={onError} />)}</ul>
        </details>
      )}
    </section>
  );
}
