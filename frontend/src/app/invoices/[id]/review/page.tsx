import React, { useEffect, useState } from "react";
import Link from "@/lib/router";
import { useRouter, useParams } from "@/lib/router";
import {
  FileText,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ZoomIn,
  ZoomOut,
  RotateCw,
  ChevronLeft,
  ChevronRight,
  Save,
  Check,
  X,
  Plus,
  Trash2,
  History,
  QrCode,
  ArrowLeft,
  Sparkles,
  ShieldAlert,
  HelpCircle,
  RefreshCw,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, API_ORIGIN, Invoice, LineItem, ValidationFlag, AuditLog } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";

const INDIAN_STATES = [
  { code: "01", name: "01 - Jammu & Kashmir" },
  { code: "02", name: "02 - Himachal Pradesh" },
  { code: "03", name: "03 - Punjab" },
  { code: "04", name: "04 - Chandigarh" },
  { code: "05", name: "05 - Uttarakhand" },
  { code: "06", name: "06 - Haryana" },
  { code: "07", name: "07 - Delhi" },
  { code: "08", name: "08 - Rajasthan" },
  { code: "09", name: "09 - Uttar Pradesh" },
  { code: "10", name: "10 - Bihar" },
  { code: "19", name: "19 - West Bengal" },
  { code: "23", name: "23 - Madhya Pradesh" },
  { code: "24", name: "24 - Gujarat" },
  { code: "27", name: "27 - Maharashtra" },
  { code: "29", name: "29 - Karnataka" },
  { code: "32", name: "32 - Kerala" },
  { code: "33", name: "33 - Tamil Nadu" },
  { code: "36", name: "36 - Telangana" },
  { code: "37", name: "37 - Andhra Pradesh" },
];

const STANDARD_UQCS = [
  "NOS-NUMBERS",
  "PCS-PIECES",
  "KGS-KILOGRAMS",
  "BOX-BOX",
  "SET-SETS",
  "LTR-LITRES",
  "MTR-METRES",
  "BAG-BAGS",
  "CTN-CARTONS",
  "DOZ-DOZEN",
  "PAC-PACKETS",
  "QTL-QUINTAL",
  "SQF-SQUARE FEET",
  "SQM-SQUARE METRES",
  "UNT-UNITS",
  "OTH-OTHERS",
];

