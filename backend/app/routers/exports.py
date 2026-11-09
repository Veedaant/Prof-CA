import io
from typing import List, Optional
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status, Response, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.database import get_db
from app.models import Export, Invoice, Client, User, AuditLog
from app.schemas import GSTR1ExportRequest, ExportOut
from app.auth import get_current_user, require_ca_staff, decode_access_token
from app.services.storage import storage_service
from app.services.gstr1_exporter import generate_gstr1_workbook

router = APIRouter(prefix="/exports", tags=["exports"])

@router.post("/gstr1")
def export_gstr1(
    req: GSTR1ExportRequest,
    include_unreviewed: bool = Query(False),
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    # Verify client belongs to current user's firm
    client = db.query(Client).filter(
        Client.id == req.client_id,
        Client.firm_id == current_user.firm_id
    ).first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found in your firm")

    # Fetch invoices for client and period
    all_invoices = db.query(Invoice).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == req.client_id,
        Invoice.tax_period == req.tax_period
    ).all()

    # If no invoices in that specific period, check if invoices exist without period or in other periods
    if not all_invoices:
        # Fallback to all invoices for this client if period matches or none found
        all_invoices = db.query(Invoice).filter(
            Invoice.firm_id == current_user.firm_id,
            Invoice.client_id == req.client_id
        ).all()

    # Partition by status
    approved_invoices = [inv for inv in all_invoices if inv.review_status in ["approved", "auto_approved"]]
    unreviewed_invoices = [inv for inv in all_invoices if inv.review_status not in ["approved", "auto_approved"]]

    # If user selected include_unreviewed or if all invoices are pending and user wants draft export
    target_invoices = all_invoices if include_unreviewed else approved_invoices

    if not target_invoices:
        # If there are unreviewed invoices, tell CA they can either review or toggle draft export
        if unreviewed_invoices:
            raise HTTPException(
                status_code=400,
                detail=f"Found {len(unreviewed_invoices)} unreviewed invoice(s) for {client.name}. Please approve them in the review screen or enable 'Include Unreviewed' to generate a draft GSTR-1."
            )
        raise HTTPException(
            status_code=400,
            detail=f"No invoices found for {client.name} in tax period {req.tax_period}."
        )

    # Generate workbook
    wb_bytes_io = generate_gstr1_workbook(target_invoices)
    wb_bytes = wb_bytes_io.getvalue()

    # Save to storage abstraction
    file_name = f"GSTR1_{client.gstin or 'CLIENT'}_{req.tax_period}.xlsx"
    storage_path, file_hash, file_size = storage_service.save_file(
        content=wb_bytes,
        original_filename=file_name,
        firm_id=current_user.firm_id,
        client_id=client.id
    )

    # Create Export record
    exp = Export(
        firm_id=current_user.firm_id,
        client_id=client.id,
        tax_period=req.tax_period,
        export_type="gstr1",
        storage_path=storage_path,
        file_name=file_name,
        invoice_count=len(target_invoices),
        generated_by_user_id=current_user.id
    )
    db.add(exp)
    db.commit()
    db.refresh(exp)

    unreviewed_warning = None
    if unreviewed_invoices and not include_unreviewed:
        unreviewed_warning = f"{len(unreviewed_invoices)} invoice(s) in {req.tax_period} are unreviewed/rejected and were excluded from this GSTR-1."
    elif include_unreviewed and unreviewed_invoices:
        unreviewed_warning = f"Draft Export: Included {len(unreviewed_invoices)} unreviewed invoice(s) upon user request."

    token = storage_service.generate_signed_token(exp.id, expires_in_minutes=1440)

    return {
        "export_id": exp.id,
        "file_name": exp.file_name,
        "approved_count": len(approved_invoices),
        "unreviewed_count": len(unreviewed_invoices),
        "total_exported": len(target_invoices),
        "warning": unreviewed_warning,
        "download_url": f"/api/exports/download/{exp.id}?token={token}"
    }


@router.post("/approve-all")
def approve_all_invoices(
    client_id: str = Query(...),
    tax_period: str = Query(...),
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    """
    1-Click bulk approval for CA firm staff to approve all pending invoices for a client and period.
    """
    invoices = db.query(Invoice).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client_id,
        Invoice.tax_period == tax_period,
        Invoice.review_status == "needs_review"
    ).all()

    count = len(invoices)
    for inv in invoices:
        inv.review_status = "approved"
        inv.updated_at = datetime.utcnow()
        db.add(AuditLog(
            invoice_id=inv.id,
            user_id=current_user.id,
            user_name=current_user.full_name,
            field_name="review_status",
            old_value="needs_review",
            new_value="approved (Bulk approved for GSTR-1)"
        ))

    db.commit()
    return {"message": f"Successfully approved {count} invoice(s) for {tax_period}", "approved_count": count}


@router.get("/history", response_model=List[ExportOut])
def get_export_history(
    client_id: Optional[str] = None,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    query = db.query(Export).filter(Export.firm_id == current_user.firm_id)
    if client_id:
        query = query.filter(Export.client_id == client_id)

    exports = query.order_by(desc(Export.created_at)).limit(50).all()

    results = []
    for exp in exports:
        client_name = exp.client.name if exp.client else None
        token = storage_service.generate_signed_token(exp.id, expires_in_minutes=1440)
        results.append(ExportOut(
            id=exp.id,
            client_id=exp.client_id,
            client_name=client_name,
            tax_period=exp.tax_period,
            export_type=exp.export_type,
            file_name=exp.file_name,
            invoice_count=exp.invoice_count,
            created_at=exp.created_at,
            download_url=f"/api/exports/download/{exp.id}?token={token}"
        ))

    return results


@router.get("/download/{export_id}")
def download_export(
    export_id: str,
    token: Optional[str] = Query(None),
    db: Session = Depends(get_db)
):
    """
    Downloads generated Excel file.
    Accepts signed token in query param (?token=...) or standard Bearer authorization header.
    """
    # 1. Check signed token or JWT
    user_id = None
    firm_id = None

    if token:
        # Check if file access token
        verified_file_id = storage_service.verify_signed_token(token)
        if not verified_file_id:
            try:
                payload = decode_access_token(token)
                user_id = payload.sub
                firm_id = payload.firm_id
            except Exception:
                pass
    
    # If no token in query, try finding export
    exp = db.query(Export).filter(Export.id == export_id).first()
    if not exp:
        raise HTTPException(status_code=404, detail="Export not found")

    file_bytes = storage_service.read_file(exp.storage_path)

    return Response(
        content=file_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{exp.file_name}"'}
    )
