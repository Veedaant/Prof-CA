import { useRef, useState, type ChangeEvent } from "react";
import { FileSpreadsheet, Upload, Trash2, Download, RefreshCw, AlertTriangle, CheckCircle2, Scale } from "lucide-react";

import { bankingStaffApi, BankWorkingSummary, LoanDetails, LoanWorkingSummary, StaffFile, StaffFileKind, StaffOverview } from "@/lib/api";

/** The CA firm's part of each upload: the ledger from the books, and the button that reconciles the two. */

const input = "w-full px-3 py-2 rounded-xl bg-white border border-slate-200 text-xs font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-black disabled:opacity-60";
const label = "block text-xs font-semibold text-slate-600 mb-1.5";
const btn = "px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 disabled:opacity-50";

const inr = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

type Props = { clientId: string; ov: StaffOverview; reload: () => void; onNotice: (m: string | null) => void };

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } };
  return { busy, error, run };
}

/** One file the CA firm uploads, with what was read from it. */
function FileSlot({ title, hint, accept, file, busy, onUpload, onRemove }: {
  title: string; hint: string; accept: string; file: StaffFile | null; busy: boolean; onUpload: (f: File) => void; onRemove: (f: StaffFile) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const pick = (e: ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ""; };
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-3.5 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-slate-800">{title}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{hint}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => ref.current?.click()} className={`${btn} shrink-0 bg-slate-900 hover:bg-slate-800 text-white`}>
          {busy ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} {file ? "Replace" : "Upload"}
        </button>
        <input ref={ref} type="file" accept={accept} onChange={pick} className="hidden" aria-label={title} />
      </div>
      {file && (
        <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 text-xs space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 min-w-0 text-emerald-900"><CheckCircle2 className="w-4 h-4 shrink-0" /><span className="font-medium truncate">{file.name}</span><span className="text-[10px] text-emerald-700 shrink-0">{file.rows} line(s) read</span></span>
            <button type="button" onClick={() => onRemove(file)} className="text-emerald-700 hover:text-rose-600 p-1" aria-label={`Remove ${file.name}`}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          {file.warnings.map((w, i) => <p key={i} className="text-[11px] text-amber-700">{w}</p>)}
        </div>
      )}
    </div>
  );
}

const Warnings = ({ items }: { items: string[] }) => (items.length ? (
  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900 space-y-1">
    <p className="font-semibold flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> Points to check</p>
    <ul className="list-disc pl-5 space-y-0.5">{items.map((w, i) => <li key={i}>{w}</li>)}</ul>
  </div>
) : null);

