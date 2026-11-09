import { TYPE_LABEL } from "./verify3b.js";

/**
 * Turns the findings of the ledger check into plain sentences: what went wrong, in the words a bookkeeper would use,
 * and what to do about it. The "ledger" is the books; the "working" is what the invoices say.
 */

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const inr = (v) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const near = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= 1;
const zero = (v) => Math.abs(Number(v) || 0) <= 1;
const HEAD = { igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess" };
const TAX_FIELDS = ["igst", "cgst", "sgst", "cess"];

export const CATS = {
  entry_missing: { label: "Entry missing in the ledger", kind: "Omission" },
  invoice_missing: { label: "Invoice missing in the working (not uploaded)", kind: "Omission" },
  not_sent: { label: "Invoice uploaded but not sent by the client", kind: "Omission" },
  wrong_type: { label: "Wrong document type (invoice / credit note / debit note)", kind: "Commission" },
  wrong_amount: { label: "Wrong amount (taxable value or invoice value)", kind: "Commission" },
  wrong_tax: { label: "Wrong tax amount", kind: "Commission" },
  wrong_head: { label: "Amount entered under the wrong tax head (CGST / SGST / IGST)", kind: "Commission" },
  transposition: { label: "Digits transposed", kind: "Commission" },
  decimal: { label: "Decimal point / zero slip", kind: "Commission" },
  gstin: { label: "Supplier GSTIN differs between invoice and books", kind: "Commission" },
  other_charges: { label: "Invoice value differs but taxes agree (other charges / round-off)", kind: "Commission" },
  date: { label: "Date differs between invoice and books", kind: "Timing" },
  rounding: { label: "Rounding difference (up to ₹1)", kind: "Rounding" },
  setup: { label: "Ledger or documents not provided", kind: "Set-up" },
};
export const CAT_ORDER = Object.keys(CATS);

const digitsOf = (n) => String(Math.round(Math.abs(Number(n) || 0) * 100)).split("").sort().join("");
const pow10 = (a, b) => {
  if (!a || !b) return false;
  const r = Math.abs(a / b);
  return [10, 100, 1000, 0.1, 0.01, 0.001].some((p) => Math.abs(r - p) < 1e-6);
};
const fmtDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d || "");
};
const statusOf = (f) => (f.dismissed ? `Accepted${f.dismissed_reason ? `: ${f.dismissed_reason}` : ""}` : "Open");
const docName = (f) => (f.doc_ref ? `${f.doc_type ? TYPE_LABEL[f.doc_type] + " " : ""}${f.doc_ref}` : f.field_label || "");

// The same standard advice for any amount that is wrong on one side: the paper invoice decides.
const checkInvoice = (ledgerText, workingText) =>
  `Look at the paper invoice. If it shows ${workingText}, correct the books. If it shows ${ledgerText}, ask the client to correct the invoice and send it again.`;

