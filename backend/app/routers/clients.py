from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.database import get_db
from app.models import Client, Invoice, User
from app.schemas import ClientCreate, ClientUpdate, ClientOut
from app.auth import get_current_user, require_ca_staff

router = APIRouter(prefix="/clients", tags=["clients"])

@router.get("", response_model=List[ClientOut])
def get_clients(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(Client).filter(Client.firm_id == current_user.firm_id)

    # Scoping for client role
    if current_user.role == "client":
        if not current_user.client_id:
            return []
        query = query.filter(Client.id == current_user.client_id)

    clients = query.order_by(Client.name.asc()).all()
    results = []

    for c in clients:
        # Compute counts
        total_inv = db.query(func.count(Invoice.id)).filter(
            Invoice.firm_id == current_user.firm_id,
            Invoice.client_id == c.id
        ).scalar() or 0

        needs_review = db.query(func.count(Invoice.id)).filter(
            Invoice.firm_id == current_user.firm_id,
            Invoice.client_id == c.id,
            Invoice.review_status == "needs_review"
        ).scalar() or 0

        approved = db.query(func.count(Invoice.id)).filter(
            Invoice.firm_id == current_user.firm_id,
            Invoice.client_id == c.id,
            Invoice.review_status.in_(["approved", "auto_approved"])
        ).scalar() or 0

        results.append(ClientOut(
            id=c.id,
            firm_id=c.firm_id,
            name=c.name,
            trade_name=c.trade_name,
            gstin=c.gstin,
            email=c.email,
            phone=c.phone,
            state=c.state,
            state_code=c.state_code,
            address=c.address,
            created_at=c.created_at,
            total_invoices=total_inv,
            needs_review_count=needs_review,
            approved_count=approved
        ))

    return results

@router.post("", response_model=ClientOut, status_code=status.HTTP_201_CREATED)
def create_client(
    client_in: ClientCreate,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    client = Client(
        firm_id=current_user.firm_id,
        name=client_in.name,
        trade_name=client_in.trade_name,
        gstin=client_in.gstin.strip().upper() if client_in.gstin else None,
        email=client_in.email,
        phone=client_in.phone,
        state=client_in.state,
        state_code=client_in.state_code,
        address=client_in.address,
    )
    db.add(client)
    db.commit()
    db.refresh(client)

    return ClientOut(
        id=client.id,
        firm_id=client.firm_id,
        name=client.name,
        trade_name=client.trade_name,
        gstin=client.gstin,
        email=client.email,
        phone=client.phone,
        state=client.state,
        state_code=client.state_code,
        address=client.address,
        created_at=client.created_at,
        total_invoices=0,
        needs_review_count=0,
        approved_count=0
    )

@router.get("/{client_id}", response_model=ClientOut)
def get_client(
    client_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(Client).filter(
        Client.id == client_id,
        Client.firm_id == current_user.firm_id
    )
    if current_user.role == "client" and current_user.client_id != client_id:
        raise HTTPException(status_code=403, detail="Access denied")

    client = query.first()
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    total_inv = db.query(func.count(Invoice.id)).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client.id
    ).scalar() or 0

    needs_review = db.query(func.count(Invoice.id)).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client.id,
        Invoice.review_status == "needs_review"
    ).scalar() or 0

    approved = db.query(func.count(Invoice.id)).filter(
        Invoice.firm_id == current_user.firm_id,
        Invoice.client_id == client.id,
        Invoice.review_status.in_(["approved", "auto_approved"])
    ).scalar() or 0

    return ClientOut(
        id=client.id,
        firm_id=client.firm_id,
        name=client.name,
        trade_name=client.trade_name,
        gstin=client.gstin,
        email=client.email,
        phone=client.phone,
        state=client.state,
        state_code=client.state_code,
        address=client.address,
        created_at=client.created_at,
        total_invoices=total_inv,
        needs_review_count=needs_review,
        approved_count=approved
    )
