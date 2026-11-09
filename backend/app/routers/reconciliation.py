import io
import re
import csv
from typing import List, Optional, Dict, Any
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Response, Query
from sqlalchemy.orm import Session
from sqlalchemy import desc
import openpyxl

from app.database import get_db
from app.models import Invoice, Client, User
from app.auth import get_current_user, require_ca_staff
from app.services.validators import validate_gstin_format, validate_gstin_checksum

router = APIRouter(prefix="/reconciliation", tags=["reconciliation"])

def normalize_gstin(gstin: Optional[str]) -> str:
    if not gstin:
        return ""
    return re.sub(r"[^A-Z0-9]", "", str(gstin).upper())

def normalize_inv_num(num: Optional[str]) -> str:
    if not num:
        return ""
    # Strip whitespace, slashes, dashes, hashes and uppercase for robust matching
    return re.sub(r"[\s\/\-_#]", "", str(num)).upper()

@router.get("/summary")
def get_reconciliation_summary(
    client_id: str = Query(...),
    tax_period: Optional[str] = Query(None),
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    """
    Analyzes all uploaded invoices for a client and period, identifying duplicates,
    tax calculation differences, and compliance anomalies.
    """
    client = db.query(Client).filter(
        Client.id == client_id,
        Client.firm_id == current_user.firm_id
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    query = db.query(Invoice).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client_id
    )
    if tax_period:
        query = query.filter(Invoice.tax_period == tax_period)

    invoices = query.order_by(Invoice.invoice_date.desc()).all()

    # Track duplicates by normalized invoice number
    inv_map: Dict[str, List[Invoice]] = {}
    for inv in invoices:
        key = normalize_inv_num(inv.invoice_number)
        if key:
            inv_map.setdefault(key, []).append(inv)

    duplicates_count = 0
    tax_math_mismatches = 0
    compliance_issues = 0
    results = []

    for inv in invoices:
        norm_key = normalize_inv_num(inv.invoice_number)
        is_duplicate = len(inv_map.get(norm_key, [])) > 1

        # Check math
        calc_tax = (inv.cgst_total or 0) + (inv.sgst_total or 0) + (inv.igst_total or 0) + (inv.cess_total or 0)
        calc_total = (inv.total_taxable_value or 0) + calc_tax
        math_diff = abs(calc_total - (inv.invoice_total or 0))
        is_math_mismatch = math_diff > 1.0

        # Compliance checks
        has_compliance_flag = any(f.get("severity") == "error" for f in (inv.flags or []))

        status_tag = "clean"
        status_label = "Clean / Verified"
        if is_duplicate:
            duplicates_count += 1
            status_tag = "duplicate"
            status_label = f"Duplicate ({len(inv_map[norm_key])} uploads)"
        elif is_math_mismatch:
            tax_math_mismatches += 1
            status_tag = "math_mismatch"
            status_label = f"Tax Math Mismatch (Diff: ₹{math_diff:.2f})"
        elif has_compliance_flag:
            compliance_issues += 1
            status_tag = "flagged"
            status_label = "Compliance Warning"

        results.append({
            "id": inv.id,
            "invoice_number": inv.invoice_number,
            "invoice_date": inv.invoice_date,
            "supplier_name": inv.supplier_name,
            "supplier_gstin": inv.supplier_gstin,
            "buyer_name": inv.buyer_name,
            "buyer_gstin": inv.buyer_gstin,
            "place_of_supply": inv.place_of_supply,
            "taxable_value": inv.total_taxable_value,
            "total_tax": inv.total_tax,
            "invoice_total": inv.invoice_total,
            "review_status": inv.review_status,
            "reconciliation_status": status_tag,
            "reconciliation_label": status_label,
            "duplicate_count": len(inv_map.get(norm_key, [])),
            "flags": inv.flags or []
        })

    clean_count = len(invoices) - duplicates_count - tax_math_mismatches - compliance_issues
    if clean_count < 0:
        clean_count = 0

    return {
        "client_id": client.id,
        "client_name": client.name,
        "tax_period": tax_period or "All",
        "total_invoices": len(invoices),
        "clean_count": clean_count,
        "duplicates_count": duplicates_count,
        "math_mismatches_count": tax_math_mismatches,
        "compliance_issues_count": compliance_issues,
        "invoices": results
    }


@router.post("/match-register")
async def match_with_external_register(
    client_id: str = Form(...),
    tax_period: Optional[str] = Form(None),
    file: UploadFile = File(...),
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    """
    Compares uploaded sales/purchase register against extracted invoices.
    Returns matched records, value discrepancies, and missing invoices.
    """
    client = db.query(Client).filter(
        Client.id == client_id,
        Client.firm_id == current_user.firm_id
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    content = await file.read()
    filename = file.filename.lower()

    # Parse rows from Excel or CSV
    register_rows: List[Dict[str, Any]] = []

    if filename.endswith(".xlsx") or filename.endswith(".xls"):
        wb = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        sheet = wb.active
        headers = []
        for row in sheet.iter_rows(values_only=True):
            if not row or all(v is None for v in row):
                continue
            if not headers:
                headers = [str(cell).strip().lower().replace(" ", "_") if cell else f"col_{i}" for i, cell in enumerate(row)]
                continue
            row_dict = {}
            for i, val in enumerate(row):
                if i < len(headers):
                    row_dict[headers[i]] = val
            register_rows.append(row_dict)
    elif filename.endswith(".csv") or filename.endswith(".txt"):
        text = content.decode("utf-8", errors="ignore")
        reader = csv.DictReader(io.StringIO(text))
        for row in reader:
            normalized_row = {str(k).strip().lower().replace(" ", "_"): v for k, v in row.items() if k}
            register_rows.append(normalized_row)
    else:
        raise HTTPException(status_code=400, detail="Only .xlsx or .csv files are supported for register matching")

    if not register_rows:
        raise HTTPException(status_code=400, detail="The uploaded register file contains no data rows")

    # Helper to find key in row dict
    def get_field_val(row: Dict[str, Any], candidates: List[str]) -> Any:
        for c in candidates:
            for k in row:
                if c in k:
                    return row[k]
        return None

    # Fetch app invoices
    query = db.query(Invoice).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client_id
    )
    if tax_period:
        query = query.filter(Invoice.tax_period == tax_period)
    app_invoices = query.all()

    # Index app invoices by normalized invoice number
    app_inv_map: Dict[str, Invoice] = {}
    matched_app_invoice_ids = set()

    for inv in app_invoices:
        norm = normalize_inv_num(inv.invoice_number)
        if norm:
            app_inv_map[norm] = inv

    matched_records = []
    exact_matches = 0
    value_mismatches = 0
    date_mismatches = 0
    missing_in_invoices = 0

    for idx, row in enumerate(register_rows):
        raw_inv_no = get_field_val(row, ["invoice_no", "inv_no", "bill_no", "doc_no", "voucher_no", "invoice"])
        raw_date = get_field_val(row, ["date", "inv_date", "invoice_date", "bill_date"])
        raw_gstin = get_field_val(row, ["gstin", "party_gstin", "buyer_gstin", "supplier_gstin", "uin"])
        raw_taxable = get_field_val(row, ["taxable", "basic", "net_amount"])
        raw_total = get_field_val(row, ["total", "invoice_value", "grand_total", "invoice_total", "amount"])

        inv_no_str = str(raw_inv_no or "").strip()
        norm_key = normalize_inv_num(inv_no_str)

        # Parse amounts
        try:
            reg_taxable = float(str(raw_taxable).replace(",", "").replace("₹", "")) if raw_taxable is not None else 0.0
        except ValueError:
            reg_taxable = 0.0

        try:
            reg_total = float(str(raw_total).replace(",", "").replace("₹", "")) if raw_total is not None else 0.0
        except ValueError:
            reg_total = 0.0

        app_inv = app_inv_map.get(norm_key)

        if app_inv:
            matched_app_invoice_ids.add(app_inv.id)
            taxable_diff = round(abs((app_inv.total_taxable_value or 0) - reg_taxable), 2)
            total_diff = round(abs((app_inv.invoice_total or 0) - reg_total), 2)
            
            # Check date match
            app_date_str = str(app_inv.invoice_date or "")
            reg_date_str = str(raw_date or "").split(" ")[0]
            dates_match = app_date_str == reg_date_str or not reg_date_str

            if taxable_diff <= 1.0 and total_diff <= 1.0 and dates_match:
                status_code = "exact_match"
                status_text = "Exact Match"
                exact_matches += 1
            elif not dates_match and taxable_diff <= 1.0 and total_diff <= 1.0:
                status_code = "date_mismatch"
                status_text = f"Date Mismatch (App: {app_date_str} vs Reg: {reg_date_str})"
                date_mismatches += 1
            else:
                status_code = "value_mismatch"
                status_text = f"Value Mismatch (Diff: ₹{total_diff:.2f})"
                value_mismatches += 1

            matched_records.append({
                "row_index": idx + 1,
                "invoice_number": inv_no_str or app_inv.invoice_number,
                "status": status_code,
                "status_text": status_text,
                "register": {
                    "invoice_number": inv_no_str,
                    "date": reg_date_str,
                    "gstin": str(raw_gstin or ""),
                    "taxable_value": reg_taxable,
                    "total_value": reg_total,
                },
                "app_invoice": {
                    "id": app_inv.id,
                    "invoice_number": app_inv.invoice_number,
                    "date": app_date_str,
                    "supplier_gstin": app_inv.supplier_gstin,
                    "buyer_gstin": app_inv.buyer_gstin,
                    "taxable_value": app_inv.total_taxable_value,
                    "total_value": app_inv.invoice_total,
                    "review_status": app_inv.review_status
                },
                "difference": {
                    "taxable": taxable_diff,
                    "total": total_diff
                }
            })
        else:
            missing_in_invoices += 1
            matched_records.append({
                "row_index": idx + 1,
                "invoice_number": inv_no_str,
                "status": "missing_in_invoices",
                "status_text": "Missing in Uploaded Invoices",
                "register": {
                    "invoice_number": inv_no_str,
                    "date": str(raw_date or "").split(" ")[0],
                    "gstin": str(raw_gstin or ""),
                    "taxable_value": reg_taxable,
                    "total_value": reg_total,
                },
                "app_invoice": None,
                "difference": None
            })

    # Any app invoices missing in register
    missing_in_register = 0
    for inv in app_invoices:
        if inv.id not in matched_app_invoice_ids:
            missing_in_register += 1
            matched_records.append({
                "row_index": None,
                "invoice_number": inv.invoice_number,
                "status": "missing_in_register",
                "status_text": "Missing in Uploaded Register",
                "register": None,
                "app_invoice": {
                    "id": inv.id,
                    "invoice_number": inv.invoice_number,
                    "date": inv.invoice_date,
                    "supplier_gstin": inv.supplier_gstin,
                    "buyer_gstin": inv.buyer_gstin,
                    "taxable_value": inv.total_taxable_value,
                    "total_value": inv.invoice_total,
                    "review_status": inv.review_status
                },
                "difference": None
            })

    return {
        "summary": {
            "total_register_rows": len(register_rows),
            "total_app_invoices": len(app_invoices),
            "exact_matches": exact_matches,
            "value_mismatches": value_mismatches,
            "date_mismatches": date_mismatches,
            "missing_in_invoices": missing_in_invoices,
            "missing_in_register": missing_in_register,
            "match_rate_percent": round((exact_matches / len(register_rows) * 100) if register_rows else 0, 1)
        },
        "records": matched_records
    }


@router.get("/sample-template")
def download_sample_template():
    """
    Generates and returns an Excel sales register template with sample rows.
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sales_Register"

    headers = [
        "Invoice Number", "Invoice Date", "Customer GSTIN", "Customer Name",
        "Place of Supply", "Taxable Value", "Rate (%)", "CGST", "SGST", "IGST", "Invoice Total"
    ]
    ws.append(headers)

    # Style header row
    for col in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col)
        cell.font = openpyxl.styles.Font(bold=True, color="FFFFFF")
        cell.fill = openpyxl.styles.PatternFill("solid", fgColor="1E40AF")

    sample_data = [
        ["INV-2025-001", "2025-01-10", "27AAACA1234A1ZK", "Apex Solutions Ltd", "27-Maharashtra", 25000.0, 18, 2250.0, 2250.0, 0.0, 29500.0],
        ["INV-2025-002", "2025-01-12", "29AABCZ9876K1Z9", "Global Enterprises", "29-Karnataka", 45000.0, 18, 0.0, 0.0, 8100.0, 53100.0],
        ["INV-2025-003", "2025-01-15", "27AAACA1234A1ZK", "Bharat Trading Co", "27-Maharashtra", 12500.0, 18, 1125.0, 1125.0, 0.0, 14750.0],
        ["INV-2025-004", "2025-01-18", "27AAACA1234A1ZK", "Sunrise Tech Pvt Ltd", "27-Maharashtra", 8000.0, 18, 720.0, 720.0, 0.0, 9440.0],
    ]

    for row in sample_data:
        ws.append(row)

    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="Sample_Sales_Register_Template.xlsx"'}
    )
