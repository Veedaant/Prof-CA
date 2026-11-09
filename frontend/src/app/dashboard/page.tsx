import React, { useEffect, useState, useMemo } from "react";
import { currentPeriod } from "@/lib/period";
import Link from "@/lib/router";
import { useRouter, useSearchParams } from "@/lib/router";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  ColumnDef,
  flexRender,
  SortingState,
} from "@tanstack/react-table";
import {
  FileText,
  AlertCircle,
  CheckCircle,
  Clock,
  Filter,
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  Building,
  Calendar,
  Sparkles,
  ArrowUpDown,
  Download,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, Invoice, Client } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

function DashboardContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();

  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [selectedPeriod, setSelectedPeriod] = useState<string>(currentPeriod());
  const [statusFilter, setStatusFilter] = useState<string>(searchParams.get("status") || "all");
  const [globalFilter, setGlobalFilter] = useState<string>("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "created_at", desc: true }]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [invList, clientList] = await Promise.all([
        api.invoices.list({
          client_id: selectedClient || undefined,
          tax_period: selectedPeriod || undefined,
          review_status: statusFilter === "all" ? undefined : statusFilter,
        }),
        api.clients.list(),
      ]);
      setInvoices(invList);
      setClients(clientList);
    } catch (err) {
      console.error("Dashboard fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchData();
    }
  }, [user, selectedClient, selectedPeriod, statusFilter]);

  // Aggregate stats
  const stats = useMemo(() => {
    const total = invoices.length;
    const needsReview = invoices.filter((i) => i.review_status === "needs_review").length;
    const autoApproved = invoices.filter((i) => i.review_status === "auto_approved").length;
    const approved = invoices.filter((i) => i.review_status === "approved" || i.review_status === "auto_approved").length;
    const totalValue = invoices.reduce((sum, i) => sum + (i.invoice_total || 0), 0);
    return { total, needsReview, autoApproved, approved, totalValue };
  }, [invoices]);

  // TanStack Table Columns definition
  const columns = useMemo<ColumnDef<Invoice>[]>(
    () => [
      {
        accessorKey: "invoice_number",
        header: ({ column }) => (
          <button
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="flex items-center gap-1.5 font-semibold text-slate-700 hover:text-slate-900"
          >
            Invoice #
            <ArrowUpDown className="w-3.5 h-3.5" />
          </button>
        ),
        cell: ({ row }) => (
          <div>
            <div className="font-semibold text-slate-900">
              {row.original.invoice_number || "Draft / Pending"}
            </div>
            <div className="text-[11px] text-slate-500">{row.original.source_filename || "Document"}</div>
          </div>
        ),
      },
      {
        accessorKey: "invoice_date",
        header: "Date",
        cell: ({ row }) => (
          <span className="text-slate-600 text-xs">
            {row.original.invoice_date || "—"}
          </span>
        ),
      },
      {
        accessorKey: "client_name",
        header: "Client / Taxpayer",
        cell: ({ row }) => (
          <div>
            <div className="font-medium text-slate-800 text-xs">
              {row.original.client_name || "Apex Retailers"}
            </div>
            <div className="text-[10px] text-slate-400 font-mono">
              POS: {row.original.place_of_supply || "—"}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "supplier_name",
        header: "Supplier / Counterparty",
        cell: ({ row }) => (
          <div className="max-w-[200px] truncate">
            <div className="font-medium text-slate-800 text-xs truncate">
              {row.original.supplier_name || "—"}
            </div>
            <div className="text-[10px] text-slate-400 font-mono truncate">
              {row.original.supplier_gstin || "No GSTIN"}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "invoice_total",
        header: ({ column }) => (
          <button
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
            className="flex items-center gap-1.5 font-semibold text-slate-700 hover:text-slate-900 text-right w-full justify-end"
          >
            Invoice Total
            <ArrowUpDown className="w-3.5 h-3.5" />
          </button>
        ),
        cell: ({ row }) => (
          <div className="text-right font-semibold text-slate-900 text-xs">
            ₹{row.original.invoice_total?.toLocaleString("en-IN", { minimumFractionDigits: 2 }) || "0.00"}
          </div>
        ),
      },
      {
        accessorKey: "review_status",
        header: "Status & Flags",
        cell: ({ row }) => {
          const status = row.original.review_status;
          const flags = row.original.flags || [];
          const hasErrors = flags.some((f) => f.severity === "error");

          if (status === "auto_approved") {
            return (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
                <CheckCircle className="w-3 h-3 text-emerald-600" />
                Auto-Approved
              </span>
            );
          }
          if (status === "approved") {
            return (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                <CheckCircle className="w-3 h-3 text-blue-600" />
                Approved
              </span>
            );
          }
          if (status === "needs_review") {
            return (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                <AlertCircle className="w-3 h-3 text-amber-600" />
                Needs Review ({flags.length})
              </span>
            );
          }
          if (status === "rejected") {
            return (
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-700 border border-rose-200">
                Rejected
              </span>
            );
          }
          return (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-slate-100 text-slate-600">
              <Clock className="w-3 h-3" />
              Processing
            </span>
          );
        },
      },
      {
        accessorKey: "overall_confidence",
        header: "Confidence",
        cell: ({ row }) => {
          const conf = row.original.overall_confidence || 0;
          const pct = Math.round(conf * 100);
          const color =
            pct >= 90
              ? "text-emerald-600 bg-emerald-50 border-emerald-200"
              : pct >= 75
              ? "text-amber-600 bg-amber-50 border-amber-200"
              : "text-rose-600 bg-rose-50 border-rose-200";

          return (
            <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold border ${color}`}>
              {pct}%
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => {
          const isNeedsReview = row.original.review_status === "needs_review";
          return (
            <div className="flex items-center gap-2 justify-end">
              <Link
                href={`/invoices/${row.original.id}/review`}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 shadow-sm ${
                  isNeedsReview
                    ? "bg-amber-600 hover:bg-amber-500 text-white shadow-amber-600/20"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                }`}
              >
                <Eye className="w-3.5 h-3.5" />
                {isNeedsReview ? "Review" : "View"}
              </Link>
            </div>
          );
        },
      },
    ],
    []
  );

  const table = useReactTable({
    data: invoices,
    columns,
    state: {
      sorting,
      globalFilter,
    },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: {
      pagination: { pageSize: 15 },
    },
  });

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title="CA Firm Workspace"
          subtitle="Real-time multi-tenant GST invoice extraction & review"
        />

        <div className="p-6 space-y-6">
          {/* Top Client Summary Cards */}
          {user?.role !== "client" && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {clients.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setSelectedClient(selectedClient === c.id ? "" : c.id)}
                  className={`cursor-pointer p-4 rounded-xl border transition shadow-sm ${
                    selectedClient === c.id
                      ? "bg-blue-50/70 border-blue-400 ring-2 ring-blue-500/20"
                      : "bg-white border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-slate-900 truncate max-w-[160px]">
                      {c.name}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                      {c.state_code || "POS"}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono truncate mb-3">
                    {c.gstin || "Unregistered"}
                  </div>
                  <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-100">
                    <span className="text-slate-500">Invoices: {c.total_invoices}</span>
                    <span
                      className={`font-semibold ${
                        c.needs_review_count > 0 ? "text-amber-600" : "text-emerald-600"
                      }`}
                    >
                      {c.needs_review_count > 0 ? `${c.needs_review_count} Needs Review` : "All Clean"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Aggregate Metrics Bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Total Invoices
              </span>
              <div className="text-2xl font-bold text-slate-900 mt-1">{stats.total}</div>
              <div className="text-xs text-slate-400 mt-1">Period: {selectedPeriod}</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs font-semibold text-amber-600 uppercase tracking-wider flex items-center gap-1">
                <AlertCircle className="w-3.5 h-3.5" />
                Needs Review
              </span>
              <div className="text-2xl font-bold text-amber-600 mt-1">{stats.needsReview}</div>
              <div className="text-xs text-slate-400 mt-1">Pending validation</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs font-semibold text-emerald-600 uppercase tracking-wider flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5" />
                Approved & Clean
              </span>
              <div className="text-2xl font-bold text-emerald-600 mt-1">{stats.approved}</div>
              <div className="text-xs text-slate-400 mt-1">{stats.autoApproved} Auto-Approved</div>
            </div>

            <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
                Total Tax Value
              </span>
              <div className="text-2xl font-bold text-blue-600 mt-1">
                ₹{stats.totalValue.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
              <div className="text-xs text-slate-400 mt-1">Ready for GSTR-1</div>
            </div>
          </div>

          {/* Filter Bar & TanStack Search */}
          <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
              {/* Search Bar */}
              <div className="relative w-full sm:w-80">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Search invoice #, supplier, GSTIN..."
                  value={globalFilter ?? ""}
                  onChange={(e) => setGlobalFilter(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition"
                />
              </div>

              {/* Dropdowns */}
              <div className="flex items-center gap-2.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
                {/* Tax Period Selector */}
                <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-xl px-2.5 py-1 text-xs">
                  <Calendar className="w-3.5 h-3.5 text-slate-400" />
                  <input type="month" value={selectedPeriod} onChange={(e) => e.target.value && setSelectedPeriod(e.target.value)} className="bg-transparent text-slate-700 font-medium focus:outline-none" />
                </div>

                {/* Client Dropdown */}
                {user?.role !== "client" && (
                  <select
                    value={selectedClient}
                    onChange={(e) => setSelectedClient(e.target.value)}
                    className="bg-slate-50 border border-slate-200 text-slate-700 rounded-xl px-3 py-1.5 text-xs font-medium focus:outline-none"
                  >
                    <option value="">All Clients</option>
                    {clients.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}

                {/* Export Button */}
                {user?.role !== "client" && (
                  <Link
                    href="/exports"
                    className="px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5 shrink-0"
                  >
                    <Download className="w-3.5 h-3.5" />
                    GSTR-1 Excel
                  </Link>
                )}
              </div>
            </div>

            {/* Status Tabs */}
            <div className="flex items-center gap-1.5 border-t border-slate-100 pt-3 overflow-x-auto">
              {[
                { id: "all", label: "All Invoices" },
                { id: "needs_review", label: "Needs Review", count: stats.needsReview },
                { id: "auto_approved", label: "Auto-Approved" },
                { id: "approved", label: "Approved" },
                { id: "rejected", label: "Rejected" },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setStatusFilter(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0 flex items-center gap-1.5 ${
                    statusFilter === tab.id
                      ? "bg-slate-900 text-white font-semibold shadow-sm"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  <span>{tab.label}</span>
                  {tab.count !== undefined && tab.count > 0 && (
                    <span className="text-[10px] font-bold bg-amber-500 text-white px-1.5 py-0.2 rounded-full">
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* TanStack Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50/80 border-b border-slate-200 text-slate-700 uppercase font-semibold text-[11px] tracking-wider">
                  {table.getHeaderGroups().map((headerGroup) => (
                    <tr key={headerGroup.id}>
                      {headerGroup.headers.map((header) => (
                        <th key={header.id} className="px-5 py-3.5">
                          {header.isPlaceholder
                            ? null
                            : flexRender(header.column.columnDef.header, header.getContext())}
                        </th>
                      ))}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={columns.length} className="px-6 py-12 text-center text-slate-500">
                        Loading invoices...
                      </td>
                    </tr>
                  ) : table.getRowModel().rows.length === 0 ? (
                    <tr>
                      <td colSpan={columns.length} className="px-6 py-12 text-center text-slate-500">
                        No invoices found matching current filters.
                      </td>
                    </tr>
                  ) : (
                    table.getRowModel().rows.map((row) => (
                      <tr
                        key={row.id}
                        className="hover:bg-slate-50/60 transition cursor-pointer"
                        onClick={() => router.push(`/invoices/${row.original.id}/review`)}
                      >
                        {row.getVisibleCells().map((cell) => (
                          <td key={cell.id} className="px-5 py-3.5">
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between text-xs text-slate-600 bg-slate-50/40">
              <div>
                Showing {table.getRowModel().rows.length} of {invoices.length} invoices
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => table.previousPage()}
                  disabled={!table.getCanPreviousPage()}
                  className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Prev
                </button>
                <span>
                  Page {table.getState().pagination.pageIndex + 1} of{" "}
                  {Math.max(1, table.getPageCount())}
                </span>
                <button
                  onClick={() => table.nextPage()}
                  disabled={!table.getCanNextPage()}
                  className="px-2.5 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 transition flex items-center gap-1"
                >
                  Next
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen bg-slate-50 flex items-center justify-center text-slate-500 text-xs">Loading workspace...</div>}>
      <DashboardContent />
    </React.Suspense>
  );
}
