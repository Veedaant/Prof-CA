import io
import openpyxl
from app.models import Invoice, LineItem
from app.services.gstr1_exporter import generate_gstr1_workbook
from app.services.gstr1_mapping import GSTR1_SHEET_CONFIGS

def test_gstr1_workbook_structure():
    # Create mock invoice
    inv = Invoice(
        id="test-inv-1",
        firm_id="firm-1",
        client_id="client-1",
        invoice_type="sales",
        supplier_name="Apex Retailers",
        supplier_gstin="27AAACA1234A1Z5",
        buyer_name="Godrej Ltd",
        buyer_gstin="27AAACG1234G1Z8",
        invoice_number="INV/001",
        invoice_date="2025-01-15",
        place_of_supply="27",
        total_taxable_value=1000.0,
        cgst_total=90.0,
        sgst_total=90.0,
        igst_total=0.0,
        cess_total=0.0,
        total_tax=180.0,
        invoice_total=1180.0,
        review_status="approved",
        tax_period="2025-01"
    )
    li = LineItem(
        invoice_id="test-inv-1",
        description="LED Lighting Fixture",
        hsn_sac="9405",
        quantity=10.0,
        unit="NOS",
        rate=100.0,
        taxable_value=1000.0,
        cgst_rate=9.0,
        cgst_amount=90.0,
        sgst_rate=9.0,
        sgst_amount=90.0,
        igst_rate=0.0,
        igst_amount=0.0,
        cess=0.0
    )
    inv.line_items = [li]

    wb_io = generate_gstr1_workbook([inv])
    assert wb_io is not None

    wb = openpyxl.load_workbook(wb_io)
    
    # Assert all 5 official sheets exist
    for sheet_name in ["b2b", "b2cl", "b2cs", "cdnr", "hsn"]:
        assert sheet_name in wb.sheetnames

    # Check b2b sheet content
    ws_b2b = wb["b2b"]
    assert ws_b2b.max_row == 2  # header + 1 invoice row
    assert ws_b2b.cell(row=2, column=1).value == "27AAACG1234G1Z8"  # Buyer GSTIN
    assert ws_b2b.cell(row=2, column=3).value == "INV/001"  # Invoice Number
    assert ws_b2b.cell(row=2, column=5).value == 1180.0  # Invoice Total
    assert ws_b2b.cell(row=2, column=12).value == 1000.0  # Taxable Value

    # Check hsn sheet content
    ws_hsn = wb["hsn"]
    assert ws_hsn.max_row == 2  # header + 1 HSN row
    assert ws_hsn.cell(row=2, column=1).value == "9405"  # HSN
    assert ws_hsn.cell(row=2, column=4).value == 10.0  # Quantity
    assert ws_hsn.cell(row=2, column=6).value == 1000.0  # Taxable Value
