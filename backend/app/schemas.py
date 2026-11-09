from pydantic import BaseModel, EmailStr, Field, ConfigDict
from typing import Optional, List, Dict, Any
from datetime import datetime

# --- Auth & User ---
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut"

class TokenPayload(BaseModel):
    sub: str
    email: str
    role: str
    firm_id: str
    client_id: Optional[str] = None

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    role: str = "staff"  # admin, staff, client
    firm_id: Optional[str] = None
    client_id: Optional[str] = None

class UserOut(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    firm_id: str
    client_id: Optional[str] = None
    firm_name: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)

# --- Firm ---
class FirmOut(BaseModel):
    id: str
    name: str
    gstin: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)

# --- Client ---
class ClientBase(BaseModel):
    name: str
    trade_name: Optional[str] = None
    gstin: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    state: Optional[str] = None
    state_code: Optional[str] = None
    address: Optional[str] = None

class ClientCreate(ClientBase):
    pass

class ClientUpdate(BaseModel):
    name: Optional[str] = None
    trade_name: Optional[str] = None
    gstin: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    state: Optional[str] = None
    state_code: Optional[str] = None
    address: Optional[str] = None

class ClientOut(ClientBase):
    id: str
    firm_id: str
    created_at: datetime
    total_invoices: int = 0
    needs_review_count: int = 0
    approved_count: int = 0

    model_config = ConfigDict(from_attributes=True)

# --- Line Items ---
class LineItemBase(BaseModel):
    description: Optional[str] = None
    hsn_sac: Optional[str] = None
    quantity: float = 1.0
    unit: str = "NOS"
    uqc: str = "NOS"
    rate: float = 0.0
    taxable_value: float = 0.0
    total_value: float = 0.0
    cgst_rate: float = 0.0
    cgst_amount: float = 0.0
    sgst_rate: float = 0.0
    sgst_amount: float = 0.0
    igst_rate: float = 0.0
    igst_amount: float = 0.0
    cess: float = 0.0
    confidence: float = 1.0

class LineItemCreate(LineItemBase):
    pass

class LineItemUpdate(LineItemBase):
    id: Optional[str] = None

class LineItemOut(LineItemBase):
    id: str
    invoice_id: str
    item_index: int = 0

    model_config = ConfigDict(from_attributes=True)

# --- Validation Flags ---
class ValidationFlag(BaseModel):
    type: str  # gstin_invalid, pos_tax_mismatch, tax_sum_mismatch, hsn_invalid, qr_mismatch, period_mismatch, blur_detected
    severity: str = "warning"  # "warning" or "error"
    field: Optional[str] = None
    message: str

# --- Audit Log ---
class AuditLogOut(BaseModel):
    id: str
    invoice_id: str
    user_name: Optional[str] = None
    field_name: str
    old_value: Optional[str] = None
    new_value: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

# --- Invoice File ---
class InvoiceFileOut(BaseModel):
    id: str
    client_id: str
    original_filename: str
    file_size: int
    mime_type: str
    status: str
    blur_score: Optional[float] = None
    is_blurry: bool = False
    is_dark: bool = False
    error_message: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

# --- Invoice ---
class InvoiceOut(BaseModel):
    id: str
    firm_id: str
    client_id: str
    client_name: Optional[str] = None
    source_file_id: Optional[str] = None
    source_filename: Optional[str] = None
    
    invoice_type: str = "sales"
    supplier_name: Optional[str] = None
    supplier_gstin: Optional[str] = None
    supplier_state: Optional[str] = None
    
    buyer_name: Optional[str] = None
    buyer_gstin: Optional[str] = None
    buyer_state: Optional[str] = None
    
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    place_of_supply: Optional[str] = None
    reverse_charge: bool = False
    
    total_taxable_value: float = 0.0
    cgst_total: float = 0.0
    sgst_total: float = 0.0
    igst_total: float = 0.0
    cess_total: float = 0.0
    total_tax: float = 0.0
    invoice_total: float = 0.0
    
    overall_confidence: float = 1.0
    field_confidences: Dict[str, Any] = {}
    review_status: str
    tax_period: Optional[str] = None
    flags: List[Dict[str, Any]] = []
    
    line_items_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

class InvoiceDetail(InvoiceOut):
    supplier_address: Optional[str] = None
    buyer_address: Optional[str] = None
    qr_data: Optional[Dict[str, Any]] = None
    line_items: List[LineItemOut] = []
    audit_logs: List[AuditLogOut] = []
    file_preview_url: Optional[str] = None

class InvoiceUpdate(BaseModel):
    supplier_name: Optional[str] = None
    supplier_gstin: Optional[str] = None
    supplier_state: Optional[str] = None
    buyer_name: Optional[str] = None
    buyer_gstin: Optional[str] = None
    buyer_state: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    place_of_supply: Optional[str] = None
    reverse_charge: Optional[bool] = None
    tax_period: Optional[str] = None
    
    total_taxable_value: Optional[float] = None
    cgst_total: Optional[float] = None
    sgst_total: Optional[float] = None
    igst_total: Optional[float] = None
    cess_total: Optional[float] = None
    total_tax: Optional[float] = None
    invoice_total: Optional[float] = None
    
    line_items: Optional[List[LineItemUpdate]] = None

class InvoiceReviewRequest(BaseModel):
    action: str = Field(..., pattern="^(approve|reject)$")
    reason: Optional[str] = None

# --- Upload Response ---
class UploadResponse(BaseModel):
    file_id: str
    invoice_id: Optional[str] = None
    filename: str
    status: str
    is_blurry: bool = False
    is_dark: bool = False
    warning_message: Optional[str] = None

# --- Export ---
class GSTR1ExportRequest(BaseModel):
    client_id: str
    tax_period: str  # YYYY-MM

class ExportOut(BaseModel):
    id: str
    client_id: str
    client_name: Optional[str] = None
    tax_period: str
    export_type: str
    file_name: str
    invoice_count: int
    created_at: datetime
    download_url: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)
