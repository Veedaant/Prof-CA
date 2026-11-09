import React, { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { api, API_ORIGIN, Client, GstWorking, gstr3bApi, Gstr3bFeedback, Gstr3bStatus, Invoice, TrackedRequest } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { PeriodPicker } from "@/components/PeriodPicker";
import { stageBadge } from "@/components/Stepper";
import { ReadingProgress } from "@/components/ReadingProgress";
import { DocFeedback, Gstr3bFeedbackCard, Gstr3bLedgerUpload } from "./gstr3b-client";
import { SentGroup, sentGroups } from "@/lib/sent";
import { SentShortcuts } from "@/components/SentShortcuts";
import { currentPeriod, periodLabel } from "@/lib/period";
import { Upload, Camera, X, CheckCircle2, ChevronDown, ChevronUp, Download } from "lucide-react";
import { ReconHead, LedgerPanel } from "./recon";

type Ret = "gstr1" | "gstr3b";
const RETURN_CATS: Record<Ret, string[]> = {
  gstr1: ["sales", "credit_note", "debit_note", "other"],
  gstr3b: ["purchase", "credit_note", "debit_note", "other"],
};
const RETURN_INFO: Record<Ret, { name: string; text: string }> = {
  gstr1: { name: "GSTR-1", text: "Outward supplies: your sales invoices, credit notes, debit notes and other documents." },
  gstr3b: { name: "GSTR-3B", text: "Inward supplies: your purchase invoices, credit notes, debit notes and other documents." },
};
const returnOfRow = (r: { return_type?: string | null; invoice_type?: string | null }): Ret => (r.return_type === "gstr3b" || r.return_type === "gstr1" ? r.return_type : r.invoice_type === "purchase" ? "gstr3b" : "gstr1");

const CATEGORIES = [
  { key: "sales", label: "Sales Invoices" },
  { key: "purchase", label: "Purchase Invoices" },
  { key: "credit_note", label: "Credit Notes" },
  { key: "debit_note", label: "Debit Notes" },
  { key: "other", label: "Other Documents" },
] as const;

const inr = (n: number | undefined | null) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const input = "w-full px-3 py-2 rounded-lg border border-slate-300 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-black";
const card = "bg-white border border-slate-200 rounded-2xl shadow-sm";

export default function GstPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  useEffect(() => {
    if (!loading && !user) router.push("/login");
  }, [user, loading, router]);

  const isClient = user?.role === "client";
  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title={isClient ? "GST Details" : "GST"}
          subtitle={isClient ? "Upload your documents for a return period, check the retrieved data and send it to your CA" : "GSTR-1, GSTR-3B, reconciliations and annual returns for a client"}
        />
        {user && (isClient ? <ClientGst clientId={user.client_id!} /> : <StaffGst />)}
      </main>
    </div>
  );
}

/* ----------------------------- Client side ----------------------------- */