/** Which characters of two GSTINs differ, in words. */
export function gstinReason(books, invoice, who = "the invoice") {
  const a = String(books || "").toUpperCase().trim(), b = String(invoice || "").toUpperCase().trim();
  if (!a) return { reason: `The books have no GSTIN for this supplier. ${who[0].toUpperCase() + who.slice(1)} shows ${b}.`, action: `Add the GSTIN ${b} to the supplier in the books, after checking it on the paper invoice.` };
  if (!b) return { reason: `${who[0].toUpperCase() + who.slice(1)} has no GSTIN. The books show ${a}.`, action: "Read the GSTIN off the paper invoice and have the client add it to the invoice, or correct the books if the GSTIN there is wrong." };
  const act = "Read the GSTIN on the paper invoice. If it matches the invoice working, correct the supplier GSTIN in the books; if it matches the books, ask the client to correct the invoice and send it again. A wrong GSTIN keeps the invoice out of GSTR-2B and can cost the client the ITC.";
  if (a.length === b.length) {
    const at = [...a].map((c, i) => (c === b[i] ? null : i + 1)).filter(Boolean);
    if (at.length && at.length <= 2) {
      return { reason: `GSTIN typed wrongly in the books: ${who} has ${b} but the books have ${a} (${at.length === 1 ? "one character differs, at position " + at[0] : "two characters differ, at positions " + at.join(" and ")}).`, action: act };
    }
    if (a.slice(0, 2) !== b.slice(0, 2) && a.slice(2) === b.slice(2)) {
      return { reason: `The state code of the GSTIN is different: ${who} has ${b.slice(0, 2)} (${b}) but the books have ${a.slice(0, 2)} (${a}).`, action: act };
    }
    if (a.slice(2, 12) !== b.slice(2, 12)) {
      return { reason: `The books and the invoice carry the GSTIN of two different taxpayers (the PAN part differs): ${who} ${b}, books ${a}. The purchase may have been booked in the wrong supplier's account.`, action: "Check which supplier issued the invoice. If the books have the wrong supplier, move the entry to the right supplier's account." };
    }
  }
  return { reason: `The GSTIN on ${who} is ${b} but the books have ${a}.`, action: act };
}

/** Same date typed differently: swapped day and month, a small slip, or a different month. */
function dateReason(books, invoice) {
  const a = String(books || ""), b = String(invoice || "");
  const ma = /^(\d{4})-(\d{2})-(\d{2})/.exec(a), mb = /^(\d{4})-(\d{2})-(\d{2})/.exec(b);
  const base = `The invoice is dated ${fmtDate(b)} but the books show ${fmtDate(a)}.`;
  const act = "Check the date on the paper invoice and correct the wrong side. The month the ITC can be claimed in depends on the invoice date.";
  if (ma && mb) {
    if (ma[1] === mb[1] && ma[2] === mb[3] && ma[3] === mb[2]) return { reason: `${base} The day and the month look swapped.`, action: act };
    if (ma[1] === mb[1] && ma[2] === mb[2]) return { reason: `${base} Only the day is different, so the books are in the right month.`, action: "Correct the date in the books. The return month is not affected." };
    return { reason: `${base} The books have it in a different month, so the ITC would fall in a different return.`, action: act };
  }
  return { reason: base, action: act };
}

const sumTax = (d) => (d.igst || 0) + (d.cgst || 0) + (d.sgst || 0);
const taxText = (d) => {
  const parts = ["igst", "cgst", "sgst"].filter((k) => (d[k] || 0) > 1).map((k) => `${HEAD[k]} ${inr(d[k])}`);
  return parts.length ? parts.join(" + ") : "no tax";
};

/** A tax amount sitting under the wrong head, found by looking at all the heads of one document together. */
function headPattern(fs) {
  const L = fs[0].ledger_doc, W = fs[0].working_doc;
  if (!L || !W) return null;
  const act = "Same tax, wrong head. Intra-state purchases carry CGST + SGST; inter-state purchases carry IGST. Look at the supplier's state on the paper invoice and correct whichever side has the wrong head. The wrong head puts the credit in the wrong ITC ledger.";
  const say = (reason) => ({ reason, action: act, ledger: taxText(L), working: taxText(W), amount: r2(Math.max(sumTax(L), sumTax(W))) });
  if (L.igst > 1 && zero(W.igst) && near(L.igst, W.cgst + W.sgst) && zero(L.cgst) && zero(L.sgst)) {
    return say(`The invoice charges CGST and SGST (${taxText(W)}) but the books have recorded it as IGST (${taxText(L)}).`);
  }
  if (W.igst > 1 && zero(L.igst) && near(W.igst, L.cgst + L.sgst) && zero(W.cgst) && zero(W.sgst)) {
    return say(`The invoice charges IGST (${taxText(W)}) but the books have recorded it as CGST and SGST (${taxText(L)}).`);
  }
  if (!near(L.cgst, W.cgst) && !near(L.sgst, W.sgst) && near(L.cgst, W.sgst) && near(L.sgst, W.cgst)) {
    return say(`CGST and SGST are interchanged: the invoice has CGST ${inr(W.cgst)} and SGST ${inr(W.sgst)}, the books have CGST ${inr(L.cgst)} and SGST ${inr(L.sgst)}.`);
  }
  for (const x of ["cgst", "sgst", "igst"]) {
    for (const y of ["cgst", "sgst", "igst"]) {
      if (x !== y && zero(L[y]) && W[y] > 1 && near(L[x], W[x] + W[y])) {
        return say(`The ${HEAD[y]} amount (${inr(W[y])}) has been entered under ${HEAD[x]} in the books. ${HEAD[x]} shows ${inr(L[x])} there against ${inr(W[x])} on the invoice, and ${HEAD[y]} shows nothing.`);
      }
    }
  }
  return null;
}

