import React, { useState, useEffect, useRef } from "react";
import { currentPeriod } from "@/lib/period";
import { useRouter } from "@/lib/router";
import {
  Upload,
  Camera,
  FileText,
  Clock,
  X,
  Sparkles,
  RefreshCw,
  Eye,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, Client, UploadResponse } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export default function UploadPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClient, setSelectedClient] = useState<string>("");
  const [invoiceType, setInvoiceType] = useState<string>("sales");
  const [taxPeriod, setTaxPeriod] = useState<string>(currentPeriod());

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadResponse[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  useEffect(() => {
    if (user) {
      api.clients.list().then((cls) => {
        setClients(cls);
        if (user.role === "client" && user.client_id) {
          setSelectedClient(user.client_id);
        } else if (cls.length > 0) {
          setSelectedClient(cls[0].id);
        }
      });
    }
  }, [user]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const added = Array.from(e.target.files);
      setSelectedFiles((prev) => [...prev, ...added]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      const added = Array.from(e.dataTransfer.files);
      setSelectedFiles((prev) => [...prev, ...added]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUploadSubmit = async () => {
    if (selectedFiles.length === 0 || !selectedClient) return;

    setIsUploading(true);
    try {
      const res = await api.invoices.upload(
        selectedFiles,
        selectedClient,
        invoiceType,
        taxPeriod
      );
      setUploadProgress(res);
      setSelectedFiles([]);

      // Auto-refresh upload items status
      pollUploadStatus();
    } catch (err: any) {
      alert(err.message || "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  const pollUploadStatus = () => {
    const interval = setInterval(async () => {
      try {
        const invList = await api.invoices.list({ client_id: selectedClient });
        // Match files
        setUploadProgress((prev) =>
          prev.map((item) => {
            const found = invList.find((i) => i.source_file_id === item.file_id);
            if (found) {
              const isBlurry = found.flags.some((f) => f.type === "blurry_image_warning");
              const isDark = found.flags.some((f) => f.type === "dark_image_warning");
              return {
                ...item,
                invoice_id: found.id,
                status: found.review_status,
                is_blurry: isBlurry,
                is_dark: isDark,
              };
            }
            return item;
          })
        );
      } catch (e) {
        // Continue polling
      }
    }, 2500);

    setTimeout(() => clearInterval(interval), 20000);
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title="Upload Invoices"
          subtitle="Direct mobile camera capture & desktop drag-and-drop batch upload"
        />

        <div className="p-6 max-w-4xl mx-auto w-full space-y-6">
          {/* Client & Period Selection Card */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">
              Upload Target & Classification
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Client Selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Taxpayer / Client
                </label>
                <select
                  disabled={user?.role === "client"}
                  value={selectedClient}
                  onChange={(e) => setSelectedClient(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
                >
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.gstin || "No GSTIN"})
                    </option>
                  ))}
                </select>
              </div>

              {/* Tax Period */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Tax Return Period
                </label>
                <input type="month" value={taxPeriod} onChange={(e) => e.target.value && setTaxPeriod(e.target.value)} className="w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black" />
              </div>

              {/* Invoice Type */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Invoice Type
                </label>
                <div className="flex rounded-xl bg-slate-100 p-1 border border-slate-200">
                  <button
                    type="button"
                    onClick={() => setInvoiceType("sales")}
                    className={`flex-1 py-1 rounded-lg text-xs font-semibold transition ${
                      invoiceType === "sales"
                        ? "bg-white text-blue-600 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Sales (GSTR-1)
                  </button>
                  <button
                    type="button"
                    onClick={() => setInvoiceType("purchase")}
                    className={`flex-1 py-1 rounded-lg text-xs font-semibold transition ${
                      invoiceType === "purchase"
                        ? "bg-white text-blue-600 shadow-sm"
                        : "text-slate-600 hover:text-slate-900"
                    }`}
                  >
                    Purchase (GSTR-2B)
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Upload Drop Zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-3xl p-8 sm:p-12 text-center transition ${
              isDragging
                ? "border-blue-500 bg-blue-50/50"
                : "border-slate-300 bg-white hover:border-slate-400"
            }`}
          >
            {/* Hidden file inputs */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="application/pdf,image/png,image/jpeg,image/heic,.pdf,.png,.jpg,.jpeg,.heic"
              onChange={handleFileChange}
              className="hidden"
            />
            {/* Direct Camera Input for Mobile PWA */}
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileChange}
              className="hidden"
            />

            <div className="max-w-md mx-auto space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center mx-auto shadow-inner">
                <Upload className="w-8 h-8" />
              </div>

              <div>
                <h3 className="text-base font-bold text-slate-800">
                  Upload Invoice Files or Photos
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Drag and drop multiple files here, browse documents, or take photos directly with your phone camera.
                </p>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Supports Multi-page PDF, PNG, JPG, HEIC
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-500/20 transition flex items-center gap-2"
                >
                  <FileText className="w-4 h-4" />
                  Select Files (Batch)
                </button>

                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-md shadow-emerald-500/20 transition flex items-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  Direct Camera Capture
                </button>
              </div>
            </div>
          </div>

          {/* Staged Files List */}
          {selectedFiles.length > 0 && (
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  Ready to Ingest ({selectedFiles.length} files)
                </span>
                <button
                  onClick={() => setSelectedFiles([])}
                  className="text-xs text-rose-600 hover:underline"
                >
                  Clear All
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-60 overflow-y-auto">
                {selectedFiles.map((file, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-xs"
                  >
                    <div className="flex items-center gap-2 truncate">
                      <FileText className="w-4 h-4 text-blue-500 shrink-0" />
                      <span className="font-medium text-slate-800 truncate">{file.name}</span>
                      <span className="text-[10px] text-slate-400">
                        ({(file.size / 1024).toFixed(0)} KB)
                      </span>
                    </div>
                    <button
                      onClick={() => removeFile(idx)}
                      className="text-slate-400 hover:text-rose-500 p-1"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={handleUploadSubmit}
                  disabled={isUploading}
                  className="w-full py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold shadow-lg shadow-slate-900/20 transition flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isUploading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Uploading & Extracting with AI...
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-4 h-4 text-amber-400" />
                      Start AI Extraction Pipeline ({selectedFiles.length} Invoices)
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Live Ingestion Queue / Status Card */}
          {uploadProgress.length > 0 && (
            <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-sm space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider flex items-center gap-2">
                  <Clock className="w-4 h-4 text-blue-600" />
                  Live Extraction Status
                </h3>
                <span className="text-[11px] text-slate-500">Auto-refreshing</span>
              </div>

              <div className="space-y-2.5">
                {uploadProgress.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-xl border border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="font-semibold text-slate-800 flex items-center gap-2">
                        <span>{item.filename}</span>
                        {item.warning_message && (
                          <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                            Duplicate Warning
                          </span>
                        )}
                        {item.is_blurry && (
                          <span className="text-[10px] font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                            Blurry Image
                          </span>
                        )}
                        {item.is_dark && (
                          <span className="text-[10px] font-semibold text-amber-600 bg-amber-50 px-2 py-0.5 rounded border border-amber-200">
                            Dark Capture
                          </span>
                        )}
                      </div>

                      <div className="text-[11px] text-slate-500 flex items-center gap-2">
                        <span>Status:</span>
                        <span
                          className={`font-semibold capitalize ${
                            item.status === "auto_approved" || item.status === "approved"
                              ? "text-emerald-600"
                              : item.status === "needs_review"
                              ? "text-amber-600"
                              : "text-blue-600"
                          }`}
                        >
                          {item.status.replace("_", " ")}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {item.invoice_id ? (
                        <button
                          onClick={() => router.push(`/invoices/${item.invoice_id}/review`)}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition flex items-center gap-1.5 text-xs shadow-sm"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Open Review
                        </button>
                      ) : (
                        <span className="text-slate-400 italic text-[11px] flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          Processing...
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
