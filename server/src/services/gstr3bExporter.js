import ExcelJS from "exceljs";
import { registerRows } from "./registerExporter.js";
import { barredBy164, blockedReason, classifyRcm, stateOf, validGstin } from "./gstRules.js";

const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const HEADS = ["igst", "cgst", "sgst", "cess"];
const zero = () => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });

function add(into, row, sign = 1) {
  into.taxable += sign * row.taxable;
  for (const h of HEADS) into[h] += sign * row[h];
}
const rounded = (t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r2(v)]));
const sumTax = (t) => HEADS.reduce((a, h) => a + t[h], 0);

/**
 * outward: GSTR-1 documents (sales +, debit notes +, credit notes -).
 * inward:  GSTR-3B documents (purchases, debit notes, credit notes).
 *
 * Purchase side, per document:
 *  - reverse charge (flagged on the invoice, or a notified service / import detected from a bill that carries no tax):
 *    the recipient works the tax out, pays it in cash (3.1(d)) and claims it in 4(A)(2)/(3). That ITC is available only
 *    after the cash payment, so it is carried to the next month and not used against this month's outward tax.
 *  - normal purchases with tax: eligible ITC in 4(A)(5), unless the supplier GSTIN is invalid, the bill is addressed to a
 *    different GSTIN, or section 16(4) bars it (then shown as ineligible, not claimed).
 *  - blocked credits under section 17(5) are claimed in 4(A) and reversed in 4(B)(1).
 *  - purchases with no tax and no reverse charge (exempt / nil / composition / unregistered) go to Table 5.
 *  - credit notes are ITC reversals in 4(B)(2); debit notes add ITC like purchases.
 */
