const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) || "/api";
const API_ORIGIN = API_BASE.startsWith("http") ? API_BASE.replace(/\/api\/?$/, "") : "";
export { API_ORIGIN };

export interface User {
  id: string;
  email: string;
  full_name: string;
  role: "admin" | "staff" | "client";
  firm_id: string;
  client_id?: string | null;
  firm_name?: string | null;
}

export interface Client {
  id: string;
  firm_id: string;
  name: string;
  trade_name?: string;
  gstin?: string;
  email?: string;
  phone?: string;
  state?: string;
  state_code?: string;
  address?: string;
  created_at: string;
  total_invoices: number;
  needs_review_count: number;
  approved_count: number;
}

export interface LineItem {
  id?: string;
  item_index?: number;
  description?: string;
  hsn_sac?: string;
  quantity: number;
  unit: string;
  uqc?: string;
  rate: number;
  taxable_value: number;
  total_value?: number;
  cgst_rate: number;
  cgst_amount: number;
  sgst_rate: number;
  sgst_amount: number;
  igst_rate: number;
  igst_amount: number;
  cess: number;
  confidence?: number;
}

export interface ValidationFlag {
  type: string;
  severity: "warning" | "error";
  field?: string;
  message: string;
}

export interface AuditLog {
  id: string;
  user_name?: string;
  field_name: string;
  old_value?: string;
  new_value?: string;
  created_at: string;
}

export interface Invoice {
  id: string;
  firm_id: string;
  client_id: string;
  client_name?: string;
  source_file_id?: string;
  source_filename?: string;
  invoice_type: string;
  supplier_name?: string;
  supplier_gstin?: string;
  supplier_state?: string;
  supplier_address?: string;
  buyer_name?: string;
  buyer_gstin?: string;
  buyer_state?: string;
  buyer_address?: string;
  invoice_number?: string;
  invoice_date?: string;
  place_of_supply?: string;
  reverse_charge: boolean;
  total_taxable_value: number;
  cgst_total: number;
  sgst_total: number;
  igst_total: number;
  cess_total: number;
  total_tax: number;
  invoice_total: number;
  overall_confidence: number;
  field_confidences?: Record<string, number>;
  client_confirmation?: "not_required" | "pending" | "confirmed" | "changes_requested";
  client_confirmed_at?: string | null;
  client_note?: string | null;
  client_approved_at?: string | null;
  alert_for?: "client" | "staff" | null;
  alert_text?: string | null;
  alert_at?: string | null;
  return_type?: "gstr1" | "gstr3b" | null;
  uploaded_at?: string;
  editable_until?: string | null;
  review_status: "uploaded" | "processing" | "needs_review" | "auto_approved" | "approved" | "rejected";
  tax_period?: string;
  flags: ValidationFlag[];
  qr_data?: Record<string, any>;
  line_items_count: number;
  line_items?: LineItem[];
  audit_logs?: AuditLog[];
  file_preview_url?: string;
  created_at: string;
  updated_at: string;
}

export interface Gstr3bPreviewDoc {
  id: string; type: string; number: string; date: string | null; party: string; gstin: string;
  taxable: number; tax: number; total: number; reverse_charge: boolean;
}

export interface ExportRecord {
  id: string;
  client_id: string;
  client_name?: string;
  tax_period: string;
  export_type: string;
  file_name: string;
  invoice_count: number;
  created_at: string;
  download_url?: string;
}

export interface UploadResponse {
  file_id: string;
  invoice_id?: string;
  filename: string;
  status: string;
  is_blurry: boolean;
  is_dark: boolean;
  warning_message?: string;
}

export interface RequestStage {
  key: string;
  step: number;
  label: string;
}

export interface TrackedRequest {
  file_id: string;
  original_filename: string;
  file_status: string;
  progress?: number;
  progress_label?: string | null;
  return_type?: "gstr1" | "gstr3b" | null;
  error_message?: string | null;
  uploaded_at: string;
  client_id: string;
  client_name: string;
  invoice_id?: string | null;
  invoice_number?: string | null;
  invoice_total?: number | null;
  review_status?: string | null;
  client_confirmation?: string | null;
  client_confirmed_at?: string | null;
  client_note?: string | null;
  updated_at?: string | null;
  invoice_type?: string | null;
  tax_period?: string | null;
  client_approved_at?: string | null;
  alert_for?: "client" | "staff" | null;
  alert_text?: string | null;
  editable_until?: string | null;
  stage: RequestStage;
}

