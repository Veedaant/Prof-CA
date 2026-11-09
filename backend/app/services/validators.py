import re
from typing import List, Dict, Any, Optional
from datetime import datetime

GSTIN_REGEX = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")
HSN_REGEX = re.compile(r"^\d{4}$|^\d{6}$|^\d{8}$")

CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
CHAR_MAP = {c: i for i, c in enumerate(CHARS)}

STATE_CODES = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
    "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan",
    "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
    "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura",
    "17": "Meghalaya", "18": "Assam", "19": "West Bengal", "20": "Jharkhand",
    "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka",
    "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu",
    "34": "Puducherry", "35": "Andaman & Nicobar Islands", "36": "Telangana",
    "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory"
}

def validate_gstin_format(gstin: Optional[str]) -> bool:
    if not gstin or not isinstance(gstin, str):
        return False
    return bool(GSTIN_REGEX.match(gstin.strip().upper()))

def validate_gstin_checksum(gstin: Optional[str]) -> bool:
    """
    Validates GSTIN check digit using official GSTN Mod 36 Luhn-variant algorithm.
    """
    if not validate_gstin_format(gstin):
        return False

    gstin = gstin.strip().upper()
    total_sum = 0

    for i in range(14):
        c = gstin[i]
        code_point = CHAR_MAP.get(c, 0)
        # Factor is 1 for odd positions (0-indexed even), 2 for even positions (0-indexed odd)
        factor = 2 if (i % 2 == 1) else 1
        product = code_point * factor
        quotient = product // 36
        remainder = product % 36
        total_sum += quotient + remainder

    check_code = (36 - (total_sum % 36)) % 36
    expected_char = CHARS[check_code]
    return gstin[14] == expected_char

def extract_state_code(gstin_or_pos: Optional[str]) -> Optional[str]:
    """Extracts 2-digit state code from GSTIN or POS string"""
    if not gstin_or_pos:
        return None
    val = str(gstin_or_pos).strip().upper()
    # Check if starts with 2 digits
    if len(val) >= 2 and val[:2].isdigit() and val[:2] in STATE_CODES:
        return val[:2]
    # Check if state name matches
    for code, name in STATE_CODES.items():
        if name.upper() in val or val in name.upper():
            return code
    return None

