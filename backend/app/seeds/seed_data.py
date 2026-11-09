import io
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy.orm import Session

from app.database import SessionLocal, Base, engine
from app.models import Firm, User, Client, InvoiceFile, Invoice, LineItem, AuditLog
from app.auth import get_password_hash
from app.services.storage import storage_service
from app.services.validators import validate_invoice, determine_review_status

def create_sample_invoice_image(
    supplier_name: str,
    supplier_gstin: str,
    buyer_name: str,
    buyer_gstin: str,
    inv_num: str,
    inv_date: str,
    items: list,
    taxable_val: float,
    cgst: float,
    sgst: float,
    igst: float,
    total: float,
    with_qr_box: bool = False
) -> bytes:
    """Generates a clean, professional invoice image for previewing in split-view"""
    width = 1200
    height = 1600
    img = Image.new("RGB", (width, height), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)

    # Header banner
    draw.rectangle([(0, 0), (width, 140)], fill="#1E3A8A")
    draw.text((60, 45), "TAX INVOICE", fill="#FFFFFF", font_size=40)
    draw.text((width - 400, 45), f"Invoice #: {inv_num}", fill="#FFFFFF", font_size=28)
    draw.text((width - 400, 85), f"Date: {inv_date}", fill="#93C5FD", font_size=22)

    # Supplier Box
    draw.rectangle([(60, 180), (560, 360)], outline="#CBD5E1", width=2, fill="#F8FAFC")
    draw.text((80, 200), "SUPPLIER (ISSUER):", fill="#1E3A8A", font_size=20)
    draw.text((80, 235), supplier_name, fill="#0F172A", font_size=22)
    draw.text((80, 270), f"GSTIN: {supplier_gstin}", fill="#334155", font_size=20)
    draw.text((80, 305), "Address: MIDC Industrial Area, Mumbai", fill="#64748B", font_size=18)

    # Buyer Box
    draw.rectangle([(640, 180), (1140, 360)], outline="#CBD5E1", width=2, fill="#F8FAFC")
    draw.text((660, 200), "BILLED TO (RECIPIENT):", fill="#1E3A8A", font_size=20)
    draw.text((660, 235), buyer_name, fill="#0F172A", font_size=22)
    draw.text((660, 270), f"GSTIN: {buyer_gstin or 'UNREGISTERED CONSUMER'}", fill="#334155", font_size=20)
    draw.text((660, 305), "Place of Supply: State Code 27", fill="#64748B", font_size=18)

    if with_qr_box:
        # Simulated e-invoice QR box
        draw.rectangle([(width - 240, 390), (width - 60, 570)], outline="#000000", width=2, fill="#FFFFFF")
        # Draw simulated QR grid pattern
        for x in range(width - 220, width - 80, 16):
            for y in range(410, 550, 16):
                if (x + y) % 3 == 0 or (x * y) % 5 == 0:
                    draw.rectangle([(x, y), (x + 12, y + 12)], fill="#000000")
        draw.text((width - 235, 575), "IRN Verified e-Invoice", fill="#059669", font_size=15)

    # Table Header
    y_start = 620
    draw.rectangle([(60, y_start), (1140, y_start + 45)], fill="#E2E8F0")
    draw.text((80, y_start + 12), "#", fill="#1E293B", font_size=18)
    draw.text((140, y_start + 12), "Description", fill="#1E293B", font_size=18)
    draw.text((540, y_start + 12), "HSN", fill="#1E293B", font_size=18)
    draw.text((660, y_start + 12), "Qty", fill="#1E293B", font_size=18)
    draw.text((760, y_start + 12), "Rate", fill="#1E293B", font_size=18)
    draw.text((950, y_start + 12), "Taxable Amount", fill="#1E293B", font_size=18)

    # Rows
    y = y_start + 65
    for idx, it in enumerate(items):
        draw.text((80, y), str(idx + 1), fill="#334155", font_size=18)
        draw.text((140, y), it["description"][:36], fill="#0F172A", font_size=18)
        draw.text((540, y), it["hsn_sac"], fill="#334155", font_size=18)
        draw.text((660, y), f"{it['quantity']:.0f} {it['unit']}", fill="#334155", font_size=18)
        draw.text((760, y), f"Rs. {it['rate']:,.2f}", fill="#334155", font_size=18)
        draw.text((950, y), f"Rs. {it['taxable_value']:,.2f}", fill="#0F172A", font_size=18)
        draw.line([(60, y + 35), (1140, y + 35)], fill="#E2E8F0", width=1)
        y += 50

    # Summary box
    tot_y = 1180
    draw.rectangle([(640, tot_y), (1140, tot_y + 260)], outline="#CBD5E1", width=2, fill="#F8FAFC")
    draw.text((660, tot_y + 20), "Total Taxable Value:", fill="#475569", font_size=20)
    draw.text((950, tot_y + 20), f"Rs. {taxable_val:,.2f}", fill="#0F172A", font_size=20)

    if cgst > 0:
        draw.text((660, tot_y + 60), "Central Tax (CGST 9%):", fill="#475569", font_size=18)
        draw.text((950, tot_y + 60), f"Rs. {cgst:,.2f}", fill="#0F172A", font_size=18)
        draw.text((660, tot_y + 100), "State Tax (SGST 9%):", fill="#475569", font_size=18)
        draw.text((950, tot_y + 100), f"Rs. {sgst:,.2f}", fill="#0F172A", font_size=18)
    elif igst > 0:
        draw.text((660, tot_y + 60), "Integrated Tax (IGST 18%):", fill="#475569", font_size=18)
        draw.text((950, tot_y + 60), f"Rs. {igst:,.2f}", fill="#0F172A", font_size=18)

    draw.line([(640, tot_y + 160), (1140, tot_y + 160)], fill="#CBD5E1", width=2)
    draw.text((660, tot_y + 185), "GRAND TOTAL:", fill="#1E3A8A", font_size=24)
    draw.text((930, tot_y + 185), f"Rs. {total:,.2f}", fill="#1E3A8A", font_size=24)

    # Footer
    draw.text((60, height - 70), "Generated for GST Invoice Automator Verification", fill="#94A3B8", font_size=16)

    bio = io.BytesIO()
    img.save(bio, format="PNG")
    return bio.getvalue()

