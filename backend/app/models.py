import uuid
from datetime import datetime
from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime, ForeignKey, Text, JSON
)
from sqlalchemy.orm import relationship
from app.database import Base

def generate_uuid() -> str:
    return str(uuid.uuid4())

class Firm(Base):
    __tablename__ = "firms"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    name = Column(String(255), nullable=False)
    gstin = Column(String(15), nullable=True)
    address = Column(Text, nullable=True)
    phone = Column(String(20), nullable=True)
    email = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    users = relationship("User", back_populates="firm", cascade="all, delete-orphan")
    clients = relationship("Client", back_populates="firm", cascade="all, delete-orphan")
    invoices = relationship("Invoice", back_populates="firm", cascade="all, delete-orphan")
    exports = relationship("Export", back_populates="firm", cascade="all, delete-orphan")


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=False)
    role = Column(String(50), nullable=False)  # "admin", "staff", "client"
    firm_id = Column(String(36), ForeignKey("firms.id"), nullable=False, index=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=True, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    firm = relationship("Firm", back_populates="users")
    client = relationship("Client", back_populates="users")


class Client(Base):
    __tablename__ = "clients"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    firm_id = Column(String(36), ForeignKey("firms.id"), nullable=False, index=True)
    name = Column(String(255), nullable=False)
    trade_name = Column(String(255), nullable=True)
    gstin = Column(String(15), nullable=True, index=True)
    email = Column(String(255), nullable=True)
    phone = Column(String(20), nullable=True)
    state = Column(String(100), nullable=True)
    state_code = Column(String(2), nullable=True)
    address = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    firm = relationship("Firm", back_populates="clients")
    users = relationship("User", back_populates="client")
    invoices = relationship("Invoice", back_populates="client", cascade="all, delete-orphan")
    files = relationship("InvoiceFile", back_populates="client", cascade="all, delete-orphan")
    exports = relationship("Export", back_populates="client", cascade="all, delete-orphan")


class InvoiceFile(Base):
    __tablename__ = "invoice_files"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    firm_id = Column(String(36), ForeignKey("firms.id"), nullable=False, index=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False, index=True)
    storage_path = Column(String(500), nullable=False)
    original_filename = Column(String(255), nullable=False)
    file_size = Column(Integer, nullable=False, default=0)
    mime_type = Column(String(100), nullable=False)
    file_hash = Column(String(64), index=True, nullable=False)  # SHA-256
    
    blur_score = Column(Float, nullable=True)
    is_blurry = Column(Boolean, default=False)
    is_dark = Column(Boolean, default=False)
    
    status = Column(String(50), default="uploaded", index=True)  # uploaded, processing, done, failed
    error_message = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="files")
    invoice = relationship("Invoice", back_populates="source_file", uselist=False)


class Invoice(Base):
    __tablename__ = "invoices"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    firm_id = Column(String(36), ForeignKey("firms.id"), nullable=False, index=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False, index=True)
    source_file_id = Column(String(36), ForeignKey("invoice_files.id"), nullable=True, index=True)

    # Generic invoice classification: sales, purchase, credit_note, debit_note
    invoice_type = Column(String(50), default="sales", index=True)
    
    supplier_name = Column(String(255), nullable=True)
    supplier_gstin = Column(String(15), nullable=True, index=True)
    supplier_state = Column(String(100), nullable=True)
    supplier_address = Column(Text, nullable=True)

    buyer_name = Column(String(255), nullable=True)
    buyer_gstin = Column(String(15), nullable=True, index=True)
    buyer_state = Column(String(100), nullable=True)
    buyer_address = Column(Text, nullable=True)

    invoice_number = Column(String(100), nullable=True, index=True)
    invoice_date = Column(String(20), nullable=True)  # YYYY-MM-DD
    place_of_supply = Column(String(50), nullable=True)  # 2-digit state code or state name
    reverse_charge = Column(Boolean, default=False)

    total_taxable_value = Column(Float, default=0.0)
    cgst_total = Column(Float, default=0.0)
    sgst_total = Column(Float, default=0.0)
    igst_total = Column(Float, default=0.0)
    cess_total = Column(Float, default=0.0)
    total_tax = Column(Float, default=0.0)
    invoice_total = Column(Float, default=0.0)

    overall_confidence = Column(Float, default=1.0)
    field_confidences = Column(JSON, default=dict)

    # review_status: uploaded, processing, needs_review, auto_approved, approved, rejected
    review_status = Column(String(50), default="uploaded", index=True)
    tax_period = Column(String(20), index=True, nullable=True)  # YYYY-MM

    flags = Column(JSON, default=list)  # list of validation alerts
    qr_data = Column(JSON, nullable=True)
    raw_extraction = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    firm = relationship("Firm", back_populates="invoices")
    client = relationship("Client", back_populates="invoices")
    source_file = relationship("InvoiceFile", back_populates="invoice")
    line_items = relationship("LineItem", back_populates="invoice", cascade="all, delete-orphan")
    audit_logs = relationship("AuditLog", back_populates="invoice", cascade="all, delete-orphan")


class LineItem(Base):
    __tablename__ = "line_items"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    invoice_id = Column(String(36), ForeignKey("invoices.id"), nullable=False, index=True)
    item_index = Column(Integer, default=0)
    description = Column(Text, nullable=True)
    hsn_sac = Column(String(20), nullable=True)
    quantity = Column(Float, default=1.0)
    unit = Column(String(50), default="NOS")
    uqc = Column(String(50), default="NOS")
    rate = Column(Float, default=0.0)
    taxable_value = Column(Float, default=0.0)
    total_value = Column(Float, default=0.0)
    
    cgst_rate = Column(Float, default=0.0)
    cgst_amount = Column(Float, default=0.0)
    sgst_rate = Column(Float, default=0.0)
    sgst_amount = Column(Float, default=0.0)
    igst_rate = Column(Float, default=0.0)
    igst_amount = Column(Float, default=0.0)
    cess = Column(Float, default=0.0)
    
    confidence = Column(Float, default=1.0)
    created_at = Column(DateTime, default=datetime.utcnow)

    invoice = relationship("Invoice", back_populates="line_items")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    invoice_id = Column(String(36), ForeignKey("invoices.id"), nullable=False, index=True)
    user_id = Column(String(36), ForeignKey("users.id"), nullable=True)
    user_name = Column(String(255), nullable=True)
    field_name = Column(String(100), nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    invoice = relationship("Invoice", back_populates="audit_logs")
    user = relationship("User")


class Export(Base):
    __tablename__ = "exports"

    id = Column(String(36), primary_key=True, default=generate_uuid)
    firm_id = Column(String(36), ForeignKey("firms.id"), nullable=False, index=True)
    client_id = Column(String(36), ForeignKey("clients.id"), nullable=False, index=True)
    tax_period = Column(String(20), nullable=False)
    export_type = Column(String(50), default="gstr1")
    storage_path = Column(String(500), nullable=False)
    file_name = Column(String(255), nullable=False)
    invoice_count = Column(Integer, default=0)
    generated_by_user_id = Column(String(36), ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    firm = relationship("Firm", back_populates="exports")
    client = relationship("Client", back_populates="exports")
    generated_by = relationship("User")