/** One finding that is a wrong amount, explained by comparing the two figures and the rest of the document. */
function amountRow(f) {
  const lv = f.ledger_num, dv = f.document_num, L = f.ledger_doc, W = f.working_doc;
  const label = f.field_label;
  const gap = r2(Math.abs(lv - dv));
  const dir = lv > dv ? "higher" : "lower";
  const books = inr(lv), inv = inr(dv);
  const std = checkInvoice(books, inv);

  if (TAX_FIELDS.includes(f.field)) {
    if (zero(lv) && dv > 1) return { cat: "wrong_tax", reason: `${label} of ${inv} is on the invoice but has not been entered in the books.`, action: `Add ${label} ${inv} to this entry in the books, after checking it on the paper invoice.` };
    if (zero(dv) && lv > 1) return { cat: "wrong_tax", reason: `The books show ${label} of ${books} but the invoice has no ${label}.`, action: `Check the invoice. If there is really no ${label}, remove it from the books; if there is, ask the client to correct the invoice and send it again.` };
    if (digitsOf(lv) === digitsOf(dv)) return { cat: "transposition", reason: `${label} digits look swapped: ${books} in the books, ${inv} on the invoice.`, action: std };
    if (pow10(lv, dv)) return { cat: "decimal", reason: `${label} has a decimal point or zero slip: ${books} in the books, ${inv} on the invoice.`, action: std };
    return { cat: "wrong_tax", reason: `${label} is ${books} in the books but ${inv} on the invoice (the books are ${inr(gap)} ${dir}).`, action: std };
  }

  if (f.field === "total" && L && W && ["taxable", "igst", "cgst", "sgst", "cess"].every((k) => near(L[k], W[k]))) {
    return { cat: "other_charges", reason: `Taxable value and taxes agree, but the invoice value is ${books} in the books and ${inv} on the invoice (${inr(gap)} ${dir} in the books). Freight, packing, TCS or a round-off has been left out on one side or the other.`, action: `Look at the paper invoice for a charge of about ${inr(gap)} (freight, packing, TCS, round-off) and post it in the books, or ask the client to correct the invoice if it was misread.` };
  }
  if (f.field === "taxable" && W && W.total && near(lv, W.total) && !near(W.total, W.taxable)) {
    return { cat: "wrong_amount", reason: `The invoice total ${inr(W.total)} (including tax) has been entered as the taxable value in the books (${books}). The taxable value on the invoice is ${inv}.`, action: `Correct the taxable value in the books to ${inv}; the tax is entered separately.` };
  }
  if (f.field === "total" && W && near(lv, W.taxable) && !near(W.total, W.taxable)) {
    return { cat: "wrong_amount", reason: `The books carry only the taxable value (${books}) as the invoice value. The invoice value with tax is ${inv}, so the tax has been left out.`, action: `Correct the invoice value in the books to ${inv}.` };
  }
  if (digitsOf(lv) === digitsOf(dv)) return { cat: "transposition", reason: `The digits look swapped in ${label}: ${books} in the books, ${inv} on the invoice.`, action: std };
  if (pow10(lv, dv)) return { cat: "decimal", reason: `${label} is ${books} in the books and ${inv} on the invoice. The two differ by a factor of ten or more, which points to a misplaced decimal point or an extra zero.`, action: std };
  return { cat: f.field === "taxable" || f.field === "total" ? "wrong_amount" : "wrong_tax", reason: `${label} is ${books} in the books but ${inv} on the invoice (the books are ${inr(gap)} ${dir}).`, action: std };
}

