import { r2, monthsOfFy, monthLabel } from "../banking/common.js";
import { latestByMonth } from "./reco.js";

/**
 * The RCM reconciliation, month by month: the reverse charge worked out on the expense ledgers, the RCM tax booked in the ITC register,
 * the RCM tax paid in GSTR-3B (Table 3.1(d)) and the ITC claimed on it (Table 4(A)(3)). GSTR-3B is the filed return where it is uploaded
 * under GST Portal, otherwise the monthly working.
 */

const TOL = 2; // rupees
const H = ["igst", "cgst", "sgst"];
const heads = (o) => (o ? { igst: o.igst || 0, cgst: o.cgst || 0, sgst: o.sgst || 0, cess: o.cess || 0 } : null);
const tot = (o) => (o ? r2((o.igst || 0) + (o.cgst || 0) + (o.sgst || 0) + (o.cess || 0)) : null);
const withTot = (o) => (o ? { ...o, tot: tot(o), taxable: o.taxable ?? null } : null);
const rs = (n) => `Rs ${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const addInto = (acc, o) => { if (!o) return acc; for (const h of [...H, "cess", "taxable", "tot"]) acc[h] = r2((acc[h] || 0) + (o[h] || 0)); return acc; };

export function buildRcmReco({ fy, rcm = { months: [], categories: [], have: false }, registerRows = [], workFiles = [], portalFiles = [] }) {
  const work = latestByMonth(workFiles.filter((f) => f.data)).byMonth;
  const filed = latestByMonth(portalFiles.filter((f) => f.data?.figures)).byMonth;
  const ledgerBy = new Map(rcm.months.map((m) => [m.month, m]));

  // RCM tax booked in the ITC register
  const booksBy = new Map();
  for (const r of registerRows.filter((x) => x.rcmFlag)) {
    const b = booksBy.get(r.month) || booksBy.set(r.month, { entries: 0, tot: 0 }).get(r.month);
    b.entries++; b.tot = r2(b.tot + (r.rcm || r.itc || 0));
  }

  const fyMonths = monthsOfFy(fy);
  const all = [...new Set([...fyMonths, ...ledgerBy.keys(), ...booksBy.keys(), ...work.keys(), ...filed.keys()])].filter((m) => m && (fyMonths.includes(m) || ledgerBy.has(m) || booksBy.has(m) || work.has(m) || filed.has(m))).sort();

  const rows = all.map((month) => {
    // a month with no entry in the ledgers has no working; one with entries and no RCM has a working of nil
    const lm = ledgerBy.get(month)?.entries > 0 ? ledgerBy.get(month) : null;
    const ledger = lm ? withTot({ taxable: lm.taxable, igst: lm.igst, cgst: lm.cgst, sgst: lm.sgst, cess: 0 }) : null;
    const ledgerItc = lm ? lm.itc : null;
    const bk = booksBy.get(month);
    const books = bk ? { entries: bk.entries, tot: bk.tot } : null;
    const f = filed.get(month), w = work.get(month);
    let paid = null, claimed = null, source = "";
    if (f) { const o = f.data.figures.outward?.d; paid = withTot({ ...heads(o), taxable: o?.taxable || 0 }); claimed = withTot(heads(f.data.figures.itc?.rcm)); source = "Filed GSTR-3B"; }
    else if (w) { const d = w.data.t31?.d; paid = d ? withTot({ ...heads(d), taxable: d.taxable || 0 }) : null; claimed = w.data.t4?.a3 ? withTot(heads(w.data.t4.a3)) : null; source = "3B working"; }

    const diffLedgerPaid = ledger && paid ? r2(ledger.tot - paid.tot) : null;
    const diffPaidItc = paid && claimed ? r2(paid.tot - claimed.tot) : null;
    const diffLedgerBooks = ledger && books ? r2(ledger.tot - books.tot) : null;
    const notes = [];
    if (diffLedgerPaid != null && Math.abs(diffLedgerPaid) > TOL) notes.push(diffLedgerPaid > 0 ? `RCM on the expense ledgers is more than the RCM paid in GSTR-3B 3.1(d) by ${rs(diffLedgerPaid)}: the tax may be short paid, or the expense is not RCM.` : `RCM paid in GSTR-3B 3.1(d) is more than the ledgers show by ${rs(diffLedgerPaid)}: RCM may have been paid on expenses outside the ledgers uploaded.`);
    if (diffPaidItc != null && Math.abs(diffPaidItc) > TOL) notes.push(diffPaidItc > 0 ? `ITC claimed on RCM (4(A)(3)) is less than the RCM paid by ${rs(diffPaidItc)}: ITC not claimed, or blocked or apportioned.` : `ITC claimed on RCM (4(A)(3)) is more than the RCM paid by ${rs(diffPaidItc)}: ITC on RCM is allowed only on the tax actually paid.`);
    if (diffLedgerBooks != null && Math.abs(diffLedgerBooks) > TOL) notes.push(`RCM tax booked in the ITC register differs from the working by ${rs(diffLedgerBooks)}.`);
    const present = [ledger, paid, claimed, books].filter(Boolean).length;
    const compared = [diffLedgerPaid, diffPaidItc, diffLedgerBooks].filter((x) => x != null).length;
    const status = !present ? "No data" : !compared ? "Nothing to compare" : notes.length ? "Differs" : "Agrees";
    return { month, label: monthLabel(month), ledger, ledgerItc, books, paid, claimed, source, diffLedgerPaid, diffPaidItc, diffLedgerBooks, status, remark: notes.join(" ") || (status === "Agrees" ? "Agrees." : "") };
  }).filter((r) => r.status !== "No data" || fyMonths.includes(r.month));

  const totals = { ledger: {}, ledgerItc: 0, books: 0, paid: {}, claimed: {} };
  for (const r of rows) {
    addInto(totals.ledger, r.ledger); addInto(totals.paid, r.paid); addInto(totals.claimed, r.claimed);
    totals.ledgerItc = r2(totals.ledgerItc + (r.ledgerItc || 0)); totals.books = r2(totals.books + (r.books?.tot || 0));
  }
  const summary = { months: rows.filter((r) => r.status !== "No data" && r.status !== "Nothing to compare").length, differing: rows.filter((r) => r.status === "Differs").length, hasLedger: rcm.have, filedMonths: rows.filter((r) => r.source === "Filed GSTR-3B").length, workingMonths: rows.filter((r) => r.source === "3B working").length };
  return { rows, totals, summary, categories: rcm.categories };
}
