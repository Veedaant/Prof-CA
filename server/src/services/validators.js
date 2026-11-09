export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const HSN_REGEX = /^(\d{4}|\d{6}|\d{8})$/;

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const STATE_CODES = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
  "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
  "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
  "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
  "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
  "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
  "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

export function validateGstinFormat(gstin) {
  if (!gstin || typeof gstin !== "string") return false;
  return GSTIN_REGEX.test(gstin.trim().toUpperCase());
}

export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const cp = Math.max(CHARS.indexOf(first14[i]), 0);
    const product = cp * (i % 2 === 1 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export function validateGstinChecksum(gstin) {
  if (!validateGstinFormat(gstin)) return false;
  const g = gstin.trim().toUpperCase();
  return g[14] === gstinCheckChar(g.slice(0, 14));
}

export function extractStateCode(value) {
  if (!value) return null;
  const val = String(value).trim().toUpperCase();
  if (val.length >= 2 && /^\d{2}/.test(val) && STATE_CODES[val.slice(0, 2)]) return val.slice(0, 2);
  for (const [code, name] of Object.entries(STATE_CODES)) {
    const n = name.toUpperCase();
    if (val.includes(n) || n.includes(val)) return code;
  }
  return null;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseIsoDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}`;
}

export function validateInvoice(inv, lineItems = [], expectedTaxPeriod = null, qr = null) {
  const flags = [];
  const supplierGstin = (inv.supplier_gstin || "").trim().toUpperCase();
  const buyerGstin = (inv.buyer_gstin || "").trim().toUpperCase();
  const pos = inv.place_of_supply;

  if (supplierGstin) {
    if (!validateGstinFormat(supplierGstin)) {
      flags.push({ type: "supplier_gstin_invalid_format", severity: "error", field: "supplier_gstin", message: `Supplier GSTIN '${supplierGstin}' is not a valid 15-character GSTIN format.` });
    } else if (!validateGstinChecksum(supplierGstin)) {
      flags.push({ type: "supplier_gstin_checksum_failed", severity: "error", field: "supplier_gstin", message: `Supplier GSTIN '${supplierGstin}' checksum validation failed.` });
    }
  } else {
    flags.push({ type: "supplier_gstin_missing", severity: "error", field: "supplier_gstin", message: "Supplier GSTIN is missing." });
  }

  if (buyerGstin) {
    if (!validateGstinFormat(buyerGstin)) {
      flags.push({ type: "buyer_gstin_invalid_format", severity: "warning", field: "buyer_gstin", message: `Buyer GSTIN '${buyerGstin}' is not valid format.` });
    } else if (!validateGstinChecksum(buyerGstin)) {
      flags.push({ type: "buyer_gstin_checksum_failed", severity: "warning", field: "buyer_gstin", message: `Buyer GSTIN '${buyerGstin}' checksum validation failed.` });
    }
  }

  const taxable = num(inv.total_taxable_value);
  const cgst = num(inv.cgst_total);
  const sgst = num(inv.sgst_total);
  const igst = num(inv.igst_total);
  const cess = num(inv.cess_total);
  const totalTax = num(inv.total_tax) || cgst + sgst + igst + cess;
  const invTotal = num(inv.invoice_total);
  const calculated = taxable + cgst + sgst + igst + cess;
  if (Math.abs(calculated - invTotal) > 1.01) {
    flags.push({
      type: "tax_calculation_mismatch", severity: "error", field: "invoice_total",
      message: `Tax math mismatch: Taxable (${taxable.toFixed(2)}) + Taxes (${totalTax.toFixed(2)}) = ${calculated.toFixed(2)}, but Invoice Total is ${invTotal.toFixed(2)}.`,
    });
  }

  const supState = extractStateCode(supplierGstin);
  const posState = extractStateCode(pos) || extractStateCode(buyerGstin);
  if (supState && posState) {
    if (supState === posState) {
      if (igst > 0.5 && cgst === 0 && sgst === 0) {
        flags.push({ type: "pos_tax_mismatch", severity: "error", field: "place_of_supply", message: `Intra-state transaction (Supplier: ${supState}, POS: ${posState}) must have CGST+SGST, but IGST was charged (${igst.toFixed(2)}).` });
      }
    } else if ((cgst > 0.5 || sgst > 0.5) && igst === 0) {
      flags.push({ type: "pos_tax_mismatch", severity: "error", field: "place_of_supply", message: `Inter-state transaction (Supplier: ${supState}, POS: ${posState}) must have IGST, but CGST/SGST was charged.` });
    }
  }

  lineItems.forEach((item, idx) => {
    const hsn = String(item.hsn_sac || "").trim();
    if (hsn && !HSN_REGEX.test(hsn)) {
      flags.push({ type: "invalid_hsn_code", severity: "warning", field: `line_items[${idx}].hsn_sac`, message: `Line item #${idx + 1} has invalid HSN/SAC code '${hsn}'. HSN must be 4, 6, or 8 digits.` });
    }
  });

  const invDate = inv.invoice_date;
  if (invDate) {
    const period = parseIsoDate(invDate);
    if (!period) {
      flags.push({ type: "invalid_date_format", severity: "error", field: "invoice_date", message: `Invoice date '${invDate}' is not a valid date format (expected YYYY-MM-DD).` });
    } else if (expectedTaxPeriod && period !== expectedTaxPeriod) {
      flags.push({ type: "tax_period_mismatch", severity: "warning", field: "invoice_date", message: `Invoice date ${invDate} falls in ${period}, but selected tax period is ${expectedTaxPeriod}.` });
    }
  } else {
    flags.push({ type: "invoice_date_missing", severity: "error", field: "invoice_date", message: "Invoice date is missing." });
  }

  if (qr) {
    const qrNum = (qr.invoice_number || "").trim();
    const aiNum = (inv.invoice_number || "").trim();
    if (qrNum && aiNum && qrNum.toLowerCase() !== aiNum.toLowerCase()) {
      flags.push({ type: "qr_ai_mismatch_invoice_number", severity: "warning", field: "invoice_number", message: `Invoice number mismatch: QR has '${qrNum}', AI extracted '${aiNum}'.` });
    }
    const qrGstin = (qr.supplier_gstin || "").trim().toUpperCase();
    if (qrGstin && supplierGstin && qrGstin !== supplierGstin) {
      flags.push({ type: "qr_ai_mismatch_supplier_gstin", severity: "warning", field: "supplier_gstin", message: `Supplier GSTIN mismatch: QR has '${qrGstin}', AI extracted '${supplierGstin}'.` });
    }
    const qrTot = qr.invoice_total;
    if (qrTot !== null && qrTot !== undefined && invTotal > 0 && Math.abs(num(qrTot) - invTotal) > 1.01) {
      flags.push({ type: "qr_ai_mismatch_total", severity: "warning", field: "invoice_total", message: `Invoice total mismatch: QR has Rs ${num(qrTot).toFixed(2)}, AI extracted Rs ${invTotal.toFixed(2)}.` });
    }
  }
  return flags;
}

export function determineReviewStatus(confidence, flags) {
  return confidence >= 0.9 && flags.length === 0 ? "auto_approved" : "needs_review";
}