function singleRow(f) {
  const base = { document: docName(f), party: f.party || "", status: statusOf(f), item: f.field_label || "" };
  switch (f.kind) {
    case "value_mismatch": {
      if (f.field === "gstin") {
        const g = gstinReason(f.ledger_value, f.document_value);
        return { ...base, cat: "gstin", ...g, ledger: f.ledger_value, working: f.document_value, diff: "" };
      }
      if (f.field === "date") {
        const d = dateReason(f.ledger_value, f.document_value);
        return { ...base, cat: "date", ...d, ledger: fmtDate(f.ledger_value), working: fmtDate(f.document_value), diff: "" };
      }
      const a = amountRow(f);
      return { ...base, ...a, ledger: f.ledger_num, working: f.document_num, diff: r2(f.ledger_num - f.document_num) };
    }
    case "not_in_ledger": {
      const t = f.working_doc ? f.working_doc.total : 0;
      return { ...base, item: "Whole entry", cat: "entry_missing", ledger: "No entry", working: f.working_doc ? `${inr(t)}${f.working_doc.date ? `, dated ${fmtDate(f.working_doc.date)}` : ""}` : f.document_value, diff: -t,
        reason: `The invoice (${inr(t)}) has been uploaded and sent, but it has not been booked: there is no entry for it in the ledger.`,
        action: "Book the invoice in the purchase ledger (expense or purchase, input GST, supplier). If it was booked in another month, or is not the client's bill, ask the client to delete the upload. The ITC must be claimed once only." };
    }
    case "missing_document": {
      const t = f.ledger_doc ? f.ledger_doc.total : 0;
      const sentLater = f.document_value === "uploaded, not sent";
      return { ...base, item: "Whole entry", cat: sentLater ? "not_sent" : "invoice_missing", ledger: `${inr(t)}${f.ledger_doc?.date ? `, dated ${fmtDate(f.ledger_doc.date)}` : ""}`, working: sentLater ? "Uploaded, not sent to the CA" : "No invoice", diff: t,
        reason: sentLater ? `The books have this purchase (${inr(t)}) and the client has uploaded the invoice, but has not checked it and sent it to the CA.` : `The books have this purchase (${inr(t)}) but there is no invoice for it in the working. The client has not uploaded it.`,
        action: sentLater ? "Ask the client to open the uploaded invoice, check the details and press \"Verify & send to CA staff\"." : "Ask the client to upload the supplier's tax invoice and send it. ITC cannot be claimed without a valid tax invoice, so hold the ITC on this entry until it is received." };
    }
    case "type_mismatch":
      return { ...base, item: "Document type", cat: "wrong_type", ledger: f.ledger_value, working: f.document_value, diff: "",
        reason: `The books have this as a ${String(f.ledger_value).toLowerCase()} but the client uploaded it as a ${String(f.document_value).toLowerCase()}.`,
        action: "Check the paper document. If the books are wrong, correct the entry; if the upload is wrong, ask the client to upload it again under the right type. A credit note reduces the ITC, an invoice adds to it." };
    case "missing_ledger":
      return { ...base, item: "Ledger", cat: "setup", ledger: "Not uploaded", working: "", diff: "", reason: "No purchase ledger has been uploaded for this month, so nothing can be compared.", action: "Ask the client to upload the purchase ledger (GSTR-3B > Other documents), then run the check again." };
    case "missing_all":
      return { ...base, cat: "setup", ledger: f.ledger_value, working: f.document_value, diff: "", reason: f.message, action: "Ask the client to upload and send these documents, then run the check again." };
    case "unsent":
      return { ...base, item: "Unsent documents", cat: "setup", ledger: "", working: f.document_value, diff: "", reason: f.message, action: "Ask the client to open the uploaded documents, check them and send them to the CA." };
    default:
      return { ...base, cat: "setup", ledger: f.ledger_value || "", working: f.document_value || "", diff: "", reason: f.message || "", action: "Review with the client." };
  }
}

