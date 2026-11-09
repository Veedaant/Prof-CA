// GSTR-1 Excel offline-utility column mappings. Update when GSTN changes the official format.
const money = "#,##0.00";
const col = (key, header, width, format) => ({ key, header, width, ...(format ? { format } : {}) });

// Line-level detail shared by the invoice-style sheets: one row per HSN/line item, invoice value repeated.
const LINE_DETAIL = [
  col("hsn", "HSN/SAC", 14),
  col("description", "Description", 28),
  col("quantity", "Quantity", 12, "#,##0.00"),
  col("uqc", "UQC", 14),
];
const TAX_SPLIT = [
  col("igst_amount", "Integrated Tax (IGST)", 18, money),
  col("cgst_amount", "Central Tax (CGST)", 18, money),
  col("sgst_amount", "State/UT Tax (SGST)", 18, money),
];

export const GSTR1_SHEET_CONFIGS = {
  b2b: {
    sheet_title: "b2b",
    columns: [
      col("buyer_gstin", "GSTIN/UIN of Recipient", 20),
      col("buyer_name", "Receiver Name", 28),
      col("invoice_number", "Invoice Number", 18),
      col("invoice_date", "Invoice date", 14),
      col("invoice_total", "Invoice Value", 16, money),
      col("place_of_supply", "Place Of Supply", 16),
      col("reverse_charge", "Reverse Charge", 15),
      col("applicable_tax_rate", "Applicable % of Tax Rate", 22),
      col("invoice_type", "Invoice Type", 15),
      col("ecommerce_gstin", "E-Commerce GSTIN", 18),
      ...LINE_DETAIL,
      col("rate", "Rate", 12, "0.00"),
      col("taxable_value", "Taxable Value", 16, money),
      ...TAX_SPLIT,
      col("cess_amount", "Cess Amount", 14, money),
      col("supplier_name", "Supplier Name", 28),
      col("supplier_gstin", "Supplier GSTIN", 20),
    ],
  },
  b2cl: {
    sheet_title: "b2cl",
    columns: [
      col("buyer_name", "Receiver Name", 28),
      col("invoice_number", "Invoice Number", 18),
      col("invoice_date", "Invoice date", 14),
      col("invoice_total", "Invoice Value", 16, money),
      col("place_of_supply", "Place Of Supply", 16),
      col("applicable_tax_rate", "Applicable % of Tax Rate", 22),
      ...LINE_DETAIL,
      col("rate", "Rate", 12, "0.00"),
      col("taxable_value", "Taxable Value", 16, money),
      ...TAX_SPLIT,
      col("cess_amount", "Cess Amount", 14, money),
      col("ecommerce_gstin", "E-Commerce GSTIN", 18),
      col("supplier_name", "Supplier Name", 28),
      col("supplier_gstin", "Supplier GSTIN", 20),
    ],
  },
  b2cs: {
    sheet_title: "b2cs",
    columns: [
      col("type", "Type", 12),
      col("place_of_supply", "Place Of Supply", 16),
      col("applicable_tax_rate", "Applicable % of Tax Rate", 22),
      col("rate", "Rate", 12, "0.00"),
      col("taxable_value", "Taxable Value", 16, money),
      ...TAX_SPLIT,
      col("cess_amount", "Cess Amount", 14, money),
      col("ecommerce_gstin", "E-Commerce GSTIN", 18),
      col("supplier_name", "Supplier Name", 28),
      col("supplier_gstin", "Supplier GSTIN", 20),
    ],
  },
  cdnr: {
    sheet_title: "cdnr",
    columns: [
      col("buyer_gstin", "GSTIN/UIN of Recipient", 20),
      col("buyer_name", "Receiver Name", 28),
      col("invoice_number", "Note Number", 18),
      col("invoice_date", "Note Date", 14),
      col("note_type", "Note Type", 12),
      col("place_of_supply", "Place Of Supply", 16),
      col("reverse_charge", "Reverse Charge", 15),
      col("note_supply_type", "Note Supply Type", 18),
      col("invoice_total", "Note Value", 16, money),
      col("applicable_tax_rate", "Applicable % of Tax Rate", 22),
      ...LINE_DETAIL,
      col("rate", "Rate", 12, "0.00"),
      col("taxable_value", "Taxable Value", 16, money),
      ...TAX_SPLIT,
      col("cess_amount", "Cess Amount", 14, money),
      col("supplier_name", "Supplier Name", 28),
      col("supplier_gstin", "Supplier GSTIN", 20),
    ],
  },
  hsn: {
    sheet_title: "hsn",
    columns: [
      col("hsn", "HSN", 14),
      col("description", "Description", 30),
      col("uqc", "UQC", 12),
      col("total_quantity", "Total Quantity", 16, money),
      col("total_value", "Total Value", 16, money),
      col("taxable_value", "Taxable Value", 16, money),
      col("igst_amount", "Integrated Tax Amount", 20, money),
      col("cgst_amount", "Central Tax Amount", 18, money),
      col("sgst_amount", "State/UT Tax Amount", 18, money),
      col("cess_amount", "Cess Amount", 14, money),
    ],
  },
};