def validate_invoice(
    invoice_data: Dict[str, Any],
    line_items: List[Dict[str, Any]],
    expected_tax_period: Optional[str] = None,
    qr_data: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    Runs complete GST validation suite and returns list of validation flags.
    """
    flags = []

    supplier_gstin = (invoice_data.get("supplier_gstin") or "").strip().upper()
    buyer_gstin = (invoice_data.get("buyer_gstin") or "").strip().upper()
    pos = invoice_data.get("place_of_supply")
    
    # 1. Supplier GSTIN format & checksum
    if supplier_gstin:
        if not validate_gstin_format(supplier_gstin):
            flags.append({
                "type": "supplier_gstin_invalid_format",
                "severity": "error",
                "field": "supplier_gstin",
                "message": f"Supplier GSTIN '{supplier_gstin}' is not a valid 15-character GSTIN format."
            })
        elif not validate_gstin_checksum(supplier_gstin):
            flags.append({
                "type": "supplier_gstin_checksum_failed",
                "severity": "error",
                "field": "supplier_gstin",
                "message": f"Supplier GSTIN '{supplier_gstin}' checksum validation failed."
            })
    else:
        flags.append({
            "type": "supplier_gstin_missing",
            "severity": "error",
            "field": "supplier_gstin",
            "message": "Supplier GSTIN is missing."
        })

    # 2. Buyer GSTIN format & checksum (if present, B2B)
    if buyer_gstin:
        if not validate_gstin_format(buyer_gstin):
            flags.append({
                "type": "buyer_gstin_invalid_format",
                "severity": "warning",
                "field": "buyer_gstin",
                "message": f"Buyer GSTIN '{buyer_gstin}' is not valid format."
            })
        elif not validate_gstin_checksum(buyer_gstin):
            flags.append({
                "type": "buyer_gstin_checksum_failed",
                "severity": "warning",
                "field": "buyer_gstin",
                "message": f"Buyer GSTIN '{buyer_gstin}' checksum validation failed."
            })

    # 3. Tax Math Check (tolerance Rs 1)
    taxable = float(invoice_data.get("total_taxable_value") or 0.0)
    cgst = float(invoice_data.get("cgst_total") or 0.0)
    sgst = float(invoice_data.get("sgst_total") or 0.0)
    igst = float(invoice_data.get("igst_total") or 0.0)
    cess = float(invoice_data.get("cess_total") or 0.0)
    total_tax = float(invoice_data.get("total_tax") or (cgst + sgst + igst + cess))
    inv_total = float(invoice_data.get("invoice_total") or 0.0)

    calculated_total = taxable + cgst + sgst + igst + cess
    if abs(calculated_total - inv_total) > 1.01:
        flags.append({
            "type": "tax_calculation_mismatch",
            "severity": "error",
            "field": "invoice_total",
            "message": f"Tax math mismatch: Taxable ({taxable:.2f}) + Taxes ({total_tax:.2f}) = {calculated_total:.2f}, but Invoice Total is {inv_total:.2f}."
        })

    # 4. State & Place of Supply (POS) Check
    supplier_state_code = extract_state_code(supplier_gstin)
    pos_state_code = extract_state_code(pos) or extract_state_code(buyer_gstin)

    if supplier_state_code and pos_state_code:
        is_intra_state = (supplier_state_code == pos_state_code)
        if is_intra_state:
            # Supplier state == POS -> intra-state: CGST + SGST must be used, IGST should be 0
            if igst > 0.5 and (cgst == 0 and sgst == 0):
                flags.append({
                    "type": "pos_tax_mismatch",
                    "severity": "error",
                    "field": "place_of_supply",
                    "message": f"Intra-state transaction (Supplier: {supplier_state_code}, POS: {pos_state_code}) must have CGST+SGST, but IGST was charged ({igst:.2f})."
                })
        else:
            # Inter-state -> IGST must be used, CGST + SGST should be 0
            if (cgst > 0.5 or sgst > 0.5) and igst == 0:
                flags.append({
                    "type": "pos_tax_mismatch",
                    "severity": "error",
                    "field": "place_of_supply",
                    "message": f"Inter-state transaction (Supplier: {supplier_state_code}, POS: {pos_state_code}) must have IGST, but CGST/SGST was charged."
                })

    # 5. HSN/SAC Code validation on line items
    for idx, item in enumerate(line_items):
        hsn = str(item.get("hsn_sac") or "").strip()
        if hsn:
            # Check length: 4, 6, or 8 digits
            if not HSN_REGEX.match(hsn):
                flags.append({
                    "type": "invalid_hsn_code",
                    "severity": "warning",
                    "field": f"line_items[{idx}].hsn_sac",
                    "message": f"Line item #{idx+1} has invalid HSN/SAC code '{hsn}'. HSN must be 4, 6, or 8 digits."
                })

    # 6. Date & Tax Period Check
    inv_date = invoice_data.get("invoice_date")
    if inv_date:
        try:
            # Check valid date
            dt = datetime.strptime(str(inv_date)[:10], "%Y-%m-%d")
            # If expected_tax_period provided (format YYYY-MM)
            if expected_tax_period:
                inv_period = dt.strftime("%Y-%m")
                if inv_period != expected_tax_period:
                    flags.append({
                        "type": "tax_period_mismatch",
                        "severity": "warning",
                        "field": "invoice_date",
                        "message": f"Invoice date {inv_date} falls in {inv_period}, but selected tax period is {expected_tax_period}."
                    })
        except ValueError:
            flags.append({
                "type": "invalid_date_format",
                "severity": "error",
                "field": "invoice_date",
                "message": f"Invoice date '{inv_date}' is not a valid date format (expected YYYY-MM-DD)."
            })
    else:
        flags.append({
            "type": "invoice_date_missing",
            "severity": "error",
            "field": "invoice_date",
            "message": "Invoice date is missing."
        })

    # 7. QR Code Cross-Check (if QR was decoded)
    if qr_data:
        qr_inv_num = (qr_data.get("invoice_number") or "").strip()
        ai_inv_num = (invoice_data.get("invoice_number") or "").strip()
        if qr_inv_num and ai_inv_num and qr_inv_num.lower() != ai_inv_num.lower():
            flags.append({
                "type": "qr_ai_mismatch_invoice_number",
                "severity": "warning",
                "field": "invoice_number",
                "message": f"Invoice number mismatch: QR has '{qr_inv_num}', AI extracted '{ai_inv_num}'."
            })

        qr_sup_gstin = (qr_data.get("supplier_gstin") or "").strip().upper()
        if qr_sup_gstin and supplier_gstin and qr_sup_gstin != supplier_gstin:
            flags.append({
                "type": "qr_ai_mismatch_supplier_gstin",
                "severity": "warning",
                "field": "supplier_gstin",
                "message": f"Supplier GSTIN mismatch: QR has '{qr_sup_gstin}', AI extracted '{supplier_gstin}'."
            })

        qr_tot = qr_data.get("invoice_total")
        if qr_tot is not None and inv_total > 0:
            if abs(float(qr_tot) - inv_total) > 1.01:
                flags.append({
                    "type": "qr_ai_mismatch_total",
                    "severity": "warning",
                    "field": "invoice_total",
                    "message": f"Invoice total mismatch: QR has Rs {float(qr_tot):.2f}, AI extracted Rs {inv_total:.2f}."
                })

    return flags

def determine_review_status(confidence: float, flags: List[Dict[str, Any]]) -> str:
    """
    Set review_status to 'auto_approved' only if overall confidence is above 0.9
    and there are no validation flags (or errors). Otherwise 'needs_review'.
    """
    has_errors = any(f.get("severity") == "error" for f in flags)
    if confidence >= 0.90 and len(flags) == 0 and not has_errors:
        return "auto_approved"
    return "needs_review"
