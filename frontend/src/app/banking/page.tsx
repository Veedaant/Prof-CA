import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "@/lib/router";
import { Landmark, FileText, Upload, X, Download, Trash2, CheckCircle2, AlertTriangle, RefreshCw, CalendarClock } from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, bankingApi, bankingStaffApi, BankFileKind, BankSubmission, BankingState, Client, StaffOverview } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { acctKey, fyOptions, monthLabel, monthsOfFy } from "@/lib/fy";
import { BankReconcile, FyDocs, LoanReconcile } from "./StaffBlocks";

type Section = "statement" | "loan";

const OTHER = "Other";
const ACCEPT = ".pdf,.xls,.xlsx,.xlsm,.xlsb,.csv,.doc,.docx,.png,.jpg,.jpeg,.heic,.heif";
const card = "bg-white rounded-2xl border border-slate-200 shadow-sm";
const input = "w-full px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-60";
const label = "block text-xs font-semibold text-slate-600 mb-1.5";

const KIND_LABEL: Record<BankFileKind, string> = {
  statement: "Bank statement", sanction_letter: "Loan sanction letter", repayment_schedule: "Repayment schedule", other: "Other document",
};

/** What each section asks for: the file boxes, in order. */
const SECTIONS: Record<Section, {
  title: string; tab: string; accountLabel: string; intro: string; submit: string; noun: string;
  boxes: { kind: BankFileKind; title: string; hint: string; required: boolean }[];
}> = {
  statement: {
    title: "Add a bank statement", tab: "Bank Statements", accountLabel: "Bank account number", submit: "Upload bank statement", noun: "Bank statement",
    intro: "Enter the account number and choose the bank, then upload its statement. Add one upload per account.",
    boxes: [
      { kind: "statement", title: "Bank statement", hint: "PDF, Excel or CSV. You can add several files, for example one per month.", required: true },
      { kind: "other", title: "Other documents", hint: "Optional: anything else about this account.", required: false },
    ],
  },
  loan: {
    title: "Add a loan", tab: "Loan Repayment Schedules", accountLabel: "Loan account number", submit: "Upload loan documents", noun: "Loan documents",
    intro: "Enter the loan account number and choose the bank, then upload the sanction letter and the repayment schedule.",
    boxes: [
      { kind: "sanction_letter", title: "Loan sanction letter", hint: "The bank's sanction letter for the loan.", required: true },
      { kind: "repayment_schedule", title: "Repayment schedule", hint: "The schedule of instalments, as PDF or Excel.", required: true },
      { kind: "other", title: "Other documents", hint: "Optional: any other document for this loan.", required: false },
    ],
  },
};

const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const accountOk = (v: string) => /^[A-Z0-9/-]{4,30}$/.test(v.replace(/\s+/g, "").toUpperCase());

