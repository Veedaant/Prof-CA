import { createHash } from "node:crypto";
import { db } from "../../db/index.js";
import { normInv, normGstin, normName } from "./sheetParser.js";

const TOL = 1;
const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;

export const TYPE_OF = { purchase: "inv", credit_note: "cn", debit_note: "dn" };
export const TYPE_LABEL = { inv: "Purchase invoice", cn: "Credit note", dn: "Debit note" };
const TYPE_PLURAL = { inv: "purchase invoices", cn: "credit notes", dn: "debit notes" };
export const FIELD_LABEL = { taxable: "Taxable value", igst: "IGST", cgst: "CGST", sgst: "SGST", cess: "Cess", total: "Invoice value", date: "Date", gstin: "Supplier GSTIN" };
const MONEY = ["taxable", "igst", "cgst", "sgst", "cess", "total"];
const inr = (v) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const partyKey = (gstin, name) => normGstin(gstin) || `N:${normName(name)}`;
// a total line, or a row with no document number and no party details, is not a document
const isTotalRow = (r) => !normInv(r.inv_no) && !normGstin(r.gstin) && /total/i.test(String(r.party || ""));
// A ledger uploaded for this period counts in full, whatever the dates of its entries (bills are often dated in earlier months
// than the return they are claimed in). A ledger uploaded without a period is read by entry date.
const inPeriod = (r, f, period) => !isTotalRow(r) && (f.tax_period === period || (r.date && String(r.date).slice(0, 7) === period));

/** The party on the other side of a purchase-side document (supplier, unless the client is the supplier). */
function counterparty(inv, clientGstin) {
  const mine = normGstin(clientGstin);
  const sup = normGstin(inv.supplier_gstin), buy = normGstin(inv.buyer_gstin);
  if (mine && sup === mine && buy !== mine) return { gstin: buy, name: inv.buyer_name || "" };
  return { gstin: sup, name: inv.supplier_name || "" };
}

function ledgerDocs(files, include) {
  // each file is totalled on its own; if the same document is in two files the newest file wins, so re-uploading a ledger never doubles it
  const merged = new Map();
  let entries = 0;
  for (const f of files) {
    const docs = new Map();
    for (const r of f.data?.rows || []) {
      if (!include(r, f)) continue;
      entries++;
      const type = r.type === "cn" ? "cn" : r.type === "dn" ? "dn" : "inv";
      const key = `${normInv(r.inv_no)}|${type}|${partyKey(r.gstin, r.party)}`;
      let d = docs.get(key);
      if (!d) { d = { key, type, inv_no: r.inv_no || "", gstin: normGstin(r.gstin), party: r.party || "", date: r.date || null, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, value: 0, file: f.original_filename }; docs.set(key, d); }
      for (const m of ["taxable", "igst", "cgst", "sgst", "cess"]) d[m] += num(r[m]);
      d.value = Math.max(d.value, num(r.value));
    }
    for (const [k, d] of docs) merged.set(k, d);
  }
  for (const d of merged.values()) {
    for (const m of ["taxable", "igst", "cgst", "sgst", "cess"]) d[m] = r2(d[m]);
    d.total = d.value || r2(d.taxable + d.igst + d.cgst + d.sgst + d.cess);
  }
  return { docs: [...merged.values()], entries };
}