export default function ReviewPage() {
  const invoiceId = useParams<{ id: string }>().id as string;

  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  // Form states
  const [supplierName, setSupplierName] = useState("");
  const [supplierGstin, setSupplierGstin] = useState("");
  const [supplierState, setSupplierState] = useState("");
  const [buyerName, setBuyerName] = useState("");
  const [buyerGstin, setBuyerGstin] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [placeOfSupply, setPlaceOfSupply] = useState("");
  const [invoiceTotal, setInvoiceTotal] = useState<number | string>("");
  const [reverseCharge, setReverseCharge] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);

  // Queue navigation
  const [queueNav, setQueueNav] = useState<{
    prev_id: string | null;
    next_id: string | null;
    total_in_queue: number;
  } | null>(null);

  // Document viewer controls
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [pdfPage, setPdfPage] = useState(0);
  const [activeTab, setActiveTab] = useState<"fields" | "audit">("fields");

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  const loadInvoiceData = async () => {
    setLoading(true);
    try {
      const inv = await api.invoices.get(invoiceId);
      setInvoice(inv);

      // Populate form
      setSupplierName(inv.supplier_name || "");
      setSupplierGstin(inv.supplier_gstin || "");
      setSupplierState(inv.supplier_state || "");
      setBuyerName(inv.buyer_name || "");
      setBuyerGstin(inv.buyer_gstin || "");
      setInvoiceNumber(inv.invoice_number || "");
      setInvoiceDate(inv.invoice_date || "");
      setPlaceOfSupply(inv.place_of_supply || "");
      setInvoiceTotal(inv.invoice_total ?? 0);
      setReverseCharge(inv.reverse_charge || false);
      setLineItems(inv.line_items || []);

      // Load queue navigation
      const nav = await api.invoices.getQueueNav(inv.id, inv.client_id);
      setQueueNav(nav);
    } catch (err) {
      console.error("Failed to load invoice:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (invoiceId && user) {
      loadInvoiceData();
    }
  }, [invoiceId, user]);

  // Recalculate totals dynamically
  const calculatedTotals = React.useMemo(() => {
    const taxable = lineItems.reduce((sum, item) => sum + (Number(item.taxable_value) || 0), 0);
    const cgst = lineItems.reduce((sum, item) => sum + (Number(item.cgst_amount) || 0), 0);
    const sgst = lineItems.reduce((sum, item) => sum + (Number(item.sgst_amount) || 0), 0);
    const igst = lineItems.reduce((sum, item) => sum + (Number(item.igst_amount) || 0), 0);
    const cess = lineItems.reduce((sum, item) => sum + (Number(item.cess) || 0), 0);
    const totalTax = cgst + sgst + igst + cess;
    const total = taxable + totalTax;
    return { taxable, cgst, sgst, igst, cess, totalTax, total };
  }, [lineItems]);

  const handleLineItemChange = (index: number, field: string, value: any) => {
    setLineItems((prev) => {
      const copy = [...prev];
      const item = { ...copy[index] };

      if (field === "gst_rate") {
        const rateNum = Number(value) || 0;
        const supCode = (supplierGstin || "").substring(0, 2);
        const posCode = (placeOfSupply || "").substring(0, 2);
        const isInter = supCode && posCode && supCode !== posCode;

        if (isInter) {
          item.igst_rate = rateNum;
          item.cgst_rate = 0;
          item.sgst_rate = 0;
        } else {
          item.cgst_rate = Math.round((rateNum / 2) * 100) / 100;
          item.sgst_rate = Math.round((rateNum / 2) * 100) / 100;
          item.igst_rate = 0;
        }
      } else if (field === "uqc") {
        item.uqc = value;
        item.unit = value.split("-")[0];
      } else {
        (item as any)[field] = value;
      }

      // Auto-compute taxable value when qty and rate change
      if (field === "quantity" || field === "rate") {
        const q = field === "quantity" ? Number(value) : Number(item.quantity);
        const r = field === "rate" ? Number(value) : Number(item.rate);
        item.taxable_value = Math.round(q * r * 100) / 100;
      }

      // Auto-compute tax amounts
      const taxVal = Number(item.taxable_value) || 0;
      item.cgst_amount = Math.round(((taxVal * Number(item.cgst_rate || 0)) / 100) * 100) / 100;
      item.sgst_amount = Math.round(((taxVal * Number(item.sgst_rate || 0)) / 100) * 100) / 100;
      item.igst_amount = Math.round(((taxVal * Number(item.igst_rate || 0)) / 100) * 100) / 100;

      // Item total value
      item.total_value = Math.round((taxVal + item.cgst_amount + item.sgst_amount + item.igst_amount + Number(item.cess || 0)) * 100) / 100;

      copy[index] = item;
      return copy;
    });
  };

  const addLineItem = () => {
    setLineItems((prev) => [
      ...prev,
      {
        description: "New Item",
        hsn_sac: "998315",
        quantity: 1,
        unit: "NOS",
        uqc: "NOS-NUMBERS",
        rate: 1000,
        taxable_value: 1000,
        total_value: 1180,
        cgst_rate: 9,
        cgst_amount: 90,
        sgst_rate: 9,
        sgst_amount: 90,
        igst_rate: 0,
        igst_amount: 0,
        cess: 0,
        confidence: 1.0,
      },
    ]);
  };

  const removeLineItem = (index: number) => {
    setLineItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveChanges = async () => {
    setSaving(true);
    try {
      const finalTotal = Number(invoiceTotal) || calculatedTotals.total;
      const updated = await api.invoices.update(invoiceId, {
        supplier_name: supplierName,
        supplier_gstin: supplierGstin,
        supplier_state: supplierState,
        buyer_name: buyerName,
        buyer_gstin: buyerGstin,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        place_of_supply: placeOfSupply,
        reverse_charge: reverseCharge,
        total_taxable_value: calculatedTotals.taxable,
        cgst_total: calculatedTotals.cgst,
        sgst_total: calculatedTotals.sgst,
        igst_total: calculatedTotals.igst,
        cess_total: calculatedTotals.cess,
        total_tax: calculatedTotals.totalTax,
        invoice_total: finalTotal,
        line_items: lineItems,
      });
      setInvoice(updated);
      setInvoiceTotal(updated.invoice_total);
      alert("Changes saved and validations re-evaluated successfully!");
    } catch (err: any) {
      alert(err.message || "Failed to save changes");
    } finally {
      setSaving(false);
    }
  };

  const [done, setDone] = useState<{ action: "approve" | "reject"; number: string } | null>(null);
  const backToQueue = () => router.push("/dashboard?status=needs_review");
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(backToQueue, 2200);
    return () => clearTimeout(t);
  }, [done]);

  const handleReviewAction = async (action: "approve" | "reject") => {
    setReviewing(true);
    try {
      // First save changes
      await api.invoices.update(invoiceId, {
        supplier_name: supplierName,
        supplier_gstin: supplierGstin,
        supplier_state: supplierState,
        buyer_name: buyerName,
        buyer_gstin: buyerGstin,
        invoice_number: invoiceNumber,
        invoice_date: invoiceDate,
        place_of_supply: placeOfSupply,
        reverse_charge: reverseCharge,
        total_taxable_value: calculatedTotals.taxable,
        cgst_total: calculatedTotals.cgst,
        sgst_total: calculatedTotals.sgst,
        igst_total: calculatedTotals.igst,
        cess_total: calculatedTotals.cess,
        total_tax: calculatedTotals.totalTax,
        invoice_total: calculatedTotals.total,
        line_items: lineItems,
      });

      const updated = await api.invoices.review(invoiceId, action);
      setInvoice(updated);
      setDone({ action, number: updated.invoice_number || invoice?.invoice_number || "" });
    } catch (err: any) {
      alert(err.message || `Failed to ${action} invoice`);
    } finally {
      setReviewing(false);
    }
  };

  const getFieldConfidenceBadge = (fieldKey: string) => {
    const conf = invoice?.field_confidences?.[fieldKey] ?? invoice?.overall_confidence ?? 1.0;
    const pct = Math.round(conf * 100);
    if (pct >= 90) return null; // Clean
    return (
      <span
        title={`AI Confidence: ${pct}%`}
        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ml-1.5 ${
          pct < 70
            ? "bg-rose-500/10 text-rose-600 border border-rose-300"
            : "bg-amber-500/10 text-amber-600 border border-amber-300"
        }`}
      >
        {pct}% AI
      </span>
    );
  };

  if (loading || !invoice) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3 text-slate-500 text-sm">
          <RefreshCw className="w-5 h-5 animate-spin text-blue-600" />
          Loading Invoice Review Workspace...
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-slate-100">
      {done && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={done.action === "approve" ? "Invoice approved" : "Invoice rejected"}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-7 text-center">
            <span className={`mx-auto w-14 h-14 rounded-full flex items-center justify-center ${done.action === "approve" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"}`}>
              {done.action === "approve" ? <Check className="w-7 h-7" /> : <X className="w-7 h-7" />}
            </span>
            <h3 className="mt-4 text-lg font-semibold text-slate-900">{done.action === "approve" ? "Invoice approved" : "Invoice rejected"}</h3>
            <p className="mt-1 text-sm text-slate-500">
              {done.number ? `${done.number} has been ${done.action === "approve" ? "approved" : "rejected"}.` : `The invoice has been ${done.action === "approve" ? "approved" : "rejected"}.`} Taking you back to Needs Review.
            </p>
            <button onClick={backToQueue} className="mt-5 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800">Back to Needs Review</button>
          </div>
        </div>
      )}
      <Sidebar className="hidden lg:flex" />

      <main className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden">
        {/* Top Review Bar */}
        <header className="h-14 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between shrink-0 z-20">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="p-1.5 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-slate-900 text-sm">
                  {invoice.invoice_number || "Invoice Review"}
                </span>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-slate-900 text-white">{invoice.return_type === "gstr3b" ? "GSTR-3B" : "GSTR-1"}</span>
                <span
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                    invoice.review_status === "auto_approved"
                      ? "bg-emerald-100 text-emerald-800"
                      : invoice.review_status === "approved"
                      ? "bg-blue-100 text-blue-800"
                      : invoice.review_status === "needs_review"
                      ? "bg-amber-100 text-amber-800"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {invoice.review_status.replace("_", " ")}
                </span>
                <span className="text-xs text-slate-400">
                  Confidence: {Math.round(invoice.overall_confidence * 100)}%
                </span>
              </div>
            </div>
          </div>

          {/* Queue Navigation & Quick Actions */}
          <div className="flex items-center gap-2">
            {queueNav && (
              <div className="flex items-center gap-1 bg-slate-50 border border-slate-200 rounded-lg p-1 text-xs">
                <button
                  disabled={!queueNav.prev_id}
                  onClick={() => queueNav.prev_id && router.push(`/invoices/${queueNav.prev_id}/review`)}
                  className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition"
                  title="Previous in Needs Review Queue"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-medium text-slate-600 px-1">
                  Queue ({queueNav.total_in_queue})
                </span>
                <button
                  disabled={!queueNav.next_id}
                  onClick={() => queueNav.next_id && router.push(`/invoices/${queueNav.next_id}/review`)}
                  className="p-1 rounded hover:bg-slate-200 disabled:opacity-30 transition"
                  title="Next in Needs Review Queue"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            <button
              onClick={handleSaveChanges}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-semibold text-xs transition flex items-center gap-1.5 shadow-sm disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? "Saving..." : "Save"}
            </button>

            <button
              onClick={() => handleReviewAction("reject")}
              disabled={reviewing}
              className="px-3 py-1.5 rounded-lg border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-700 font-semibold text-xs transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <X className="w-3.5 h-3.5" />
              Reject
            </button>

            <button
              onClick={() => handleReviewAction("approve")}
              disabled={reviewing}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs shadow-md shadow-emerald-600/20 transition flex items-center gap-1.5 disabled:opacity-50"
            >
              <Check className="w-3.5 h-3.5" />
              Approve
            </button>
          </div>
        </header>

        {invoice.alert_for === "staff" && (
          <div className="bg-amber-50 border-b border-amber-200 text-amber-900 text-sm px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
            <span>{invoice.alert_text || "The client changed this invoice - please review it again."}</span>
            <button onClick={() => api.invoices.ackAlert(invoice.id).then(setInvoice).catch(() => {})} className="px-3 py-1 rounded-lg border border-amber-300 bg-white text-xs font-medium hover:border-black">Mark as reviewed</button>
          </div>
        )}

        {/* SPLIT SCREEN WORKSPACE */}
        <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-hidden">
          {/* LEFT PANE: Document Image/PDF Viewer */}
          <div className="w-full lg:w-1/2 bg-slate-900 border-r border-slate-800 flex flex-col min-h-0">
            {/* Viewer Toolbar */}
            <div className="h-10 bg-slate-950/80 border-b border-slate-800 px-4 flex items-center justify-between text-xs text-slate-300 shrink-0">
              <span className="font-medium text-slate-400 truncate max-w-[200px]">
                {invoice.source_filename || "Original Document"}
              </span>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setZoom((z) => Math.max(50, z - 20))}
                  className="p-1 hover:text-white transition"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-mono text-slate-400">{zoom}%</span>
                <button
                  onClick={() => setZoom((z) => Math.min(250, z + 20))}
                  className="p-1 hover:text-white transition"
                  title="Zoom In"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
                <span className="text-slate-700">|</span>
                <button
                  onClick={() => setRotation((r) => (r + 90) % 360)}
                  className="p-1 hover:text-white transition"
                  title="Rotate 90°"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Document Canvas */}
            <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-slate-950/50">
              {invoice.file_preview_url ? (
                <div
                  style={{
                    transform: `scale(${zoom / 100}) rotate(${rotation}deg)`,
                    transformOrigin: "center center",
                    transition: "transform 0.15s ease-out",
                  }}
                  className="shadow-2xl rounded-lg overflow-hidden max-w-full"
                >
                  {/* Image / Rendered PDF page */}
                  <img
                    src={`${API_ORIGIN}${invoice.file_preview_url}&as_image=true`}
                    alt="Invoice Preview"
                    className="max-h-[85vh] object-contain rounded bg-white"
                  />
                </div>
              ) : (
                <div className="text-slate-500 text-xs flex flex-col items-center gap-2">
                  <FileText className="w-10 h-10 stroke-1" />
                  <span>No preview available for this document</span>
                </div>
              )}
            </div>

            {/* QR Metadata Badge if present */}
            {invoice.qr_data && (
              <div className="p-2.5 bg-slate-950 border-t border-slate-800 text-[11px] text-emerald-400 flex items-center justify-between shrink-0">
                <span className="flex items-center gap-1.5 font-semibold">
                  <QrCode className="w-3.5 h-3.5" />
                  e-Invoice QR Code Decoded & Verified
                </span>
                <span className="font-mono text-slate-400 text-[10px]">
                  IRN: {String(invoice.qr_data.irn || "").substring(0, 16)}...
                </span>
              </div>
            )}
          </div>

          {/* RIGHT PANE: Extracted Fields, Validations & Line Items */}
          <div className="w-full lg:w-1/2 bg-white flex flex-col min-h-0 overflow-y-auto">
            {/* Validation Alert Banners */}
            {invoice.flags && invoice.flags.length > 0 && (
              <div className="p-4 bg-amber-50/70 border-b border-amber-200/80 space-y-2 shrink-0">
                <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800 uppercase tracking-wider">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>Compliance & Validation Flags ({invoice.flags.length})</span>
                </div>
                <div className="space-y-1.5">
                  {invoice.flags.map((flag, idx) => (
                    <div
                      key={idx}
                      className={`text-xs p-2 rounded-lg flex items-start gap-2 ${
                        flag.severity === "error"
                          ? "bg-rose-100/70 text-rose-800 border border-rose-200"
                          : "bg-amber-100/70 text-amber-800 border border-amber-200"
                      }`}
                    >
                      <span className="font-bold text-[10px] uppercase px-1 rounded bg-white/70 mt-0.5">
                        {flag.severity}
                      </span>
                      <span>{flag.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tab navigation: Fields vs Audit Trail */}
            <div className="flex items-center gap-4 px-6 pt-4 border-b border-slate-200 bg-white sticky top-0 z-10">
              <button
                onClick={() => setActiveTab("fields")}
                className={`pb-2.5 text-xs font-bold border-b-2 transition ${
                  activeTab === "fields"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                Extracted Fields & Items
              </button>
              <button
                onClick={() => setActiveTab("audit")}
                className={`pb-2.5 text-xs font-bold border-b-2 transition flex items-center gap-1.5 ${
                  activeTab === "audit"
                    ? "border-blue-600 text-blue-600"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                <History className="w-3.5 h-3.5" />
                Audit Trail ({invoice.audit_logs?.length || 0})
              </button>
            </div>

            {activeTab === "audit" ? (
              /* AUDIT LOG TAB */
              <div className="p-6 space-y-3">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Historical Change Log
                </h3>
                {invoice.audit_logs && invoice.audit_logs.length > 0 ? (
                  <div className="space-y-2">
                    {invoice.audit_logs.map((log) => (
                      <div
                        key={log.id}
                        className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between text-slate-500 text-[11px]">
                          <span className="font-semibold text-slate-800">
                            {log.user_name || "System"}
                          </span>
                          <span>{new Date(log.created_at).toLocaleString("en-IN")}</span>
                        </div>
                        <div className="font-medium text-slate-700">
                          Field: <span className="font-mono text-blue-600">{log.field_name}</span>
                        </div>
                        {log.old_value !== null && (
                          <div className="text-slate-500 text-[11px]">
                            Old: <span className="line-through text-rose-500">{log.old_value}</span>
                          </div>
                        )}
                        <div className="text-slate-700 text-[11px]">
                          New: <span className="font-semibold text-emerald-600">{log.new_value}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">No modifications logged yet.</p>
                )}
              </div>
            ) : (
              /* EXTRACTED FIELDS TAB */
              <div className="p-6 space-y-6">
                {/* Header Information: Invoice #, Date, POS, Total Value */}
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="flex items-center text-xs font-semibold text-slate-700 mb-1">
                      Invoice Number
                      {getFieldConfidenceBadge("invoice_number")}
                    </label>
                    <input
                      type="text"
                      value={invoiceNumber}
                      onChange={(e) => setInvoiceNumber(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="flex items-center text-xs font-semibold text-slate-700 mb-1">
                      Invoice Date
                      {getFieldConfidenceBadge("invoice_date")}
                    </label>
                    <input
                      type="date"
                      value={invoiceDate}
                      onChange={(e) => setInvoiceDate(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>

                  <div>
                    <label className="flex items-center text-xs font-semibold text-slate-700 mb-1">
                      Place of Supply (POS)
                      {getFieldConfidenceBadge("place_of_supply")}
                    </label>
                    <select
                      value={placeOfSupply}
                      onChange={(e) => setPlaceOfSupply(e.target.value)}
                      className="w-full px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-medium text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select State / POS</option>
                      {INDIAN_STATES.map((s) => (
                        <option key={s.code} value={s.code}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="flex items-center text-xs font-semibold text-slate-700">
                        Total Invoice Value
                        {getFieldConfidenceBadge("totals")}
                      </label>
                      <button
                        type="button"
                        onClick={() => setInvoiceTotal(calculatedTotals.total)}
                        title="Sync with sum of line items"
                        className="text-[10px] text-blue-600 hover:underline"
                      >
                        Sync Sum
                      </button>
                    </div>
                    <div className="relative">
                      <span className="absolute left-2.5 top-1.5 text-xs text-slate-400 font-semibold">₹</span>
                      <input
                        type="number"
                        step="0.01"
                        value={invoiceTotal}
                        onChange={(e) => setInvoiceTotal(e.target.value)}
                        className="w-full pl-6 pr-3 py-1.5 rounded-lg border border-blue-300 bg-blue-50/30 text-xs font-bold text-blue-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  </div>
                </div>

                {/* Parties: Supplier & Buyer Boxes */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Supplier Box */}
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                    <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">
                      Supplier / Issuer Details
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                        Supplier Legal / Trade Name
                      </label>
                      <input
                        type="text"
                        value={supplierName}
                        onChange={(e) => setSupplierName(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-800 bg-white"
                      />
                    </div>
                    <div>
                      <label className="flex items-center text-[11px] font-medium text-slate-600 mb-0.5">
                        Supplier GSTIN
                        {getFieldConfidenceBadge("supplier_gstin")}
                      </label>
                      <input
                        type="text"
                        value={supplierGstin}
                        onChange={(e) => setSupplierGstin(e.target.value.toUpperCase())}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono text-slate-800 bg-white"
                      />
                    </div>
                  </div>

                  {/* Buyer Box */}
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                    <div className="text-[11px] font-bold text-blue-700 uppercase tracking-wider">
                      Buyer / Recipient Details
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-0.5">
                        Buyer Name
                      </label>
                      <input
                        type="text"
                        value={buyerName}
                        onChange={(e) => setBuyerName(e.target.value)}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs text-slate-800 bg-white"
                      />
                    </div>
                    <div>
                      <label className="flex items-center text-[11px] font-medium text-slate-600 mb-0.5">
                        Buyer GSTIN (Leave empty if B2C)
                        {getFieldConfidenceBadge("buyer_gstin")}
                      </label>
                      <input
                        type="text"
                        value={buyerGstin}
                        onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())}
                        className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-mono text-slate-800 bg-white"
                      />
                    </div>
                  </div>
                </div>

                {/* Line Items Table */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">
                        Invoice Line Items ({lineItems.length})
                      </h3>
                      <span className="text-[11px] text-slate-400">
                        (Supports UQC, Rates & Values)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={addLineItem}
                      className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-semibold transition flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Item
                    </button>
                  </div>

                  <div className="border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
                    <table className="w-full text-left text-xs min-w-[900px]">
                      <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-[11px] font-semibold">
                        <tr>
                          <th className="p-2.5">#</th>
                          <th className="p-2.5 w-36">Description</th>
                          <th className="p-2.5 w-20">HSN</th>
                          <th className="p-2.5 w-16">Qty</th>
                          <th className="p-2.5 w-28">UQC (Unit)</th>
                          <th className="p-2.5 w-20">Unit Rate (₹)</th>
                          <th className="p-2.5 w-24">Taxable (₹)</th>
                          <th className="p-2.5 w-20">GST Rate</th>
                          <th className="p-2.5 w-16">CGST (₹)</th>
                          <th className="p-2.5 w-16">SGST (₹)</th>
                          <th className="p-2.5 w-16">IGST (₹)</th>
                          <th className="p-2.5 w-24">Item Total (₹)</th>
                          <th className="p-2.5 w-8"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {lineItems.map((item, idx) => {
                          const gstRate = (Number(item.igst_rate) || 0) > 0
                            ? Number(item.igst_rate)
                            : (Number(item.cgst_rate) || 0) + (Number(item.sgst_rate) || 0);

                          return (
                            <tr key={idx} className="hover:bg-slate-50/50">
                              <td className="p-2 text-slate-400 font-mono text-[11px]">{idx + 1}</td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={item.description || ""}
                                  onChange={(e) => handleLineItemChange(idx, "description", e.target.value)}
                                  className="w-full px-2 py-1 rounded border border-slate-200 text-xs"
                                  placeholder="Description"
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="text"
                                  value={item.hsn_sac || ""}
                                  onChange={(e) => handleLineItemChange(idx, "hsn_sac", e.target.value)}
                                  className="w-full px-2 py-1 rounded border border-slate-200 text-xs font-mono"
                                  placeholder="HSN"
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="number"
                                  step="any"
                                  value={item.quantity}
                                  onChange={(e) => handleLineItemChange(idx, "quantity", e.target.value)}
                                  className="w-full px-2 py-1 rounded border border-slate-200 text-xs text-right"
                                />
                              </td>
                              <td className="p-2">
                                <select
                                  value={item.uqc || `${item.unit || "NOS"}-NUMBERS`}
                                  onChange={(e) => handleLineItemChange(idx, "uqc", e.target.value)}
                                  className="w-full px-1.5 py-1 rounded border border-slate-200 text-[11px] bg-white font-medium text-slate-700"
                                >
                                  {STANDARD_UQCS.map((u) => (
                                    <option key={u} value={u}>
                                      {u}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td className="p-2">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={item.rate}
                                  onChange={(e) => handleLineItemChange(idx, "rate", e.target.value)}
                                  className="w-full px-2 py-1 rounded border border-slate-200 text-xs text-right"
                                />
                              </td>
                              <td className="p-2">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={item.taxable_value}
                                  onChange={(e) => handleLineItemChange(idx, "taxable_value", e.target.value)}
                                  className="w-full px-2 py-1 rounded border border-slate-200 text-xs text-right font-semibold"
                                />
                              </td>
                              <td className="p-2">
                                <select
                                  value={gstRate}
                                  onChange={(e) => handleLineItemChange(idx, "gst_rate", e.target.value)}
                                  className="w-full px-1.5 py-1 rounded border border-blue-200 bg-blue-50/40 text-xs font-semibold text-blue-800"
                                >
                                  <option value={0}>0%</option>
                                  <option value={5}>5%</option>
                                  <option value={12}>12%</option>
                                  <option value={18}>18%</option>
                                  <option value={28}>28%</option>
                                </select>
                              </td>
                              <td className="p-2 text-right text-xs text-slate-600 font-mono">
                                ₹{item.cgst_amount || 0}
                              </td>
                              <td className="p-2 text-right text-xs text-slate-600 font-mono">
                                ₹{item.sgst_amount || 0}
                              </td>
                              <td className="p-2 text-right text-xs text-slate-600 font-mono">
                                ₹{item.igst_amount || 0}
                              </td>
                              <td className="p-2 text-right text-xs font-bold text-slate-800 font-mono">
                                ₹{item.total_value || Math.round((Number(item.taxable_value || 0) + Number(item.cgst_amount || 0) + Number(item.sgst_amount || 0) + Number(item.igst_amount || 0)) * 100) / 100}
                              </td>
                              <td className="p-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => removeLineItem(idx)}
                                  className="text-slate-400 hover:text-rose-500 p-1"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Calculated Totals Summary Box */}
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2">
                  <div className="flex justify-between text-xs text-slate-600">
                    <span>Taxable Value:</span>
                    <span className="font-semibold text-slate-800">
                      ₹{calculatedTotals.taxable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                  {calculatedTotals.cgst > 0 && (
                    <div className="flex justify-between text-xs text-slate-600">
                      <span>Central Tax (CGST):</span>
                      <span className="font-semibold text-slate-800">
                        ₹{calculatedTotals.cgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                  {calculatedTotals.sgst > 0 && (
                    <div className="flex justify-between text-xs text-slate-600">
                      <span>State Tax (SGST):</span>
                      <span className="font-semibold text-slate-800">
                        ₹{calculatedTotals.sgst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                  {calculatedTotals.igst > 0 && (
                    <div className="flex justify-between text-xs text-slate-600">
                      <span>Integrated Tax (IGST):</span>
                      <span className="font-semibold text-slate-800">
                        ₹{calculatedTotals.igst.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  )}
                  <div className="pt-2 border-t border-slate-200 flex justify-between text-sm font-bold text-slate-900">
                    <span>Invoice Grand Total:</span>
                    <span className="text-blue-700">
                      ₹{calculatedTotals.total.toLocaleString("en-IN", { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
