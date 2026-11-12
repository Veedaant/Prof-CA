import { r2, monthsOfFy, monthOf, fyFrom, fyTo, addMonthsIso, monthLabel } from "./common.js";

/**
 * The loan working: the lender's repayment schedule against the loan ledger in the books, month by month, and the year-end position
 * (closing balance, instalments pending, the short-term and long-term split, security and guarantee) for the audit.
 */

const sum = (list) => r2(list.reduce((a, b) => a + b, 0));

/** What a ledger entry on a loan account is, from the other ledger named, the narration and the voucher type. */
export function classifyLoanEntry(e) {
  const text = `${e.party} ${e.narration} ${e.vchType}`;
  if (e.credit) {
    if (/interest|\bint\b/i.test(text)) return { kind: "interest", nature: "Interest charged to the loan account", remark: "Interest booked on the loan." };
    if (/processing|charges|fee|premium|insurance/i.test(text)) return { kind: "charges", nature: "Processing fee / charges added to the loan", remark: "Charges added to the loan balance." };
    if (/disburs|drawdown|loan received|sanction|receipt/i.test(text) || /bank|a\/c/i.test(e.party)) return { kind: "disbursement", nature: "Loan received (disbursement)", remark: "Additional loan received from the lender." };
    return { kind: "other_add", nature: "Other addition to the loan", remark: "Credit to the loan account that is not interest or a receipt: check." };
  }
  if (/prepay|foreclos|pre-?closure|part ?payment/i.test(text)) return { kind: "prepayment", nature: "Prepayment / part payment", remark: "Loan paid ahead of the schedule." };
  if (/interest|\bint\b/i.test(text)) return { kind: "interest_paid", nature: "Interest paid", remark: "Interest paid on the loan." };
  if (/emi|instal|repay|ecs|nach|payment/i.test(text) || /bank/i.test(e.party)) return { kind: "emi", nature: "EMI / instalment paid", remark: "Instalment paid to the lender." };
  return { kind: "other_deduct", nature: "Other reduction of the loan", remark: "Debit to the loan account that is not a payment to the lender: check." };
}

function scheduleMonths(rows, months) {
  const out = {};
  const firstMonth = monthOf(rows[0].date);
  for (const m of months) {
    if (m < firstMonth) { out[m] = null; continue; }
    const rs = rows.filter((r) => monthOf(r.date) === m);
    if (rs.length) {
      out[m] = { open: rs[0].opening, interest: sum(rs.map((r) => r.interest)), principal: sum(rs.map((r) => r.principal)), installment: sum(rs.map((r) => r.installment)), close: rs[rs.length - 1].closing };
    } else {
      const before = rows.filter((r) => monthOf(r.date) < m);
      const c = before[before.length - 1].closing;
      out[m] = { open: c, interest: 0, principal: 0, installment: 0, close: c, none: true };
    }
  }
  return out;
}

function bookMonths(entries, opening, months, fy, warnings) {
  const from = fyFrom(fy), to = fyTo(fy);
  let open = -opening; // a credit balance is what is owed
  for (const e of entries) if (e.date < from) open += e.credit - e.debit;
  const rows = entries.filter((e) => e.date >= from && e.date <= to);
  const first = rows[0]?.date || from, last = rows[rows.length - 1]?.date || from;
  const start = first <= addMonthsIso(from, 3) ? months[0] : monthOf(first);
  let end = months[11];
  if (last < addMonthsIso(to, -3)) { end = monthOf(last); warnings.push(`The ledger has entries only up to ${last}. Later months are not compared.`); }
  const out = {};
  let run = open;
  for (const m of months) {
    if (m < start || m > end) { out[m] = null; continue; }
    const rs = rows.filter((e) => monthOf(e.date) === m);
    const adds = sum(rs.filter((e) => ["disbursement", "charges", "other_add"].includes(e.kind)).map((e) => e.credit));
    const interest = sum(rs.filter((e) => e.kind === "interest").map((e) => e.credit));
    const installment = sum(rs.filter((e) => ["emi", "interest_paid", "other_deduct"].includes(e.kind)).map((e) => e.debit));
    const prepay = sum(rs.filter((e) => e.kind === "prepayment").map((e) => e.debit));
    out[m] = { open: r2(run), adds, interest, installment, prepay, close: r2(run + adds + interest - installment - prepay) };
    run = out[m].close;
  }
  return { table: out, rows, opening: r2(open) };
}

