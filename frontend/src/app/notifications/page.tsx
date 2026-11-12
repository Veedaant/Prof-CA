import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "@/lib/router";
import { Bell, CheckCheck, FileText, MessageSquare, ShieldCheck, Upload, AlertTriangle, Landmark, ClipboardCheck } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { AppNotification, notificationsApi } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

const card = "bg-white border border-slate-200 rounded-2xl";

const ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  doc_sent: FileText, doc_unsent: FileText, doc_edited: FileText, doc_rejected: AlertTriangle,
  ledger_uploaded: Upload, banking_upload: Landmark, audit_checklist: ClipboardCheck, audit_upload: ClipboardCheck, audit_query: MessageSquare, audit_reply: MessageSquare, feedback: MessageSquare, resubmitted: MessageSquare, verified: ShieldCheck,
};

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  const load = useCallback(() => {
    notificationsApi.list().then((r) => { setItems(r.notifications); setError(null); setReady(true); }).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!user) return;
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [user, load]);

  const unread = items.filter((n) => !n.read).length;
  const shown = items.filter((n) => filter === "all" || !n.read);
  const isClient = user?.role === "client";

  const open = async (n: AppNotification) => {
    if (!n.read) {
      setItems((cur) => cur.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      notificationsApi.markRead([n.id]).catch(() => {});
    }
    if (n.link) router.push(n.link);
  };
  const markAll = async () => {
    setItems((cur) => cur.map((x) => ({ ...x, read: true })));
    await notificationsApi.markRead(undefined, true).catch(() => {});
    load();
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Notifications" subtitle={isClient ? "What your CA firm has done with your documents and requests" : "What your clients have sent, changed or replied to"} />
        <div className="p-6 max-w-3xl mx-auto w-full space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-1.5">
              {([["all", "All"], ["unread", `Unread${unread ? ` (${unread})` : ""}`]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setFilter(k)} className={`px-3.5 py-1.5 rounded-full text-sm font-medium border transition ${filter === k ? "bg-black text-white border-black" : "bg-white text-slate-600 border-slate-200 hover:border-black"}`}>{l}</button>
              ))}
            </div>
            <button disabled={unread === 0} onClick={markAll} className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40">
              <CheckCheck className="w-4 h-4" /> Mark all as read
            </button>
          </div>

          {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}

          {!ready && !error ? (
            <div className={`${card} p-8 text-center text-sm text-slate-500`}>Loading...</div>
          ) : shown.length === 0 ? (
            <div className={`${card} p-10 text-center text-sm text-slate-500`}>
              <Bell className="w-6 h-6 mx-auto mb-2 text-slate-400" />
              {filter === "unread" ? "You are all caught up." : isClient ? "Nothing yet. You will see it here when your CA firm replies to what you send." : "Nothing yet. You will see it here when a client sends, edits or replies."}
            </div>
          ) : (
            <ul className="space-y-2">
              {shown.map((n) => {
                const Icon = ICON[n.kind] || Bell;
                return (
                  <li key={n.id}>
                    <button onClick={() => open(n)} className={`w-full text-left ${card} p-4 flex gap-3 items-start hover:border-black transition ${n.read ? "" : "border-black"}`}>
                      <span className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${n.read ? "bg-slate-100 text-slate-500" : "bg-black text-white"}`}><Icon className="w-4 h-4" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-3">
                          <span className={`text-sm ${n.read ? "text-slate-700" : "font-semibold text-slate-900"}`}>{n.title}</span>
                          <span className="text-xs text-slate-400 whitespace-nowrap shrink-0">{ago(n.created_at)}</span>
                        </span>
                        {n.body && <span className="block text-sm text-slate-500 mt-0.5">{n.body}</span>}
                        {n.actor_name && <span className="block text-xs text-slate-400 mt-1">{n.actor_name}</span>}
                      </span>
                      {!n.read && <span className="w-2 h-2 rounded-full bg-rose-600 mt-2 shrink-0" aria-label="Unread" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
