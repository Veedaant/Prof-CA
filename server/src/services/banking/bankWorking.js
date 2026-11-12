import { r2, monthsOfFy, monthOf, monthEnd, fyFrom, fyTo, accountKey, daysBetween, monthLabel } from "./common.js";
import { buildParties, nameScore, tokensOf } from "./parties.js";
import { describeEntry } from "./remarks.js";

/**
 * The bank working for one account and one financial year: the statement and the books ledger with a remark on every entry,
 * the entries matched between the two, and the month by month reconciliation.
 */

const sum = (list) => r2(list.reduce((a, b) => a + b, 0));
const digitsIn = (s) => new Set((String(s || "").match(/\d{5,}/g) || []).map((d) => d.replace(/^0+/, "")).filter((d) => d.length >= 5));
const monthStart = (m) => `${m}-01`;

/** The balance at the start of the financial year (or of the data), and the rows inside the year. */
function withinYear(opening, rows, fy, net) {
  const from = fyFrom(fy), to = fyTo(fy);
  let open = opening ?? 0;
  for (const r of rows) if (r.date < from) open += net(r);
  return { opening: r2(open), rows: rows.filter((r) => r.date >= from && r.date <= to), before: rows.filter((r) => r.date < from).length, after: rows.filter((r) => r.date > to).length };
}

function mergeStatements(files, warnings) {
  const usable = files.filter((f) => f.parsed?.txns?.length).sort((a, b) => (a.parsed.from < b.parsed.from ? -1 : a.parsed.from > b.parsed.from ? 1 : 0));
  const seen = new Map();
  const txns = [];
  let dup = 0;
  for (const f of usable) {
    for (const t of f.parsed.txns) {
      const key = [t.date, t.narration, t.debit, t.credit, t.balance].join("|");
      if (seen.has(key) && seen.get(key) !== f.name) { dup++; continue; }
      seen.set(key, f.name);
      txns.push({ ...t, file: f.name });
    }
  }
  if (dup) warnings.push(`${dup} identical line(s) appear in more than one statement file (overlapping periods); they were counted once.`);
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1].parsed, b = usable[i].parsed;
    if (a.closing != null && b.opening != null && a.to < b.from && Math.abs(a.closing - b.opening) > 1) warnings.push(`${usable[i - 1].name} closes at Rs ${a.closing} but ${usable[i].name} opens at Rs ${b.opening}. A statement may be missing between them.`);
  }
  txns.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.seq - y.seq));
  return { txns, opening: usable[0]?.parsed.opening ?? 0, from: txns[0]?.date, to: txns[txns.length - 1]?.date };
}