function remarkFor(s, b, prevDiff) {
  const out = [];
  if (s.none && !b.installment && !b.interest) return "No instalment is due in this month.";
  if (!s.none && s.installment > 0 && b.installment === 0) out.push("The instalment due is not recorded in the books.");
  else if (Math.abs(s.installment - b.installment) > 1) out.push(`Instalment in the books differs from the schedule by Rs ${r2(s.installment - b.installment)}.`);
  if (s.interest > 0 && b.interest === 0 && !(b.installment && Math.abs(b.installment - s.principal) <= 1)) out.push("Interest for the month is not provided in the books.");
  else if (b.interest === 0 && b.installment && Math.abs(b.installment - s.principal) <= 1 && s.interest > 0) out.push("The books show the principal part only; interest appears to be booked in a separate interest account.");
  else if (Math.abs(s.interest - b.interest) > 1) out.push(`Interest in the books differs from the schedule by Rs ${r2(s.interest - b.interest)}.`);
  if (b.prepay) out.push(`Prepayment of Rs ${b.prepay} in the books is not in the schedule.`);
  if (b.adds) out.push(`Addition of Rs ${b.adds} in the books (disbursement or charges).`);
  if (prevDiff && Math.abs(s.open - b.open) > 1) out.push("The opening balance differs: carried from an earlier month.");
  if (Math.abs(s.close - b.close) > 1 && !out.length) out.push(`Closing balance differs by Rs ${r2(s.close - b.close)}.`);
  return out.join(" ");
}

