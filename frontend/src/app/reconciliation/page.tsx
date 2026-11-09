import { useState, useEffect } from "react";
import { useRouter } from "@/lib/router";
import Link from "@/lib/router";
import {
  GitCompare,
  CheckCircle2,
  AlertTriangle,
  FileSpreadsheet,
  Download,
  RefreshCw,
  ArrowRight,
  ExternalLink,
  Layers,
  Building,
  AlertCircle,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, Client } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export default function ReconciliationPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [taxPeriod, setTaxPeriod] = useState<string>("2025-01");
  const [activeTab, setActiveTab] = useState<"internal" | "register">("internal");

  // Internal Audit State
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalData, setInternalData] = useState<any>(null);

  // Register Match State
  const [registerFile, setRegisterFile] = useState<File | null>(null);
  const [matching, setMatching] = useState(false);
  const [matchResult, setMatchResult] = useState<any>(null);
  const [filterStatus, setFilterStatus] = useState<string>("all");

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
    }
  }, [user]);

  const loadInternalSummary = async () => {
    if (!selectedClient) return;
    setInternalLoading(true);
    try {
      const data = await api.reconciliation.getSummary(selectedClient, taxPeriod);
      setInternalData(data);
    } catch (err: any) {
      console.error("Failed to load internal reconciliation:", err);
    } finally {
      setInternalLoading(false);
    }
  };

  useEffect(() => {
    if (selectedClient) {
      loadInternalSummary();
    }
  }, [selectedClient, taxPeriod]);

  const handleMatchRegister = async () => {
    if (!selectedClient || !registerFile) return;
    setMatching(true);
    try {
      const res = await api.reconciliation.matchRegister(selectedClient, registerFile, taxPeriod);
      setMatchResult(res);
    } catch (err: any) {
      alert(err.message || "Failed to reconcile register");
    } finally {
      setMatching(false);
    }
  };

  const handleDownloadSample = async () => {
    try {
      await api.reconciliation.downloadSampleTemplate();
    } catch (e: any) {
      alert("Failed to download sample template");
    }
  };

  const filteredRegisterRecords = (matchResult?.records || []).filter((r: any) => {
    if (filterStatus === "all") return true;
    if (filterStatus === "exact") return r.status === "exact_match";
    if (filterStatus === "mismatch") return r.status === "value_mismatch" || r.status === "date_mismatch";
    if (filterStatus === "missing") return r.status === "missing_in_invoices" || r.status === "missing_in_register";
    return true;
  });

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title="Record Matching & Reconciliation"
          subtitle="Cross-reference uploaded invoices, identify duplicates, and match against client sales registers"
        />

        <div className="p-6 max-w-6xl mx-auto w-full space-y-6">
          {/* Top Controls: Client & Period */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Client / Taxpayer
                </label>
                <select
                  value={selectedClient}
                  onChange={(e) => setSelectedClient(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 bg-white"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                  Tax Filing Period
                </label>
                <select
                  value={taxPeriod}
                  onChange={(e) => setTaxPeriod(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 bg-white"
                >
                  <option value="2025-01">January 2025</option>
                  <option value="2025-02">February 2025</option>
                  <option value="2025-03">March 2025</option>
                </select>
              </div>
            </div>

            {/* Mode Switcher */}
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl self-stretch sm:self-auto">
              <button
                onClick={() => setActiveTab("internal")}
                className={`flex-1 sm:flex-initial px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  activeTab === "internal"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <Layers className="w-3.5 h-3.5" />
                Internal Audit & Duplicates
              </button>
              <button
                onClick={() => setActiveTab("register")}
                className={`flex-1 sm:flex-initial px-3.5 py-1.5 rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 ${
                  activeTab === "register"
                    ? "bg-white text-blue-700 shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                Match External Register
              </button>
            </div>
          </div>

          {/* TAB 1: INTERNAL AUDIT & DUPLICATE DETECTION */}
          {activeTab === "internal" && (
            <div className="space-y-6">
              {/* Summary Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>Clean Verified</span>
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-800">
                    {internalData?.clean_count ?? 0}
                  </div>
                  <div className="text-[11px] text-emerald-600 mt-1 font-medium">
                    No discrepancies detected
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>Duplicates</span>
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                  </div>
                  <div className="text-2xl font-bold text-amber-600">
                    {internalData?.duplicates_count ?? 0}
                  </div>
                  <div className="text-[11px] text-amber-600 mt-1 font-medium">
                    Duplicate invoice numbers
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>Tax Math Diff</span>
                    <AlertCircle className="w-4 h-4 text-rose-500" />
                  </div>
                  <div className="text-2xl font-bold text-rose-600">
                    {internalData?.math_mismatches_count ?? 0}
                  </div>
                  <div className="text-[11px] text-rose-500 mt-1 font-medium">
                    Taxable + Tax != Total
                  </div>
                </div>

                <div className="p-4 rounded-2xl bg-white border border-slate-200 shadow-sm">
                  <div className="flex items-center justify-between text-xs text-slate-500 mb-1">
                    <span>Total Invoices</span>
                    <Building className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="text-2xl font-bold text-slate-800">
                    {internalData?.total_invoices ?? 0}
                  </div>
                  <div className="text-[11px] text-blue-600 mt-1 font-medium">
                    In {taxPeriod}
                  </div>
                </div>
              </div>

              {/* Internal Invoices Table */}
              <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                    Invoices Reconciliation Status
                  </h3>
                  <button
                    onClick={loadInternalSummary}
                    className="text-xs text-blue-600 hover:text-blue-700 flex items-center gap-1 font-semibold"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Refresh
                  </button>
                </div>

                {internalLoading ? (
                  <div className="p-8 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
                    Auditing invoices...
                  </div>
                ) : (internalData?.invoices || []).length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs min-w-[700px]">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-[11px] font-semibold">
                        <tr>
                          <th className="p-3">Invoice #</th>
                          <th className="p-3">Date</th>
                          <th className="p-3">Buyer / Supplier</th>
                          <th className="p-3 text-right">Taxable (₹)</th>
                          <th className="p-3 text-right">Total (₹)</th>
                          <th className="p-3">Match Status</th>
                          <th className="p-3 text-right">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {internalData.invoices.map((inv: any) => (
                          <tr key={inv.id} className="hover:bg-slate-50/50">
                            <td className="p-3 font-semibold text-slate-800 font-mono">
                              {inv.invoice_number || "—"}
                            </td>
                            <td className="p-3 text-slate-500">{inv.invoice_date || "—"}</td>
                            <td className="p-3">
                              <div className="text-slate-800 font-medium truncate max-w-[180px]">
                                {inv.buyer_name || inv.supplier_name || "—"}
                              </div>
                              <div className="text-[10px] text-slate-400 font-mono">
                                {inv.buyer_gstin || inv.supplier_gstin || "Unregistered"}
                              </div>
                            </td>
                            <td className="p-3 text-right font-mono text-slate-700">
                              ₹{(inv.taxable_value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                            </td>
                            <td className="p-3 text-right font-mono font-bold text-slate-900">
                              ₹{(inv.invoice_total || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                            </td>
                            <td className="p-3">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider inline-flex items-center gap-1 ${
                                  inv.reconciliation_status === "clean"
                                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    : inv.reconciliation_status === "duplicate"
                                    ? "bg-amber-100 text-amber-800 border border-amber-300 font-black"
                                    : inv.reconciliation_status === "math_mismatch"
                                    ? "bg-rose-100 text-rose-800 border border-rose-300"
                                    : "bg-slate-100 text-slate-700 border border-slate-200"
                                }`}
                              >
                                {inv.reconciliation_label}
                              </span>
                            </td>
                            <td className="p-3 text-right">
                              <Link
                                href={`/invoices/${inv.id}/review`}
                                className="px-2.5 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold inline-flex items-center gap-1"
                              >
                                Review
                                <ArrowRight className="w-3 h-3" />
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-8 text-center text-xs text-slate-400">
                    No invoices found for this client and tax period.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: EXTERNAL REGISTER RECONCILIATION */}
          {activeTab === "register" && (
            <div className="space-y-6">
              {/* Upload Card */}
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-slate-200 shadow-sm space-y-5">
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-base font-bold text-slate-800 flex items-center gap-2">
                      <FileSpreadsheet className="w-5 h-5 text-emerald-600" />
                      Reconcile Invoices with Client Register
                    </h3>
                    <p className="text-xs text-slate-500">
                      Upload an Excel (.xlsx) or CSV file containing the client's internal sales/purchase register to detect missing invoices, value mismatches, and date conflicts.
                    </p>
                  </div>

                  <button
                    onClick={handleDownloadSample}
                    className="px-3.5 py-1.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 transition flex items-center gap-1.5 shrink-0"
                  >
                    <Download className="w-3.5 h-3.5 text-blue-600" />
                    Download Sample Register (.xlsx)
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <div className="flex-1 w-full">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(e) => setRegisterFile(e.target.files?.[0] || null)}
                      className="block w-full text-xs text-slate-500 file:mr-4 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer border border-slate-200 rounded-xl p-1 bg-slate-50"
                    />
                  </div>

                  <button
                    onClick={handleMatchRegister}
                    disabled={!registerFile || matching}
                    className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-md shadow-blue-600/20 transition flex items-center justify-center gap-2 disabled:opacity-50 shrink-0"
                  >
                    {matching ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        Reconciling...
                      </>
                    ) : (
                      <>
                        <GitCompare className="w-4 h-4" />
                        Run Reconciliation Match
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Match Results Display */}
              {matchResult && (
                <div className="space-y-6">
                  {/* Metric Summary Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                    <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-sm">
                      <div className="text-[11px] text-slate-500 font-medium">Exact Matches</div>
                      <div className="text-xl font-bold text-emerald-600 mt-0.5">
                        {matchResult.summary.exact_matches}
                      </div>
                      <div className="text-[10px] text-emerald-600">Values & dates match</div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-sm">
                      <div className="text-[11px] text-slate-500 font-medium">Value Mismatches</div>
                      <div className="text-xl font-bold text-amber-600 mt-0.5">
                        {matchResult.summary.value_mismatches}
                      </div>
                      <div className="text-[10px] text-amber-600">Tax or total discrepancy</div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-sm">
                      <div className="text-[11px] text-slate-500 font-medium">Missing in App</div>
                      <div className="text-xl font-bold text-rose-600 mt-0.5">
                        {matchResult.summary.missing_in_invoices}
                      </div>
                      <div className="text-[10px] text-rose-500">In register, no document</div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-sm">
                      <div className="text-[11px] text-slate-500 font-medium">Missing in Register</div>
                      <div className="text-xl font-bold text-purple-600 mt-0.5">
                        {matchResult.summary.missing_in_register}
                      </div>
                      <div className="text-[10px] text-purple-600">Document without entry</div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-slate-200 shadow-sm">
                      <div className="text-[11px] text-slate-500 font-medium">Match Accuracy</div>
                      <div className="text-xl font-bold text-blue-600 mt-0.5">
                        {matchResult.summary.match_rate_percent}%
                      </div>
                      <div className="text-[10px] text-blue-600">Reconciled</div>
                    </div>
                  </div>

                  {/* Filter Pills */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 font-medium">Filter Records:</span>
                    <button
                      onClick={() => setFilterStatus("all")}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                        filterStatus === "all"
                          ? "bg-slate-800 text-white"
                          : "bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      All ({matchResult.records.length})
                    </button>
                    <button
                      onClick={() => setFilterStatus("exact")}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                        filterStatus === "exact"
                          ? "bg-emerald-600 text-white"
                          : "bg-white text-emerald-700 hover:bg-emerald-50"
                      }`}
                    >
                      Exact Matches ({matchResult.summary.exact_matches})
                    </button>
                    <button
                      onClick={() => setFilterStatus("mismatch")}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                        filterStatus === "mismatch"
                          ? "bg-amber-600 text-white"
                          : "bg-white text-amber-700 hover:bg-amber-50"
                      }`}
                    >
                      Mismatches ({matchResult.summary.value_mismatches + matchResult.summary.date_mismatches})
                    </button>
                    <button
                      onClick={() => setFilterStatus("missing")}
                      className={`px-3 py-1 rounded-lg text-xs font-semibold ${
                        filterStatus === "missing"
                          ? "bg-rose-600 text-white"
                          : "bg-white text-rose-700 hover:bg-rose-50"
                      }`}
                    >
                      Missing ({matchResult.summary.missing_in_invoices + matchResult.summary.missing_in_register})
                    </button>
                  </div>

                  {/* Side-by-Side Comparison Table */}
                  <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-xs min-w-[850px]">
                        <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-[11px] font-semibold">
                          <tr>
                            <th className="p-3">#</th>
                            <th className="p-3">Invoice Number</th>
                            <th className="p-3">Reconciliation Status</th>
                            <th className="p-3">Uploaded Register Row</th>
                            <th className="p-3">Extracted App Invoice</th>
                            <th className="p-3 text-right">Variance / Diff</th>
                            <th className="p-3 text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {filteredRegisterRecords.map((r: any, idx: number) => (
                            <tr key={idx} className="hover:bg-slate-50/50">
                              <td className="p-3 text-slate-400 font-mono text-[11px]">
                                {r.row_index ?? "—"}
                              </td>
                              <td className="p-3 font-semibold text-slate-800 font-mono">
                                {r.invoice_number || "—"}
                              </td>
                              <td className="p-3">
                                <span
                                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                                    r.status === "exact_match"
                                      ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                                      : r.status === "value_mismatch"
                                      ? "bg-amber-100 text-amber-800 border border-amber-300"
                                      : r.status === "date_mismatch"
                                      ? "bg-blue-100 text-blue-800 border border-blue-300"
                                      : "bg-rose-100 text-rose-800 border border-rose-300"
                                  }`}
                                >
                                  {r.status_text}
                                </span>
                              </td>

                              {/* Register Data */}
                              <td className="p-3">
                                {r.register ? (
                                  <div className="text-[11px] space-y-0.5">
                                    <div className="text-slate-800 font-medium">
                                      Total: ₹{(r.register.total_value || 0).toLocaleString("en-IN")}
                                    </div>
                                    <div className="text-slate-400">
                                      Date: {r.register.date || "—"} | Taxable: ₹{(r.register.taxable_value || 0).toLocaleString("en-IN")}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-rose-500 italic text-[11px]">Not in Register</span>
                                )}
                              </td>

                              {/* App Data */}
                              <td className="p-3">
                                {r.app_invoice ? (
                                  <div className="text-[11px] space-y-0.5">
                                    <div className="text-slate-800 font-medium">
                                      Total: ₹{(r.app_invoice.total_value || 0).toLocaleString("en-IN")}
                                    </div>
                                    <div className="text-slate-400">
                                      Date: {r.app_invoice.date || "—"} | Status: {r.app_invoice.review_status}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-rose-500 italic text-[11px]">No Uploaded Invoice</span>
                                )}
                              </td>

                              {/* Variance */}
                              <td className="p-3 text-right font-mono">
                                {r.difference ? (
                                  r.difference.total > 0 ? (
                                    <span className="text-amber-700 font-bold">
                                      ₹{r.difference.total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                                    </span>
                                  ) : (
                                    <span className="text-emerald-600 font-semibold">₹0.00</span>
                                  )
                                ) : (
                                  <span className="text-slate-400">—</span>
                                )}
                              </td>

                              {/* Action */}
                              <td className="p-3 text-right">
                                {r.app_invoice ? (
                                  <Link
                                    href={`/invoices/${r.app_invoice.id}/review`}
                                    className="px-2.5 py-1 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold text-xs inline-flex items-center gap-1"
                                  >
                                    View
                                    <ExternalLink className="w-3 h-3" />
                                  </Link>
                                ) : (
                                  <Link
                                    href="/upload"
                                    className="px-2.5 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold text-xs inline-flex items-center gap-1"
                                  >
                                    Upload
                                  </Link>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