export function computeGstr3b(outwardDocs, inwardDocs, clientGstin, taxPeriod = "") {
  const outRows = [];
  for (const d of outwardDocs) {
    const sign = d.invoice_type === "credit_note" ? -1 : 1;
    if (!["sales", "debit_note", "credit_note"].includes(d.invoice_type)) continue;
    for (const r of registerRows([d], clientGstin)) outRows.push({ ...r, sign, type: d.invoice_type });
  }

  const mine = stateOf(clientGstin);
  const inRows = [];
  const review = [];
  const rcmAll = zero(), impS = zero(), rcmOther = zero(), other = zero(), blockedRcm = zero(), blockedOther = zero(), reversal = zero();
  const barred = zero(), notAllowed = zero();
  const t5 = { inter: 0, intra: 0 };

  for (const d of inwardDocs) {
    if (!["purchase", "debit_note", "credit_note"].includes(d.invoice_type)) continue;
    const base = registerRows([d], clientGstin);
    const isCN = d.invoice_type === "credit_note";
    const info = isCN ? { rcm: false, basis: "", rate: 0, import: false } : classifyRcm(d, base);
    const blocked = isCN ? null : blockedReason(d, base);
    const supplierGstin = base[0]?.supplier_gstin || "";
    const supplierState = stateOf(supplierGstin) || String(d.place_of_supply || "").slice(0, 2);
    const inter = info.import ? true : supplierState && mine ? supplierState !== mine : false;
    const barred164 = !isCN && barredBy164(d.invoice_date, taxPeriod);
    const buyer = String(d.buyer_gstin || "").trim().toUpperCase();
    const notToUs = !isCN && buyer && clientGstin && buyer !== String(clientGstin).toUpperCase();

    for (const base_r of base) {
      const r = { ...base_r, sign: 1, type: d.invoice_type, rcm: info.rcm ? "Y" : "N", rcm_basis: info.basis, itc_status: "", itc_reason: "" };
      const shown = r.igst + r.cgst + r.sgst + r.cess;

      if (info.rcm && !isCN) {
        if (shown === 0 && r.taxable > 0) {
          const rate = r.rate > 0 ? r.rate : info.rate;
          const tax = r2((r.taxable * rate) / 100);
          if (inter) r.igst = tax; else { r.cgst = r2(tax / 2); r.sgst = r2(tax - r.cgst); }
          r.rate = rate;
          if (!(base_r.rate > 0) && info.rate_assumed) r.rcm_basis = `${info.basis}. Rate ${rate}% assumed - check it`;
        }
        add(rcmAll, r);
        r.itc_reason = "Tax paid in cash under reverse charge";
        if (barred164) { r.itc_status = "Not claimed - section 16(4)"; add(barred, r); r.itc_reason = "Document is too old to claim ITC (30 November limit)"; }
        else {
          add(info.import ? impS : rcmOther, r);
          r.itc_status = "ITC claimed - usable from next month";
          if (blocked) { add(blockedRcm, r); r.itc_status = "Blocked - section 17(5)"; r.itc_reason = blocked; }
        }
      } else if (isCN) {
        add(reversal, r);
        r.itc_status = "ITC reversal (credit note)";
      } else if (shown === 0) {
        t5[inter ? "inter" : "intra"] += r.taxable;
        r.itc_status = "No ITC - no tax charged";
        r.itc_reason = "Exempt / nil rated / composition / unregistered supplier. Reported in Table 5";
      } else if (!validGstin(supplierGstin)) {
        add(notAllowed, r); r.itc_status = "Not claimed - no valid supplier GSTIN"; r.itc_reason = "Section 16(2): ITC needs a valid tax invoice from a registered person";
      } else if (notToUs) {
        add(notAllowed, r); r.itc_status = "Not claimed - bill is for another GSTIN"; r.itc_reason = `Buyer GSTIN on the bill is ${buyer}`;
      } else if (barred164) {
        add(barred, r); r.itc_status = "Not claimed - section 16(4)"; r.itc_reason = "Document is too old to claim ITC (30 November limit)";
      } else {
        add(other, r);
        r.itc_status = "Eligible ITC";
        if (blocked) { add(blockedOther, r); r.itc_status = "Blocked - section 17(5)"; r.itc_reason = blocked; }
      }
      inRows.push(r);
    }
    const first = inRows[inRows.length - base.length];
    if (first && (info.rcm || blocked || barred164 || notToUs || first.itc_status.startsWith("Not claimed"))) {
      review.push({ number: d.invoice_number || "", party: first.supplier_name, gstin: supplierGstin, type: d.invoice_type, rcm: info.rcm ? "Y" : "N", basis: first.rcm_basis, status: first.itc_status, reason: first.itc_reason });
    }
  }

  const a = zero(), c = zero();
  for (const r of outRows) {
    if (r.rate > 0 || r.igst + r.cgst + r.sgst + r.cess > 0) add(a, r, r.sign);
    else add(c, r, r.sign);
  }

  // ITC claimed (before reversals), reversals, net
  const gross = zero(), blocked = zero(), usable = {}, rcmNet = {}, net = {};
  for (const x of [other, rcmOther, impS]) add(gross, x);
  for (const x of [blockedOther, blockedRcm]) add(blocked, x);
  for (const h of HEADS) {
    usable[h] = Math.max(0, other[h] - blockedOther[h] - reversal[h]);
    rcmNet[h] = Math.max(0, rcmOther[h] + impS[h] - blockedRcm[h]);
    net[h] = usable[h] + rcmNet[h];
  }

  // Outward tax is set off in the statutory order against the ITC already in the ledger. ITC on reverse charge arises only after
  // the cash payment, so it goes to the carry-forward. Reverse-charge tax itself is always paid in cash.
  const L = { igst: a.igst, cgst: a.cgst, sgst: a.sgst, cess: a.cess };
  let I = usable.igst, C = usable.cgst, S = usable.sgst, X = usable.cess;
  const use = (avail, key) => { const u = Math.max(0, Math.min(avail, L[key])); L[key] -= u; return avail - u; };
  I = use(I, "igst"); I = use(I, "cgst"); I = use(I, "sgst");
  C = use(C, "cgst"); C = use(C, "igst");
  S = use(S, "sgst"); S = use(S, "igst");
  X = use(X, "cess");
  const cash = {};
  for (const h of HEADS) cash[h] = Math.max(0, L[h]) + rcmAll[h];
  const carry = { igst: I + rcmNet.igst, cgst: C + rcmNet.cgst, sgst: S + rcmNet.sgst, cess: X + rcmNet.cess };
  const used = {};
  for (const h of HEADS) used[h] = usable[h] - { igst: I, cgst: C, sgst: S, cess: X }[h];

  // Rule 42 is only an estimate: all ITC is treated as common credit and exempt supplies are those without tax in the documents.
  const turnover = a.taxable + c.taxable;
  const ratio = turnover > 0 && c.taxable > 0 ? c.taxable / turnover : 0;
  const rule42 = r2(ratio * (sumTax(other) - sumTax(blockedOther)));

  return {
    outRows, inRows, review,
    t31: { a: rounded(a), c: rounded(c), d: rounded(rcmAll) },
    t4: {
      import_services: rounded(impS), rcm: rounded(rcmOther), other: rounded(other), gross: rounded(gross),
      blocked: rounded(blocked), reversal: rounded(reversal), net: rounded(net),
      barred164: rounded(barred), not_allowed: rounded(notAllowed), rcm_net: rounded(rcmNet),
    },
    t5: { inter: r2(t5.inter), intra: r2(t5.intra) },
    rule42: { ratio: Math.round(ratio * 10000) / 100, estimate: rule42 },
    t61: { liability: rounded({ taxable: 0, ...Object.fromEntries(HEADS.map((h) => [h, a[h] + rcmAll[h]])) }), itc_used: rounded({ taxable: 0, ...used }), cash: rounded({ taxable: 0, ...cash }), carry_forward: rounded({ taxable: 0, ...carry }) },
  };
}

