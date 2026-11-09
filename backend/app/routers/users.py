from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, Client
from app.schemas import UserCreate, UserOut
from app.auth import get_current_user, require_ca_admin, require_ca_staff, get_password_hash

router = APIRouter(prefix="/users", tags=["users"])

@router.get("", response_model=List[UserOut])
def get_users(
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    users = db.query(User).filter(User.firm_id == current_user.firm_id).order_by(User.created_at.desc()).all()
    results = []
    for u in users:
        results.append(UserOut(
            id=u.id,
            email=u.email,
            full_name=u.full_name,
            role=u.role,
            firm_id=u.firm_id,
            client_id=u.client_id,
            firm_name=u.firm.name if u.firm else None
        ))
    return results

@router.post("", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def create_user(
    user_in: UserCreate,
    current_user: User = Depends(require_ca_staff),
    db: Session = Depends(get_db)
):
    # Only admin can create another admin
    if user_in.role == "admin" and current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only CA firm admin can create admin users")

    # Check if email already taken
    existing = db.query(User).filter(User.email == user_in.email.lower().strip()).first()
    if existing:
        raise HTTPException(status_code=400, detail="User with this email already exists")

    # If role is client, verify client exists in firm
    if user_in.role == "client":
        if not user_in.client_id:
            raise HTTPException(status_code=400, detail="client_id is required for users with client role")
        client = db.query(Client).filter(
            Client.id == user_in.client_id,
            Client.firm_id == current_user.firm_id
        ).first()
        if not client:
            raise HTTPException(status_code=404, detail="Client not found in your firm")

    new_user = User(
        email=user_in.email.lower().strip(),
        password_hash=get_password_hash(user_in.password),
        full_name=user_in.full_name.strip(),
        role=user_in.role,
        firm_id=current_user.firm_id,
        client_id=user_in.client_id if user_in.role == "client" else None,
        is_active=True
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)

    return UserOut(
        id=new_user.id,
        email=new_user.email,
        full_name=new_user.full_name,
        role=new_user.role,
        firm_id=new_user.firm_id,
        client_id=new_user.client_id,
        firm_name=current_user.firm.name if current_user.firm else None
    )

@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_user(
    user_id: str,
    current_user: User = Depends(require_ca_admin),
    db: Session = Depends(get_db)
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete your own user account")

    user_to_delete = db.query(User).filter(
        User.id == user_id,
        User.firm_id == current_user.firm_id
    ).first()
    if not user_to_delete:
        raise HTTPException(status_code=404, detail="User not found")

    db.delete(user_to_delete)
    db.commit()
    return None
