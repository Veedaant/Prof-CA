import ExcelJS from "exceljs";

const safe = (s, used) => {
  let n = String(s).replace(/[\\/?*[\]:]/g, " ").slice(0, 28).trim() || "Sheet";
  let k = n, i = 2;
  while (used.has(k.toLowerCase())) k = `${n.slice(0, 25)} ${i++}`;
  used.add(k.toLowerCase());
  return k;
};

export async function reportToWorkbook(report) {
  const wb = new ExcelJS.Workbook();
  const used = new Set();
  const head = wb.addWorksheet(safe("Summary", used));
  head.addRow([report.title]).font = { bold: true, size: 14 };
  head.addRow(["Client", report.client?.name || "", "GSTIN", report.client?.gstin || ""]);
  head.addRow(["Period", report.fy ? `FY ${report.fy}` : `${report.from} to ${report.to}`]);
  head.addRow([]);
  head.addRow(["Discrepancies", report.summary.total, "High", report.summary.high, "Medium", report.summary.medium, "Low", report.summary.low]);
  if (report.missing?.length) { head.addRow([]); head.addRow(["Not yet available:"]).font = { bold: true }; report.missing.forEach((m) => head.addRow(["", m])); }
  if (report.pending_approval) head.addRow(["", `${report.pending_approval} invoice(s) are awaiting client approval and are not included.`]);
  head.columns = [{ width: 24 }, { width: 40 }, { width: 14 }, { width: 18 }, { width: 12 }, { width: 8 }, { width: 8 }, { width: 8 }];

  const addTable = (ws, columns, rows) => {
    const hr = ws.addRow(columns.map((c) => c.label));
    hr.font = { bold: true, color: { argb: "FFFFFFFF" } };
    hr.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF111111" } }; c.alignment = { wrapText: true, vertical: "middle" }; });
    for (const r of rows) {
      const row = ws.addRow(columns.map((c) => (r[c.key] === undefined || r[c.key] === null ? "" : r[c.key])));
      if (r._total) row.font = { bold: true };
      columns.forEach((c, i) => {
        const cell = row.getCell(i + 1);
        if (c.type === "money") { cell.numFmt = "#,##0.00;[Red]-#,##0.00"; if (c.diff && Number(r[c.key])) cell.font = { color: { argb: "FFC00000" }, bold: true }; }
        if (c.type === "long") cell.alignment = { wrapText: true, vertical: "top" };
      });
    }
    ws.columns.forEach((col, i) => { col.width = columns[i].type === "long" ? 55 : columns[i].type === "money" ? 16 : columns[i].key === "desc" ? 55 : 18; });
    ws.views = [{ state: "frozen", ySplit: 1 }];
  };

  for (const s of report.sections) {
    const ws = wb.addWorksheet(safe(s.title.replace(/^\d+[A-Z]?\.\s*/, ""), used));
    if (s.note) { ws.addRow([s.note]).font = { italic: true }; ws.addRow([]); }
    const startRow = ws.rowCount;
    const t = wb.addWorksheet("__tmp");
    addTable(t, s.columns, s.rows);
    t.eachRow((row) => { const nr = ws.addRow(row.values.slice(1)); nr.font = row.font; row.eachCell({ includeEmpty: true }, (c, n) => { const d = nr.getCell(n); d.numFmt = c.numFmt; d.fill = c.fill; d.alignment = c.alignment; if (c.font) d.font = c.font; }); });
    t.columns.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });
    wb.removeWorksheet(t.id);
    ws.views = [{ state: "frozen", ySplit: startRow + 1 }];
  }

  const dws = wb.addWorksheet(safe("Discrepancy report", used));
  addTable(dws, [
    { key: "severity", label: "Severity", type: "text" }, { key: "area", label: "Area", type: "text" }, { key: "issue", label: "Issue", type: "text" }, { key: "period", label: "Month", type: "text" },
    { key: "party", label: "Party", type: "text" }, { key: "gstin", label: "GSTIN", type: "text" }, { key: "ref", label: "Reference", type: "text" }, { key: "amount", label: "Amount", type: "money" },
    { key: "reason", label: "Possible reason", type: "long" }, { key: "action", label: "Recommended action", type: "long" },
  ], report.discrepancies);
  return wb.xlsx.writeBuffer();
}

export async function ledgerTemplate(kind) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(kind === "purchase_ledger" ? "Purchase Ledger" : "Sales Ledger");
  const base = ["Date", "Invoice No", kind === "purchase_ledger" ? "Supplier Name" : "Party Name", "GSTIN", "Place of Supply", "Taxable Value", "Rate %", "IGST", "CGST", "SGST", "Cess", "Invoice Value", "Type (Invoice/Credit Note/Debit Note)"];
  if (kind === "purchase_ledger") base.push("RCM (Y/N)", "ITC Eligible (Y/N)");
  ws.addRow(base).font = { bold: true };
  ws.addRow(["2026-04-05", "INV-001", "Sample Party", "27ABCDE1234F1Z5", "Maharashtra", 10000, 18, 0, 900, 900, 0, 11800, "Invoice", ...(kind === "purchase_ledger" ? ["N", "Y"] : [])]);
  ws.columns.forEach((c) => { c.width = 20; });
  return wb.xlsx.writeBuffer();
}
