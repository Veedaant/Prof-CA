import ExcelJS from "exceljs";

const border = { style: "thin", color: { argb: "FFD9D9D9" } };
const borders = { left: border, right: border, top: border, bottom: border };
const money = "#,##0.00";
const head = (c) => {
  c.font = { name: "Calibri", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
  c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F497D" } };
  c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  c.border = borders;
};
const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

export const SHORT = {
  eligible: "Eligible", conditional: "Eligible - check condition", ineligible: "Ineligible", ineligible_16_4: "Ineligible", hold: "Not now - hold",
  rcm: "Eligible on RCM payment", not_booked: "Eligible once booked", no_tax: "No ITC", reversal: "Reversal",
};
const SHADE = { eligible: "FFE8F5E9", conditional: "FFFFF8E1", ineligible: "FFFDECEA", ineligible_16_4: "FFFDECEA", hold: "FFFFF8E1", rcm: "FFE8F5E9", not_booked: "FFFFF8E1", no_tax: "FFF3F4F6", reversal: "FFFDECEA" };
const CAT_LABEL = {
  matched: "Matches GSTR-2B", rounding: "Rounding difference", amount: "Amount differs", head: "Wrong tax head", gstin: "Supplier GSTIN differs", invno: "Invoice number differs",
  date: "Date differs", rcm: "Reverse charge", unavailable: "GSTR-2B says ITC not available", books_only: "In books, not in GSTR-2B", g2b_only: "In GSTR-2B, not in books", no_tax: "No tax charged",
};
export const catLabel = (c) => CAT_LABEL[c] || c;
export const rcmShort = (r) => (!r || r.mode === "none" ? "Not a reverse-charge case" : r.mode === "fcm" ? "RCM kind, supplier charged GST (FCM)" : r.source === "detected" ? "RCM applicable - not in books" : r.source === "2b" ? "RCM - per GSTR-2B" : "RCM - recorded in books");
const SOURCE = { books: "ITC register (books)", detected: "ITC register (books)", "2b": "GSTR-2B", supplier: "ITC register and GSTR-2B", ledger: "Client's purchase ledger" };

/** The GSTR-2B reconciliation workbook: summary of the GSTR-3B, the reconciliation with remarks, and the counts. */
export async function generateItcWorkbook({ clientName, clientGstin, period, result, uploads }) {
  const wb = new ExcelJS.Workbook();
  const s = result.summary;
  const heads = ["igst", "cgst", "sgst", "cess"];

  // ------------------------------------------------------------ sheet 1: GSTR-3B summary
  const ws = wb.addWorksheet("GSTR-3B Summary");
  ws.getColumn(1).width = 66;
  for (let i = 2; i <= 6; i++) ws.getColumn(i).width = 17;
  let r = 1;
  const put = (row, col, v, o = {}) => {
    const c = ws.getCell(row, col);
    c.value = v;
    c.font = { name: "Calibri", size: o.size || 10, bold: Boolean(o.bold) };
    if (o.border) c.border = borders;
    if (typeof v === "number") { c.numFmt = money; c.alignment = { horizontal: "right" }; }
    else if (o.wrap !== false && col === 1) c.alignment = { wrapText: true, vertical: "top" };
    return c;
  };
  put(r++, 1, `GSTR-3B summary from GSTR-1, GSTR-2B and the books - ${clientName}${clientGstin ? ` (${clientGstin})` : ""} - ${period}`, { bold: true, size: 13 });
  put(r++, 1, `Nature of business: ${result.profile.label}.   GSTR-1 liability read from the PDF (${s.outward ? s.outward.source : "not read"}).`);
  r++;
  const table = (title, cols, lines, boldLast = false) => {
    put(r++, 1, title, { bold: true, size: 11 });
    cols.forEach((h, i) => { const c = ws.getCell(r, i + 1); c.value = h; head(c); });
    lines.forEach((ln, li) => {
      r++;
      ln.forEach((v, i) => put(r, i + 1, v, { border: true, bold: boldLast && li === lines.length - 1 }));
    });
    r += 2;
  };
  const four = (t) => heads.map((h) => (t ? t[h] : 0));
  const o = s.outward || { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
  table("Table 3.1 - Outward supplies (from the GSTR-1 PDF) and inward supplies liable to reverse charge (from the books and GSTR-2B)",
    ["Nature of supplies", "Taxable value", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["(a) Outward taxable supplies - total liability per GSTR-1, net of credit notes and amendments", o.taxable, ...four(o)],
      ["(d) Inward supplies liable to reverse charge", "", ...four(s.rcm)],
    ]);
  table("Table 4 - Input tax credit",
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["(A)(3) Inward supplies liable to reverse charge - claimed now, usable from next month", ...four(s.itc.a3)],
      ["(A)(5) All other ITC - invoices in both the books and GSTR-2B (including blocked credit)", ...four(s.itc.a5)],
      ["(B)(1) ITC reversed - section 17(5) blocked credits and exempt-business ITC", ...four(s.itc.b1)],
      ["(B)(1) ITC reversed - rule 42 on exempt supplies (estimate)" + (s.itc.rule42_ratio ? ` at ${s.itc.rule42_ratio}%` : ""), ...four(s.itc.rule42)],
      ["(B)(2) ITC reversed - credit notes", ...four(s.itc.b2)],
      ["Opening ITC balance entered (usable now)", ...four(s.itc.opening)],
      ["(C) Net ITC available now (excluding reverse-charge credit)", ...heads.map((h) => s.itc.net_now[h] + (s.itc.opening[h] || 0))],
      ["Net ITC including reverse-charge credit (reverse-charge credit is usable from next month)", ...four(s.itc.net)],
    ], false);
  table("Table 6.1 - Payment of tax",
    ["Details", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["Outward tax payable (per GSTR-1)", ...four(s.payment.liability)],
      ["Paid through ITC (set off in the statutory order)", ...four(s.payment.itc_used)],
      ["Outward tax payable in cash after set-off", ...four(s.payment.cash_outward)],
      ["Reverse-charge tax payable in cash (cannot be paid through ITC)", ...four(s.payment.rcm_cash)],
      ["   of which found only in the client's purchase ledger", ...four(s.rcm_ledger)],
      ["NET PAYMENT IN CASH (outward balance + reverse charge)", ...four(s.payment.cash)],
      ["ITC carried forward (includes this month's reverse-charge credit)", ...four(s.payment.carry_forward)],
    ], false);
  put(r, 1, "Total cash payment for the month", { bold: true, size: 11 });
  put(r, 2, s.payment.total_cash, { bold: true, size: 11 });
  r += 2;
  table("ITC not claimed in the figures above",
    ["Reason", "Integrated tax", "Central tax", "State/UT tax", "Cess"],
    [
      ["Not in GSTR-2B yet, or booked higher than GSTR-2B (claim when it appears)", ...four(s.not_claimed.hold)],
      ["Barred or marked not available by GSTR-2B (section 16(4), rule 37A, place of supply)", ...four(s.not_claimed.barred)],
      ["In GSTR-2B but not booked (claim after booking, if genuine)", ...four(s.not_claimed.unbooked)],
    ]);
  for (const w of s.warnings) put(r++, 1, w);
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // ------------------------------------------------------------ sheet 2: counts
  const cs = wb.addWorksheet("Reconciliation Summary");
  cs.getColumn(1).width = 54; cs.getColumn(2).width = 12; cs.getColumn(3).width = 16; cs.getColumn(4).width = 16;
  let k = 1;
  const cp = (row, col, v, o = {}) => { const c = cs.getCell(row, col); c.value = v; c.font = { name: "Calibri", size: o.size || 10, bold: Boolean(o.bold) }; if (o.border) c.border = borders; if (typeof v === "number" && o.num) { c.numFmt = money; c.alignment = { horizontal: "right" }; } return c; };
  cp(k++, 1, "ITC as per books against GSTR-2B", { bold: true, size: 13 });
  cp(k++, 1, `${clientName} - ${period}`);
  for (const [a, b] of [["Books file", uploads.books_name], ["GSTR-2B file", uploads.gstr2b_name], ["GSTR-1 PDF", uploads.gstr1_name]]) { cp(k, 1, a, { bold: true }); cp(k, 2, b || "not uploaded"); k++; }
  k++;
  ["Result", "Number"].forEach((h, i) => { const c = cs.getCell(k, i + 1); c.value = h; head(c); });
  k++;
  const c = result.counts;
  for (const [label, n] of [
    ["Lines compared", c.total], ["Matching GSTR-2B (including paise rounding)", c.matched], ["Matching apart from rounding", c.rounding], ["Different from GSTR-2B", c.different],
    ["In the books, not in GSTR-2B", c.books_only], ["In GSTR-2B, not in the books", c.g2b_only], ["Reverse-charge purchases", c.rcm], ["No tax charged", c.no_tax], ["ITC ineligible", c.ineligible], ["ITC on hold (not in GSTR-2B)", c.hold],
  ]) { cp(k, 1, label, { border: true }); cp(k, 2, n, { border: true }); k++; }
  k++;
  ["Tax (credit notes deducted)", "IGST", "CGST", "SGST", "Cess"].forEach((h, i) => { const x = cs.getCell(k, i + 1); x.value = h; head(x); });
  cs.getColumn(5).width = 16;
  k++;
  for (const [label, t] of [["As per books", c.tax_books], ["As per GSTR-2B", c.tax_2b]]) {
    cp(k, 1, label, { border: true });
    heads.forEach((h, i) => cp(k, i + 2, t[h], { border: true, num: true }));
    k++;
  }
  cp(k, 1, "Difference", { border: true, bold: true });
  heads.forEach((h, i) => cp(k, i + 2, Math.round((c.tax_books[h] - c.tax_2b[h]) * 100) / 100, { border: true, num: true, bold: true }));

  // ------------------------------------------------------------ sheet 3: reverse charge
  const rc = wb.addWorksheet("RCM Check");
  const rcCols = [["No.", 5], ["Where found", 22], ["Supplier", 26], ["GSTIN", 18], ["Invoice no.", 14], ["Date", 11], ["Nature of supply", 24], ["Taxable value", 14], ["Reverse charge category", 40], ["Provision", 62], ["Treatment", 34], ["Rate %", 8], ["IGST", 12], ["CGST", 12], ["SGST", 12], ["Cess", 10], ["Note", 70]];
  rcCols.forEach(([h, w], i) => { rc.getColumn(i + 1).width = w; const x = rc.getCell(1, i + 1); x.value = h; head(x); });
  rc.getRow(1).height = 30;
  const cases = result.rcm_cases || [];
  const tr = (c) => (c.mode === "fcm" ? "RCM kind: supplier charged GST (FCM) - no RCM payable, ITC in GSTR-2B" : c.source === "ledger" ? "RCM payable - found in the client's ledger, not in the books register" : c.source === "detected" ? "RCM payable - not recorded in the books" : c.source === "2b" ? "RCM payable - GSTR-2B shows reverse charge" : "RCM payable - recorded in the books");
  cases.forEach((c, i) => {
    const t = c.tax || { igst: 0, cgst: 0, sgst: 0, cess: 0 };
    const vals = [i + 1, SOURCE[c.source] || c.source, c.party, c.gstin, c.inv_no, c.date ? c.date.split("-").reverse().join("-") : "", c.nature || "", c.taxable, c.rule ? c.rule.name : "Marked as reverse charge (no notified category found)", c.rule ? c.rule.ref + (c.rule.verify ? " (verify the current notification)" : "") : "Section 9(3) / 9(4) CGST Act", tr(c), c.rate ?? "", t.igst, t.cgst, t.sgst, t.cess, c.note || ""];
    vals.forEach((v, j) => {
      const x = rc.getCell(i + 2, j + 1);
      x.value = v; x.border = borders; x.font = { name: "Calibri", size: 10 };
      x.alignment = { vertical: "top", wrapText: j === 2 || j === 6 || j >= 8 && j !== 11 };
      if (typeof v === "number" && j >= 7 && j !== 11) { x.numFmt = money; x.alignment = { vertical: "top", horizontal: "right" }; }
      if (j === 10) x.fill = fill(c.mode === "fcm" ? "FFFFF8E1" : "FFE8F5E9");
    });
  });
  if (!cases.length) rc.getCell(2, 2).value = "No reverse-charge case was found in the books, GSTR-2B or the client's ledger.";
  else {
    const at = cases.length + 2;
    const payable = cases.filter((c) => c.mode === "rcm");
    rc.getCell(at, 3).value = "Total reverse-charge tax payable in cash"; rc.getCell(at, 3).font = { name: "Calibri", size: 10, bold: true };
    ["igst", "cgst", "sgst", "cess"].forEach((h, k) => { const x = rc.getCell(at, 13 + k); x.value = Math.round(payable.reduce((a, c) => a + ((c.tax || {})[h] || 0), 0) * 100) / 100; x.numFmt = money; x.font = { name: "Calibri", size: 10, bold: true }; x.border = borders; });
  }
  rc.views = [{ state: "frozen", xSplit: 3, ySplit: 1 }];
  rc.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: rcCols.length } };

  // ------------------------------------------------------------ sheet 4: the reconciliation
  const rs = wb.addWorksheet("ITC Reconciliation");
  const cols = [
    ["No.", 5], ["Supplier", 26], ["GSTIN", 18], ["Invoice no.", 16], ["Date", 11], ["Type", 10], ["Nature", 24],
    ["Books: taxable", 14], ["Books: IGST", 12], ["Books: CGST", 12], ["Books: SGST", 12], ["Books: cess", 10],
    ["GSTR-2B: taxable", 14], ["GSTR-2B: IGST", 12], ["GSTR-2B: CGST", 12], ["GSTR-2B: SGST", 12], ["GSTR-2B: cess", 10],
    ["Tax difference (books - 2B)", 14], ["Remark", 60], ["Recommended course of action", 64], ["RCM applicability", 34], ["ITC eligible / ineligible", 22], ["ITC claimed in 3B", 14], ["Reason", 40], ["Relevant provision of the GST Act (ITC)", 80], ["RCM provision", 60],
  ];
  cols.forEach(([h, w], i) => { rs.getColumn(i + 1).width = w; const x = rs.getCell(1, i + 1); x.value = h; head(x); });
  rs.getRow(1).height = 34;
  const tax = (o) => (o ? o.igst + o.cgst + o.sgst + o.cess : 0);
  result.lines.forEach((l, i) => {
    const claimed = l.amounts ? tax(l.amounts.claim) + tax(l.amounts.rcm_claim) : 0;
    const b = l.books, g = l.g2b;
    const vals = [
      l.no, l.party, l.gstin, l.inv_no, l.date ? l.date.split("-").reverse().join("-") : "", { inv: "Invoice", cn: "Credit note", dn: "Debit note" }[l.type] || l.type, l.nature,
      b ? b.taxable : "", b ? b.igst : "", b ? b.cgst : "", b ? b.sgst : "", b ? b.cess : "",
      g ? g.taxable : "", g ? g.igst : "", g ? g.cgst : "", g ? g.sgst : "", g ? g.cess : "",
      Math.round((tax(b) - tax(g)) * 100) / 100, `${catLabel(l.cat)}: ${l.remark}`, l.action, rcmShort(l.rcm), SHORT[l.code] || l.eligibility, claimed, l.reason, l.provision, l.rcm && l.rcm.ref ? l.rcm.ref : "",
    ];
    vals.forEach((v, j) => {
      const x = rs.getCell(i + 2, j + 1);
      x.value = v;
      x.border = borders;
      x.font = { name: "Calibri", size: 10 };
      x.alignment = { vertical: "top", wrapText: j >= 18 || j === 1 || j === 6 };
      if (typeof v === "number" && j >= 7) { x.numFmt = money; x.alignment = { vertical: "top", horizontal: "right" }; }
      if (j === 21) { x.fill = fill(SHADE[l.code] || "FFFFFFFF"); x.font = { name: "Calibri", size: 10, bold: true }; }
    });
  });
  rs.views = [{ state: "frozen", xSplit: 4, ySplit: 1 }];
  rs.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  // ------------------------------------------------------------ sheet 4: notes
  const ns = wb.addWorksheet("Notes");
  ns.getColumn(1).width = 140;
  [
    "How this was worked out",
    "Matching: the ITC register in the books is matched with GSTR-2B on supplier GSTIN and invoice number. Where they do not match exactly, the same invoice number with a different GSTIN, the same supplier and amounts with a different number, and near-identical numbers are tried before a line is called missing.",
    "Differences of up to ₹1 are treated as paise rounding.",
    "ITC claimed: for matched invoices the claim is the lower of the books and GSTR-2B, head by head (section 16(2)(aa)). Where the total tax agrees but sits under the wrong heads, the claim follows GSTR-2B and the books should be corrected.",
    "Eligibility: judged on the nature of the business entered for the client, the description of the purchase, the dates and the GSTR-2B availability column, against sections 16, 17(1)-(5), 34 and 38, rules 36, 37, 37A, 42, 43 and 86B of the CGST Act and Rules, the reverse-charge notifications (13/2017-CT(R), 4/2017-CT(R), 10/2017-IT(R), 5/2022-CT(R)), circulars 135/05/2020-GST and 140/10/2020-GST and the Supreme Court's decision in Safari Retreats with the Finance Act 2025 amendment of section 17(5)(d).",
    "The description in the books is all that is known about the use of a purchase. Check the lines marked 'check condition', and any block that depends on how the item is used (a vehicle, a building, food, insurance).",
    "Reverse charge check: every purchase is read against the services and goods notified for reverse charge (Notification 13/2017-CT(R) for services such as GTA, advocate, arbitral tribunal, sponsorship, director's fee, security service, renting of motor vehicle and residential dwelling, import of services; Notification 4/2017-CT(R) for goods such as raw cotton, cashew, tobacco leaves, scrap from the Government; section 9(4) for notified supplies from unregistered persons). The books usually leave the RCM column blank because the credit arises after the tax is paid, so where the supplier has charged no GST the tax is worked out here at the rate on the books or the notified rate. Where the supplier has charged GST (for example a GTA that opted for forward charge) the case is noted and no RCM is payable. The client's purchase ledger is also scanned for entries that are in neither the register nor GSTR-2B. Rows marked verify depend on conditions or notifications that must be confirmed.",
    "Reverse charge: tax is paid in cash. The credit is claimed in the same return in Table 4(A)(3) but can be used only from the next month. It does not reduce this month's cash payment.",
    "Outward tax is taken from the GSTR-1 PDF (total liability, net of credit notes and amendments) and set off in the statutory order: IGST credit against IGST, CGST, SGST; CGST credit against CGST, IGST; SGST credit against SGST, IGST.",
    "Not included: import of goods (bill of entry), ISD credit not in the books, ITC reclaimed, interest, late fee, rule 37 reversal for non-payment to suppliers within 180 days, rule 43 on capital goods, and any notification issued after this working was built. Review before filing.",
  ].forEach((t, i) => { const x = ns.getCell(i + 1, 1); x.value = t; x.alignment = { wrapText: true, vertical: "top" }; x.font = { name: "Calibri", size: i === 0 ? 12 : 10, bold: i === 0 }; });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