export interface RegisterInput {
  email: string;
  password: string;
  full_name: string;
  company_name: string;
  firm_id: string;
  gstin?: string;
  phone?: string;
}

async function jsonOrThrow(res: Response, fallback: string) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || fallback);
  }
  return res.json();
}

function getAuthHeaders(isJson = true): HeadersInit {
  const headers: HeadersInit = {};
  if (isJson) {
    headers["Content-Type"] = "application/json";
  }
  if (typeof window !== "undefined") {
    const token = localStorage.getItem("auth_token");
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }
  return headers;
}

export interface GstWorking {
  client: { id: string; name: string; gstin?: string | null };
  tax_period: string;
  pending_client_approval: number;
  gstr3b: { purchases: Invoice[]; credit_notes: Invoice[]; debit_notes: Invoice[]; others: Invoice[] };
  all_credit_notes: Invoice[];
  all_debit_notes: Invoice[];
  sales: Invoice[];
  credit_notes: Invoice[];
  debit_notes: Invoice[];
  purchases: Invoice[];
  purchase_notes: Invoice[];
  others: Invoice[];
  working: {
    sections: { key: string; count: number; taxable: number }[];
    hsn: { hsn: string; description: string; total_quantity: number; taxable_value: number; igst_amount: number; cgst_amount: number; sgst_amount: number }[];
    sales: GstTotals;
    credit_notes: GstTotals;
    debit_notes: GstTotals;
    net: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; tax: number; total: number };
  };
}
export interface GstTotals { count: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; tax: number; total: number }

export interface ReconColumn { key: string; label: string; type: "text" | "money" | "int" | "period" | "status" | "long"; diff?: boolean }
export interface ReconSection { key: string; title: string; note?: string; columns: ReconColumn[]; rows: Record<string, any>[] }
export interface ReconDiscrepancy { severity: "high" | "medium" | "low"; area: string; issue: string; period?: string; party?: string; gstin?: string; ref?: string; amount: number; reason: string; action: string }
export interface ReconReport {
  title: string; client: { id: string; name: string; gstin?: string | null }; from: string; to: string; fy?: string; periods: string[];
  pending_approval: number; missing: string[]; ledgers?: { sales: string[]; purchase: string[]; files: number; duplicates_skipped: number };
  summary: { total: number; high: number; medium: number; low: number };
  sections: ReconSection[]; discrepancies: ReconDiscrepancy[];
}
export interface ReconFile {
  id: string; kind: string; tax_period: string | null; original_filename: string; row_count: number; uploaded_by_role: string; created_at: string;
  figures?: any; meta?: { found?: number; expected?: number; edited?: boolean } | null;
}
export type ReconKind = "gstr1_portal" | "gstr2b" | "gstr3b" | "sales_ledger" | "purchase_ledger";

export interface OutputStatus {
  periods: { period: string; ledger: boolean; invoices: boolean; gstr1: boolean; gstr3b: boolean }[];
  pending_approval: number; ledger_entries: number; invoice_rows: number;
  reports: Record<string, { discrepancies: number; missing: string[] }>;
}

