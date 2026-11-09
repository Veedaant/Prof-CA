import os
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, BackgroundTasks
from sqlalchemy.orm import Session
from sqlalchemy import or_, desc, asc

from app.database import get_db, SessionLocal
from app.models import Invoice, LineItem, InvoiceFile, AuditLog, Client, User
from app.schemas import (
    InvoiceOut, InvoiceDetail, InvoiceUpdate, InvoiceReviewRequest, 
    UploadResponse, LineItemOut, AuditLogOut
)
from app.auth import get_current_user, require_ca_staff
from app.services.storage import storage_service
from app.services.extractor import run_extraction_pipeline
from app.services.validators import validate_invoice, determine_review_status

router = APIRouter(prefix="/invoices", tags=["invoices"])

def background_process_file(file_id: str, firm_id: str, client_id: str, invoice_type: str, tax_period: Optional[str]):
    """
    Background worker that runs extraction, duplicate detection, and GST validations.
    """
    db = SessionLocal()
    try:
        inv_file = db.query(InvoiceFile).filter(InvoiceFile.id == file_id).first()
        if not inv_file:
            return

        inv_file.status = "processing"
        db.commit()

        file_bytes = storage_service.read_file(inv_file.storage_path)

        # Run extraction pipeline
        result = run_extraction_pipeline(
            file_bytes=file_bytes,
            filename=inv_file.original_filename,
            expected_tax_period=tax_period
        )

        quality = result["quality"]
        inv_file.blur_score = quality["blur_score"]
        inv_file.is_blurry = quality["is_blurry"]
        inv_file.is_dark = quality["is_dark"]

        inv_data = result["invoice_data"]
        line_items_data = result["line_items"]
        flags = result["flags"]
        overall_conf = result["confidence"]["overall"]
        review_status = result["review_status"]

        # Auto-match client by GSTIN if found in firm
        sup_gstin = inv_data.get("supplier_gstin")
        buyer_gstin = inv_data.get("buyer_gstin")
        target_client_id = client_id

        if sup_gstin:
            matching_client = db.query(Client).filter(
                Client.firm_id == firm_id,
                Client.gstin == sup_gstin
            ).first()
            if matching_client:
                target_client_id = matching_client.id
        elif buyer_gstin:
            matching_client = db.query(Client).filter(
                Client.firm_id == firm_id,
                Client.gstin == buyer_gstin
            ).first()
            if matching_client:
                target_client_id = matching_client.id

        # Duplicate detection by GSTIN + invoice_number
        inv_num = inv_data.get("invoice_number")
        if sup_gstin and inv_num:
            duplicate = db.query(Invoice).filter(
                Invoice.firm_id == firm_id,
                Invoice.client_id == target_client_id,
                Invoice.supplier_gstin == sup_gstin,
                Invoice.invoice_number == inv_num,
                Invoice.source_file_id != file_id
            ).first()
            if duplicate:
                flags.append({
                    "type": "duplicate_invoice_detected",
                    "severity": "error",
                    "field": "invoice_number",
                    "message": f"Duplicate Invoice Detected! Invoice #{inv_num} from supplier {sup_gstin} already exists in database."
                })
                review_status = "needs_review"

        # Auto-compute tax_period from invoice_date if not specified
        inv_date = inv_data.get("invoice_date")
        computed_period = tax_period
        if not computed_period and inv_date and len(inv_date) >= 7:
            computed_period = inv_date[:7]

        # Create or update Invoice
        invoice = db.query(Invoice).filter(Invoice.source_file_id == file_id).first()
        if not invoice:
            invoice = Invoice(
                firm_id=firm_id,
                client_id=target_client_id,
                source_file_id=file_id,
                invoice_type=invoice_type,
            )
            db.add(invoice)
        else:
            invoice.client_id = target_client_id

        invoice.supplier_name = inv_data.get("supplier_name")
        invoice.supplier_gstin = sup_gstin
        invoice.supplier_state = inv_data.get("supplier_state")
        invoice.buyer_name = inv_data.get("buyer_name")
        invoice.buyer_gstin = buyer_gstin
        invoice.buyer_state = inv_data.get("buyer_state")
        invoice.invoice_number = inv_num
        invoice.invoice_date = inv_date
        invoice.place_of_supply = inv_data.get("place_of_supply")
        invoice.reverse_charge = inv_data.get("reverse_charge", False)
        invoice.total_taxable_value = inv_data.get("total_taxable_value", 0.0)
        invoice.cgst_total = inv_data.get("cgst_total", 0.0)
        invoice.sgst_total = inv_data.get("sgst_total", 0.0)
        invoice.igst_total = inv_data.get("igst_total", 0.0)
        invoice.cess_total = inv_data.get("cess_total", 0.0)
        invoice.total_tax = inv_data.get("total_tax", 0.0)
        invoice.invoice_total = inv_data.get("invoice_total", 0.0)
        invoice.overall_confidence = overall_conf
        invoice.field_confidences = result["confidence"]["fields"]
        invoice.review_status = review_status
        invoice.tax_period = computed_period
        invoice.flags = flags
        invoice.qr_data = result.get("qr_data")
        invoice.raw_extraction = result.get("raw_ai_data")

        db.flush()

        # Delete old line items if re-processing
        db.query(LineItem).filter(LineItem.invoice_id == invoice.id).delete()

        # Add line items
        for idx, item in enumerate(line_items_data):
            unit_val = item.get("unit") or "NOS"
            uqc_val = item.get("uqc") or f"{unit_val}-NUMBERS"
            total_val = float(item.get("total_value") or (
                float(item.get("taxable_value") or 0.0) +
                float(item.get("cgst_amount") or 0.0) +
                float(item.get("sgst_amount") or 0.0) +
                float(item.get("igst_amount") or 0.0)
            ))

            li = LineItem(
                invoice_id=invoice.id,
                item_index=idx,
                description=item.get("description"),
                hsn_sac=str(item.get("hsn_sac") or ""),
                quantity=float(item.get("quantity") or 1.0),
                unit=unit_val,
                uqc=uqc_val,
                rate=float(item.get("rate") or 0.0),
                taxable_value=float(item.get("taxable_value") or 0.0),
                total_value=total_val,
                cgst_rate=float(item.get("cgst_rate") or 0.0),
                cgst_amount=float(item.get("cgst_amount") or 0.0),
                sgst_rate=float(item.get("sgst_rate") or 0.0),
                sgst_amount=float(item.get("sgst_amount") or 0.0),
                igst_rate=float(item.get("igst_rate") or 0.0),
                igst_amount=float(item.get("igst_amount") or 0.0),
                cess=float(item.get("cess") or 0.0),
                confidence=float(item.get("confidence") or 0.95),
            )
            db.add(li)

        # Initial audit log
        audit = AuditLog(
            invoice_id=invoice.id,
            user_name="AI Extraction Pipeline",
            field_name="extraction",
            old_value=None,
            new_value=f"Extracted with status {review_status} (conf: {overall_conf:.2f})"
        )
        db.add(audit)

        inv_file.status = "done"
        db.commit()

    except Exception as e:
        db.rollback()
        inv_file = db.query(InvoiceFile).filter(InvoiceFile.id == file_id).first()
        if inv_file:
            inv_file.status = "failed"
            inv_file.error_message = str(e)
            db.commit()
    finally:
        db.close()


