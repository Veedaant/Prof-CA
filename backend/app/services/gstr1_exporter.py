import io
from typing import List, Dict, Any, Tuple
from collections import defaultdict
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

from app.services.gstr1_mapping import GSTR1_SHEET_CONFIGS
from app.services.validators import extract_state_code, STATE_CODES
from app.models import Invoice, LineItem

HEADER_FILL = PatternFill(start_color="1F497D", end_color="1F497D", fill_type="solid")
HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
DATA_FONT = Font(name="Calibri", size=10)
BORDER_THIN = Border(
    left=Side(style="thin", color="D9D9D9"),
    right=Side(style="thin", color="D9D9D9"),
    top=Side(style="thin", color="D9D9D9"),
    bottom=Side(style="thin", color="D9D9D9")
)

def format_date_gstr1(date_str: str) -> str:
    """Formats YYYY-MM-DD to official GSTR-1 format DD-MMM-YYYY"""
    if not date_str:
        return ""
    try:
        from datetime import datetime
        dt = datetime.strptime(str(date_str)[:10], "%Y-%m-%d")
        return dt.strftime("%d-%b-%Y")
    except Exception:
        return str(date_str)

def format_place_of_supply(pos_input: str) -> str:
    """Formats place of supply into standard GSTR-1 format: '27-Maharashtra'"""
    if not pos_input:
        return "27-Maharashtra"
    code = extract_state_code(pos_input)
    if code and code in STATE_CODES:
        return f"{code}-{STATE_CODES[code]}"
    return str(pos_input)

