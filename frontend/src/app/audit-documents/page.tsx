import { useCallback, useEffect, useState } from "react";
import { useRouter } from "@/lib/router";
import { ClipboardCheck } from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { auditApi, AuditState } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { AuditDocumentList } from "@/components/AuditDocuments";
import { QueriesPanel } from "@/components/AuditProgramme";

const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const input = "px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black";

export default function AuditDocumentsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [fy, setFy] = useState("");
  const [state, setState] = useState<AuditState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!authLoading && !user) router.push("/login"); }, [user, authLoading, router]);
  useEffect(() => { if (user && user.role !== "client") router.push("/audit-compliance"); }, [user, router]);

  const clientId = user?.role === "client" ? user.client_id || "" : "";
  const load = useCallback(() => {
    if (!clientId) return;
    auditApi.state(clientId, fy || undefined).then((s) => { setState(s); setError(null); if (!fy && s.fy) setFy(s.fy); }).catch((e) => setError(e.message));
  }, [clientId, fy]);
  useEffect(() => { load(); }, [load]);

  const c = state?.checklist || null;

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Audit Documents" subtitle="The documents your CA firm needs for the audit, and its queries: upload and answer beside each one" />
        <div className="p-6 max-w-4xl mx-auto w-full space-y-5">
          {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
          {state && state.years.length > 1 && (
            <div className="flex items-center gap-2">
              <label htmlFor="ad-fy" className="text-xs font-semibold text-slate-600">Financial year</label>
              <select id="ad-fy" value={fy} onChange={(e) => { setFy(e.target.value); setState(null); }} className={input}>
                {state.years.map((y) => <option key={y.fy} value={y.fy}>{y.fy}</option>)}
              </select>
            </div>
          )}

          {state && !c && (
            <div className={`${card} p-6 flex items-start gap-3`}>
              <ClipboardCheck className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-slate-800">No documents are asked for yet</p>
                <p className="text-xs text-slate-500 mt-1">When your CA firm sends the list of documents the audit needs, it appears here, and you can upload each document beside its name.</p>
              </div>
            </div>
          )}

          {c && (
            <>
              <QueriesPanel checklist={c} onChanged={load} onError={setError} />
              <AuditDocumentList checklist={c} onChanged={load} onError={setError} />
            </>
          )}
          {!state && !error && <p className="text-xs text-slate-500">Loading...</p>}
        </div>
      </main>
    </div>
  );
}