function FileBox({ title, hint, required, files, onChange }: {
  title: string; hint: string; required: boolean; files: File[]; onChange: (f: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const add = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length) onChange([...files, ...picked]);
    e.target.value = "";
  };
  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-800">
            {title} {required ? <span className="text-rose-600">*</span> : <span className="text-slate-400 font-normal">(optional)</span>}
          </p>
          <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button type="button" onClick={() => ref.current?.click()} className="shrink-0 px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5">
          <Upload className="w-3.5 h-3.5" /> Choose file
        </button>
        <input ref={ref} type="file" multiple accept={ACCEPT} onChange={add} className="hidden" aria-label={title} />
      </div>
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 border border-slate-200 text-xs">
              <span className="flex items-center gap-2 min-w-0">
                <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                <span className="font-medium text-slate-800 truncate">{f.name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{size(f.size)}</span>
              </span>
              <button type="button" onClick={() => onChange(files.filter((_, j) => j !== i))} className="text-slate-400 hover:text-rose-600 p-1" aria-label={`Remove ${f.name}`}>
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UploadForm({ section, banks, clientId, clientName, forClient, onSaved }: {
  section: Section; banks: string[]; clientId: string; clientName: string; forClient: boolean; onSaved: (msg: string) => void;
}) {
  const spec = SECTIONS[section];
  const [account, setAccount] = useState("");
  const [bank, setBank] = useState("");
  const [otherBank, setOtherBank] = useState("");
  const [files, setFiles] = useState<Partial<Record<BankFileKind, File[]>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fy, setFy] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const fyMonths = fy ? monthsOfFy(fy) : [];

  const reset = () => { setAccount(""); setBank(""); setOtherBank(""); setFiles({}); setFy(""); setPeriodFrom(""); setPeriodTo(""); };

  const submit = async () => {
    setError(null);
    if (!accountOk(account)) return setError("Enter the account number: 4 to 30 letters, digits, / or -.");
    if (!bank) return setError("Choose the bank. If it is not in the list, choose Other and type its name.");
    if (bank === OTHER && otherBank.trim().length < 2) return setError("Type the name of the bank.");
    if (!fy) return setError("Select the financial year.");
    if (section === "statement") {
      if (!periodFrom || !periodTo) return setError("Select the period the statement covers: the from month and the to month.");
      if (periodFrom > periodTo) return setError("The 'to' month cannot be before the 'from' month.");
    }
    const missing = spec.boxes.find((b) => b.required && !(files[b.kind] || []).length);
    if (missing) return setError(`Upload the ${missing.title.toLowerCase()}.`);
    setBusy(true);
    try {
      await bankingApi.upload(section, clientId, { account, bank, otherBank, fy, periodFrom, periodTo }, files);
      reset();
      onSaved(forClient ? `${spec.noun} uploaded. Your CA firm has been told.` : `${spec.noun} saved for ${clientName}. The client has been told.`);
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${card} p-6 space-y-5`}>
      <div>
        <h2 className="text-sm font-bold text-slate-800 uppercase tracking-wider">{spec.title}</h2>
        <p className="text-xs text-slate-500 mt-1">{spec.intro}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={label} htmlFor={`acc-${section}`}>{spec.accountLabel} <span className="text-rose-600">*</span></label>
          <input id={`acc-${section}`} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. 50100123456789" className={input} autoComplete="off" />
        </div>
        <div>
          <label className={label} htmlFor={`bank-${section}`}>Bank <span className="text-rose-600">*</span></label>
          <select id={`bank-${section}`} value={bank} onChange={(e) => setBank(e.target.value)} className={input}>
            <option value="">Select the bank</option>
            {banks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        {bank === OTHER && (
          <div>
            <label className={label} htmlFor={`other-${section}`}>Name of the bank <span className="text-rose-600">*</span></label>
            <input id={`other-${section}`} value={otherBank} onChange={(e) => setOtherBank(e.target.value)} placeholder="Type the bank's name" className={input} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className={label} htmlFor={`fy-${section}`}>Financial year <span className="text-rose-600">*</span></label>
          <select id={`fy-${section}`} value={fy} onChange={(e) => { setFy(e.target.value); setPeriodFrom(""); setPeriodTo(""); }} className={input}>
            <option value="">Select the financial year</option>
            {fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        {section === "statement" && (
          <>
            <div>
              <label className={label} htmlFor={`from-${section}`}>Statement period: from month <span className="text-rose-600">*</span></label>
              <select id={`from-${section}`} value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} disabled={!fy} className={input}>
                <option value="">{fy ? "From month" : "Select the year first"}</option>
                {fyMonths.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor={`to-${section}`}>Statement period: to month <span className="text-rose-600">*</span></label>
              <select id={`to-${section}`} value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} disabled={!fy} className={input}>
                <option value="">{fy ? "To month" : "Select the year first"}</option>
                {fyMonths.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </div>
          </>
        )}
      </div>

      <div className="space-y-3">
        {spec.boxes.map((b) => (
          <FileBox key={b.kind} title={b.title} hint={b.hint} required={b.required} files={files[b.kind] || []} onChange={(f) => setFiles((p) => ({ ...p, [b.kind]: f }))} />
        ))}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" /> {error}
        </div>
      )}

      <button type="button" onClick={submit} disabled={busy} className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-2 disabled:opacity-50">
        {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
        {busy ? "Uploading..." : spec.submit}
      </button>
    </div>
  );
}

type StaffCtx = { clientId: string; ov: StaffOverview | null; reload: () => void; onNotice: (m: string | null) => void };

function Uploads({ section, items, onDelete, staff }: { section: Section; items: BankSubmission[]; onDelete: (s: BankSubmission) => void; staff?: StaffCtx }) {
  const [err, setErr] = useState<string | null>(null);
  // one card for each bank account (or loan) and financial year, the latest year first
  const groups = new Map<string, BankSubmission[]>();
  for (const s of items) {
    const key = `${s.fy || ""}|${s.bank_name}|${acctKey(s.account_number)}`;
    groups.set(key, [...(groups.get(key) || []), s]);
  }
  const ordered = [...groups.entries()].sort(([x], [y]) => (x < y ? 1 : x > y ? -1 : 0));
  const get = (id: string) => bankingApi.download(id).catch((e) => setErr(e.message));

  if (!items.length) {
    return (
      <div className={`${card} p-8 text-center text-xs text-slate-500`}>
        Nothing uploaded yet. {section === "statement" ? "Bank statements" : "Loan documents"} you upload will be listed here.
      </div>
    );
  }
  const seenFy = new Set<string>();
  const ov = staff?.ov || null;
  return (
    <div className="space-y-4">
      {err && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{err}</div>}
      {ordered.map(([key, subs]) => {
        const fy = subs[0].fy;
        const first = fy && !seenFy.has(fy);
        if (fy) seenFy.add(fy);
        const ledgerKind = section === "statement" ? "bank_ledger" : "loan_ledger";
        const ledger = ov && fy ? ov.files.find((f) => f.kind === ledgerKind && f.fy === fy && acctKey(f.account_number || "") === acctKey(subs[0].account_number)) || null : null;
        const loan = section === "loan" && ov && fy ? ov.loans.find((l) => l.id === subs[0].id) || null : null;
        return (
          <div key={key} className="space-y-3">
            {staff && ov && section === "statement" && first && <FyDocs fy={fy!} clientId={staff.clientId} ov={ov} reload={staff.reload} onNotice={staff.onNotice} />}
            <div className={`${card} overflow-hidden`}>
              <div className="px-5 py-3.5 border-b border-slate-200 flex items-center gap-3 bg-slate-50">
                <div className="w-8 h-8 rounded-lg bg-black text-white flex items-center justify-center shrink-0"><Landmark className="w-4 h-4" /></div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {subs[0].bank_name}
                    {subs[0].is_other_bank && <span className="ml-2 text-[10px] font-semibold text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5 align-middle">Other bank</span>}
                  </p>
                  <p className="text-[11px] text-slate-500">{section === "statement" ? "Account" : "Loan account"} {subs[0].account_number}{fy ? ` · FY ${fy}` : " · no financial year chosen"}</p>
                </div>
                <span className="ml-auto text-[11px] text-slate-500 shrink-0">{subs.length} upload{subs.length > 1 ? "s" : ""}</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {subs.map((s) => (
                  <li key={s.id} className="px-5 py-3.5 space-y-2.5">
                    <div className="flex items-center justify-between gap-3 text-[11px] text-slate-500">
                      <span className="flex items-center gap-1.5 flex-wrap">
                        {s.period_from && s.period_to && <span className="font-semibold text-slate-700 bg-slate-100 rounded px-1.5 py-0.5">{monthLabel(s.period_from)} to {monthLabel(s.period_to)}</span>}
                        <CalendarClock className="w-3.5 h-3.5" /> {when(s.created_at)} by {s.uploaded_by_name || "unknown"}{s.uploaded_by_role === "client" ? "" : ` (${s.uploaded_by_role})`}
                      </span>
                      <button type="button" onClick={() => { if (window.confirm("Delete this upload and its files? This cannot be undone.")) onDelete(s); }} className="text-slate-400 hover:text-rose-600 p-1 rounded-lg hover:bg-rose-50" title="Delete this upload" aria-label="Delete this upload">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {s.files.map((f) => (
                        <li key={f.id} className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-slate-200 text-xs">
                          <span className="flex items-center gap-2 min-w-0">
                            <FileText className="w-4 h-4 text-slate-500 shrink-0" />
                            <span className="min-w-0">
                              <span className="block font-medium text-slate-800 truncate">{f.name}</span>
                              <span className="block text-[10px] text-slate-400">{KIND_LABEL[f.kind]} · {size(f.size)}</span>
                            </span>
                          </span>
                          <button type="button" onClick={() => get(f.id)} className="shrink-0 p-1.5 rounded-lg text-slate-600 hover:bg-slate-100" title="Download" aria-label={`Download ${f.name}`}>
                            <Download className="w-4 h-4" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {staff && !fy && <p className="px-5 py-3 border-t border-slate-200 bg-amber-50 text-[11px] text-amber-800">These uploads have no financial year, so they cannot be reconciled. Delete them and ask the client to upload again with the year.</p>}
              {staff && ov && fy && section === "statement" && (
                <BankReconcile fy={fy} account={subs[0].account_number} bank={subs[0].bank_name} statementIds={subs.map((s) => s.id)} ledger={ledger}
                  hasDocs={{ form_26as: ov.files.some((f) => f.kind === "form_26as" && f.fy === fy), tis: ov.files.some((f) => f.kind === "tis" && f.fy === fy) }}
                  clientId={staff.clientId} ov={ov} reload={staff.reload} onNotice={staff.onNotice} />
              )}
              {staff && ov && fy && section === "loan" && <LoanReconcile key={`${subs[0].id}-${ledger?.id || "x"}`} loan={loan} ledger={ledger} clientId={staff.clientId} reload={staff.reload} onNotice={staff.onNotice} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function BankingPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const isClient = user?.role === "client";

  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [section, setSection] = useState<Section>("statement");
  const [data, setData] = useState<BankingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { if (!authLoading && !user) router.push("/login"); }, [user, authLoading, router]);

  useEffect(() => {
    if (!user) return;
    api.clients.list().then((cls) => {
      setClients(cls);
      setClientId(user.role === "client" && user.client_id ? user.client_id : cls[0]?.id || "");
    }).catch((e) => setError(e.message));
  }, [user]);

  const [ov, setOv] = useState<StaffOverview | null>(null);
  const load = useCallback(() => {
    if (!clientId) return;
    bankingApi.state(clientId).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
    // the CA firm's side: the ledgers, 26AS and TIS and the loan terms that go under each upload
    if (!isClient) bankingStaffApi.overview(clientId).then(setOv).catch((e) => setError(e.message));
  }, [clientId, isClient]);
  useEffect(() => { load(); }, [load]);

  const remove = async (s: BankSubmission) => {
    try { await bankingApi.remove(s.id); setNotice("Upload deleted."); load(); } catch (e: any) { setError(e.message); }
  };

  const [fyPick, setFyPick] = useState("");
  const years = [...new Set([...(data?.statements || []), ...(data?.loans || [])].map((s) => s.fy).filter((y): y is string => Boolean(y)))].sort().reverse();
  const fyFilter = fyPick === "all" ? "" : fyPick || years[0] || "";
  const pick = (items: BankSubmission[]) => (fyFilter ? items.filter((s) => s.fy === fyFilter) : items);
  const counts = { statement: pick(data?.statements || []).length, loan: pick(data?.loans || []).length };
  const clientName = data?.client.name || clients.find((c) => c.id === clientId)?.name || "the client";

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Banking" subtitle="Bank statements, and loan sanction letters with repayment schedules" />

        <div className="p-6 max-w-5xl mx-auto w-full space-y-6">
          {!isClient && (
            <div className={`${card} p-5`}>
              <label className={label} htmlFor="banking-client">Client</label>
              <select id="banking-client" value={clientId} onChange={(e) => { setClientId(e.target.value); setData(null); setOv(null); setNotice(null); setFyPick(""); }} className={`${input} sm:max-w-md`}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.gstin || "No GSTIN"})</option>)}
              </select>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div role="tablist" className="inline-flex rounded-xl bg-slate-100 p-1 border border-slate-200">
              {(Object.keys(SECTIONS) as Section[]).map((k) => (
                <button key={k} role="tab" aria-selected={section === k} type="button" onClick={() => { setSection(k); setNotice(null); }}
                  className={`px-4 py-2 rounded-lg text-xs font-semibold transition flex items-center gap-2 ${section === k ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}>
                  {SECTIONS[k].tab}
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${section === k ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-600"}`}>{counts[k]}</span>
                </button>
              ))}
            </div>
            {years.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-xs font-semibold text-slate-600" htmlFor="banking-fy">Financial year</label>
                <select id="banking-fy" value={fyPick || years[0]} onChange={(e) => setFyPick(e.target.value)} className={`${input} w-auto`}>
                  {years.map((y) => <option key={y} value={y}>{y}</option>)}
                  <option value="all">All years</option>
                </select>
              </div>
            )}
          </div>

          {error && <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{error}</div>}
          {notice && (
            <div role="status" className="flex items-center gap-2 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> {notice}
            </div>
          )}

          {data && clientId && (
            <>
              <UploadForm key={`${section}-${clientId}`} section={section} banks={data.banks} clientId={clientId} clientName={clientName} forClient={Boolean(isClient)}
                onSaved={(msg) => { setNotice(msg); load(); }} />
              <div>
                <h2 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">
                  {section === "statement" ? "Uploaded bank statements" : "Uploaded loan documents"}
                </h2>
                <Uploads section={section} items={pick(section === "statement" ? data.statements : data.loans)} onDelete={remove}
                  staff={isClient ? undefined : { clientId, ov, reload: load, onNotice: setNotice }} />
              </div>
            </>
          )}
          {!data && !error && <p className="text-xs text-slate-500">Loading...</p>}
        </div>
      </main>
    </div>
  );
}