def generate_gstr1_workbook(invoices: List[Invoice]) -> io.BytesIO:
    """
    Builds an official multi-sheet GSTR-1 Excel workbook matching the offline utility.
    Sheets: b2b, b2cl, b2cs, cdnr, hsn
    Strictly includes uqc, place of supply, invoice value, rate, taxable value.
    """
    wb = openpyxl.Workbook()
    # Remove default sheet
    wb.remove(wb.active)

    # 1. Categorize data
    b2b_rows = []
    b2cl_rows = []
    b2cs_map = defaultdict(lambda: {"taxable_value": 0.0, "cess_amount": 0.0})
    cdnr_rows = []
    hsn_map = defaultdict(lambda: {
        "description": "",
        "uqc": "NOS-NUMBERS",
        "total_quantity": 0.0,
        "total_value": 0.0,
        "taxable_value": 0.0,
        "igst_amount": 0.0,
        "cgst_amount": 0.0,
        "sgst_amount": 0.0,
        "cess_amount": 0.0
    })

    for inv in invoices:
        sup_state_code = extract_state_code(inv.supplier_gstin) or "27"
        pos_code = extract_state_code(inv.place_of_supply) or sup_state_code
        pos_formatted = format_place_of_supply(inv.place_of_supply or pos_code)
        
        is_inter_state = (sup_state_code != pos_code)
        is_registered = bool(inv.buyer_gstin and len(inv.buyer_gstin.strip()) == 15)
        is_credit_debit = inv.invoice_type in ["credit_note", "debit_note"]

        # HSN aggregation across all line items
        for item in inv.line_items:
            hsn = str(item.hsn_sac or "9999").strip()
            desc = item.description or "Goods / Services"
            hsn_entry = hsn_map[hsn]
            if not hsn_entry["description"]:
                hsn_entry["description"] = desc
            
            # Use explicit UQC code (e.g. NOS-NUMBERS, PCS-PIECES, KGS-KILOGRAMS)
            raw_uqc = getattr(item, "uqc", None) or getattr(item, "unit", None) or "NOS"
            if "-" not in str(raw_uqc):
                uqc_formatted = f"{raw_uqc}-NUMBERS" if raw_uqc in ["NOS", "PCS"] else f"{raw_uqc}-OTHERS"
            else:
                uqc_formatted = str(raw_uqc)
            hsn_entry["uqc"] = uqc_formatted
            
            hsn_entry["total_quantity"] += float(item.quantity or 1.0)
            
            # Tax rate
            rate_combined = float(item.cgst_rate + item.sgst_rate + item.igst_rate)
            if rate_combined == 0 and float(item.rate or 0) > 0 and float(item.rate or 0) <= 28:
                rate_combined = float(item.rate)
            
            item_tax = float(item.cgst_amount + item.sgst_amount + item.igst_amount + item.cess)
            item_total = float(item.taxable_value + item_tax)
            
            hsn_entry["total_value"] += item_total
            hsn_entry["taxable_value"] += float(item.taxable_value)
            hsn_entry["igst_amount"] += float(item.igst_amount)
            hsn_entry["cgst_amount"] += float(item.cgst_amount)
            hsn_entry["sgst_amount"] += float(item.sgst_amount)
            hsn_entry["cess_amount"] += float(item.cess)

            # Categorize by invoice type
            if is_credit_debit and is_registered:
                cdnr_rows.append({
                    "buyer_gstin": inv.buyer_gstin,
                    "buyer_name": inv.buyer_name or "",
                    "invoice_number": inv.invoice_number or "",
                    "invoice_date": format_date_gstr1(inv.invoice_date),
                    "note_type": "C" if inv.invoice_type == "credit_note" else "D",
                    "place_of_supply": pos_formatted,
                    "reverse_charge": "Y" if inv.reverse_charge else "N",
                    "note_supply_type": "Regular",
                    "invoice_total": float(inv.invoice_total),
                    "applicable_tax_rate": "",
                    "rate": rate_combined,
                    "taxable_value": float(item.taxable_value),
                    "cess_amount": float(item.cess),
                })
            elif is_registered:
                b2b_rows.append({
                    "buyer_gstin": inv.buyer_gstin,
                    "buyer_name": inv.buyer_name or "",
                    "invoice_number": inv.invoice_number or "",
                    "invoice_date": format_date_gstr1(inv.invoice_date),
                    "invoice_total": float(inv.invoice_total),
                    "place_of_supply": pos_formatted,
                    "reverse_charge": "Y" if inv.reverse_charge else "N",
                    "applicable_tax_rate": "",
                    "invoice_type": "Regular",
                    "ecommerce_gstin": "",
                    "rate": rate_combined,
                    "taxable_value": float(item.taxable_value),
                    "cess_amount": float(item.cess),
                })
            else:
                # Unregistered Buyer (B2C)
                if is_inter_state and float(inv.invoice_total) > 250000:
                    # B2CL: Inter-state > 2.5 Lakhs
                    b2cl_rows.append({
                        "invoice_number": inv.invoice_number or "",
                        "invoice_date": format_date_gstr1(inv.invoice_date),
                        "invoice_total": float(inv.invoice_total),
                        "place_of_supply": pos_formatted,
                        "applicable_tax_rate": "",
                        "rate": rate_combined,
                        "taxable_value": float(item.taxable_value),
                        "cess_amount": float(item.cess),
                        "ecommerce_gstin": "",
                    })
                else:
                    # B2CS: Small B2C summary by (POS, Rate)
                    key = (pos_formatted, rate_combined)
                    b2cs_map[key]["taxable_value"] += float(item.taxable_value)
                    b2cs_map[key]["cess_amount"] += float(item.cess)

    # Flatten B2CS
    b2cs_rows = []
    for (pos_val, rate_val), vals in b2cs_map.items():
        b2cs_rows.append({
            "type": "OE",  # Other than E-commerce
            "place_of_supply": pos_val,
            "applicable_tax_rate": "",
            "rate": rate_val,
            "taxable_value": round(vals["taxable_value"], 2),
            "cess_amount": round(vals["cess_amount"], 2),
            "ecommerce_gstin": "",
        })

    # Flatten HSN
    hsn_rows = []
    for hsn_code, vals in hsn_map.items():
        hsn_rows.append({
            "hsn": hsn_code,
            "description": vals["description"][:30],
            "uqc": vals["uqc"],
            "total_quantity": round(vals["total_quantity"], 2),
            "total_value": round(vals["total_value"], 2),
            "taxable_value": round(vals["taxable_value"], 2),
            "igst_amount": round(vals["igst_amount"], 2),
            "cgst_amount": round(vals["cgst_amount"], 2),
            "sgst_amount": round(vals["sgst_amount"], 2),
            "cess_amount": round(vals["cess_amount"], 2),
        })

    sheet_datasets = {
        "b2b": b2b_rows,
        "b2cl": b2cl_rows,
        "b2cs": b2cs_rows,
        "cdnr": cdnr_rows,
        "hsn": hsn_rows
    }

    # Build sheets
    for sheet_key, config in GSTR1_SHEET_CONFIGS.items():
        ws = wb.create_sheet(title=config["sheet_title"])
        cols = config["columns"]

        # Write Headers
        for col_idx, col in enumerate(cols, 1):
            cell = ws.cell(row=1, column=col_idx, value=col["header"])
            cell.fill = HEADER_FILL
            cell.font = HEADER_FONT
            cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            cell.border = BORDER_THIN

            # Set column width
            col_letter = get_column_letter(col_idx)
            ws.column_dimensions[col_letter].width = col.get("width", 15)

        ws.row_dimensions[1].height = 28

        # Write Data
        data = sheet_datasets.get(sheet_key, [])
        for row_idx, record in enumerate(data, 2):
            for col_idx, col in enumerate(cols, 1):
                val = record.get(col["key"], "")
                cell = ws.cell(row=row_idx, column=col_idx, value=val)
                cell.font = DATA_FONT
                cell.border = BORDER_THIN
                
                fmt = col.get("format")
                if fmt and isinstance(val, (int, float)):
                    cell.number_format = fmt
                    cell.alignment = Alignment(horizontal="right", vertical="center")
                else:
                    cell.alignment = Alignment(horizontal="left", vertical="center")

            ws.row_dimensions[row_idx].height = 20

    out = io.BytesIO()
    wb.save(out)
    out.seek(0)
    return out
