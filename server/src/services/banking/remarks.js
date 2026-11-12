import { r2, money, daysBetween, accountKey } from "./common.js";
import { docText, findParty, matchDocs, nameScore, tokensOf } from "./parties.js";

/**
 * The remark against a bank or ledger entry: what the entry is, and which party it belongs to as shown by the documents
 * available for that party (invoices in the system, 26AS, the loan schedule). Rules are listed in the order they apply.
 */

const NATURES = [
  { dir: "P", re: /\b(GST|IGST|CGST|SGST)\b[^A-Z]*\b(ON|@|CHG|CHGS|CHARGES?|FEE|SMS)\b|\b(CHG|CHGS|CHARGES?)\b.*\b(GST|IGST|CGST|SGST)\b|^(IGST|CGST|SGST)\b/i, nature: "GST on bank charges" },
  { dir: "P", re: /\b(EMI|LOAN (REPAYMENT|INSTAL+MENT|REPAY)|LOAN A\/?C|INSTAL+MENT|REPAYMENT|ECS[- ]?LOAN|NACH[- ]?LOAN)\b/i, nature: "Loan EMI / instalment" },
  { dir: "P", re: /\bINT(EREST)?\b(?!.*\b(PAID|PD|CREDIT|CR)\b)|\bINTEREST (DEBIT|CHARGED|COLL|ON)\b|\bINT\.? ?COLL\b/i, nature: "Interest debited by the bank (loan / overdraft)" },
  { dir: "R", re: /\bINT(EREST)?\b|\bINT\.? ?(PD|PAID|CR|CREDIT)\b/i, nature: "Interest credited by the bank" },
  { dir: "P", re: /\b(CHG|CHGS|CHARGES?|SMS ALERT|SERVICE CHARGE|AMC|ANNUAL (FEE|CHARGE)|MIN(IMUM)? BAL|PENAL|PROCESSING FEE|CHQ BOOK|CHEQUE BOOK|DD ISSUE|STAMP DUTY|BANK COMMISSION)\b/i, nature: "Bank charges" },
  { dir: "P", re: /\b(SALARY|SALARIES|WAGES|PAYROLL)\b/i, nature: "Salary / wages" },
  { dir: "P", re: /\b(GSTN|CBIC|CPIN)\b|\bGST (PAYMENT|PMT|CHALLAN|TAX)\b|GOODS AND SERVICES TAX/i, nature: "GST payment (challan)" },
  { dir: "P", re: /\b(INCOME ?TAX|ITD|OLTAS|CBDT|TRACES|ADVANCE TAX|SELF ASSESSMENT|TDS (PAYMENT|DEPOSIT|ON)|CHALLAN 28\d)\b/i, nature: "Income tax / TDS payment" },
  { dir: "P", re: /\b(EPFO?|PF PAYMENT|ESIC|PROFESSIONAL TAX|PROF TAX)\b/i, nature: "PF / ESIC / professional tax" },
  { dir: "R", re: /\b(CASH DEP(OSIT)?|CDM|BY CASH|CASH-DEP)\b/i, nature: "Cash deposited in the bank" },
  { dir: "P", re: /\b(CASH WDL|CASH WITHDRAWAL|ATM|SELF|CASH PAID|TO CASH|CHQ SELF)\b/i, nature: "Cash withdrawn" },
  { dir: "R", re: /\b(POS|PAYTM|RAZORPAY|PHONEPE|CASHFREE|PAYU|BILLDESK|CCAVENUE|SETTLEMENT|MERCHANT|AMAZON PAY|STRIPE)\b/i, nature: "Settlement of card / online sales" },
  { dir: "R", re: /\bDIVIDEND\b/i, nature: "Dividend received" },
  { dir: "R", re: /\b(REFUND|REVERSAL|REV)\b/i, nature: "Refund / reversal" },
  { dir: "P", re: /\b(LIC|INSURANCE|PREMIUM|MUTUAL FUND|SIP|ZERODHA|GROWW|HDFC LIFE|SBI LIFE)\b/i, nature: "Insurance / investment" },
  { dir: "P", re: /\b(ELECTRICITY|MSEDCL|BESCOM|TATA POWER|BSNL|AIRTEL|JIO|VODAFONE|TELEPHONE|BROADBAND|WATER BILL|MUNICIPAL)\b/i, nature: "Electricity / telephone / utility" },
  { dir: "P", re: /\bRENT\b/i, nature: "Rent" },
];

const MODES = [[/\bUPI\b/i, "UPI"], [/\bNEFT\b/i, "NEFT"], [/\bRTGS\b/i, "RTGS"], [/\bIMPS\b/i, "IMPS"], [/\b(CHQ|CHEQUE|CLG|CLEARING)\b/i, "Cheque"], [/\b(ECS|NACH)\b/i, "ECS / NACH"], [/\bATM\b/i, "ATM"], [/\bPOS\b/i, "Card / POS"]];
export const modeOf = (text) => MODES.find(([re]) => re.test(text))?.[1] || "";

export function natureOf(text, dir) {
  const t = String(text || "");
  const hit = NATURES.find((n) => n.dir === dir && n.re.test(t));
  return hit ? hit.nature : null;
}