export async function generateGstr3bWorkbook(res, { clientName, clientGstin, taxPeriod }) {
  const wb = new ExcelJS.Workbook();
  const border = { style: "thin", color: { argb: "FFD9D9D9" } };
  const borders = { left: border, right: border, top: border, bottom: border };
  const head = (c) => {
    c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.border = borders;
  };
  const money = "#,##0.00";

  // ---------------------------------------------------------------- summary
  const ws = wb.addWorksheet("GSTR-3B Summary");
  ws.getColumn(1).width = 66;
  for (let i = 2; i <= 6; i++) ws.getColumn(i).width = 17;
  let row = 1;
  ws.getCell(row, 1).value = `GSTR-3B working - ${clientName}${clientGstin ? ` (${clientGstin})` : ""} - ${taxPeriod}`;
  ws.getCell(row, 1).font = { name: "Calibri", size: 13, bold: true };
  row += 2;

  const table = (title, heads, lines, boldLast = false) => {
    ws.getCell(row, 1).value = title;
    ws.getCell(row, 1).font = { name: "Calibri", size: 11, bold: true };
    row++;
    heads.forEach((h, i) => { const c = ws.getCell(row, i + 1); c.value = h; head(c); });
    lines.forEach((ln, li) => {
      row++;
      ln.forEach((v, i) => {
        const c = ws.getCell(row, i + 1);
        c.value = v;
        c.border = borders;
        c.font = { name: "Calibri", size: 10, bold: boldLast && li === lines.length - 1 };
        if (typeof v === "number") { c.numFmt = money; c.alignment = { horizontal: "right" }; }
        else if (i === 0) c.alignment = { wrapText: true, vertical: "top" };
      });
    });
    row += 2;
  };
  const five = (t) => [t.taxable, t.igst, t.cgst, t.sgst, t.cess];
  const taxOnly = (t) => [t.igst, t.cgst, t.sgst, t.cess];
  const z4 = [0, 0, 0, 0];

  table(
    "Table 3.1 - Outward supplies and inward supplies liable to reverse charge",
    ["Nature of supplies", "Taxable value", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["(a) Outward taxable supplies (other than zero rated, nil rated and exempted)", ...five(res.t31.a)],
      ["(b) Outward taxable supplies (zero rated) - not separately identified from documents", 0, 0, 0, 0, 0],
      ["(c) Other outward supplies (nil rated, exempted)", ...five(res.t31.c)],
      ["(d) Inward supplies (liable to reverse charge) - tax worked out by the recipient", ...five(res.t31.d)],
      ["(e) Non-GST outward supplies - not captured from documents", 0, 0, 0, 0, 0],
    ],
  );
  table(
    "Table 4 - Eligible ITC",
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["(A)(1) Import of goods - not captured (needs bill of entry)", ...z4],
      ["(A)(2) Import of services", ...taxOnly(res.t4.import_services)],
      ["(A)(3) Inward supplies liable to reverse charge (other than 1 and 2 above)", ...taxOnly(res.t4.rcm)],
      ["(A)(4) Inward supplies from ISD - not captured", ...z4],
      ["(A)(5) All other ITC (purchase invoices and debit notes)", ...taxOnly(res.t4.other)],
      ["(B)(1) ITC reversed - rules 38, 42, 43 and section 17(5) (blocked credits found in the documents)", ...taxOnly(res.t4.blocked)],
      ["(B)(2) ITC reversed - others (credit notes on purchases)", ...taxOnly(res.t4.reversal)],
      ["(C) Net ITC available (A - B)", ...taxOnly(res.t4.net)],
      ["(D)(2) Ineligible ITC under section 16(4) - not claimed above", ...taxOnly(res.t4.barred164)],
      ["Other tax on purchases not claimed (no valid supplier GSTIN / bill for another GSTIN)", ...taxOnly(res.t4.not_allowed)],
    ],
    false,
  );
  table(
    "Table 5 - Exempt, nil rated and non-GST inward supplies (purchases with no tax charged)",
    ["Nature of supplies", "Inter-State", "Intra-State"],
    [["From composition dealers, exempt / nil rated supplies, unregistered suppliers and non-GST supplies", res.t5.inter, res.t5.intra]],
  );
  table(
    "Table 6.1 - Payment of tax (after set-off of ITC in the statutory order)",
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["Tax payable (outward tax + reverse charge)", ...taxOnly(res.t61.liability)],
      ["Paid through ITC (ITC already in the ledger; reverse-charge ITC is not usable until next month)", ...taxOnly(res.t61.itc_used)],
      ["Paid in cash (includes reverse-charge tax, which can only be paid in cash)", ...taxOnly(res.t61.cash)],
      ["ITC carried forward (includes this month's reverse-charge ITC)", ...taxOnly(res.t61.carry_forward)],
    ],
    true,
  );
  if (res.rule42.ratio > 0) {
    table(
      "For review - Rule 42 reversal estimate (NOT deducted above)",
      ["Details", "Amount"],
      [[`Exempt / nil rated outward turnover is ${res.rule42.ratio}% of total. If all ITC were common credit, the reversal would be about`, res.rule42.estimate]],
    );
  }

  // ---------------------------------------------------------------- detail sheets
  const detail = (name, rows, signed, extra = []) => {
    const sh = wb.addWorksheet(name);
    const cols = [
      ["Document Number", 20, "doc_no"], ["Document Date", 14, "doc_date"], ["Type", 14, "type"],
      ["Supplier Name", 26, "supplier_name"], ["Supplier GSTIN", 20, "supplier_gstin"],
      ["Buyer Name", 26, "buyer_name"], ["Buyer GSTIN", 20, "buyer_gstin"],
      ["Reverse Charge", 10, "rcm"], ["HSN/SAC", 12, "hsn"], ["Rate %", 9, "rate"],
    ];
    const nums = [["Taxable Value", "taxable"], ["IGST", "igst"], ["CGST", "cgst"], ["SGST", "sgst"], ["Cess", "cess"]];
    const all = [...cols.map(([h, w]) => [h, w]), ...(signed ? [["Effect", 9]] : []), ...nums.map(([h]) => [h, 15]), ...extra.map(([h, w]) => [h, w])];
    all.forEach(([h, w], i) => { sh.getColumn(i + 1).width = w; const c = sh.getCell(1, i + 1); c.value = h; head(c); });
    rows.forEach((r, ri) => {
      let col = 0;
      const put = (v, num) => { const c = sh.getCell(ri + 2, ++col); c.value = v; c.border = borders; c.font = { name: "Calibri", size: 10 }; if (num) { c.numFmt = money; c.alignment = { horizontal: "right" }; } };
      cols.forEach(([, , k]) => put(k === "type" ? r.type.replace("_", " ") : r[k] ?? ""));
      if (signed) put(r.sign < 0 ? "Less" : "Add");
      nums.forEach(([, k]) => put(r[k], true));
      extra.forEach(([, , k]) => put(r[k] ?? ""));
    });
    sh.views = [{ state: "frozen", ySplit: 1 }];
  };
  detail("Outward detail (GSTR-1 docs)", res.outRows, true);
  detail("Inward detail (GSTR-3B docs)", res.inRows, false, [["RCM basis", 52, "rcm_basis"], ["ITC treatment", 34, "itc_status"], ["Reason", 52, "itc_reason"]]);

  // ---------------------------------------------------------------- documents that need a decision
  const rv = wb.addWorksheet("RCM and ITC review");
  const rvCols = [["Document", 20, "number"], ["Supplier", 28, "party"], ["Supplier GSTIN", 20, "gstin"], ["Type", 14, "type"], ["Reverse charge", 10, "rcm"], ["Why reverse charge", 60, "basis"], ["ITC treatment", 34, "status"], ["Reason", 60, "reason"]];
  rvCols.forEach(([h, w], i) => { rv.getColumn(i + 1).width = w; const c = rv.getCell(1, i + 1); c.value = h; head(c); });
  res.review.forEach((x, ri) => rvCols.forEach(([, , k], i) => { const c = rv.getCell(ri + 2, i + 1); c.value = String(x[k] ?? "").replace("_", " "); c.border = borders; c.font = { name: "Calibri", size: 10 }; c.alignment = { wrapText: true, vertical: "top" }; }));
  if (!res.review.length) rv.getCell(2, 1).value = "No document needed a reverse-charge, blocked-credit or eligibility decision.";
  rv.views = [{ state: "frozen", ySplit: 1 }];

  // ---------------------------------------------------------------- notes
  const notes = wb.addWorksheet("Notes");
  notes.getColumn(1).width = 130;
  [
    "This is a working prepared from documents the client has verified and sent to the CA. It is not the filed return. Check it against GSTR-2B and the ledgers before filing.",
    "Table 3.1(a) and (c): sales invoices and debit notes sent for GSTR-1, less credit notes sent for GSTR-1. Lines with no tax are shown as nil rated / exempt. Zero-rated and non-GST outward supplies cannot be told apart from documents and are shown as zero.",
    "Reverse charge (sections 9(3), 9(4), 5(3)/5(4) of the CGST/IGST Acts): a purchase is under reverse charge when the invoice is marked so, or when the bill carries no GST and the description / SAC matches a service notified in Notification 13/2017-CT(R) (goods transport agency, advocate, arbitral tribunal, sponsorship, director's fee, security service, residential rent to a registered person, and similar) or goods in Notification 4/2017-CT(R), or it is an import of service. Tax is worked out on the taxable value at the rate on the bill, or at the notified rate where the bill shows none. The rows where the rate was assumed are marked in the review sheet.",
    "Reverse-charge tax is shown in 3.1(d), paid in cash in 6.1, and claimed as ITC in 4(A)(2)/(3). Because that ITC arises only after the cash payment, it cannot be used against this month's outward tax; it is carried forward to the next month.",
    "Purchases from unregistered suppliers are not under reverse charge unless a notified category applies (section 9(4) is limited to notified classes). They carry no ITC and are reported in Table 5.",
    "ITC conditions checked from the documents: valid supplier GSTIN (tax invoice by a registered person), bill addressed to this client's GSTIN, and the section 16(4) limit (a document dated in a financial year can be claimed up to 30 November after it). Documents failing these are shown as 'Not claimed'. Section 16(2)(aa) (appearing in GSTR-2B), payment to the supplier within 180 days (rule 37) and receipt of goods cannot be checked here.",
    "Blocked credits (section 17(5)) are recognised from words in the description (motor vehicles, food and catering, club and fitness, life/health insurance, works contract/construction, gifts and similar). They are claimed in 4(A) and reversed in 4(B)(1). The exceptions in section 17(5) (for example food where the outward supply is of the same kind, vehicles used for transport or sale) cannot be told from the document: check the review sheet and correct manually.",
    "Not captured from documents: import of goods (bill of entry), ISD credit, rule 38 / 43 reversals, ITC reclaimed, opening ITC balances, interest, late fee and previous-period carry-forward. Rule 42 is shown only as an estimate and is not deducted.",
    "Set-off: IGST credit is used for IGST, then CGST, then SGST; CGST credit for CGST then IGST; SGST credit for SGST then IGST. The rules encoded are the ones in force when this working was built; later notifications or rate changes are not read automatically.",
  ].forEach((t, i) => { const c = notes.getCell(i + 1, 1); c.value = t; c.alignment = { wrapText: true, vertical: "top" }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