function roundingRow(x) {
  const gap = r2(Math.abs(x.ledger_num - x.document_num));
  return {
    cat: "rounding", document: `${TYPE_LABEL[x.doc_type]} ${x.doc_ref}`, party: x.party || "", item: x.field_label, status: "No action needed",
    ledger: x.ledger_num, working: x.document_num, diff: r2(x.ledger_num - x.document_num),
    reason: `${x.field_label} is ${inr(x.ledger_num)} in the books and ${inr(x.document_num)} on the invoice. The ${inr(gap)} gap is paise rounding.`,
    action: "Nothing to correct for GSTR-3B. If the books should tie to the paisa, post the difference to the round-off account.",
  };
}

/** All rows of the Differences sheet, one per problem, in the order they should be worked through. */
export function buildRows(findings, rounding = []) {
  const rows = [];
  const merged = new Set();

  // tax heads of one document are read together, so "CGST entered as SGST" is one row, not three
  const groups = new Map();
  for (const f of findings) {
    if (f.kind !== "value_mismatch" || !["igst", "cgst", "sgst"].includes(f.field)) continue;
    const k = `${f.doc_type}|${f.doc_ref}|${f.invoice_id || ""}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(f);
  }
  for (const fs of groups.values()) {
    const p = headPattern(fs);
    if (!p) continue;
    for (const f of fs) merged.add(f);
    const open = fs.some((f) => !f.dismissed);
    rows.push({
      cat: "wrong_head", document: docName(fs[0]), party: fs[0].party || "", item: "Tax head", ledger: p.ledger, working: p.working, diff: "", amount: p.amount,
      reason: p.reason, action: p.action, status: open ? "Open" : statusOf(fs[0]),
    });
  }

  // an invoice-value difference that is just the sum of the other differences on the same document is a knock-on, not a separate error
  const byDoc = new Map();
  for (const f of findings) {
    if (f.kind !== "value_mismatch" || merged.has(f)) continue;
    const k = `${f.doc_type}|${f.doc_ref}|${f.invoice_id || ""}`;
    (byDoc.get(k) || byDoc.set(k, []).get(k)).push(f);
  }
  const note = new Map();
  for (const fs of byDoc.values()) {
    const total = fs.find((f) => f.field === "total");
    const parts = fs.filter((f) => ["taxable", "igst", "cgst", "sgst", "cess"].includes(f.field));
    if (!total || !parts.length) continue;
    const gap = parts.reduce((a, f) => a + (f.ledger_num - f.document_num), 0);
    if (Math.abs(gap - (total.ledger_num - total.document_num)) > 1) continue;
    merged.add(total);
    const d = r2(total.ledger_num - total.document_num);
    note.set(parts[0], ` As a result the invoice value is also ${inr(Math.abs(d))} ${d < 0 ? "lower" : "higher"} in the books (${inr(total.ledger_num)} against ${inr(total.document_num)}).`);
  }

  for (const f of findings) {
    if (merged.has(f)) continue;
    const row = singleRow(f);
    if (note.has(f)) row.reason += note.get(f);
    rows.push(row);
  }
  for (const x of rounding) rows.push(roundingRow(x));
  rows.sort((a, b) => CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat));
  return rows;
}