export function buildLoanWorking({ fy, client, loans }) {
  const months = monthsOfFy(fy);
  const fyEnd = fyTo(fy), next12 = addMonthsIso(fyEnd, 12);
  const warnings = [];
  const out = loans.map((loan) => {
    const w = [...(loan.warnings || [])];
    const label = `${loan.bank_name} - ${loan.account_number}`;
    const sched = loan.schedule?.rows || [];
    if (!sched.length) w.push("The repayment schedule could not be read, so the schedule side is blank.");
    if (!loan.ledger) w.push("The loan ledger has not been uploaded yet, so the books side is blank.");
    const ledgerRows = (loan.ledger?.entries || []).map((e) => ({ ...e, ...classifyLoanEntry(e) }));
    const books = loan.ledger ? bookMonths(ledgerRows, loan.ledger.opening, months, fy, w) : { table: {}, rows: [], opening: 0 };
    const sTable = sched.length ? scheduleMonths(sched, months) : {};

    let prevDiff = false;
    const table = months.map((m) => {
      const s = sTable[m] || null, b = books.table[m] || null;
      const d = s && b ? { open: r2(s.open - b.open), interest: r2(s.interest - b.interest), installment: r2(s.installment - b.installment), close: r2(s.close - b.close) } : null;
      const remark = d ? (Object.values(d).some((v) => v !== 0) ? remarkFor(s, b, prevDiff) : "") : !s ? (sched.length ? "Outside the schedule" : "") : !b ? "No ledger entries compared" : "";
      if (d) prevDiff = d.close !== 0;
      return { month: m, label: monthLabel(m), sched: s, book: b, diff: d, remark };
    });

    const paid = sched.filter((r) => r.installment > 0 && r.date <= fyEnd);
    const pending = sched.filter((r) => r.installment > 0 && r.date > fyEnd);
    const within = pending.filter((r) => r.date <= next12), beyond = pending.filter((r) => r.date > next12);
    const upTo = sched.filter((r) => r.date <= fyEnd);
    const schedClose = sched.length ? (upTo.length ? upTo[upTo.length - 1].closing : sched[0].opening || loan.details.sanctioned_amount || 0) : null;
    const lastBookMonth = [...months].reverse().find((m) => books.table[m]);
    const bookClose = lastBookMonth ? books.table[lastBookMonth].close : null;
    const basis = bookClose != null ? bookClose : schedClose;
    const dueSoon = sum(within.map((r) => r.principal));
    const short = basis == null ? null : r2(Math.min(Math.max(basis, 0), dueSoon));
    const instalments = sched.filter((r) => r.installment > 0);
    // the books and the schedule are compared at the same date: the last month the ledger covers
    const schedAtBook = lastBookMonth && sTable[lastBookMonth] ? sTable[lastBookMonth].close : null;
    const summary = {
      closingBooks: bookClose, closingSchedule: schedClose, closingDiff: bookClose != null && schedAtBook != null ? r2(schedAtBook - bookClose) : null,
      comparedTo: lastBookMonth && lastBookMonth !== months[11] ? monthLabel(lastBookMonth) : "",
      total: instalments.length, paid: paid.length, pending: pending.length,
      pendingPrincipal: sum(pending.map((r) => r.principal)), pendingInterest: sum(pending.map((r) => r.interest)), pendingTotal: sum(pending.map((r) => r.installment)),
      nextCount: within.length, nextPrincipal: dueSoon, nextInterest: sum(within.map((r) => r.interest)),
      laterCount: beyond.length, laterPrincipal: sum(beyond.map((r) => r.principal)),
      short, long: basis == null ? null : r2(Math.max(0, basis) - short), basis: bookClose != null ? "closing balance as per the books" : "closing balance as per the lender's schedule",
      firstDate: instalments[0]?.date || "", lastDate: instalments[instalments.length - 1]?.date || "", emi: instalments.length ? instalments[Math.floor(instalments.length / 2)].installment : null,
    };

    const points = [];
    if (summary.closingDiff) points.push(`The closing balance as per the books${summary.comparedTo ? ` at ${summary.comparedTo}` : ""} differs from the lender's schedule by Rs ${summary.closingDiff}. Get the lender's loan statement or a balance confirmation.`);
    if (summary.comparedTo) points.push(`The ledger covers the months up to ${summary.comparedTo} only, so the closing balance as per the books is not the year-end balance. Upload the full-year ledger.`);
    const missed = table.filter((r) => r.diff && /not recorded in the books/.test(r.remark)).map((r) => r.label);
    if (missed.length) points.push(`The instalment due is not recorded in the books for: ${missed.join(", ")}.`);
    const noInt = table.filter((r) => r.diff && /Interest for the month is not provided/.test(r.remark)).map((r) => r.label);
    if (noInt.length) points.push(`Interest is not provided in the books for: ${noInt.join(", ")}. Check the provision for interest expense.`);
    if (summary.short) points.push(`Rs ${summary.short} falls due within 12 months of the year end. Show it as the current maturity of long-term borrowings (short-term borrowings) and the rest as long-term borrowings.`);
    if (!loan.details.security) points.push("Security / mortgage details are not available. Confirm them from the sanction letter and the charge records (ROC / CERSAI).");
    if (!loan.details.guarantee) points.push("Guarantee details are not available. Confirm whether any director, partner or third party has given a personal or corporate guarantee.");
    if (!loan.details.interest_rate) points.push("The rate of interest is not available. Enter it from the sanction letter.");
    if (loan.ledger && !books.rows.some((e) => ["interest", "interest_paid"].includes(e.kind))) points.push("No interest entry was found in the loan ledger. Interest may be booked in a separate interest expense account: check that it agrees to the schedule.");

    return { id: loan.id, label, bank_name: loan.bank_name, account_number: loan.account_number, details: loan.details, files: loan.files || [], schedule: sched, ledger: ledgerRows, ledgerOpening: loan.ledger ? books.opening : null, months: table, summary, points, warnings: w };
  });
  for (const l of out) for (const x of l.warnings) warnings.push(`${l.label}: ${x}`);
  const have = (k) => out.map((l) => l.summary[k]).filter((v) => v != null);
  const totals = {
    closingBooks: sum(have("closingBooks")), closingSchedule: sum(have("closingSchedule")), short: sum(have("short")), long: sum(have("long")),
    pending: sum(out.map((l) => l.summary.pending)), pendingTotal: sum(out.map((l) => l.summary.pendingTotal)),
  };
  return { fy, client, loans: out, totals, warnings };
}