function ClientGst({ clientId }: { clientId: string }) {
  const [section, setSection] = useState<Ret | "ledgers">("gstr1");
  const [period, setPeriod] = useState(currentPeriod());
  const [cat, setCat] = useState<(typeof CATEGORIES)[number]["key"]>("sales");
  const [rows, setRows] = useState<TrackedRequest[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [fb3b, setFb3b] = useState<{ status: Gstr3bStatus; feedback: Gstr3bFeedback[] }>({ status: "pending", feedback: [] });
  const [reBusy, setReBusy] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);

  const load = () => api.invoices.requests().then((r) => setRows(r.requests)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  const ret: Ret = section === "gstr3b" ? "gstr3b" : "gstr1";
  const cats = CATEGORIES.filter((c) => RETURN_CATS[ret].includes(c.key));
  useEffect(() => {
    if (ret !== "gstr3b") { setFb3b({ status: "pending", feedback: [] }); return; }
    const pull = () => gstr3bApi.clientReview(period).then((r) => setFb3b({ status: r.review.status, feedback: r.feedback })).catch(() => {});
    pull();
    const t = setInterval(pull, 8000);
    return () => clearInterval(t);
  }, [ret, period]);
  // the CA firm's latest feedback that is about this very document
  const normRef = (s?: string | null) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const latestFb = fb3b.feedback[0];
  const feedbackFor = (r: TrackedRequest) => {
    if (!latestFb || !["feedback_sent", "resubmitted"].includes(fb3b.status) || !r.invoice_id) return [];
    return latestFb.items.filter((it) => (it.invoice_id && it.invoice_id === r.invoice_id) || (!it.invoice_id && it.doc_ref && normRef(it.doc_ref) === normRef(r.invoice_number)));
  };
  const reupload = async (r: TrackedRequest, file: File) => {
    setReBusy(r.invoice_id || null);
    setError(null);
    setNotice(null);
    try {
      await api.invoices.upload([file], clientId, r.invoice_type || cat, r.tax_period || period, "gstr3b", r.invoice_id || undefined);
      setNotice("Corrected document uploaded. Open it below to check the details and send it to your CA again.");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setReBusy(null);
    }
  };

  const label = CATEGORIES.find((c) => c.key === cat)!.label;
  const mine = rows.filter(
    (r) => (r.invoice_type === cat && r.tax_period === period && returnOfRow(r) === ret) || (!r.invoice_id && !r.tax_period && pending.includes(r.file_id)),
  );
  const countFor = (k: string) => rows.filter((r) => r.invoice_type === k && r.tax_period === period && returnOfRow(r) === ret).length;

  const add = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (picked.length) setFiles((p) => [...p, ...picked]);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.invoices.upload(files, clientId, cat, period, ret);
      setNotice(`${res.length} file${res.length > 1 ? "s" : ""} uploaded successfully. Open each one below to check the retrieved data and send it to your CA.`);
      setPending((p) => [...p, ...res.map((r) => r.file_id)]);
      setFiles([]);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto w-full space-y-5">
      <div className="flex gap-2 border-b border-slate-200">
        {([["gstr1", "GSTR-1"], ["gstr3b", "GSTR-3B"], ["ledgers", "Sales / Purchase ledgers"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => { setSection(k); setOpen(null); setFiles([]); setNotice(null); if (k !== "ledgers") setCat(RETURN_CATS[k][0] as (typeof CATEGORIES)[number]["key"]); }} className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${section === k ? "border-black text-black" : "border-transparent text-slate-500 hover:text-black"}`}>{l}</button>
        ))}
      </div>
      {section === "ledgers" && <LedgerPanel clientId={clientId} />}
      {section !== "ledgers" && (<>
      <div className={`${card} p-4 border-black`}>
        <p className="text-sm font-semibold">{RETURN_INFO[ret].name}</p>
        <p className="text-sm text-slate-500">{RETURN_INFO[ret].text} Everything you send here reaches your CA marked as {RETURN_INFO[ret].name}.</p>
      </div>
      <div className={`${card} p-5 flex flex-wrap items-center justify-between gap-3`}>
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Return period</p>
          <p className="text-lg font-semibold">{periodLabel(period)}</p>
        </div>
        <PeriodPicker value={period} onChange={(p) => { setPeriod(p); setOpen(null); }} />
      </div>
      {ret === "gstr3b" && <Gstr3bFeedbackCard period={period} />}

      <div className="flex gap-1.5 flex-wrap">
        {cats.map((c) => (
          <button
            key={c.key}
            onClick={() => { setCat(c.key); setOpen(null); }}
            className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${cat === c.key ? "bg-black text-white border-black" : "bg-white text-slate-600 border-slate-200 hover:border-black"}`}
          >
            {c.label} <span className="opacity-60">({countFor(c.key)})</span>
          </button>
        ))}
      </div>

      {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
      {notice && <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">{notice}</div>}

      {ret === "gstr3b" && cat === "other" ? (
        <Gstr3bLedgerUpload clientId={clientId} period={period} />
      ) : (<>
      <div className={`${card} p-6 space-y-4`}>
        <div>
          <h3 className="font-semibold">Upload {label}</h3>
          <p className="text-sm text-slate-500">For {periodLabel(period)}. PDF, PNG, JPG or HEIC. The data is retrieved for you to check. Once you verify it and send it to your CA, they can download the Excel.</p>
        </div>
        <input ref={fileRef} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.heic,.heif" onChange={add} className="hidden" />
        <input ref={camRef} type="file" accept="image/*" capture="environment" onChange={add} className="hidden" />
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800">
            <Upload className="w-4 h-4" /> Select files
          </button>
          <button onClick={() => camRef.current?.click()} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black">
            <Camera className="w-4 h-4" /> Take photo
          </button>
        </div>
        {files.length > 0 && (
          <div className="space-y-2">
            {files.map((f, i) => (
              <div key={i} className="flex items-center justify-between text-sm border border-slate-200 rounded-lg px-3 py-2">
                <span className="truncate">{f.name}</span>
                <button onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} aria-label="Remove file"><X className="w-4 h-4" /></button>
              </div>
            ))}
            <button disabled={busy} onClick={submit} className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium disabled:opacity-40">
              {busy ? "Uploading..." : `Upload ${files.length} file${files.length > 1 ? "s" : ""} to ${periodLabel(period)}`}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="font-semibold text-sm">{label} — {periodLabel(period)}</h3>
        {mine.length === 0 ? (
          <div className={`${card} p-8 text-center text-sm text-slate-500`}>Nothing uploaded in this category for this period yet.</div>
        ) : (
          mine.map((r) => (
            <div key={r.file_id} className={card}>
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.original_filename}</p>
                  <p className="text-xs text-slate-500">
                    {r.invoice_number ? `No. ${r.invoice_number} · ` : ""}
                    {r.invoice_total != null ? `${inr(r.invoice_total)} · ` : ""}
                    {new Date(r.uploaded_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {r.alert_for === "client" && <span className="text-[11px] font-medium px-2.5 py-1 rounded-full border whitespace-nowrap bg-amber-50 text-amber-800 border-amber-200">CA changed it - review</span>}
                  <span className={`text-[11px] font-medium px-2.5 py-1 rounded-full border whitespace-nowrap ${stageBadge(r.stage.key)}`}>{r.stage.label}</span>
                  {r.invoice_id && (
                    <button onClick={() => setOpen(open === r.invoice_id ? null : r.invoice_id!)} className="inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4">
                      {r.client_approved_at ? (r.editable_until && new Date(r.editable_until).getTime() > Date.now() ? "View / edit" : "View") : "Check & send to CA"}
                      {open === r.invoice_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </button>
                  )}
                </div>
              </div>
              {r.stage.key === "processing" && (
                <div className="px-4 pb-4">
                  <ReadingProgress pct={r.progress || 0} label={r.file_status === "queued" ? "Waiting to start" : r.progress_label} />
                </div>
              )}
              {r.stage.key === "failed" && r.error_message && <p className="px-4 pb-3 text-xs text-rose-600">{r.error_message}</p>}
              {ret === "gstr3b" && feedbackFor(r).length > 0 && latestFb && (
                <DocFeedback items={feedbackFor(r)} status={fb3b.status} sentAt={latestFb.created_at} busy={reBusy === r.invoice_id} onReupload={(f) => reupload(r, f)} />
              )}
              {open === r.invoice_id && r.invoice_id && <ApprovePanel id={r.invoice_id} onChanged={load} />}
            </div>
          ))
        )}
      </div>
      </>)}
      </>)}
    </div>
  );
}

const FIELDS: { key: keyof Invoice; label: string; num?: boolean }[] = [
  { key: "invoice_number", label: "Document number" },
  { key: "invoice_date", label: "Date (YYYY-MM-DD)" },
  { key: "supplier_name", label: "Supplier name (seller)" },
  { key: "supplier_gstin", label: "Supplier GSTIN" },
  { key: "buyer_name", label: "Buyer name" },
  { key: "buyer_gstin", label: "Buyer GSTIN" },
  { key: "place_of_supply", label: "Place of supply" },
  { key: "total_taxable_value", label: "Taxable value", num: true },
  { key: "cgst_total", label: "CGST", num: true },
  { key: "sgst_total", label: "SGST", num: true },
  { key: "igst_total", label: "IGST", num: true },
  { key: "total_tax", label: "Total tax", num: true },
  { key: "invoice_total", label: "Total amount", num: true },
];

function ApprovePanel({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [inv, setInv] = useState<Invoice | null>(null);
  const [form, setForm] = useState<Record<string, any>>({});
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.invoices.get(id).then((i) => {
      setInv(i);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, (i as any)[f.key] ?? ""])));
    }).catch((e) => setError(e.message));
  }, [id]);

  if (!inv) return <div className="p-4 text-sm text-slate-500 border-t border-slate-100">{error || "Loading..."}</div>;
  const sent = Boolean(inv.client_approved_at);
  const windowOpen = Boolean(inv.editable_until) && new Date(inv.editable_until!).getTime() > Date.now();
  const locked = sent && !windowOpen;
  const flags = (inv.flags || []);

  const payload = () => {
    const out: Record<string, any> = {};
    for (const f of FIELDS) out[f.key] = f.num ? Number(form[f.key]) || 0 : String(form[f.key] ?? "");
    return out;
  };
  const save = async () => {
    const updated = await api.invoices.update(id, payload() as Partial<Invoice>);
    setInv(updated);
    setSaved(true);
  };
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); onChanged(); } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <div className="border-t border-slate-100 p-5 space-y-4">
      {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
      {inv.alert_for === "client" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 text-amber-900 text-sm p-3 flex flex-wrap items-center justify-between gap-3">
          <span>{inv.alert_text || "Your CA firm changed this invoice - please review it again."}</span>
          <button disabled={busy} onClick={() => run(async () => { setInv(await api.invoices.ackAlert(id)); })} className="px-3 py-1.5 rounded-lg border border-amber-300 bg-white text-xs font-medium hover:border-black disabled:opacity-40">I have reviewed it</button>
        </div>
      )}
      {sent && (
        <div className="flex flex-wrap gap-2 items-center justify-between text-sm text-emerald-700">
          <span className="flex gap-2 items-center"><CheckCircle2 className="w-4 h-4" /> You verified this and sent it to your CA on {new Date(inv.client_approved_at!).toLocaleString()}.</span>
          {windowOpen
            ? <span className="text-xs text-slate-600">You can edit or unsend until {new Date(inv.editable_until!).toLocaleString()}. Your CA will be alerted to any change.</span>
            : <span className="text-xs text-slate-500">The 24-hour edit window has ended. Ask your CA firm to change anything.</span>}
        </div>
      )}
      {flags.length > 0 && !locked && (
        <ul className="text-xs space-y-1 rounded-lg bg-amber-50 border border-amber-200 p-3 text-amber-800">
          {flags.map((f, i) => <li key={i}>• {f.message}</li>)}
        </ul>
      )}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="block text-xs font-medium text-slate-600 mb-1">{f.label}</span>
            <input
              disabled={locked}
              type={f.num ? "number" : "text"}
              step={f.num ? "0.01" : undefined}
              value={form[f.key] ?? ""}
              onChange={(e) => { setSaved(false); setForm((p) => ({ ...p, [f.key]: e.target.value })); }}
              className={`${input} disabled:bg-slate-50`}
            />
          </label>
        ))}
      </div>
      {inv.file_preview_url && (
        <a href={`${API_ORIGIN}${inv.file_preview_url}`} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium underline underline-offset-4">
          Open the original document to compare
        </a>
      )}
      {sent && windowOpen && (
        <div className="flex gap-2 flex-wrap items-center pt-1">
          <button disabled={busy} onClick={() => run(save)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40">Save changes (CA is alerted)</button>
          <button
            disabled={busy}
            onClick={() => { if (window.confirm("Unsend this invoice? Your CA will no longer see it until you send it again.")) run(async () => { setInv(await api.invoices.unsend(id)); }); }}
            className="px-4 py-2 rounded-lg border border-rose-300 text-rose-700 text-sm font-medium hover:bg-rose-50 disabled:opacity-40"
          >Unsend</button>
          {saved && <span className="text-xs text-emerald-700">Saved - your CA has been alerted</span>}
        </div>
      )}
      {!sent && (
        <div className="space-y-3 pt-1">
          <label className="flex items-start gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 accent-black w-4 h-4" />
            <span>I have checked these details against the document and they are correct.</span>
          </label>
          <div className="flex gap-2 flex-wrap items-center">
            <button disabled={busy} onClick={() => run(save)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black disabled:opacity-40">Save changes</button>
            <button
              disabled={busy || !checked}
              onClick={() => run(async () => { await save(); setInv(await api.invoices.clientApprove(id)); })}
              className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800 disabled:opacity-40"
            >
              Verify &amp; send to CA staff
            </button>
            {saved && <span className="text-xs text-emerald-700">Saved</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ Staff side ----------------------------- */

const HEADS = [
  { key: "gstr1", label: "GSTR-1" },
  { key: "gstr3b", label: "GSTR-3B" },
  { key: "output", label: "Output Reconciliation" },
  { key: "input", label: "Input Reconciliation" },
  { key: "gstr9", label: "GSTR-9" },
  { key: "gstr9c", label: "GSTR-9C" },
] as const;

function StaffGst() {
  const [head, setHead] = useState<(typeof HEADS)[number]["key"]>("gstr1");
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  useEffect(() => {
    api.clients.list().then((c) => { setClients(c); if (c.length) setClientId(c[0].id); }).catch(() => {});
  }, []);
  return (
    <div>
      <div className="px-6 pt-5 max-w-6xl mx-auto w-full">
        <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
          {HEADS.map((h) => (
            <button key={h.key} onClick={() => setHead(h.key)} className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap -mb-px border-b-2 ${head === h.key ? "border-black text-black" : "border-transparent text-slate-500 hover:text-black"}`}>{h.label}</button>
          ))}
        </div>
      </div>
      {head === "gstr1" ? (
        <Gstr1Head key="gstr1" ret="gstr1" clients={clients} clientId={clientId} setClientId={setClientId} />
      ) : head === "gstr3b" ? (
        <>
          <Gstr1Head key="gstr3b-docs" ret="gstr3b" clients={clients} clientId={clientId} setClientId={setClientId} />
          <div className="px-6 max-w-6xl mx-auto w-full"><div className="border-t border-slate-200 pt-4 text-sm font-semibold">GSTR-3B reconciliation</div></div>
          <ReconHead key="gstr3b" head="gstr3b" clients={clients} clientId={clientId} setClientId={setClientId} />
        </>
      ) : (
        <ReconHead key={head} head={head} clients={clients} clientId={clientId} setClientId={setClientId} />
      )}
    </div>
  );
}

function Gstr1Head({ clients, clientId, setClientId, ret = "gstr1" }: { clients: Client[]; clientId: string; setClientId: (v: string) => void; ret?: Ret }) {
  const [period, setPeriod] = useState(currentPeriod());
  const [data, setData] = useState<GstWorking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"sales" | "working" | "credit" | "debit" | "purchase" | "other">(ret === "gstr3b" ? "purchase" : "sales");
  const router = useRouter();
  const [dlBusy, setDlBusy] = useState(false);
  const [groups, setGroups] = useState<SentGroup[] | null>(null);
  const defaulted = useRef(false);
  useEffect(() => { sentGroups().then(setGroups).catch(() => setGroups([])); }, []);
  // open on the client and month that most recently sent documents for this return
  useEffect(() => {
    if (defaulted.current || !clients.length || groups === null) return;
    defaulted.current = true;
    const g = groups.find((x) => x.return_type === ret);
    if (g) { setClientId(g.client_id); setPeriod(g.tax_period); }
  }, [clients, groups]);
  const CATEGORY_OF_TAB = { sales: "sales", credit: "credit_note", debit: "debit_note", purchase: "purchase", other: "other", working: "sales" } as const;
  const downloadRegister = async (category: string) => {
    setDlBusy(true);
    setError(null);
    try {
      const r = await api.exports.generateRegister(clientId, period, category, ret);
      await api.exports.downloadFile(r.download_url, r.file_name);
      if (r.warning) setError(r.warning);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDlBusy(false);
    }
  };

  useEffect(() => {
    if (!clientId) return;
    setError(null);
    api.gst.working(clientId, period).then(setData).catch((e) => { setData(null); setError(e.message); });
  }, [clientId, period]);

  const w = data?.working;
  const rows3 = data?.gstr3b;
  const tabs = !data
    ? []
    : ret === "gstr3b"
    ? [
        { key: "purchase", label: `Purchase invoices (${rows3!.purchases.length})` },
        { key: "credit", label: `Credit notes (${rows3!.credit_notes.length})` },
        { key: "debit", label: `Debit notes (${rows3!.debit_notes.length})` },
        { key: "other", label: `Other (${rows3!.others.length})` },
      ]
    : [
        { key: "sales", label: `Sales invoices (${data.sales.length})` },
        { key: "working", label: "GSTR-1 working" },
        { key: "credit", label: `Credit notes (${data.all_credit_notes.length})` },
        { key: "debit", label: `Debit notes (${data.all_debit_notes.length})` },
        { key: "other", label: `Other (${data.others.length})` },
      ];

  const table = (rows: Invoice[], empty: string) =>
    rows.length === 0 ? (
      <div className={`${card} p-8 text-center text-sm text-slate-500`}>{empty}</div>
    ) : (
      <div className={`${card} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
              <th className="px-4 py-3 font-medium">Number</th>
              <th className="px-3 py-3 font-medium">Date</th>
              <th className="px-3 py-3 font-medium">Supplier</th>
              <th className="px-3 py-3 font-medium">Buyer</th>
              <th className="px-3 py-3 font-medium text-right">Taxable</th>
              <th className="px-3 py-3 font-medium text-right">Tax</th>
              <th className="px-4 py-3 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} onClick={() => router.push(`/invoices/${i.id}/review`)} className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50">
                <td className="px-4 py-3 font-medium">{i.invoice_number || "—"}</td>
                <td className="px-3 py-3">{i.invoice_date || "—"}</td>
                <td className="px-3 py-3">{i.supplier_name || "—"}<div className="text-xs text-slate-400">{i.supplier_gstin}</div></td>
                <td className="px-3 py-3">{i.buyer_name || "—"}<div className="text-xs text-slate-400">{i.buyer_gstin}</div></td>
                <td className="px-3 py-3 text-right">{inr(i.total_taxable_value)}</td>
                <td className="px-3 py-3 text-right">{inr(i.total_tax)}</td>
                <td className="px-4 py-3 text-right font-medium">{inr(i.invoice_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  const SECTION_NAMES: Record<string, string> = { b2b: "B2B invoices", b2cl: "B2C large", b2cs: "B2C small", cdnr: "Credit / debit notes (registered)" };

  return (
    <div className="p-6 max-w-6xl mx-auto w-full space-y-5">
      <div className={`${card} p-5 flex flex-wrap items-end gap-4 justify-between`}>
        <label className="block min-w-[16rem]">
          <span className="block text-xs font-medium text-slate-600 mb-1">Client</span>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
          </select>
        </label>
        <div>
          <span className="block text-xs font-medium text-slate-600 mb-1">Return period</span>
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      </div>

      <SentShortcuts groups={groups} ret={ret} clientId={clientId} period={period} onPick={(g) => { setClientId(g.client_id); setPeriod(g.tax_period); }} />

      {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}

      {data && w && (
        <>
          {data.pending_client_approval > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm px-4 py-3">
              {data.pending_client_approval} document(s) for {periodLabel(period)} are still waiting for the client to check and approve. They will appear here once approved.
            </div>
          )}
          <div className={`grid grid-cols-2 md:grid-cols-4 gap-3 ${ret === "gstr3b" ? "hidden" : ""}`}>
            {[
              ["Sales invoices", `${w.sales.count} · ${inr(w.sales.taxable)}`],
              ["Credit notes", `${w.credit_notes.count} · ${inr(w.credit_notes.taxable)}`],
              ["Debit notes", `${w.debit_notes.count} · ${inr(w.debit_notes.taxable)}`],
              ["Net tax liability", inr(w.net.tax)],
            ].map(([k, v]) => (
              <div key={k} className={`${card} p-4`}>
                <p className="text-xs text-slate-500">{k}</p>
                <p className="font-semibold mt-1">{v}</p>
              </div>
            ))}
          </div>

          <div className="flex gap-1.5 flex-wrap">
            {tabs.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key as any)} className={`px-3.5 py-2 rounded-full text-sm font-medium border transition ${tab === t.key ? "bg-black text-white border-black" : "bg-white text-slate-600 border-slate-200 hover:border-black"}`}>
                {t.label}
              </button>
            ))}
          </div>

          {tab !== "working" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">Only documents the client verified and sent <span className="font-semibold text-slate-800">for {ret === "gstr3b" ? "GSTR-3B" : "GSTR-1"}</span> are listed.</p>
              <button
                disabled={dlBusy}
                onClick={() => downloadRegister(CATEGORY_OF_TAB[tab])}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800 disabled:opacity-40"
              >
                <Download className="w-4 h-4" /> {dlBusy ? "Preparing..." : "Download Excel"}
              </button>
            </div>
          )}
          {ret === "gstr1" && tab === "sales" && table(data.sales, "No client-approved sales invoices for this period.")}
          {tab === "credit" && table(ret === "gstr3b" ? rows3!.credit_notes : data.all_credit_notes, `No credit notes sent for ${ret === "gstr3b" ? "GSTR-3B" : "GSTR-1"} this period.`)}
          {tab === "debit" && table(ret === "gstr3b" ? rows3!.debit_notes : data.all_debit_notes, `No debit notes sent for ${ret === "gstr3b" ? "GSTR-3B" : "GSTR-1"} this period.`)}
          {ret === "gstr3b" && tab === "purchase" && table(rows3!.purchases, "No purchase invoices sent for GSTR-3B this period.")}
          {tab === "other" && table(ret === "gstr3b" ? rows3!.others : data.others, `No other documents sent for ${ret === "gstr3b" ? "GSTR-3B" : "GSTR-1"} this period.`)}
          {tab === "working" && (
            <div className="space-y-4">
              <div className={`${card} overflow-x-auto`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="px-4 py-3 font-medium">GSTR-1 table</th>
                      <th className="px-3 py-3 font-medium text-right">Entries</th>
                      <th className="px-4 py-3 font-medium text-right">Taxable value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.sections.map((s) => (
                      <tr key={s.key} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3">{SECTION_NAMES[s.key] || s.key}</td>
                        <td className="px-3 py-3 text-right">{s.count}</td>
                        <td className="px-4 py-3 text-right">{inr(s.taxable)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className={`${card} overflow-x-auto`}>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                      <th className="px-4 py-3 font-medium"> </th>
                      {["Taxable", "CGST", "SGST", "IGST", "Cess", "Invoice value"].map((h) => <th key={h} className="px-3 py-3 font-medium text-right">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {([["Sales invoices", w.sales, ""], ["Debit notes (+)", w.debit_notes, ""], ["Credit notes (−)", w.credit_notes, ""]] as const).map(([name, t]) => (
                      <tr key={name} className="border-b border-slate-100">
                        <td className="px-4 py-3">{name}</td>
                        {[t.taxable, t.cgst, t.sgst, t.igst, t.cess, t.total].map((v, i) => <td key={i} className="px-3 py-3 text-right">{inr(v)}</td>)}
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className="px-4 py-3">Net outward supply</td>
                      {[w.net.taxable, w.net.cgst, w.net.sgst, w.net.igst, w.net.cess, w.net.total].map((v, i) => <td key={i} className="px-3 py-3 text-right">{inr(v)}</td>)}
                    </tr>
                  </tbody>
                </table>
              </div>
              {w.hsn.length > 0 && (
                <div className={`${card} overflow-x-auto`}>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th className="px-4 py-3 font-medium">HSN / SAC summary</th>
                        <th className="px-3 py-3 font-medium text-right">Qty</th>
                        <th className="px-3 py-3 font-medium text-right">Taxable</th>
                        <th className="px-3 py-3 font-medium text-right">IGST</th>
                        <th className="px-3 py-3 font-medium text-right">CGST</th>
                        <th className="px-4 py-3 font-medium text-right">SGST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {w.hsn.map((h) => (
                        <tr key={h.hsn} className="border-b border-slate-100 last:border-0">
                          <td className="px-4 py-3">{h.hsn} <span className="text-xs text-slate-400">{h.description}</span></td>
                          <td className="px-3 py-3 text-right">{h.total_quantity}</td>
                          <td className="px-3 py-3 text-right">{inr(h.taxable_value)}</td>
                          <td className="px-3 py-3 text-right">{inr(h.igst_amount)}</td>
                          <td className="px-3 py-3 text-right">{inr(h.cgst_amount)}</td>
                          <td className="px-4 py-3 text-right">{inr(h.sgst_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <button onClick={() => router.push("/exports")} className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800">
                Generate GSTR-1 Excel
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