/** Pairs each statement line with the books entry for the same amount and direction: by cheque / reference number first, then the nearest date. */
function matchEntries(stmt, book) {
  const sMatch = new Array(stmt.length).fill(-1), bMatch = new Array(book.length).fill(-1);
  const byKey = new Map();
  book.forEach((e, j) => { const k = `${e.debit ? "R" : "P"}|${(e.debit || e.credit).toFixed(2)}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(j); });
  const keyOf = (t) => `${t.credit ? "R" : "P"}|${(t.credit || t.debit).toFixed(2)}`;
  const bRefs = book.map((e) => digitsIn(`${e.vchNo} ${e.narration} ${e.party}`));
  const sRefs = stmt.map((t) => digitsIn(`${t.ref} ${t.narration}`));
  const gap = (i, j) => Math.abs(daysBetween(stmt[i].date, book[j].date));
  for (const pass of [1, 2]) {
    stmt.forEach((t, i) => {
      if (sMatch[i] >= 0) return;
      let best = -1, bestGap = pass === 1 ? 120 : 90, bestName = -1;
      for (const j of byKey.get(keyOf(t)) || []) {
        if (bMatch[j] >= 0) continue;
        if (pass === 1 && ![...sRefs[i]].some((d) => bRefs[j].has(d))) continue;
        const g = gap(i, j);
        const nm = nameScore({ tokens: tokensOf(book[j].party) }, tokensOf(t.narration));
        if (g < bestGap || (g === bestGap && nm > bestName)) { best = j; bestGap = g; bestName = nm; }
      }
      if (best >= 0) { sMatch[i] = best; bMatch[best] = i; }
    });
  }
  return { sMatch, bMatch };
}

function monthTable(rows, rec, pay, opening, months, covered) {
  const out = {};
  let run = opening;
  for (const m of months) {
    if (!covered.has(m)) { out[m] = null; continue; }
    const rs = rows.filter((r) => monthOf(r.date) === m);
    const r = sum(rs.map(rec)), p = sum(rs.map(pay));
    out[m] = { open: r2(run), rec: r, pay: p, close: r2(run + r - p) };
    run = out[m].close;
  }
  return out;
}

const range = (months, from, to) => months.filter((m) => m >= from && m <= to);

export function buildBankWorking({ fy, client, account, statements, coverage = [], ledger = null, invoices = [], tax26as = null, tis = null, ownAccounts = [], loans = [] }) {
  const warnings = [];
  const months = monthsOfFy(fy);
  const fyFirst = months[0];

  // --- the statement
  for (const f of statements) for (const w of f.parsed?.warnings || []) warnings.push(`${f.name}: ${w}`);
  const merged = mergeStatements(statements, warnings);
  if (!merged.txns.length) throw new Error("No statement could be read for this account. Check the uploaded files.");
  const sw = withinYear(merged.opening, merged.txns, fy, (t) => t.credit - t.debit);
  if (sw.before) warnings.push(`${sw.before} statement line(s) before ${fy} were folded into the opening balance.`);
  if (sw.after) warnings.push(`${sw.after} statement line(s) after ${fy} were left out.`);
  const stmt = sw.rows;
  let sFrom = monthOf(stmt[0]?.date || fyFrom(fy)), sTo = monthOf(stmt[stmt.length - 1]?.date || fyFrom(fy));
  for (const c of coverage) { if (c.from && c.from < sFrom) sFrom = c.from; if (c.to && c.to > sTo) sTo = c.to; }
  if (stmt.length && stmt[0].date <= `${fyFirst}-15` || sw.before) sFrom = fyFirst;
  const stmtCovered = new Set();
  for (const f of statements) if (f.parsed?.txns?.length) for (const m of range(months, monthOf(f.parsed.from), monthOf(f.parsed.to))) stmtCovered.add(m);
  for (const c of coverage) for (const m of range(months, c.from, c.to)) stmtCovered.add(m);
  if (sFrom === fyFirst) for (const m of range(months, sFrom, monthOf(stmt[0]?.date || sFrom))) stmtCovered.add(m);
  if (sw.before) stmtCovered.add(fyFirst);

  // --- the books
  let book = [], bookOpening = 0, bookCovered = new Set();
  if (ledger) {
    for (const w of ledger.warnings || []) warnings.push(`Ledger: ${w}`);
    const bw = withinYear(ledger.opening, ledger.entries, fy, (e) => e.debit - e.credit);
    if (bw.before) warnings.push(`${bw.before} ledger entr${bw.before > 1 ? "ies" : "y"} before ${fy} were folded into the opening balance.`);
    if (bw.after) warnings.push(`${bw.after} ledger entr${bw.after > 1 ? "ies" : "y"} after ${fy} were left out.`);
    book = bw.rows;
    bookOpening = bw.opening;
    const first = book[0]?.date || fyFrom(fy), last = book[book.length - 1]?.date || first;
    const bFrom = first <= `${fyFirst}-15` || bw.before ? fyFirst : monthOf(first);
    for (const m of range(months, bFrom, monthOf(last))) bookCovered.add(m);
    if (monthOf(last) < months[11]) warnings.push(`The ledger has entries only up to ${last}. Months after that are not compared.`);
  } else warnings.push("The bank ledger has not been uploaded yet, so only the statement side is prepared.");

  // --- the documents behind the remarks
  const parties = buildParties(invoices, tax26as?.deductors || []);
  const ctx = {
    parties, taxPaid: tax26as?.taxPaid || [],
    own: ownAccounts.map((a) => ({ key: accountKey(a.account_number), label: `${a.bank_name} ${a.account_number}` })).filter((a) => a.key && a.key !== accountKey(account.account_number)),
    loans: loans.map((l) => ({ label: `${l.bank_name} loan ${l.account_number}`, installments: l.installments || [] })),
  };

  // --- match, then describe
  const { sMatch, bMatch } = ledger ? matchEntries(stmt, book) : { sMatch: stmt.map(() => -1), bMatch: [] };
  const stmtRows = stmt.map((t, i) => {
    const b = sMatch[i] >= 0 ? book[sMatch[i]] : null;
    const d = describeEntry({ dir: t.credit ? "R" : "P", text: t.narration, ledgerParty: b?.party || "", vchType: b?.vchType || "", amount: t.credit || t.debit, date: t.date, ctx });
    return { ...t, kind: t.credit ? "Receipt" : "Payment", ...d, booked: !ledger ? "Ledger not uploaded" : b ? `Yes - ${b.date}${b.vchType ? ` ${b.vchType}` : ""}${b.vchNo ? ` ${b.vchNo}` : ""}${b.party ? ` (${b.party})` : ""}` : "No - not found in the books", matched: Boolean(b) };
  });
  const bookRows = book.map((e, j) => {
    const t = bMatch[j] >= 0 ? stmt[bMatch[j]] : null;
    const d = describeEntry({ dir: e.debit ? "R" : "P", text: `${e.narration} ${t?.narration || ""}`, ledgerParty: e.party, vchType: e.vchType, amount: e.debit || e.credit, date: e.date, ctx });
    return { ...e, kind: e.debit ? "Receipt" : "Payment", ...d, inBank: t ? `Yes - ${t.date}` : "No - not in the bank statement", matched: Boolean(t) };
  });

  // --- the months
  const sTable = monthTable(stmt, (t) => t.credit, (t) => t.debit, sw.opening, months, stmtCovered);
  const bTable = ledger ? monthTable(book, (e) => e.debit, (e) => e.credit, bookOpening, months, bookCovered) : {};
  {
    let seen = false, gap = [];
    for (const m of months) {
      if (sTable[m]) { if (gap.length) warnings.push(`No bank statement for ${gap.map(monthLabel).join(", ")}, between months that have one. The balances after the gap carry on from before it.`); gap = []; seen = true; }
      else if (seen) gap.push(m);
    }
  }
  const tableRows = months.map((m) => {
    const s = sTable[m], b = bTable[m] || null;
    const both = Boolean(s && b);
    const d = both ? { open: r2(s.open - b.open), rec: r2(s.rec - b.rec), pay: r2(s.pay - b.pay), close: r2(s.close - b.close) } : null;
    const note = !s ? "No bank statement for this month" : !ledger ? "Ledger not uploaded" : !b ? "No ledger entries for this month" : "";
    return { month: m, label: monthLabel(m), stmt: s, book: b, diff: d, hasDiff: Boolean(d && d.close !== 0), note };
  });

  // a closing balance on the statement's own balance column that disagrees with the chain
  for (const r of tableRows) if (r.stmt) {
    const last = [...stmt].filter((t) => monthOf(t.date) === r.month && t.balance != null).pop();
    if (last && Math.abs(last.balance - r.stmt.close) > 1) warnings.push(`${r.label}: the statement's last balance (Rs ${last.balance}) differs from the balance worked out from its lines (Rs ${r.stmt.close}).`);
  }

  // --- the reconciliation of each month that differs
  const both = tableRows.filter((r) => r.stmt && r.book);
  const recons = [];
  if (both.length) {
    const wStart = monthStart(both[0].month);
    const openDiff = r2(both[0].book.open - both[0].stmt.open);
    for (const row of both.filter((r) => r.hasDiff)) {
      const end = monthEnd(row.month);
      const win = (d) => d >= wStart && d <= end;
      const bo = [], so = [];
      book.forEach((e, j) => { if (!win(e.date)) return; const i = bMatch[j]; if (i >= 0 && win(stmt[i].date)) return; bo.push({ e: bookRows[j], partner: i >= 0 ? stmt[i] : null }); });
      stmt.forEach((t, i) => { if (!win(t.date)) return; const j = sMatch[i]; if (j >= 0 && win(book[j].date)) return; so.push({ t: stmtRows[i], partner: j >= 0 ? book[j] : null }); });
      const items = {
        booksReceipts: bo.filter((x) => x.e.debit).map((x) => ({ date: x.e.date, text: `${x.e.party || "Receipt"}${x.e.vchType ? `, ${x.e.vchType}` : ""}${x.e.vchNo ? ` ${x.e.vchNo}` : ""}`, amount: x.e.debit, note: x.partner ? `Credited by the bank on ${x.partner.date}` : "Not found in the bank statement" })),
        booksPayments: bo.filter((x) => x.e.credit).map((x) => ({ date: x.e.date, text: `${x.e.party || "Payment"}${x.e.vchType ? `, ${x.e.vchType}` : ""}${x.e.vchNo ? ` ${x.e.vchNo}` : ""}`, amount: x.e.credit, note: x.partner ? `Debited by the bank on ${x.partner.date}` : "Not found in the bank statement" })),
        stmtReceipts: so.filter((x) => x.t.credit).map((x) => ({ date: x.t.date, text: x.t.narration.slice(0, 90), amount: x.t.credit, note: x.partner ? `Entered in the books on ${x.partner.date}` : "Not entered in the books" })),
        stmtPayments: so.filter((x) => x.t.debit).map((x) => ({ date: x.t.date, text: x.t.narration.slice(0, 90), amount: x.t.debit, note: x.partner ? `Entered in the books on ${x.partner.date}` : "Not entered in the books" })),
      };
      // same day, same direction, different amount: probably one wrongly entered
      for (const b of [...items.booksReceipts, ...items.booksPayments].filter((x) => /Not found/.test(x.note))) {
        const pool = (items.booksReceipts.includes(b) ? items.stmtReceipts : items.stmtPayments).filter((s) => /Not entered/.test(s.note) && Math.abs(daysBetween(s.date, b.date)) <= 5 && s.amount !== b.amount);
        if (pool.length === 1) { b.note += `. Possible amount error: the statement shows Rs ${pool[0].amount} on ${pool[0].date}, the books Rs ${b.amount}`; pool[0].note += `. Possible amount error: the books show Rs ${b.amount} on ${b.date}`; }
      }
      const T = (l) => sum(l.map((x) => x.amount));
      const computed = r2(row.stmt.close + T(items.booksReceipts) - T(items.booksPayments) - T(items.stmtReceipts) + T(items.stmtPayments) + openDiff);
      recons.push({ month: row.month, label: row.label, asOf: end, stmtClose: row.stmt.close, bookClose: row.book.close, openDiff, items, computed, check: r2(row.book.close - computed) });
    }
  }

  const unmatchedS = stmtRows.filter((r) => ledger && !r.matched), unmatchedB = bookRows.filter((r) => !r.matched);
  return {
    client, account, fy, warnings,
    stmt: { rows: stmtRows, opening: sw.opening, closing: sTable[months.filter((m) => sTable[m]).pop()]?.close ?? sw.opening, files: statements.map((f) => f.name) },
    book: ledger ? { rows: bookRows, opening: bookOpening, closing: bTable[months.filter((m) => bTable[m]).pop()]?.close ?? bookOpening } : null,
    months: tableRows, recons,
    summary: {
      stmtLines: stmtRows.length, bookLines: bookRows.length, matched: stmtRows.filter((r) => r.matched).length,
      stmtOnly: unmatchedS.length, booksOnly: unmatchedB.length, monthsWithDifference: tableRows.filter((r) => r.hasDiff).length,
      monthsCompared: both.length, unidentified: stmtRows.filter((r) => /not identified/.test(r.nature)).length,
    },
    tis: tis?.items || [], has26as: Boolean(tax26as), hasTis: Boolean(tis),
  };
}