@router.post("/upload", response_model=List[UploadResponse])
async def upload_invoices(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    client_id: str = Form(...),
    invoice_type: str = Form("sales"),
    tax_period: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    # Enforce role scoping
    if current_user.role == "client":
        if not current_user.client_id or current_user.client_id != client_id:
            raise HTTPException(status_code=403, detail="Clients can only upload for their own account")

    # Verify client exists in user's firm
    client = db.query(Client).filter(
        Client.id == client_id,
        Client.firm_id == current_user.firm_id
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found in your firm")

    responses = []

    for file in files:
        content = await file.read()
        if not content:
            continue

        # Save to storage abstraction
        storage_path, file_hash, file_size = storage_service.save_file(
            content=content,
            original_filename=file.filename or "invoice",
            firm_id=current_user.firm_id,
            client_id=client_id
        )

        # Duplicate file hash check
        existing_file = db.query(InvoiceFile).filter(
            InvoiceFile.firm_id == current_user.firm_id,
            InvoiceFile.client_id == client_id,
            InvoiceFile.file_hash == file_hash
        ).first()

        warning_message = None
        if existing_file:
            warning_message = "Warning: An identical file was previously uploaded for this client."

        inv_file = InvoiceFile(
            firm_id=current_user.firm_id,
            client_id=client_id,
            storage_path=storage_path,
            original_filename=file.filename or "invoice",
            file_size=file_size,
            mime_type=file.content_type or "application/octet-stream",
            file_hash=file_hash,
            status="queued"
        )
        db.add(inv_file)
        db.commit()
        db.refresh(inv_file)

        # Trigger background extraction pipeline
        background_tasks.add_task(
            background_process_file,
            file_id=inv_file.id,
            firm_id=current_user.firm_id,
            client_id=client_id,
            invoice_type=invoice_type,
            tax_period=tax_period
        )

        responses.append(UploadResponse(
            file_id=inv_file.id,
            filename=inv_file.original_filename,
            status="queued",
            warning_message=warning_message
        ))

    return responses


@router.get("", response_model=List[InvoiceOut])
def get_invoices(
    client_id: Optional[str] = None,
    tax_period: Optional[str] = None,
    review_status: Optional[str] = None,
    invoice_type: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(Invoice).filter(Invoice.firm_id == current_user.firm_id)

    # Scoping for client role
    if current_user.role == "client":
        query = query.filter(Invoice.client_id == current_user.client_id)
    elif client_id:
        query = query.filter(Invoice.client_id == client_id)

    if tax_period:
        query = query.filter(Invoice.tax_period == tax_period)
    if review_status:
        query = query.filter(Invoice.review_status == review_status)
    if invoice_type:
        query = query.filter(Invoice.invoice_type == invoice_type)

    if search:
        search_term = f"%{search.strip()}%"
        query = query.filter(
            or_(
                Invoice.invoice_number.ilike(search_term),
                Invoice.supplier_name.ilike(search_term),
                Invoice.buyer_name.ilike(search_term),
                Invoice.supplier_gstin.ilike(search_term),
                Invoice.buyer_gstin.ilike(search_term),
            )
        )

    invoices = query.order_by(desc(Invoice.created_at)).offset(skip).limit(limit).all()

    results = []
    for inv in invoices:
        source_name = inv.source_file.original_filename if inv.source_file else None
        client_name = inv.client.name if inv.client else None
        item_count = len(inv.line_items)

        results.append(InvoiceOut(
            id=inv.id,
            firm_id=inv.firm_id,
            client_id=inv.client_id,
            client_name=client_name,
            source_file_id=inv.source_file_id,
            source_filename=source_name,
            invoice_type=inv.invoice_type,
            supplier_name=inv.supplier_name,
            supplier_gstin=inv.supplier_gstin,
            supplier_state=inv.supplier_state,
            buyer_name=inv.buyer_name,
            buyer_gstin=inv.buyer_gstin,
            buyer_state=inv.buyer_state,
            invoice_number=inv.invoice_number,
            invoice_date=inv.invoice_date,
            place_of_supply=inv.place_of_supply,
            reverse_charge=inv.reverse_charge,
            total_taxable_value=inv.total_taxable_value,
            cgst_total=inv.cgst_total,
            sgst_total=inv.sgst_total,
            igst_total=inv.igst_total,
            cess_total=inv.cess_total,
            total_tax=inv.total_tax,
            invoice_total=inv.invoice_total,
            overall_confidence=inv.overall_confidence,
            field_confidences=inv.field_confidences or {},
            review_status=inv.review_status,
            tax_period=inv.tax_period,
            flags=inv.flags or [],
            line_items_count=item_count,
            created_at=inv.created_at,
            updated_at=inv.updated_at
        ))

    return results


@router.get("/queue/next")
def get_queue_navigation(
    current_invoice_id: str,
    client_id: Optional[str] = None,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    """
    Returns previous and next invoice IDs in the 'needs_review' queue.
    """
    query = db.query(Invoice.id).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.review_status == "needs_review"
    )
    if client_id:
        query = query.filter(Invoice.client_id == client_id)

    ids = [r[0] for r in query.order_by(desc(Invoice.created_at)).all()]
    prev_id = None
    next_id = None

    if current_invoice_id in ids:
        idx = ids.index(current_invoice_id)
        if idx > 0:
            prev_id = ids[idx - 1]
        if idx < len(ids) - 1:
            next_id = ids[idx + 1]
    elif ids:
        next_id = ids[0]

    return {
        "current_id": current_invoice_id,
        "prev_id": prev_id,
        "next_id": next_id,
        "total_in_queue": len(ids)
    }


@router.get("/{invoice_id}", response_model=InvoiceDetail)
def get_invoice(
    invoice_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.firm_id == current_user.firm_id
    )
    if current_user.role == "client":
        query = query.filter(Invoice.client_id == current_user.client_id)

    inv = query.first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    # Generate short-lived signed file preview token
    preview_url = None
    if inv.source_file_id:
        token = storage_service.generate_signed_token(inv.source_file_id, expires_in_minutes=120)
        preview_url = f"/api/files/{inv.source_file_id}/view?token={token}"

    line_items_out = [
        LineItemOut(
            id=li.id,
            invoice_id=li.invoice_id,
            item_index=li.item_index,
            description=li.description,
            hsn_sac=li.hsn_sac,
            quantity=li.quantity,
            unit=li.unit,
            rate=li.rate,
            taxable_value=li.taxable_value,
            cgst_rate=li.cgst_rate,
            cgst_amount=li.cgst_amount,
            sgst_rate=li.sgst_rate,
            sgst_amount=li.sgst_amount,
            igst_rate=li.igst_rate,
            igst_amount=li.igst_amount,
            cess=li.cess,
            confidence=li.confidence
        )
        for li in sorted(inv.line_items, key=lambda x: x.item_index)
    ]

    audit_logs_out = [
        AuditLogOut(
            id=a.id,
            invoice_id=a.invoice_id,
            user_name=a.user_name,
            field_name=a.field_name,
            old_value=a.old_value,
            new_value=a.new_value,
            created_at=a.created_at
        )
        for a in sorted(inv.audit_logs, key=lambda x: x.created_at, reverse=True)
    ]

    return InvoiceDetail(
        id=inv.id,
        firm_id=inv.firm_id,
        client_id=inv.client_id,
        client_name=inv.client.name if inv.client else None,
        source_file_id=inv.source_file_id,
        source_filename=inv.source_file.original_filename if inv.source_file else None,
        invoice_type=inv.invoice_type,
        supplier_name=inv.supplier_name,
        supplier_gstin=inv.supplier_gstin,
        supplier_state=inv.supplier_state,
        supplier_address=inv.supplier_address,
        buyer_name=inv.buyer_name,
        buyer_gstin=inv.buyer_gstin,
        buyer_state=inv.buyer_state,
        buyer_address=inv.buyer_address,
        invoice_number=inv.invoice_number,
        invoice_date=inv.invoice_date,
        place_of_supply=inv.place_of_supply,
        reverse_charge=inv.reverse_charge,
        total_taxable_value=inv.total_taxable_value,
        cgst_total=inv.cgst_total,
        sgst_total=inv.sgst_total,
        igst_total=inv.igst_total,
        cess_total=inv.cess_total,
        total_tax=inv.total_tax,
        invoice_total=inv.invoice_total,
        overall_confidence=inv.overall_confidence,
        field_confidences=inv.field_confidences or {},
        review_status=inv.review_status,
        tax_period=inv.tax_period,
        flags=inv.flags or [],
        qr_data=inv.qr_data,
        line_items_count=len(inv.line_items),
        line_items=line_items_out,
        audit_logs=audit_logs_out,
        file_preview_url=preview_url,
        created_at=inv.created_at,
        updated_at=inv.updated_at
    )


@router.put("/{invoice_id}", response_model=InvoiceDetail)
def update_invoice(
    invoice_id: str,
    update_data: InvoiceUpdate,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.firm_id == current_user.firm_id
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    upd_dict = update_data.model_dump(exclude_unset=True)
    line_items_in = upd_dict.pop("line_items", None)

    # Track field edits in audit log
    for field, new_val in upd_dict.items():
        old_val = getattr(inv, field)
        if str(old_val) != str(new_val):
            audit = AuditLog(
                invoice_id=inv.id,
                user_id=current_user.id,
                user_name=current_user.full_name,
                field_name=field,
                old_value=str(old_val) if old_val is not None else None,
                new_value=str(new_val) if new_val is not None else None
            )
            db.add(audit)
            setattr(inv, field, new_val)

    # Handle line items if provided
    if line_items_in is not None:
        db.query(LineItem).filter(LineItem.invoice_id == inv.id).delete()
        for idx, item in enumerate(line_items_in):
            li = LineItem(
                invoice_id=inv.id,
                item_index=idx,
                description=item.get("description"),
                hsn_sac=str(item.get("hsn_sac") or ""),
                quantity=float(item.get("quantity") or 1.0),
                unit=item.get("unit") or "NOS",
                rate=float(item.get("rate") or 0.0),
                taxable_value=float(item.get("taxable_value") or 0.0),
                cgst_rate=float(item.get("cgst_rate") or 0.0),
                cgst_amount=float(item.get("cgst_amount") or 0.0),
                sgst_rate=float(item.get("sgst_rate") or 0.0),
                sgst_amount=float(item.get("sgst_amount") or 0.0),
                igst_rate=float(item.get("igst_rate") or 0.0),
                igst_amount=float(item.get("igst_amount") or 0.0),
                cess=float(item.get("cess") or 0.0),
                confidence=1.0  # Manually reviewed/saved
            )
            db.add(li)

        audit = AuditLog(
            invoice_id=inv.id,
            user_id=current_user.id,
            user_name=current_user.full_name,
            field_name="line_items",
            old_value=None,
            new_value=f"Updated {len(line_items_in)} line items"
        )
        db.add(audit)

    db.flush()

    # Re-run validations on edited data
    items_dicts = [
        {
            "description": li.description,
            "hsn_sac": li.hsn_sac,
            "quantity": li.quantity,
            "unit": li.unit,
            "rate": li.rate,
            "taxable_value": li.taxable_value,
            "cgst_rate": li.cgst_rate,
            "cgst_amount": li.cgst_amount,
            "sgst_rate": li.sgst_rate,
            "sgst_amount": li.sgst_amount,
            "igst_rate": li.igst_rate,
            "igst_amount": li.igst_amount,
            "cess": li.cess,
        }
        for li in inv.line_items
    ]

    inv_flat = {
        "supplier_gstin": inv.supplier_gstin,
        "buyer_gstin": inv.buyer_gstin,
        "place_of_supply": inv.place_of_supply,
        "invoice_number": inv.invoice_number,
        "invoice_date": inv.invoice_date,
        "total_taxable_value": inv.total_taxable_value,
        "cgst_total": inv.cgst_total,
        "sgst_total": inv.sgst_total,
        "igst_total": inv.igst_total,
        "cess_total": inv.cess_total,
        "total_tax": inv.total_tax,
        "invoice_total": inv.invoice_total,
    }

    new_flags = validate_invoice(
        invoice_data=inv_flat,
        line_items=items_dicts,
        expected_tax_period=inv.tax_period,
        qr_data=inv.qr_data
    )
    inv.flags = new_flags
    inv.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(inv)

    return get_invoice(invoice_id=inv.id, current_user=current_user, db=db)


@router.post("/{invoice_id}/review", response_model=InvoiceDetail)
def review_invoice(
    invoice_id: str,
    review_req: InvoiceReviewRequest,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.firm_id == current_user.firm_id
    ).first()
    if not inv:
        raise HTTPException(status_code=404, detail="Invoice not found")

    old_status = inv.review_status
    new_status = "approved" if review_req.action == "approve" else "rejected"
    inv.review_status = new_status
    inv.updated_at = datetime.utcnow()

    audit = AuditLog(
        invoice_id=inv.id,
        user_id=current_user.id,
        user_name=current_user.full_name,
        field_name="review_status",
        old_value=old_status,
        new_value=f"{new_status} (Reason: {review_req.reason or 'None provided'})"
    )
    db.add(audit)
    db.commit()

    return get_invoice(invoice_id=inv.id, current_user=current_user, db=db)


@router.post("/{invoice_id}/retry")
def retry_extraction(
    invoice_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    inv = db.query(Invoice).filter(
        Invoice.id == invoice_id,
        Invoice.firm_id == current_user.firm_id
    ).first()
    if not inv or not inv.source_file_id:
        raise HTTPException(status_code=404, detail="Invoice or source file not found")

    background_tasks.add_task(
        background_process_file,
        file_id=inv.source_file_id,
        firm_id=inv.firm_id,
        client_id=inv.client_id,
        invoice_type=inv.invoice_type,
        tax_period=inv.tax_period
    )

    return {"message": "Extraction task re-queued successfully"}
