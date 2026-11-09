import React, { useEffect, useState } from "react";
import Link, { useRouter } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { api, TrackedRequest } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { Stepper, stageBadge } from "@/components/Stepper";
import { ReadingProgress } from "@/components/ReadingProgress";
import { Upload } from "lucide-react";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "client_review", label: "To verify" },
  { key: "with_staff", label: "With CA staff" },
  { key: "completed", label: "Completed" },
  { key: "alert", label: "Changed - review again" },
];

export default function RequestsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<TrackedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user) return;
    const load = () =>
      api.invoices
        .requests()
        .then((r) => setRows(r.requests))
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [user]);

  const isClient = user?.role === "client";
  const alertMine = (r: TrackedRequest) => (isClient ? r.alert_for === "client" : r.alert_for === "staff");
  const shown = rows.filter((r) => filter === "all" || (filter === "alert" ? alertMine(r) : r.stage.key === filter));
  const pending = rows.filter((r) => r.stage.key === "client_review").length;

  const open = (r: TrackedRequest) => {
    if (!r.invoice_id) return;
    router.push(isClient ? ("/gst") : `/invoices/${r.invoice_id}/review`);
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Requests" subtitle="Track every upload from submission to final confirmation" />
        <div className="p-6 max-w-5xl mx-auto w-full space-y-5">
          {pending > 0 && isClient && (
            <div className="rounded-xl bg-black text-white px-5 py-4 text-sm flex items-center justify-between">
              <span>
                {pending} invoice{pending > 1 ? "s" : ""} retrieved - check them and send to your CA.
              </span>
              <button onClick={() => setFilter("client_review")} className="underline underline-offset-4 font-medium">
                Show
              </button>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex gap-1.5 flex-wrap">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                    filter === f.key ? "bg-black text-white border-black" : "bg-white text-slate-600 border-slate-200 hover:border-black"
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <Link href={isClient ? "/gst" : "/upload"} className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800">
              <Upload className="w-4 h-4" /> New upload
            </Link>
          </div>

          {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}

          {loading ? (
            <p className="text-sm text-slate-500">Loading...</p>
          ) : shown.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center text-sm text-slate-500">No requests here yet.</div>
          ) : (
            <div className="space-y-3">
              {shown.map((r) => (
                <div
                  key={r.file_id}
                  onClick={() => open(r)}
                  className={`bg-white border border-slate-200 rounded-2xl p-5 shadow-sm ${r.invoice_id ? "cursor-pointer hover:border-black" : ""} transition`}
                >
                  <div className="flex items-start justify-between gap-3 mb-5">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate">{r.original_filename}</p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {!isClient && <>{r.client_name} · </>}
                        {r.invoice_number ? `Invoice ${r.invoice_number} · ` : ""}
                        {new Date(r.uploaded_at).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-semibold px-2 py-1 rounded-full bg-slate-900 text-white whitespace-nowrap">{(r.return_type === "gstr3b" || (!r.return_type && r.invoice_type === "purchase")) ? "GSTR-3B" : "GSTR-1"}</span>
                      <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full border whitespace-nowrap ${stageBadge(r.stage.key)}`}>{r.stage.label}</span>
                    </div>
                  </div>
                  <Stepper step={r.stage.step} failed={["failed", "rejected"].includes(r.stage.key)} />
                  {alertMine(r) && r.alert_text && <p className="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-3">{r.alert_text}</p>}
                  {r.stage.key === "processing" && (
                    <div className="mt-4"><ReadingProgress pct={r.progress || 0} label={r.file_status === "queued" ? "Waiting to start" : r.progress_label} /></div>
                  )}
                  {r.stage.key === "failed" && r.error_message && <p className="text-xs text-rose-600 mt-3">{r.error_message}</p>}
                  {r.stage.key === "changes_requested" && r.client_note && <p className="text-xs text-amber-700 mt-3">Your note: {r.client_note}</p>}
                  {r.stage.key === "client_review" && isClient && (
                    <p className="text-xs font-medium mt-3 underline underline-offset-4">Check and send to CA →</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