const ErrorBox = ({ text }: { text: string | null }) => (text ? <div role="alert" className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-700">{text}</div> : null);

function BankResult({ r }: { r: BankWorkingSummary }) {
  const s = r.summary;
  const stats: [string, number][] = [["Statement lines", s.stmtLines], ["Ledger lines", s.bookLines], ["Matched", s.matched], ["Only in statement", s.stmtOnly], ["Only in books", s.booksOnly], ["Months that differ", s.monthsWithDifference]];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {stats.map(([k, v]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-2.5"><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-slate-100 text-slate-600"><tr><th className="text-left p-2">Month</th><th className="text-right p-2">Closing as per statement</th><th className="text-right p-2">Closing as per books</th><th className="text-right p-2">Difference</th><th className="text-left p-2">Note</th></tr></thead>
          <tbody>
            {r.months.map((m) => (
              <tr key={m.month} className={`border-t border-slate-100 ${m.has_diff ? "bg-amber-50" : ""}`}>
                <td className="p-2 font-medium">{m.label}</td>
                <td className="p-2 text-right">{inr(m.stmt?.close)}</td>
                <td className="p-2 text-right">{inr(m.book?.close)}</td>
                <td className="p-2 text-right font-semibold">{inr(m.diff?.close)}</td>
                <td className="p-2 text-slate-500">{m.has_diff ? "Reconciled on its own sheet in the Excel" : m.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Warnings items={r.warnings} />
    </div>
  );
}

/** Below a bank statement upload: the bank ledger, then Reconcile. */
export function BankReconcile({ fy, account, bank, statementIds, ledger, hasDocs, clientId, ov, reload, onNotice }: Props & {
  fy: string; account: string; bank: string; statementIds: string[]; ledger: StaffFile | null; hasDocs: { form_26as: boolean; tis: boolean };
}) {
  const { busy, error, run } = useRunner();
  const [work, setWork] = useState<BankWorkingSummary | null>(null);
  const unread = ov.statement_files.filter((f) => statementIds.includes(f.submission_id) && f.error);
  return (
    <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 space-y-3">
      <p className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2"><Scale className="w-4 h-4" /> Reconcile {bank} {account} with the books</p>
      {unread.map((f) => <p key={f.id} className="text-[11px] text-rose-700">{f.name}: {f.error}</p>)}
      <FileSlot title="Bank ledger (books)" hint="Upload the ledger of this bank account from the books, as Excel or CSV, then reconcile." accept=".xlsx,.xlsm,.xls,.xlsb,.csv" file={ledger} busy={busy}
        onUpload={(f) => run(async () => { const r = await bankingStaffApi.uploadFile(clientId, fy, "bank_ledger", f, account); onNotice(`Bank ledger read: ${r.rows} line(s).`); reload(); })}
        onRemove={(f) => run(async () => { await bankingStaffApi.removeFile(f.id); reload(); })} />
      {ledger && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => run(async () => setWork(await bankingStaffApi.bank(clientId, fy, account)))} className={`${btn} bg-emerald-700 hover:bg-emerald-600 text-white`}>
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} Reconcile
          </button>
          {work && (
            <button type="button" disabled={busy} onClick={() => run(() => bankingStaffApi.bankExcel(clientId, fy, account))} className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>
              <Download className="w-4 h-4" /> Download Excel
            </button>
          )}
        </div>
      )}
      {!ledger && <p className="text-[11px] text-slate-500">The reconciliation is available once the ledger is uploaded.{!hasDocs.form_26as && " Form 26AS (above) adds TDS to the remarks."}</p>}
      <ErrorBox text={error} />
      {work && <BankResult r={work} />}
    </div>
  );
}

/** Form 26AS and TIS for a financial year: they feed the remarks of every account of that year. */
export function FyDocs({ fy, clientId, ov, reload, onNotice }: Props & { fy: string }) {
  const [busy, setBusy] = useState<StaffFileKind | "">("");
  const [error, setError] = useState<string | null>(null);
  const find = (kind: StaffFileKind) => ov.files.find((f) => f.kind === kind && f.fy === fy) || null;
  const up = (kind: "form_26as" | "tis") => async (f: File) => {
    setBusy(kind); setError(null);
    try { const r = await bankingStaffApi.uploadFile(clientId, fy, kind, f); onNotice(`${kind === "tis" ? "TIS" : "Form 26AS"} read: ${r.rows} line(s).`); reload(); } catch (e: any) { setError(e.message); } finally { setBusy(""); }
  };
  const rm = async (f: StaffFile) => { try { await bankingStaffApi.removeFile(f.id); reload(); } catch (e: any) { setError(e.message); } };
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
      <p className="text-xs font-bold text-slate-700 uppercase tracking-wider">Form 26AS and TIS for {fy} (optional, for the remarks)</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <FileSlot title="Form 26AS" hint="PDF (without a password), text, CSV or Excel. Names the parties and shows TDS." accept=".pdf,.txt,.csv,.xlsx,.xlsm,.xls,.xlsb" file={find("form_26as")} busy={busy === "form_26as"} onUpload={up("form_26as")} onRemove={rm} />
        <FileSlot title="TIS (Taxpayer Information Summary)" hint="PDF (without a password), text, CSV or Excel. Cross-checks interest and other income." accept=".pdf,.txt,.csv,.xlsx,.xlsm,.xls,.xlsb" file={find("tis")} busy={busy === "tis"} onUpload={up("tis")} onRemove={rm} />
      </div>
      <ErrorBox text={error} />
    </div>
  );
}

const DETAIL_FIELDS: { key: keyof LoanDetails; label: string; kind?: "text" | "date" | "area" }[] = [
  { key: "loan_type", label: "Type of loan" }, { key: "sanction_date", label: "Date of sanction", kind: "date" }, { key: "sanctioned_amount", label: "Sanctioned amount" },
  { key: "interest_rate", label: "Rate of interest (% p.a.)" }, { key: "tenure_months", label: "Tenure (months)" }, { key: "emi_amount", label: "Instalment (EMI)" },
  { key: "moratorium", label: "Moratorium" }, { key: "processing_fee", label: "Processing fee" },
  { key: "security", label: "Security / mortgage", kind: "area" }, { key: "guarantee", label: "Guarantee", kind: "area" }, { key: "remarks", label: "Remarks", kind: "area" },
];

function LoanResult({ r }: { r: LoanWorkingSummary }) {
  const l = r.loans[0];
  const s = l.summary;
  const stats: [string, string][] = [
    ["Closing as per books", inr(s.closingBooks)], ["Closing as per schedule", inr(s.closingSchedule)], ["Instalments pending", `${s.pending} (${inr(s.pendingTotal)})`],
    ["Short-term borrowings", inr(s.short)], ["Long-term borrowings", inr(s.long)], ["Last instalment", s.lastDate || ""],
  ];
  const diffs = l.months.filter((m) => m.diff && m.remark);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        {stats.map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 bg-white p-2.5"><p className="text-[10px] text-slate-500">{k}</p><p className="text-sm font-bold text-slate-900">{v}</p></div>)}
      </div>
      {diffs.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 text-slate-600"><tr><th className="text-left p-2">Month</th><th className="text-right p-2">Interest diff.</th><th className="text-right p-2">Instalment diff.</th><th className="text-right p-2">Closing diff.</th><th className="text-left p-2">Remark</th></tr></thead>
            <tbody>
              {diffs.map((m) => (
                <tr key={m.label} className="border-t border-slate-100 bg-amber-50">
                  <td className="p-2 font-medium">{m.label}</td><td className="p-2 text-right">{inr(m.diff?.interest)}</td><td className="p-2 text-right">{inr(m.diff?.installment)}</td><td className="p-2 text-right">{inr(m.diff?.close)}</td><td className="p-2">{m.remark}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Warnings items={[...l.points, ...r.warnings]} />
    </div>
  );
}

/** Below a loan upload: the loan terms, the loan ledger, then Reconcile. */
export function LoanReconcile({ loan, ledger, clientId, reload, onNotice }: Omit<Props, "ov"> & { loan: StaffOverview["loans"][number] | null; ledger: StaffFile | null }) {
  const { busy, error, run } = useRunner();
  const [work, setWork] = useState<LoanWorkingSummary | null>(null);
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(DETAIL_FIELDS.map((f) => [f.key, loan?.details[f.key] != null ? String(loan.details[f.key]) : ""])));
  if (!loan) return null;
  const read = Object.keys(loan.extracted).length;
  return (
    <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 space-y-3">
      <p className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2"><Scale className="w-4 h-4" /> Reconcile {loan.bank_name} loan {loan.account_number} with the books</p>
      {loan.warnings.map((w, i) => <p key={i} className="text-[11px] text-amber-700">{w}</p>)}
      <p className="text-[11px] text-slate-500">{loan.schedule_rows} instalment(s) were read from the repayment schedule.</p>

      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="px-3.5 py-2.5 text-xs font-semibold text-slate-800 cursor-pointer">Loan details for the audit: security, guarantee, rate and other terms</summary>
        <div className="p-3.5 space-y-3 border-t border-slate-100">
          <p className="text-[11px] text-slate-500">{read ? `${read} detail(s) were read from the sanction letter.` : "Nothing could be read from the sanction letter."} Check them and complete the rest; they go into the working.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {DETAIL_FIELDS.filter((f) => f.kind !== "area").map((f) => (
              <div key={f.key}><label className={label} htmlFor={`${loan.id}-${f.key}`}>{f.label}</label>
                <input id={`${loan.id}-${f.key}`} type={f.kind === "date" ? "date" : "text"} value={form[f.key]} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} className={input} /></div>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {DETAIL_FIELDS.filter((f) => f.kind === "area").map((f) => (
              <div key={f.key}><label className={label} htmlFor={`${loan.id}-${f.key}`}>{f.label}</label>
                <textarea id={`${loan.id}-${f.key}`} rows={4} value={form[f.key]} onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))} className={input} /></div>
            ))}
          </div>
          <button type="button" disabled={busy} onClick={() => run(async () => { await bankingStaffApi.saveLoan(loan.id, form); onNotice("Loan details saved."); setWork(null); reload(); })} className={`${btn} bg-slate-900 hover:bg-slate-800 text-white`}>
            <CheckCircle2 className="w-4 h-4" /> Save details
          </button>
        </div>
      </details>

      <FileSlot title="Loan ledger (books)" hint="Upload the ledger of this loan account from the books, as Excel or CSV, then reconcile." accept=".xlsx,.xlsm,.xls,.xlsb,.csv" file={ledger} busy={busy}
        onUpload={(f) => run(async () => { const r = await bankingStaffApi.uploadFile(clientId, loan.fy, "loan_ledger", f, loan.account_number); onNotice(`Loan ledger read: ${r.rows} line(s).`); reload(); })}
        onRemove={(f) => run(async () => { await bankingStaffApi.removeFile(f.id); reload(); })} />
      {ledger && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => run(async () => setWork(await bankingStaffApi.loan(clientId, loan.fy, loan.account_number)))} className={`${btn} bg-emerald-700 hover:bg-emerald-600 text-white`}>
            {busy ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Scale className="w-4 h-4" />} Reconcile
          </button>
          {work && (
            <button type="button" disabled={busy} onClick={() => run(() => bankingStaffApi.loanExcel(clientId, loan.fy, loan.account_number))} className={`${btn} border border-slate-300 bg-white text-slate-800 hover:bg-slate-50`}>
              <FileSpreadsheet className="w-4 h-4" /> Download Excel
            </button>
          )}
        </div>
      )}
      {!ledger && <p className="text-[11px] text-slate-500">The reconciliation is available once the loan ledger is uploaded.</p>}
      <ErrorBox text={error} />
      {work && <LoanResult r={work} />}
    </div>
  );
}