const dmy = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}-${y}`; };

/** Own accounts and loans named in the narration. */
function ownAccount(text, ctx) {
  const key = accountKey(text);
  for (const a of ctx.own || []) if (a.key.length >= 6 && key.includes(a.key)) return a;
  return null;
}

function loanByAmount(amount, date, ctx) {
  for (const l of ctx.loans || []) {
    for (const i of l.installments) {
      if (Math.abs(i.amount - amount) <= 1 && Math.abs(daysBetween(i.date, date)) <= 7) return { loan: l, due: i.date };
    }
  }
  return null;
}

function tdsNote(party) {
  const rows = party?.tds || [];
  if (!rows.length) return "";
  const total = r2(rows.reduce((a, r) => a + (r.tds || 0), 0));
  const sections = [...new Set(rows.map((r) => r.section).filter(Boolean))].join(", ");
  return total ? ` 26AS shows TDS of Rs ${money(total)}${sections ? ` (section ${sections})` : ""} deducted by this party in the year.` : "";
}

/**
 * dir: "R" receipt / "P" payment. text: the narration. ledgerParty: the party named in the books for the same entry, if known.
 * Returns { party, nature, remark, support }.
 */
export function describeEntry({ dir, text, ledgerParty = "", vchType = "", amount, date, ctx }) {
  const verb = dir === "R" ? "Receipt" : "Payment";
  const joined = `${ledgerParty} ${text}`;
  const mode = modeOf(text);
  const modeTxt = mode ? ` by ${mode}` : "";

  // 1. the party: the books' own party first, then the narration
  let party = null;
  if (ledgerParty) {
    let best = 0;
    const lt = tokensOf(ledgerParty);
    for (const p of ctx.parties) { const s = Math.max(nameScore(p, lt), nameScore({ tokens: lt }, p.tokens)); if (s > best) { best = s; party = s >= 0.6 ? p : party; } }
  }
  party ||= findParty(ctx.parties, text);
  const partyName = party?.name || ledgerParty || "";

  // 2. things that are not a trade party
  const own = ownAccount(text, ctx);
  if (own) return { party: own.label, nature: dir === "R" ? "Transfer from own account" : "Transfer to own account", remark: `${verb}${modeTxt}: ${dir === "R" ? "transfer from" : "transfer to"} the client's own account ${own.label}.`, support: "Other bank account of the client uploaded under Banking" };
  const loan = dir === "P" ? loanByAmount(amount, date, ctx) : null;
  if (loan) return { party: loan.loan.label, nature: "Loan EMI / instalment", remark: `Payment${modeTxt}: instalment of ${loan.loan.label}, due ${dmy(loan.due)} as per the repayment schedule.`, support: `Repayment schedule of ${loan.loan.label}` };
  if (/contra/i.test(vchType)) return { party: partyName, nature: "Contra entry", remark: `${verb}: contra entry (transfer between bank and cash or another bank account).`, support: "Voucher type Contra in the books" };

  const nature = !party ? natureOf(joined, dir) : null;
  if (nature) {
    let support = "";
    let extra = "";
    if (/Income tax/i.test(nature)) {
      const paid = (ctx.taxPaid || []).find((t) => Math.abs(t.amount - amount) <= 1 && Math.abs(daysBetween(t.date, date)) <= 10);
      if (paid) { extra = ` ${paid.kind} of Rs ${money(paid.amount)} paid on ${dmy(paid.date)} appears in 26AS (BSR ${paid.bsr}).`; support = "Form 26AS - tax paid"; }
    }
    return { party: ledgerParty || "", nature, remark: `${verb}${modeTxt}: ${nature.toLowerCase()}.${extra}`, support };
  }

  // 3. a trade party: which of its documents does this amount settle
  if (party) {
    const side = dir === "R" ? "sales" : "purchase";
    const other = dir === "R" ? "purchase" : "sales";
    const m = matchDocs(party, side, amount, date);
    const label = side === "sales" ? "sales" : "purchase";
    const tds = tdsNote(party);
    const lead = dir === "R" ? `Receipt from ${party.name}${modeTxt}` : `Payment to ${party.name}${modeTxt}`;
    if (m) {
      const list = m.docs.map(docText).join(" and ");
      const net = m.how === "tds" ? ` after TDS of Rs ${money(m.tds)} (${(m.rate * 100).toFixed(m.rate < 0.01 ? 1 : 0)}%)` : "";
      return { party: party.name, nature: dir === "R" ? "Receipt from customer" : "Payment to supplier", remark: `${lead} against ${list}${net}.${dir === "R" ? tds : ""}`, support: m.docs.map(docText).join("; ") };
    }
    const own = party.docs.filter((d) => d.side === side);
    if (own.length) {
      const total = r2(own.reduce((a, d) => a + d.total, 0));
      return { party: party.name, nature: dir === "R" ? "Receipt from customer" : "Payment to supplier", remark: `${lead}: the amount does not agree to a single ${label} invoice. ${own.length} ${label} document(s) of this party in the system, total Rs ${money(total)}. Part payment, advance or settlement of several invoices.${dir === "R" ? tds : ""}`, support: own.slice(0, 3).map(docText).join("; ") };
    }
    const opp = party.docs.filter((d) => d.side === other);
    if (opp.length) return { party: party.name, nature: dir === "R" ? "Receipt (refund / advance?)" : "Payment (refund / advance?)", remark: `${lead}: this party has only ${other} documents in the system (${opp.length}). The entry may be a refund, advance or adjustment.`, support: opp.slice(0, 2).map(docText).join("; ") };
    return { party: party.name, nature: verb, remark: `${lead}: no invoice of this party is available in the system.${dir === "R" ? tds : ""}`, support: "" };
  }

  // 4. a party named only in the books or the narration
  if (ledgerParty) return { party: ledgerParty, nature: verb, remark: `${verb}${modeTxt} ${dir === "R" ? "from" : "to"} ${ledgerParty} as per the books. No invoice of this party is available in the system.`, support: "" };
  return { party: "", nature: `${verb} - party not identified`, remark: `${verb}${modeTxt}: the party could not be identified from the narration or from any document available.`, support: "" };
}