export async function verify3b(firmId, client, period) {
  const files = await db.query(
    "select id, tax_period, original_filename, row_count, data, created_at from recon_files where firm_id=$1 and client_id=$2 and kind='purchase_ledger' order by created_at",
    [firmId, client.id],
  );
  const invoices = await db.query(
    `select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 and return_type='gstr3b'
       and invoice_type in ('purchase','credit_note','debit_note') and review_status <> 'rejected' order by created_at`,
    [firmId, client.id, period],
  );

  const sent = [], unsent = [];
  const seen = new Set();
  let duplicates = 0;
  for (const i of invoices) {
    const cp = counterparty(i, client.gstin);
    const doc = {
      invoice_id: i.id, number: i.invoice_number || "", type: TYPE_OF[i.invoice_type], gstin: cp.gstin, party: cp.name, date: i.invoice_date ? String(i.invoice_date).slice(0, 10) : null,
      taxable: r2(num(i.total_taxable_value)), igst: r2(num(i.igst_total)), cgst: r2(num(i.cgst_total)), sgst: r2(num(i.sgst_total)), cess: r2(num(i.cess_total)), total: r2(num(i.invoice_total)),
      alert: i.alert_for === "staff" ? i.alert_text || "Edited by the client - please review again." : null,
    };
    if (!i.client_approved_at) { unsent.push(doc); continue; }
    const dk = `${normInv(doc.number)}|${doc.type}|${partyKey(doc.gstin, doc.party)}`;
    if (doc.number && seen.has(dk)) { duplicates++; continue; }
    seen.add(dk);
    sent.push(doc);
  }

  const led = ledgerDocs(files, (r, f) => inPeriod(r, f, period));
  // the whole ledger, any month: a bill is looked for here before it is called "not in the ledger"
  const everything = ledgerDocs(files, (r) => !isTotalRow(r));
  const ledgerByNo = new Map();
  for (const d of everything.docs) { const k = `${normInv(d.inv_no)}|${d.type}`; (ledgerByNo.get(k) || ledgerByNo.set(k, []).get(k)).push(d); }
  const byNo = new Map();
  for (const d of sent) { const k = `${normInv(d.number)}|${d.type}`; (byNo.get(k) || byNo.set(k, []).get(k)).push(d); }
  const unsentByNo = new Set(unsent.map((d) => `${normInv(d.number)}|${d.type}`));
  const used = new Set();
  const findings = [];
  let matched = 0;
  const rounding = [];
  // what each side holds for the document being compared, attached to the findings raised about it
  const snap = (x) => (x ? { date: x.date || null, gstin: x.gstin || "", taxable: x.taxable, igst: x.igst, cgst: x.cgst, sgst: x.sgst, cess: x.cess, total: x.total, party: x.party || "", number: x.inv_no ?? x.number ?? "" } : null);
  let ctx = {};
  const F = (f) => findings.push({ ...ctx, ...f });

  // returns true when the document agrees with its ledger entry
  const compareDoc = (L, d) => {
    const ref = L.inv_no || "(no number)";
    const label = TYPE_LABEL[L.type];
    let clean = true;
    ctx = { ledger_doc: snap(L), working_doc: snap(d) };
    for (const m of MONEY) {
      const lv = m === "total" ? L.total : L[m], dv = d[m];
      // a difference of up to one rupee is not a mismatch, but it is a rounding difference worth reporting
      if (Math.abs(lv - dv) <= TOL && Math.abs(lv - dv) > 0.005) {
        rounding.push({ doc_type: L.type, doc_ref: ref, party: L.party || d.party, field: m, field_label: FIELD_LABEL[m], ledger_num: lv, document_num: dv, invoice_id: d.invoice_id, ledger_doc: snap(L), working_doc: snap(d) });
      }
      if (Math.abs(lv - dv) > TOL) {
        clean = false;
        F({ key: `val|${L.key}|${m}`, kind: "value_mismatch", severity: "error", doc_type: L.type, doc_ref: ref, party: L.party || d.party, field: m, field_label: FIELD_LABEL[m], ledger_value: inr(lv), document_value: inr(dv), ledger_num: lv, document_num: dv, invoice_id: d.invoice_id,
          message: `${label} ${ref}: ${FIELD_LABEL[m]} is ${inr(lv)} in the ledger but ${inr(dv)} in the uploaded document.` });
      }
    }
    if (L.gstin && d.gstin && L.gstin !== d.gstin) {
      clean = false;
      F({ key: `val|${L.key}|gstin`, kind: "value_mismatch", severity: "error", doc_type: L.type, doc_ref: ref, party: L.party || d.party, field: "gstin", field_label: FIELD_LABEL.gstin, ledger_value: L.gstin, document_value: d.gstin, invoice_id: d.invoice_id,
        message: `${label} ${ref}: supplier GSTIN is ${L.gstin} in the ledger but ${d.gstin} in the uploaded document.` });
    }
    if (L.date && d.date && L.date !== d.date) {
      clean = false;
      F({ key: `val|${L.key}|date`, kind: "value_mismatch", severity: "warning", doc_type: L.type, doc_ref: ref, party: L.party || d.party, field: "date", field_label: FIELD_LABEL.date, ledger_value: L.date, document_value: d.date, invoice_id: d.invoice_id,
        message: `${label} ${ref}: date is ${L.date} in the ledger but ${d.date} in the uploaded document.` });
    }
    return clean;
  };

  // same idea as pick(), from the ledger's side: which ledger entry belongs to this uploaded bill
  const pick2 = (cands, d) => (cands || []).find((c) => c.gstin && d.gstin && c.gstin === d.gstin)
    || (cands || []).find((c) => normName(c.party) && normName(c.party) === normName(d.party))
    || ((cands || []).length === 1 ? cands[0] : null);
  const pick = (cands, L) => {
    const free = (cands || []).filter((c) => !used.has(c.invoice_id));
    return free.find((c) => c.gstin && L.gstin && c.gstin === L.gstin)
      || free.find((c) => normName(c.party) && normName(c.party) === normName(L.party))
      || (free.length === 1 ? free[0] : null);
  };

  for (const L of led.docs) {
    const ref = L.inv_no || "(no number)";
    const label = TYPE_LABEL[L.type];
    let d = L.inv_no ? pick(byNo.get(`${normInv(L.inv_no)}|${L.type}`), L) : null;
    let wrongType = false;
    if (!d && L.inv_no) {
      // same number uploaded under a different document type
      for (const t of ["inv", "cn", "dn"]) {
        if (t === L.type) continue;
        const alt = pick(byNo.get(`${normInv(L.inv_no)}|${t}`), L);
        if (alt) {
          used.add(alt.invoice_id);
          ctx = { ledger_doc: snap(L), working_doc: snap(alt) };
          F({ key: `type|${L.key}`, kind: "type_mismatch", severity: "error", doc_type: L.type, doc_ref: ref, party: L.party, field: "type", field_label: "Document type", ledger_value: label, document_value: TYPE_LABEL[t], invoice_id: alt.invoice_id,
            message: `${ref} is a ${label.toLowerCase()} in the ledger but was uploaded as a ${TYPE_LABEL[t].toLowerCase()}. Upload it again under the correct type.` });
          d = alt;
          wrongType = true;
          break;
        }
      }
    }
    if (wrongType) continue;
    if (!d) {
      ctx = { ledger_doc: snap(L), working_doc: null };
      const wasUploaded = unsentByNo.has(`${normInv(L.inv_no)}|${L.type}`);
      F({ key: `missing|${L.key}`, kind: "missing_document", severity: "error", doc_type: L.type, doc_ref: ref, party: L.party, field: "document", field_label: "Document", ledger_value: inr(L.total), document_value: wasUploaded ? "uploaded, not sent" : "not uploaded", invoice_id: null,
        message: wasUploaded
          ? `${label} ${ref} (${L.party || "supplier"}, ${inr(L.total)}) is in your ledger. You uploaded it but have not verified and sent it to the CA.`
          : `${label} ${ref} (${L.party || "supplier"}, ${inr(L.total)}) is in your ledger but no matching document was uploaded.` });
      continue;
    }
    used.add(d.invoice_id);
    if (compareDoc(L, d)) matched++;
  }

  for (const d of sent.filter((x) => !used.has(x.invoice_id))) {
    const hit = d.number ? pick2(ledgerByNo.get(`${normInv(d.number)}|${d.type}`), d) : null;
    if (hit) { used.add(d.invoice_id); if (compareDoc(hit, d)) matched++; }
  }
  const notInLedger = sent.filter((d) => !used.has(d.invoice_id));
  for (const d of notInLedger) {
    ctx = { ledger_doc: null, working_doc: snap(d) };
    F({ key: `extra|${d.invoice_id}`, kind: "not_in_ledger", severity: "warning", doc_type: d.type, doc_ref: d.number || "(no number)", party: d.party, field: "ledger", field_label: "Ledger entry", ledger_value: "not found", document_value: inr(d.total), invoice_id: d.invoice_id,
      message: `${TYPE_LABEL[d.type]} ${d.number || "(no number)"} (${d.party || "supplier"}, ${inr(d.total)}) was uploaded but is not in the ledger.` });
  }

  ctx = {};
  // group-level findings
  const ledgerCount = { inv: 0, cn: 0, dn: 0 };
  for (const d of led.docs) ledgerCount[d.type]++;
  const sentCount = { inv: 0, cn: 0, dn: 0 };
  for (const d of sent) sentCount[d.type]++;
  if (!led.entries) {
    F({ key: "no_ledger", kind: "missing_ledger", severity: "error", doc_type: null, doc_ref: "", party: "", field: "ledger", field_label: "Purchase ledger", ledger_value: "", document_value: "", invoice_id: null,
      message: "No purchase ledger has been uploaded for this period. Upload it under GSTR-3B > Other documents so the documents can be checked against it." });
  }
  for (const t of ["inv", "cn", "dn"]) {
    if (ledgerCount[t] > 0 && sentCount[t] === 0) {
      F({ key: `none_sent|${t}`, kind: "missing_all", severity: "error", doc_type: t, doc_ref: "", party: "", field: "documents", field_label: TYPE_LABEL[t] + "s", ledger_value: String(ledgerCount[t]), document_value: "0", invoice_id: null,
        message: `No ${TYPE_PLURAL[t]} were sent, but the ledger lists ${ledgerCount[t]}. The GSTR-3B report cannot be generated. Please upload all the ${TYPE_PLURAL[t]} again, carefully.` });
    }
  }
  if (!led.entries && !sent.length) {
    F({ key: "nothing", kind: "missing_all", severity: "error", doc_type: null, doc_ref: "", party: "", field: "documents", field_label: "Documents", ledger_value: "", document_value: "", invoice_id: null,
      message: "Nothing has been sent for GSTR-3B for this period. Upload the purchase invoices, credit notes, debit notes and the purchase ledger." });
  }
  if (unsent.length) {
    F({ key: "unsent", kind: "unsent", severity: "warning", doc_type: null, doc_ref: "", party: "", field: "documents", field_label: "Unsent documents", ledger_value: "", document_value: String(unsent.length), invoice_id: null,
      message: `${unsent.length} document(s) were uploaded but the client has not verified and sent them to the CA yet.` });
  }

  // net purchases on each side (credit notes reduce), so the two can be compared as a whole
  const sumSide = (list, get) => {
    const t = { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, total: 0 };
    for (const d of list) { const sg = d.type === "cn" ? -1 : 1; for (const k of Object.keys(t)) t[k] += sg * num(get(d, k)); }
    return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r2(v)]));
  };
  const totals = { ledger: sumSide(led.docs, (d, k) => d[k]), working: sumSide(sent, (d, k) => d[k]) };

  const order = { error: 0, warning: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  // changes whenever a sent document or a ledger file changes, so a verification run can tell when it is out of date
  const sig = createHash("sha1").update(JSON.stringify([invoices.map((i) => [i.id, i.updated_at, i.client_approved_at]), files.map((f) => [f.id, f.created_at])])).digest("hex");

  return {
    period, sig,
    ledger: { files: files.filter((f) => (f.data?.rows || []).some((r) => inPeriod(r, f, period))).map((f) => ({ id: f.id, filename: f.original_filename, entries: f.row_count, ai: Boolean(f.data?.meta?.ai) })), entries: led.entries, documents: led.docs.length, by_type: ledgerCount },
    documents: { sent: sentCount, sent_total: sent.length, unsent_total: unsent.length, duplicates_skipped: duplicates },
    matched,
    rounding,
    totals,
    findings,
    docs: sent.map((d) => ({ ...d, status: findings.some((f) => f.invoice_id === d.invoice_id && f.severity === "error") ? "mismatch" : findings.some((f) => f.invoice_id === d.invoice_id) ? "check" : "matched" })),
  };
}