async function download(res: Response, fallback: string) {
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || fallback); }
  const cd = res.headers.get("content-disposition") || "";
  const name = /filename="?([^"]+)"?/.exec(cd)?.[1] || "report.xlsx";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  recon: {
    report: async (head: string, params: Record<string, string>): Promise<ReconReport> => {
      const res = await fetch(`${API_BASE}/recon/${head}?${new URLSearchParams(params)}`, { headers: getAuthHeaders() });
      return jsonOrThrow(res, "Failed to build the report");
    },
    exportReport: async (head: string, params: Record<string, string>) => {
      const res = await fetch(`${API_BASE}/recon/export/${head}?${new URLSearchParams(params)}`, { headers: getAuthHeaders() });
      return download(res, "Failed to download the report");
    },
    outputStatus: async (params: Record<string, string>): Promise<OutputStatus> => {
      const res = await fetch(`${API_BASE}/recon/output-status?${new URLSearchParams(params)}`, { headers: getAuthHeaders() });
      return jsonOrThrow(res, "Failed to load status");
    },
    outputExport: async (name: string, params: Record<string, string>) => {
      const res = await fetch(`${API_BASE}/recon/output-export/${name}?${new URLSearchParams(params)}`, { headers: getAuthHeaders() });
      return download(res, "Failed to download the report");
    },
    files: async (clientId?: string): Promise<ReconFile[]> => {
      const res = await fetch(`${API_BASE}/recon/files${clientId ? `?client_id=${clientId}` : ""}`, { headers: getAuthHeaders() });
      return jsonOrThrow(res, "Failed to load files");
    },
    upload: async (files: File[], kind: ReconKind, clientId: string | undefined, taxPeriod?: string, merge = false): Promise<(ReconFile & { warning?: string | null; batch?: { name: string; rows: number; added: number }[]; duplicates_skipped?: number })[]> => {
      const fd = new FormData();
      fd.append("kind", kind);
      if (merge) fd.append("merge", "1");
      if (clientId) fd.append("client_id", clientId);
      if (taxPeriod) fd.append("tax_period", taxPeriod);
      files.forEach((f) => fd.append("files", f));
      const res = await fetch(`${API_BASE}/recon/files`, { method: "POST", headers: getAuthHeaders(false), body: fd });
      return jsonOrThrow(res, "Upload failed");
    },
    remove: async (id: string) => {
      const res = await fetch(`${API_BASE}/recon/files/${id}`, { method: "DELETE", headers: getAuthHeaders() });
      return jsonOrThrow(res, "Delete failed");
    },
    saveFigures: async (id: string, figures: any) => {
      const res = await fetch(`${API_BASE}/recon/files/${id}/figures`, { method: "PUT", headers: getAuthHeaders(), body: JSON.stringify({ figures }) });
      return jsonOrThrow(res, "Could not save figures");
    },
    template: async (kind: "sales_ledger" | "purchase_ledger") => {
      const res = await fetch(`${API_BASE}/recon/ledger-template?kind=${kind}`, { headers: getAuthHeaders() });
      return download(res, "Failed to download template");
    },
  },
  gst: {
    working: async (clientId: string, taxPeriod: string): Promise<GstWorking> => {
      const res = await fetch(`${API_BASE}/gst/working?client_id=${clientId}&tax_period=${taxPeriod}`, { headers: getAuthHeaders() });
      return jsonOrThrow(res, "Failed to load GST working");
    },
  },
  auth: {
    login: async (email: string, password: string) => {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Login failed");
      }
      return res.json();
    },
    register: async (data: RegisterInput) => {
      const res = await fetch(`${API_BASE}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return jsonOrThrow(res, "Sign up failed") as Promise<{ access_token: string; user: User }>;
    },
    firms: async (): Promise<{ id: string; name: string }[]> => {
      const res = await fetch(`${API_BASE}/auth/firms`);
      return jsonOrThrow(res, "Could not load CA firms");
    },
    me: async (): Promise<User> => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Unauthorized");
      return res.json();
    },
  },

  clients: {
    list: async (): Promise<Client[]> => {
      const res = await fetch(`${API_BASE}/clients`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch clients");
      return res.json();
    },
    create: async (data: Partial<Client>): Promise<Client> => {
      const res = await fetch(`${API_BASE}/clients`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create client");
      return res.json();
    },
    get: async (id: string): Promise<Client> => {
      const res = await fetch(`${API_BASE}/clients/${id}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch client");
      return res.json();
    },
  },

  invoices: {
    requests: async (): Promise<{ steps: string[]; requests: TrackedRequest[] }> => {
      const res = await fetch(`${API_BASE}/invoices/requests`, { headers: getAuthHeaders() });
      return jsonOrThrow(res, "Failed to load requests");
    },
    clientApprove: async (id: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}/client-approve`, { method: "POST", headers: getAuthHeaders() });
      return jsonOrThrow(res, "Could not send the invoice to the CA");
    },
    unsend: async (id: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}/unsend`, { method: "POST", headers: getAuthHeaders() });
      return jsonOrThrow(res, "Could not unsend the invoice");
    },
    ackAlert: async (id: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}/ack`, { method: "POST", headers: getAuthHeaders() });
      return jsonOrThrow(res, "Could not mark the change as reviewed");
    },
    confirm: async (id: string, action: "confirm" | "request_changes", note?: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}/confirm`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, note }),
      });
      return jsonOrThrow(res, "Could not save your response");
    },
    list: async (params?: {
      client_id?: string;
      tax_period?: string;
      review_status?: string;
      invoice_type?: string;
      search?: string;
      skip?: number;
      limit?: number;
    }): Promise<Invoice[]> => {
      const query = new URLSearchParams();
      if (params?.client_id) query.append("client_id", params.client_id);
      if (params?.tax_period) query.append("tax_period", params.tax_period);
      if (params?.review_status) query.append("review_status", params.review_status);
      if (params?.invoice_type) query.append("invoice_type", params.invoice_type);
      if (params?.search) query.append("search", params.search);
      if (params?.skip) query.append("skip", String(params.skip));
      if (params?.limit) query.append("limit", String(params.limit));

      const res = await fetch(`${API_BASE}/invoices?${query.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch invoices");
      return res.json();
    },
    get: async (id: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch invoice");
      return res.json();
    },
    update: async (id: string, data: Partial<Invoice>): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}`, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
      });
      return jsonOrThrow(res, "Failed to update invoice");
    },
    review: async (id: string, action: "approve" | "reject", reason?: string): Promise<Invoice> => {
      const res = await fetch(`${API_BASE}/invoices/${id}/review`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ action, reason }),
      });
      if (!res.ok) throw new Error("Failed to review invoice");
      return res.json();
    },
    upload: async (
      files: File[],
      clientId: string,
      invoiceType = "sales",
      taxPeriod?: string,
      returnType?: "gstr1" | "gstr3b",
      replaces?: string,
    ): Promise<UploadResponse[]> => {
      const formData = new FormData();
      files.forEach((f) => formData.append("files", f));
      formData.append("client_id", clientId);
      formData.append("invoice_type", invoiceType);
      if (taxPeriod) formData.append("tax_period", taxPeriod);
      if (returnType) formData.append("return_type", returnType);
      if (replaces) formData.append("replaces", replaces);

      const res = await fetch(`${API_BASE}/invoices/upload`, {
        method: "POST",
        headers: getAuthHeaders(false),
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Upload failed");
      }
      return res.json();
    },
    getQueueNav: async (currentInvoiceId: string, clientId?: string) => {
      const q = new URLSearchParams({ current_invoice_id: currentInvoiceId });
      if (clientId) q.append("client_id", clientId);
      const res = await fetch(`${API_BASE}/invoices/queue/next?${q.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) return null;
      return res.json();
    },
    retry: async (id: string) => {
      const res = await fetch(`${API_BASE}/invoices/${id}/retry`, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      return res.json();
    },
  },

  users: {
    list: async (): Promise<User[]> => {
      const res = await fetch(`${API_BASE}/users`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch users");
      return res.json();
    },
    create: async (data: {
      email: string;
      password: string;
      full_name: string;
      role: "admin" | "staff" | "client";
      client_id?: string | null;
    }): Promise<User> => {
      const res = await fetch(`${API_BASE}/users`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to create user");
      }
      return res.json();
    },
    delete: async (id: string): Promise<void> => {
      const res = await fetch(`${API_BASE}/users/${id}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to delete user");
      }
    },
  },

  exports: {
    generateGSTR1: async (clientId: string, taxPeriod: string, includeUnreviewed = false) => {
      const url = `${API_BASE}/exports/gstr1?include_unreviewed=${includeUnreviewed}`;
      const res = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ client_id: clientId, tax_period: taxPeriod }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to generate GSTR-1");
      }
      return res.json();
    },
    preview3B: async (clientId: string, taxPeriod: string): Promise<{
      gate: { ok: boolean; message: string | null; review_status: string };
      outward: Gstr3bPreviewDoc[]; inward: Gstr3bPreviewDoc[]; unsent: number; duplicates: number;
      summary: { outward_tax: Record<string, number>; itc_net: Record<string, number>; cash_payable: Record<string, number>; carry_forward: Record<string, number> };
    }> => {
      const res = await fetch(`${API_BASE}/exports/gstr3b/preview?client_id=${clientId}&tax_period=${taxPeriod}`, { headers: getAuthHeaders() });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Could not load the preview");
      }
      return res.json();
    },
    generateGSTR3B: async (clientId: string, taxPeriod: string): Promise<{
      file_name: string; total_exported: number; outward_documents: number; inward_documents: number; warning: string | null; download_url: string;
      summary: { outward_tax: Record<string, number>; itc_net: Record<string, number>; cash_payable: Record<string, number>; carry_forward: Record<string, number> };
    }> => {
      const res = await fetch(`${API_BASE}/exports/gstr3b`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify({ client_id: clientId, tax_period: taxPeriod }) });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Could not generate GSTR-3B");
      }
      return res.json();
    },
    generateRegister: async (clientId: string, taxPeriod: string, category: string, returnType?: "gstr1" | "gstr3b"): Promise<{ file_name: string; total_exported: number; warning: string | null; download_url: string }> => {
      const res = await fetch(`${API_BASE}/exports/register`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ client_id: clientId, tax_period: taxPeriod, category, return_type: returnType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Could not generate the Excel");
      }
      return res.json();
    },
    approveAll: async (clientId: string, taxPeriod: string) => {
      const url = `${API_BASE}/exports/approve-all?client_id=${clientId}&tax_period=${taxPeriod}`;
      const res = await fetch(url, {
        method: "POST",
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to approve invoices");
      }
      return res.json();
    },
    history: async (clientId?: string): Promise<ExportRecord[]> => {
      const q = clientId ? `?client_id=${clientId}` : "";
      const res = await fetch(`${API_BASE}/exports/history${q}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error("Failed to fetch export history");
      return res.json();
    },
    getDownloadUrl: (exportId: string) => {
      return `${API_BASE}/exports/download/${exportId}`;
    },
    downloadFile: async (downloadUrl: string, fileName?: string) => {
      const target = downloadUrl.startsWith("/api") ? API_BASE + downloadUrl.slice(4) : downloadUrl;
      const res = await fetch(target);
      if (!res.ok) throw new Error("Failed to download file from server");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName || "GSTR1_Export.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    },
  },

  reconciliation: {
    getSummary: async (clientId: string, taxPeriod?: string) => {
      const q = new URLSearchParams({ client_id: clientId });
      if (taxPeriod) q.append("tax_period", taxPeriod);
      const res = await fetch(`${API_BASE}/reconciliation/summary?${q.toString()}`, {
        headers: getAuthHeaders(),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to fetch reconciliation summary");
      }
      return res.json();
    },
    matchRegister: async (clientId: string, file: File, taxPeriod?: string) => {
      const formData = new FormData();
      formData.append("client_id", clientId);
      formData.append("file", file);
      if (taxPeriod) formData.append("tax_period", taxPeriod);

      const res = await fetch(`${API_BASE}/reconciliation/match-register`, {
        method: "POST",
        headers: getAuthHeaders(false),
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || "Failed to reconcile register");
      }
      return res.json();
    },
    downloadSampleTemplate: async () => {
      const res = await fetch(`${API_BASE}/reconciliation/sample-template`, {
        headers: getAuthHeaders(false),
      });
      if (!res.ok) throw new Error("Failed to download sample template");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "Sample_Sales_Register_Template.xlsx";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    },
    getSampleTemplateUrl: () => `${API_BASE}/reconciliation/sample-template`,
  },

  getFileViewUrl: (fileId: string, token: string, asImage = false, page = 0) => {
    return `${API_BASE}/files/${fileId}/view?token=${token}${asImage ? "&as_image=true" : ""}&page=${page}`;
  },
};


/* ------------------------------ GSTR-3B verification ------------------------------ */

export interface Gstr3bFinding {
  key: string; kind: string; severity: "error" | "warning"; doc_type: string | null; doc_ref: string; party: string;
  field: string; field_label: string; ledger_value: string; document_value: string; invoice_id: string | null; message: string;
  dismissed: boolean; dismissed_reason: string | null; hidden: boolean;
}
export interface Gstr3bNote {
  id: string; doc_ref?: string | null; field_label?: string | null; ledger_value?: string | null; document_value?: string | null;
  message: string; severity: "error" | "warning"; resolved: boolean; created_at: string;
}
export interface Gstr3bFeedbackItem {
  invoice_id?: string | null;
  source: "system" | "staff"; kind: string; severity: "error" | "warning"; doc_type: string | null; doc_ref: string; party: string;
  field_label: string; ledger_value: string; document_value: string; message: string;
}
export interface Gstr3bFeedback {
  id: string; message: string; items: Gstr3bFeedbackItem[]; status: "sent" | "resubmitted"; created_at: string; sent_by_name?: string | null; resubmitted_at?: string | null;
}
export type Gstr3bStatus = "pending" | "feedback_sent" | "resubmitted" | "verified";
export interface Gstr3bDoc { alert?: string | null; invoice_id: string; number: string; type: "inv" | "cn" | "dn"; party: string; date: string | null; taxable: number; total: number; status: "matched" | "check" | "mismatch" }
export interface Gstr3bReview {
  client: { id: string; name: string; gstin?: string | null };
  review: { id: string; status: Gstr3bStatus; verified_at?: string | null };
  verification: {
    period: string;
    ledger: { files: { id: string; filename: string; entries: number; ai: boolean }[]; entries: number; documents: number; by_type: Record<string, number> };
    documents: { sent: Record<string, number>; sent_total: number; unsent_total: number; duplicates_skipped: number };
    matched: number; findings: Gstr3bFinding[]; docs: Gstr3bDoc[];
  };
  notes: Gstr3bNote[]; blockers: number; open_notes: number; can_verify: boolean; feedback: Gstr3bFeedback[];
  excel: Gstr3bExcel;
  run: { at: string | null; current: boolean };
}
export interface Gstr3bExcel {
  prepared: boolean; id?: string; file_name?: string; prepared_at?: string; download_url?: string; stale: boolean;
  counts: { purchase: number; credit_note: number; debit_note: number; total: number };
}
export interface Gstr3bReviewRow { id: string; client_id: string; client_name: string; tax_period: string; status: Gstr3bStatus; verified_at?: string | null; updated_at: string }

async function g3(path: string, init?: RequestInit) {
  const res = await fetch(`${API_BASE}/gstr3b${path}`, { ...init, headers: getAuthHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export const gstr3bApi = {
  review: (clientId: string, period: string): Promise<Gstr3bReview> => g3(`/review?client_id=${clientId}&tax_period=${period}`),
  clientReview: (period: string): Promise<{ review: { id: string; status: Gstr3bStatus; verified_at?: string | null }; feedback: Gstr3bFeedback[] }> => g3(`/review?tax_period=${period}`),
  reviews: (): Promise<Gstr3bReviewRow[]> => g3("/reviews"),
  addNote: (body: Record<string, unknown>): Promise<Gstr3bNote> => g3("/notes", post(body)),
  deleteNote: (id: string) => g3(`/notes/${id}`, { method: "DELETE" }),
  resolveNote: (id: string, resolved: boolean) => g3(`/notes/${id}/resolve`, post({ resolved })),
  dismiss: (clientId: string, period: string, key: string, reason: string) => g3("/dismiss", post({ client_id: clientId, tax_period: period, finding_key: key, reason })),
  deleteFinding: (clientId: string, period: string, key: string) => g3("/dismiss", post({ client_id: clientId, tax_period: period, finding_key: key, hidden: true })),
  restore: (clientId: string, period: string, key: string) => g3("/restore", post({ client_id: clientId, tax_period: period, finding_key: key })),
  sendFeedback: (body: { client_id: string; tax_period: string; message?: string; finding_keys: string[]; note_ids: string[] }): Promise<Gstr3bFeedback> => g3("/feedback", post(body)),
  verify: (clientId: string, period: string) => g3("/verify", post({ client_id: clientId, tax_period: period })),
  prepareExcel: (clientId: string, period: string): Promise<Gstr3bExcel> => g3("/excel", post({ client_id: clientId, tax_period: period })),
  runCheck: (clientId: string, period: string): Promise<{ run: { at: string; current: boolean }; counts: { missing: number; changed: number; matched: number } }> => g3("/run", post({ client_id: clientId, tax_period: period })),
  downloadCheck: async (clientId: string, period: string) => {
    const res = await fetch(`${API_BASE}/gstr3b/verification-excel?client_id=${clientId}&tax_period=${period}`, { headers: getAuthHeaders() });
    return download(res, "Could not download the report");
  },
  resubmit: (feedbackId: string) => g3(`/feedback/${feedbackId}/resubmit`, post({})),
};


/* ------------------------------ GSTR-2B reconciliation ------------------------------ */

export interface Itc4 { igst: number; cgst: number; sgst: number; cess: number }
export interface ItcSide { taxable: number; igst: number; cgst: number; sgst: number; cess: number; value: number; inv_no: string; gstin: string; date: string | null; charge?: string; reverse?: boolean; avail?: string; reason?: string }
export interface ItcLine {
  no: number; type: "inv" | "cn" | "dn"; gstin: string; party: string; inv_no: string; date: string | null; nature: string;
  books: ItcSide | null; g2b: ItcSide | null; status: "matched" | "different" | "books_only" | "g2b_only"; cat: string; remark: string; action: string;
  eligibility: string; code: string; provision: string; reason: string;
  rcm: { mode: "rcm" | "fcm" | "none"; source: string; category: string | null; ref: string | null; verify: boolean; note: string; rate?: number; tax?: Itc4 };
  amounts: { claim: Itc4; blocked: Itc4; blocked_rcm: Itc4; barred: Itc4; hold: Itc4; reversal: Itc4; rcm: Itc4; rcm_claim: Itc4; unbooked: Itc4 };
}
export interface ItcSummary {
  outward: (Itc4 & { taxable: number; source: string }) | null;
  exempt: { nil: number; exempt: number; non_gst: number } | null;
  itc: { a3: Itc4; a5: Itc4; b1: Itc4; rule42: Itc4; rule42_ratio: number; b2: Itc4; net_now: Itc4; net_rcm: Itc4; net: Itc4; opening: Itc4 };
  not_claimed: { hold: Itc4; barred: Itc4; unbooked: Itc4 };
  rcm: Itc4;
  rcm_ledger: Itc4;
  payment: { liability: Itc4; itc_used: Itc4; cash_outward: Itc4; rcm_cash: Itc4; cash: Itc4; carry_forward: Itc4; total_cash: number; total_itc_used: number };
  rule86b: { applies: boolean; minimum?: number; cash?: number };
  warnings: string[];
}
export interface ItcRcmCase {
  source: "books" | "detected" | "2b" | "supplier" | "ledger"; line?: number; type: string; party: string; gstin: string; inv_no: string; date: string | null; nature: string; taxable: number;
  rule: { name: string; ref: string; verify?: boolean } | null; mode: "rcm" | "fcm"; rate: number | null; tax: Itc4 | null; note: string; recorded: boolean;
}
export interface ItcUpload { name: string; at: string; rows?: number; sheets?: string[]; columns?: string[]; warnings: string[]; status?: "reading" | "ready" | "failed"; error?: string | null; source?: string | null; return_period?: string | null }
export interface ItcState {
  client: { id: string; name: string; gstin: string | null; business_nature: string; business_detail: string };
  natures: { value: string; label: string }[];
  uploads: { books: ItcUpload | null; gstr2b: ItcUpload | null; gstr1: ItcUpload | null };
  opening_itc: Partial<Itc4>;
  result: null | {
    lines: ItcLine[]; rcm_cases: ItcRcmCase[]; ledger_rows: number; summary: ItcSummary; profile: { nature: string | null; label: string };
    counts: { total: number; matched: number; rounding: number; different: number; books_only: number; g2b_only: number; rcm: number; no_tax: number; ineligible: number; hold: number; tax_books: Itc4; tax_2b: Itc4 };
  };
}

async function itc(path: string, init?: RequestInit, json = true) {
  const res = await fetch(`${API_BASE}/itc2b${path}`, { ...init, headers: getAuthHeaders(json) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}
export const itc2bApi = {
  state: (clientId: string, period: string): Promise<ItcState> => itc(`?client_id=${clientId}&tax_period=${period}`),
  upload: (clientId: string, period: string, kind: "books" | "gstr2b" | "gstr1", file: File): Promise<{ ok: boolean; rows?: number; warnings?: string[] }> => {
    const fd = new FormData();
    fd.append("client_id", clientId); fd.append("tax_period", period); fd.append("kind", kind); fd.append("file", file);
    return itc("/upload", { method: "POST", body: fd }, false);
  },
  remove: (clientId: string, period: string, kind: string) => itc(`/upload?client_id=${clientId}&tax_period=${period}&kind=${kind}`, { method: "DELETE" }),
  reread: (clientId: string, period: string) => itc("/gstr1/reread", post({ client_id: clientId, tax_period: period })),
  settings: (body: { client_id: string; tax_period: string; business_nature?: string; business_detail?: string; opening_itc?: Partial<Itc4> }): Promise<ItcState> => itc("/settings", { method: "PUT", body: JSON.stringify(body) }),
  excel: async (clientId: string, period: string) => {
    const res = await fetch(`${API_BASE}/itc2b/excel?client_id=${clientId}&tax_period=${period}`, { headers: getAuthHeaders() });
    return download(res, "Could not download the Excel");
  },
};

/* ------------------------------ output GST reconciliation ------------------------------ */

export interface Out5 { taxable: number; igst: number; cgst: number; sgst: number; cess: number }
export interface OutFile { id: string; kind: "books" | "gstr1" | "gstr3b"; name: string; period: string | null; rows: number; warnings: string[]; at: string; sheets: string[]; multi?: boolean }
export interface OutCompareRow { month: string; label: string; a: Out5; b: Out5; d: Out5; hasA: boolean; hasB: boolean }
export interface OutDifference { area: string; period: string; item: string; a_label: string; a: Partial<Out5> | null; b_label: string; b: Partial<Out5> | null; d: Partial<Out5> | null; reason: string; action: string; ref: string }
export interface OutState {
  client: { id: string; name: string; gstin: string | null }; fy: string; months: string[];
  files: { books: OutFile[]; gstr1: OutFile[]; gstr3b: OutFile[] };
  party_types: string;
  coverage: { month: string; label: string; books: boolean; gstr1: boolean; gstr3b: boolean }[];
  totals: { books: Out5; g1: Out5; b3: Out5; exempt: { nil: number; exempt: number; non_gst: number } };
  notes: string[];
  compare: Record<"g1_vs_3b" | "g1_vs_books" | "b3_vs_books", { rows: OutCompareRow[]; total: OutCompareRow }>;
  classification: (Out5 & { key: string; name: string; docs: number })[];
  parties: { total: number; different: number }; capital: number;
  differences: OutDifference[]; difference_count: number; ready: boolean;
}
async function out(path: string, init?: RequestInit, json = true) {
  const res = await fetch(`${API_BASE}/output${path}`, { ...init, headers: getAuthHeaders(json) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Request failed");
  }
  return res.json();
}
export const outputApi = {
  state: (clientId: string, fy: string): Promise<OutState> => out(`?client_id=${clientId}&fy=${fy}`),
  upload: (clientId: string, fy: string, kind: "books" | "gstr1" | "gstr3b", files: File[]): Promise<{ results: { name: string; ok: boolean; error?: string; period?: string | null; rows?: number; warnings?: string[] }[] }> => {
    const fd = new FormData();
    fd.append("client_id", clientId); fd.append("fy", fy); fd.append("kind", kind);
    files.forEach((f) => fd.append("files", f));
    return out("/upload", { method: "POST", body: fd }, false);
  },
  setPeriod: (id: string, period: string) => out(`/file/${id}`, { method: "PUT", body: JSON.stringify({ period }) }),
  remove: (id: string) => out(`/file/${id}`, { method: "DELETE" }),
  settings: (clientId: string, fy: string, partyTypes: string) => out("/settings", { method: "PUT", body: JSON.stringify({ client_id: clientId, fy, party_types: partyTypes }) }),
  download: async (what: "combined/books" | "combined/gstr1" | "working", clientId: string, fy: string) => {
    const res = await fetch(`${API_BASE}/output/${what}?client_id=${clientId}&fy=${fy}`, { headers: getAuthHeaders() });
    return download(res, "Could not download the Excel");
  },
};

/* ------------------------------ notifications ------------------------------ */

export interface AppNotification {
  id: string; kind: string; title: string; body: string | null; link: string | null;
  actor_name: string | null; actor_role: string | null; created_at: string; read: boolean;
}

export const notificationsApi = {
  list: async (): Promise<{ unread: number; notifications: AppNotification[] }> => {
    const res = await fetch(`${API_BASE}/notifications`, { headers: getAuthHeaders() });
    if (!res.ok) throw new Error("Could not load notifications");
    return res.json();
  },
  unread: async (): Promise<number> => {
    const res = await fetch(`${API_BASE}/notifications/unread-count`, { headers: getAuthHeaders() });
    if (!res.ok) return 0;
    return (await res.json()).unread || 0;
  },
  markRead: async (ids?: string[], all = false) => {
    const res = await fetch(`${API_BASE}/notifications/read`, { method: "POST", headers: getAuthHeaders(), body: JSON.stringify({ ids, all }) });
    if (!res.ok) throw new Error("Could not update notifications");
    return res.json();
  },
};
