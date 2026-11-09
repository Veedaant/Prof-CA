import { useState, useEffect } from "react";
import { currentPeriod } from "@/lib/period";
import { useRouter } from "@/lib/router";
import {
  Download,
  FileSpreadsheet,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, Client, ExportRecord, Invoice } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export default function ExportsPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [taxPeriod, setTaxPeriod] = useState<string>(currentPeriod());

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [exportHistory, setExportHistory] = useState<ExportRecord[]>([]);
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [includeUnreviewed, setIncludeUnreviewed] = useState(false);
  const [warningMsg, setWarningMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  useEffect(() => {
    if (user) {
      api.clients.list().then((cls) => {
        setClients(cls);
        if (cls.length > 0) setSelectedClient(cls[0].id);
      });
      loadHistory();
    }
  }, [user]);

  const loadHistory = async () => {
    try {
      const history = await api.exports.history();
      setExportHistory(history);
    } catch (e) {
      console.error("Failed to load export history:", e);
    }
  };

  const loadInvoices = async () => {
    if (selectedClient && taxPeriod) {
      try {
        const invs = await api.invoices.list({ client_id: selectedClient, tax_period: taxPeriod });
        setInvoices(invs);
      } catch (e) {
        console.error("Failed to load invoices:", e);
      }
    }
  };

  useEffect(() => {
    loadInvoices();
  }, [selectedClient, taxPeriod]);

  const approvedInvoices = invoices.filter(
    (i) => i.review_status === "approved" || i.review_status === "auto_approved"
  );
  const unreviewedInvoices = invoices.filter(
    (i) => i.review_status !== "approved" && i.review_status !== "auto_approved"
  );

  const handleBulkApprove = async () => {
    if (!selectedClient || !taxPeriod) return;
    if (!confirm(`Are you sure you want to approve all ${unreviewedInvoices.length} pending invoices for ${taxPeriod}?`)) {
      return;
    }
    setApproving(true);
    try {
      const res = await api.exports.approveAll(selectedClient, taxPeriod);
      alert(res.message);
      await loadInvoices();
    } catch (err: any) {
      alert(err.message || "Failed to bulk approve invoices");
    } finally {
      setApproving(false);
    }
  };

  const handleGenerateExport = async () => {
    if (!selectedClient || !taxPeriod) return;
    setGenerating(true);
    setWarningMsg(null);
    try {
      const res = await api.exports.generateGSTR1(selectedClient, taxPeriod, includeUnreviewed);
      if (res.warning) {
        setWarningMsg(res.warning);
      }
      loadHistory();
      // Reliable blob download directly in browser
      await api.exports.downloadFile(res.download_url!, res.file_name);
    } catch (err: any) {
      alert(err.message || "Failed to generate GSTR-1");
    } finally {
      setGenerating(false);
    }
  };

  const handleDirectDownload = async (downloadUrl: string, fileName: string) => {
    try {
      await api.exports.downloadFile(downloadUrl, fileName);
    } catch (err: any) {
      alert(err.message || "Download failed");
    }
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title="GSTR-1 Offline Utility Generator"
          subtitle="Generate official multi-sheet Excel files (b2b, b2cl, b2cs, cdnr, hsn)"
        />

        <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
          {/* Export Generator Card */}
          <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 shadow-sm space-y-6">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-600 flex items-center justify-center font-bold shadow-inner">
                <FileSpreadsheet className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-base font-bold text-slate-800">
                  Generate Official GSTR-1 Excel (.xlsx)
                </h2>
                <p className="text-xs text-slate-500">
                  Strictly conforms to GSTN Offline Utility template formatting and column schema.
                </p>
              </div>
            </div>

            {/* Selection Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Select Taxpayer / Client
                </label>
                <select
                  value={selectedClient}
                  onChange={(e) => setSelectedClient(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} — GSTIN: {c.gstin || "None"}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Tax Filing Period
                </label>
                <input type="month" value={taxPeriod} onChange={(e) => e.target.value && setTaxPeriod(e.target.value)} className="w-full px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black" />
              </div>
            </div>

            {/* Pre-export Audit Box */}
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-700">Pre-Filing Compliance Check:</span>
                <span className="text-slate-500">{invoices.length} Invoices Found in Period</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs">
                  <span className="text-[11px] font-semibold text-emerald-800 uppercase">
                    Eligible for GSTR-1
                  </span>
                  <div className="text-lg font-bold text-emerald-700 mt-0.5">
                    {approvedInvoices.length} Approved Invoices
                  </div>
                  <div className="text-[11px] text-emerald-600">
                    Included in b2b, b2cl, b2cs, cdnr & hsn
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs flex flex-col justify-between">
                  <div>
                    <span className="text-[11px] font-semibold text-amber-800 uppercase">
                      Excluded (Unreviewed)
                    </span>
                    <div className="text-lg font-bold text-amber-700 mt-0.5">
                      {unreviewedInvoices.length} Invoices
                    </div>
                    <div className="text-[11px] text-amber-600">
                      {unreviewedInvoices.length > 0 ? "Pending CA approval" : "All clear!"}
                    </div>
                  </div>
                  {unreviewedInvoices.length > 0 && (
                    <button
                      type="button"
                      onClick={handleBulkApprove}
                      disabled={approving}
                      className="mt-2 py-1 px-2.5 rounded bg-amber-600 hover:bg-amber-700 text-white font-semibold text-[11px] transition flex items-center justify-center gap-1 self-start"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {approving ? "Approving..." : `1-Click Approve All (${unreviewedInvoices.length})`}
                    </button>
                  )}
                </div>
              </div>

              {/* Draft Export Checkbox */}
              <div className="pt-2 border-t border-slate-200 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="includeUnreviewed"
                  checked={includeUnreviewed}
                  onChange={(e) => setIncludeUnreviewed(e.target.checked)}
                  className="w-4 h-4 text-blue-600 rounded border-slate-300 focus:ring-blue-500 cursor-pointer"
                />
                <label htmlFor="includeUnreviewed" className="text-xs font-medium text-slate-700 cursor-pointer">
                  Draft Export Mode: Include unreviewed / pending invoices in generated GSTR-1
                </label>
              </div>

              {warningMsg && (
                <div className="p-3 rounded-lg bg-amber-100 text-amber-800 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>{warningMsg}</span>
                </div>
              )}
            </div>

            {/* Included Sheets Preview */}
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Sheets Included in Generated Workbook:
              </span>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                  b2b (Registered Invoices)
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                  b2cl (Inter-state &gt; ₹2.5L)
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                  b2cs (Small B2C Summary)
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                  cdnr (Credit/Debit Notes)
                </span>
                <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 font-semibold border border-blue-200">
                  hsn (HSN Summary Table)
                </span>
              </div>
            </div>

            {/* Action Button */}
            <button
              onClick={handleGenerateExport}
              disabled={generating || (!includeUnreviewed && approvedInvoices.length === 0) || (includeUnreviewed && invoices.length === 0)}
              className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-lg shadow-emerald-600/20 transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {generating ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Building Excel Workbook...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Generate & Download GSTR-1 Excel ({includeUnreviewed ? invoices.length : approvedInvoices.length} Invoices)
                </>
              )}
            </button>
          </div>

          {/* Export History Table */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-2">
              <Clock className="w-4 h-4 text-slate-400" />
              Generated Export History
            </h3>

            {exportHistory.length > 0 ? (
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                {exportHistory.map((exp) => (
                  <div
                    key={exp.id}
                    className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50 transition text-xs"
                  >
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-800 flex items-center gap-2">
                        <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
                        <span>{exp.file_name}</span>
                        <span className="text-[10px] font-bold bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                          {exp.tax_period}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Client: {exp.client_name || "Client"} | Invoices: {exp.invoice_count} |
                        Generated on {new Date(exp.created_at).toLocaleString("en-IN")}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDirectDownload(exp.download_url!, exp.file_name)}
                      className="px-3.5 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-800 font-semibold text-xs transition flex items-center gap-1.5 self-start sm:self-auto border border-emerald-200"
                    >
                      <Download className="w-3.5 h-3.5 text-emerald-600" />
                      Download .xlsx
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">No export files generated yet.</p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