def seed_database():
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        # Check if firm already exists
        firm = db.query(Firm).first()
        if firm:
            print("Database already seeded. Skipping.")
            return

        print("Seeding demo CA firm...")
        firm = Firm(
            name="Sharma & Associates, Chartered Accountants",
            gstin="27AAAFS1234F1Z6",
            address="102 Marine Chambers, Fort, Mumbai 400001",
            phone="+91 22 2266 7788",
            email="contact@sharmaca.com"
        )
        db.add(firm)
        db.flush()

        print("Seeding users (admin, staff, clients)...")
        # 1. Admin
        admin_user = User(
            email="admin@example.com",
            password_hash=get_password_hash("admin123"),
            full_name="CA Rajesh Sharma",
            role="admin",
            firm_id=firm.id
        )
        db.add(admin_user)

        # 2. Staff
        staff_user = User(
            email="staff@example.com",
            password_hash=get_password_hash("staff123"),
            full_name="Pooja Mehta (Senior Articled Assistant)",
            role="staff",
            firm_id=firm.id
        )
        db.add(staff_user)

        # 3. Clients
        client1 = Client(
            firm_id=firm.id,
            name="Apex Retailers Pvt Ltd",
            trade_name="Apex Superstores",
            gstin="27AAACA1234A1Z5",
            email="accounts@apexretail.in",
            phone="+91 98200 11223",
            state="Maharashtra",
            state_code="27",
            address="Plot 45, Andheri MIDC, Mumbai 400093"
        )
        db.add(client1)
        db.flush()

        client2 = Client(
            firm_id=firm.id,
            name="Zenith Tech Solutions",
            trade_name="Zenith Cloud Services",
            gstin="29AABCZ9876K1ZQ",
            email="billing@zenithtech.io",
            phone="+91 80 4112 3344",
            state="Karnataka",
            state_code="29",
            address="Tower B, Tech Park, Whitefield, Bengaluru 560066"
        )
        db.add(client2)
        db.flush()

        # Client Users
        user_c1 = User(
            email="client1@example.com",
            password_hash=get_password_hash("client123"),
            full_name="Suresh Patel (Apex Retailers)",
            role="client",
            firm_id=firm.id,
            client_id=client1.id
        )
        db.add(user_c1)

        user_c2 = User(
            email="client2@example.com",
            password_hash=get_password_hash("client123"),
            full_name="Ananya Rao (Zenith Tech)",
            role="client",
            firm_id=firm.id,
            client_id=client2.id
        )
        db.add(user_c2)
        db.flush()

        print("Seeding 5 sample invoices with generated image files...")

        # Invoice 1: Clean B2B Intra-state (Auto-Approved)
        items1 = [
            {"description": "Industrial LED High Bay Light Fixture 150W", "hsn_sac": "9405", "quantity": 20.0, "unit": "NOS", "rate": 2500.0, "taxable_value": 50000.0, "cgst_rate": 9.0, "cgst_amount": 4500.0, "sgst_rate": 9.0, "sgst_amount": 4500.0, "igst_rate": 0.0, "igst_amount": 0.0, "cess": 0.0},
            {"description": "Heavy Duty Industrial Power Cable 100m", "hsn_sac": "8544", "quantity": 5.0, "unit": "ROL", "rate": 6000.0, "taxable_value": 30000.0, "cgst_rate": 9.0, "cgst_amount": 2700.0, "sgst_rate": 9.0, "sgst_amount": 2700.0, "igst_rate": 0.0, "igst_amount": 0.0, "cess": 0.0}
        ]
        img_bytes1 = create_sample_invoice_image(
            supplier_name=client1.name, supplier_gstin=client1.gstin,
            buyer_name="Godrej & Boyce Mfg Co Ltd", buyer_gstin="27AAACG1234G1Z8",
            inv_num="APEX/2025/0101", inv_date="2025-01-10",
            items=items1, taxable_val=80000.0, cgst=7200.0, sgst=7200.0, igst=0.0, total=94400.0
        )
        p1, h1, s1 = storage_service.save_file(img_bytes1, "invoice_apex_0101.png", firm.id, client1.id)
        f1 = InvoiceFile(firm_id=firm.id, client_id=client1.id, storage_path=p1, original_filename="invoice_apex_0101.png", file_size=s1, mime_type="image/png", file_hash=h1, status="done")
        db.add(f1)
        db.flush()

        inv1 = Invoice(
            firm_id=firm.id, client_id=client1.id, source_file_id=f1.id, invoice_type="sales",
            supplier_name=client1.name, supplier_gstin=client1.gstin, supplier_state="Maharashtra",
            buyer_name="Godrej & Boyce Mfg Co Ltd", buyer_gstin="27AAACG1234G1Z8", buyer_state="Maharashtra",
            invoice_number="APEX/2025/0101", invoice_date="2025-01-10", place_of_supply="27", reverse_charge=False,
            total_taxable_value=80000.0, cgst_total=7200.0, sgst_total=7200.0, igst_total=0.0, cess_total=0.0, total_tax=14400.0, invoice_total=94400.0,
            overall_confidence=0.98, review_status="auto_approved", tax_period="2025-01", flags=[]
        )
        db.add(inv1)
        db.flush()
        for i, it in enumerate(items1):
            db.add(LineItem(invoice_id=inv1.id, item_index=i, **it, confidence=0.98))

        # Invoice 2: Inter-state B2B with QR Code (Approved)
        items2 = [
            {"description": "Enterprise Cloud Server Infrastructure Subscription", "hsn_sac": "998315", "quantity": 1.0, "unit": "NOS", "rate": 150000.0, "taxable_value": 150000.0, "cgst_rate": 0.0, "cgst_amount": 0.0, "sgst_rate": 0.0, "sgst_amount": 0.0, "igst_rate": 18.0, "igst_amount": 27000.0, "cess": 0.0}
        ]
        img_bytes2 = create_sample_invoice_image(
            supplier_name=client2.name, supplier_gstin=client2.gstin,
            buyer_name="Reliance Retail Ltd", buyer_gstin="27AABCR1234R1Z1",
            inv_num="ZEN/25/042", inv_date="2025-01-18",
            items=items2, taxable_val=150000.0, cgst=0.0, sgst=0.0, igst=27000.0, total=177000.0, with_qr_box=True
        )
        p2, h2, s2 = storage_service.save_file(img_bytes2, "invoice_zenith_042.png", firm.id, client2.id)
        f2 = InvoiceFile(firm_id=firm.id, client_id=client2.id, storage_path=p2, original_filename="invoice_zenith_042.png", file_size=s2, mime_type="image/png", file_hash=h2, status="done")
        db.add(f2)
        db.flush()

        inv2 = Invoice(
            firm_id=firm.id, client_id=client2.id, source_file_id=f2.id, invoice_type="sales",
            supplier_name=client2.name, supplier_gstin=client2.gstin, supplier_state="Karnataka",
            buyer_name="Reliance Retail Ltd", buyer_gstin="27AABCR1234R1Z1", buyer_state="Maharashtra",
            invoice_number="ZEN/25/042", invoice_date="2025-01-18", place_of_supply="27", reverse_charge=False,
            total_taxable_value=150000.0, cgst_total=0.0, sgst_total=0.0, igst_total=27000.0, cess_total=0.0, total_tax=27000.0, invoice_total=177000.0,
            overall_confidence=0.96, review_status="approved", tax_period="2025-01",
            qr_data={"irn": "4a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b", "supplier_gstin": client2.gstin, "buyer_gstin": "27AABCR1234R1Z1", "invoice_number": "ZEN/25/042", "invoice_date": "2025-01-18", "invoice_total": 177000.0}
        )
        db.add(inv2)
        db.flush()
        for i, it in enumerate(items2):
            db.add(LineItem(invoice_id=inv2.id, item_index=i, **it, confidence=0.96))

        # Invoice 3: Large B2CL Inter-state to Unregistered (> 2.5 Lakhs) (Approved)
        items3 = [
            {"description": "Specialized Industrial Compressor Unit 50HP", "hsn_sac": "8414", "quantity": 1.0, "unit": "SET", "rate": 300000.0, "taxable_value": 300000.0, "cgst_rate": 0.0, "cgst_amount": 0.0, "sgst_rate": 0.0, "sgst_amount": 0.0, "igst_rate": 18.0, "igst_amount": 54000.0, "cess": 0.0}
        ]
        img_bytes3 = create_sample_invoice_image(
            supplier_name=client1.name, supplier_gstin=client1.gstin,
            buyer_name="Anand Engineering Works (Unregistered)", buyer_gstin="",
            inv_num="APEX/2025/0125", inv_date="2025-01-22",
            items=items3, taxable_val=300000.0, cgst=0.0, sgst=0.0, igst=54000.0, total=354000.0
        )
        p3, h3, s3 = storage_service.save_file(img_bytes3, "invoice_apex_b2cl.png", firm.id, client1.id)
        f3 = InvoiceFile(firm_id=firm.id, client_id=client1.id, storage_path=p3, original_filename="invoice_apex_b2cl.png", file_size=s3, mime_type="image/png", file_hash=h3, status="done")
        db.add(f3)
        db.flush()

        inv3 = Invoice(
            firm_id=firm.id, client_id=client1.id, source_file_id=f3.id, invoice_type="sales",
            supplier_name=client1.name, supplier_gstin=client1.gstin, supplier_state="Maharashtra",
            buyer_name="Anand Engineering Works (Unregistered)", buyer_gstin=None, buyer_state="Gujarat",
            invoice_number="APEX/2025/0125", invoice_date="2025-01-22", place_of_supply="24", reverse_charge=False,
            total_taxable_value=300000.0, cgst_total=0.0, sgst_total=0.0, igst_total=54000.0, cess_total=0.0, total_tax=54000.0, invoice_total=354000.0,
            overall_confidence=0.94, review_status="approved", tax_period="2025-01", flags=[]
        )
        db.add(inv3)
        db.flush()
        for i, it in enumerate(items3):
            db.add(LineItem(invoice_id=inv3.id, item_index=i, **it, confidence=0.94))

        # Invoice 4: Small B2C Intra-state (Approved)
        items4 = [
            {"description": "Consumer Retail Electronic Accessories Pack", "hsn_sac": "8523", "quantity": 10.0, "unit": "NOS", "rate": 1200.0, "taxable_value": 12000.0, "cgst_rate": 9.0, "cgst_amount": 1080.0, "sgst_rate": 9.0, "sgst_amount": 1080.0, "igst_rate": 0.0, "igst_amount": 0.0, "cess": 0.0}
        ]
        img_bytes4 = create_sample_invoice_image(
            supplier_name=client1.name, supplier_gstin=client1.gstin,
            buyer_name="Direct Cash Customer", buyer_gstin="",
            inv_num="APEX/2025/0130", inv_date="2025-01-28",
            items=items4, taxable_val=12000.0, cgst=1080.0, sgst=1080.0, igst=0.0, total=14160.0
        )
        p4, h4, s4 = storage_service.save_file(img_bytes4, "invoice_apex_b2cs.png", firm.id, client1.id)
        f4 = InvoiceFile(firm_id=firm.id, client_id=client1.id, storage_path=p4, original_filename="invoice_apex_b2cs.png", file_size=s4, mime_type="image/png", file_hash=h4, status="done")
        db.add(f4)
        db.flush()

        inv4 = Invoice(
            firm_id=firm.id, client_id=client1.id, source_file_id=f4.id, invoice_type="sales",
            supplier_name=client1.name, supplier_gstin=client1.gstin, supplier_state="Maharashtra",
            buyer_name="Direct Cash Customer", buyer_gstin=None, buyer_state="Maharashtra",
            invoice_number="APEX/2025/0130", invoice_date="2025-01-28", place_of_supply="27", reverse_charge=False,
            total_taxable_value=12000.0, cgst_total=1080.0, sgst_total=1080.0, igst_total=0.0, cess_total=0.0, total_tax=2160.0, invoice_total=14160.0,
            overall_confidence=0.95, review_status="approved", tax_period="2025-01", flags=[]
        )
        db.add(inv4)
        db.flush()
        for i, it in enumerate(items4):
            db.add(LineItem(invoice_id=inv4.id, item_index=i, **it, confidence=0.95))

        # Invoice 5: Flagged invoice with Tax Discrepancy & Lower Confidence ("needs_review")
        items5 = [
            {"description": "Industrial Rubber Seals and Gaskets Set", "hsn_sac": "40169", "quantity": 50.0, "unit": "NOS", "rate": 400.0, "taxable_value": 20000.0, "cgst_rate": 9.0, "cgst_amount": 1800.0, "sgst_rate": 9.0, "sgst_amount": 1800.0, "igst_rate": 0.0, "igst_amount": 0.0, "cess": 0.0}
        ]
        img_bytes5 = create_sample_invoice_image(
            supplier_name="Apex Retailers Pvt Ltd", supplier_gstin=client1.gstin,
            buyer_name="Larsen & Toubro Ltd", buyer_gstin="27AAACL1234L1Z2",
            inv_num="APEX/2025/0140", inv_date="2025-01-29",
            items=items5, taxable_val=20000.0, cgst=1800.0, sgst=1800.0, igst=0.0, total=24000.0  # discrepancy: 20000+3600 != 24000
        )
        p5, h5, s5 = storage_service.save_file(img_bytes5, "invoice_apex_flagged.png", firm.id, client1.id)
        f5 = InvoiceFile(firm_id=firm.id, client_id=client1.id, storage_path=p5, original_filename="invoice_apex_flagged.png", file_size=s5, mime_type="image/png", file_hash=h5, status="done")
        db.add(f5)
        db.flush()

        flags5 = [
            {
                "type": "tax_calculation_mismatch",
                "severity": "error",
                "field": "invoice_total",
                "message": "Tax math mismatch: Taxable (20000.00) + Taxes (3600.00) = 23600.00, but Invoice Total is 24000.00."
            },
            {
                "type": "invalid_hsn_code",
                "severity": "warning",
                "field": "line_items[0].hsn_sac",
                "message": "Line item #1 has invalid HSN/SAC code '40169'. HSN must be 4, 6, or 8 digits."
            }
        ]

        inv5 = Invoice(
            firm_id=firm.id, client_id=client1.id, source_file_id=f5.id, invoice_type="sales",
            supplier_name=client1.name, supplier_gstin=client1.gstin, supplier_state="Maharashtra",
            buyer_name="Larsen & Toubro Ltd", buyer_gstin="27AAACL1234L1Z2", buyer_state="Maharashtra",
            invoice_number="APEX/2025/0140", invoice_date="2025-01-29", place_of_supply="27", reverse_charge=False,
            total_taxable_value=20000.0, cgst_total=1800.0, sgst_total=1800.0, igst_total=0.0, cess_total=0.0, total_tax=3600.0, invoice_total=24000.0,
            overall_confidence=0.82, review_status="needs_review", tax_period="2025-01", flags=flags5
        )
        db.add(inv5)
        db.flush()
        for i, it in enumerate(items5):
            db.add(LineItem(invoice_id=inv5.id, item_index=i, **it, confidence=0.82))

        db.commit()
        print("Database successfully seeded with 1 firm, 4 users, 2 clients, and 5 sample invoices!")

    except Exception as e:
        db.rollback()
        print(f"Error seeding database: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    seed_database()
