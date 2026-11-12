import { db } from "../../db/index.js";
import { readFile } from "../storage.js";
import { readStatement } from "./statementReader.js";
import { readSchedule, readSanction } from "./scheduleReader.js";
import { accountKey, fyFrom, fyTo, addMonthsIso } from "./common.js";

/** Bumped when a reader changes, so files read by an older reader are read again. */
export const PARSER_VERSION = 1;

/** The reading of one uploaded file, kept with the file so it is read once. A failure to open the stored file is not kept. */
export async function parsedFile(file, reader) {
  if (file.parsed_ver === PARSER_VERSION && file.parsed) return { parsed: file.parsed, error: null };
  if (file.parsed_ver === PARSER_VERSION && file.parse_error) return { parsed: null, error: file.parse_error };
  let bytes;
  try { bytes = await readFile(file.storage_path); } catch (e) { return { parsed: null, error: String(e.message || e) }; }
  try {
    const parsed = await reader(bytes, file.original_filename);
    await db.query("update banking_files set parsed=$2::jsonb, parse_error=null, parsed_ver=$3 where id=$1", [file.id, JSON.stringify(parsed), PARSER_VERSION]);
    return { parsed, error: null };
  } catch (e) {
    const error = String(e.message || e).slice(0, 500);
    await db.query("update banking_files set parsed=null, parse_error=$2, parsed_ver=$3 where id=$1", [file.id, error, PARSER_VERSION]);
    return { parsed: null, error };
  }
}

async function filesOf(submissionIds, kinds) {
  if (!submissionIds.length) return [];
  return db.query("select * from banking_files where submission_id = any($1::uuid[]) and kind = any($2::text[]) order by created_at, original_filename", [submissionIds, kinds]);
}

export const sameAccount = (a, b) => accountKey(a) === accountKey(b);

/** Everything the bank working needs for one account, read from the database. */
export async function loadBankInputs({ firmId, clientId, fy, accountNumber }) {
  const client = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [clientId, firmId]);
  const all = await db.query("select * from banking_submissions where firm_id=$1 and client_id=$2 order by created_at", [firmId, clientId]);
  const subs = all.filter((s) => s.section === "statement" && s.fy === fy && sameAccount(s.account_number, accountNumber));
  if (!subs.length) return { client, error: "No bank statement has been uploaded for this account and financial year." };
  const errors = [];
  const statements = [];
  for (const f of await filesOf(subs.map((s) => s.id), ["statement"])) {
    const r = await parsedFile(f, readStatement);
    if (r.parsed) statements.push({ name: f.original_filename, parsed: r.parsed }); else errors.push(`${f.original_filename}: ${r.error}`);
  }
  const staff = await db.query("select * from banking_staff_files where firm_id=$1 and client_id=$2 and fy=$3", [firmId, clientId, fy]);
  const ledgerFile = staff.find((f) => f.kind === "bank_ledger" && sameAccount(f.account_number, accountNumber));
  const invoices = await db.query(
    `select invoice_type, return_type, supplier_name, supplier_gstin, buyer_name, buyer_gstin, invoice_number, invoice_date, invoice_total, total_taxable_value
       from invoices where firm_id=$1 and client_id=$2 and replaced_at is null and review_status <> 'rejected' and invoice_date >= $3 and invoice_date <= $4`,
    [firmId, clientId, addMonthsIso(fyFrom(fy), -6), addMonthsIso(fyTo(fy), 2)],
  );
  const own = [...new Map(all.filter((s) => s.section === "statement" && !sameAccount(s.account_number, accountNumber)).map((s) => [accountKey(s.account_number), { bank_name: s.bank_name, account_number: s.account_number }])).values()];
  const loans = [];
  for (const l of all.filter((s) => s.section === "loan" && s.fy === fy)) {
    const rows = [];
    for (const f of await filesOf([l.id], ["repayment_schedule"])) { const r = await parsedFile(f, readSchedule); if (r.parsed) rows.push(...r.parsed.rows); }
    loans.push({ bank_name: l.bank_name, account_number: l.account_number, installments: rows.filter((r) => r.installment > 0).map((r) => ({ date: r.date, amount: r.installment })) });
  }
  return {
    client, errors, statements, ledger: ledgerFile?.parsed || null, ledgerName: ledgerFile?.original_filename || null,
    coverage: subs.filter((s) => s.period_from && s.period_to).map((s) => ({ from: s.period_from, to: s.period_to })),
    invoices, tax26as: staff.find((f) => f.kind === "form_26as")?.parsed || null, tis: staff.find((f) => f.kind === "tis")?.parsed || null,
    ownAccounts: own, loans, account: { bank_name: subs[0].bank_name, account_number: subs[0].account_number },
  };
}

/** Terms read from the sanction letters, with whatever the CA staff have entered on top. */
export const effectiveDetails = (extracted, saved) => {
  const out = { ...extracted };
  for (const [k, v] of Object.entries(saved || {})) if (v !== "" && v != null) out[k] = v;
  return out;
};

export async function loadLoanInputs({ firmId, clientId, fy }) {
  const client = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [clientId, firmId]);
  const subs = await db.query("select * from banking_submissions where firm_id=$1 and client_id=$2 and section='loan' and fy=$3 order by created_at", [firmId, clientId, fy]);
  const staff = await db.query("select * from banking_staff_files where firm_id=$1 and client_id=$2 and fy=$3 and kind='loan_ledger'", [firmId, clientId, fy]);
  const loans = [];
  for (const s of subs) {
    const warnings = [];
    const rows = [];
    for (const f of await filesOf([s.id], ["repayment_schedule"])) {
      const r = await parsedFile(f, readSchedule);
      if (r.parsed) { rows.push(...r.parsed.rows); for (const w of r.parsed.warnings || []) warnings.push(`${f.original_filename}: ${w}`); } else warnings.push(`${f.original_filename}: ${r.error}`);
    }
    const seen = new Set();
    const schedule = rows.filter((r) => { const k = `${r.date}|${r.installment}|${r.closing}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const extracted = {};
    for (const f of await filesOf([s.id], ["sanction_letter"])) {
      const r = await parsedFile(f, readSanction);
      if (r.parsed) { for (const [k, v] of Object.entries(r.parsed.details || {})) if (extracted[k] == null) extracted[k] = v; if (r.parsed.warning) warnings.push(r.parsed.warning); }
      else warnings.push(`${f.original_filename}: ${r.error}`);
    }
    const ledgerFile = staff.find((f) => sameAccount(f.account_number, s.account_number));
    loans.push({
      id: s.id, bank_name: s.bank_name, account_number: s.account_number, schedule: schedule.length ? { rows: schedule } : null, ledger: ledgerFile?.parsed || null,
      ledgerFile: ledgerFile ? { id: ledgerFile.id, name: ledgerFile.original_filename } : null, extracted, saved: s.loan_details || {}, details: effectiveDetails(extracted, s.loan_details), warnings,
      files: [], created_at: s.created_at,
    });
  }
  return { client, loans };
}
