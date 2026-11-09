from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Firm
from app.schemas import UserLogin, Token, UserOut
from app.auth import verify_password, create_access_token, get_current_user

router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/login", response_model=Token)
def login(login_data: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == login_data.email.lower().strip()).first()
    if not user or not verify_password(login_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Account is inactive"
        )

    # Token payload
    payload = {
        "sub": user.id,
        "email": user.email,
        "role": user.role,
        "firm_id": user.firm_id,
        "client_id": user.client_id,
    }
    access_token = create_access_token(data=payload)

    user_out = UserOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        firm_id=user.firm_id,
        client_id=user.client_id,
        firm_name=user.firm.name if user.firm else None
    )

    return Token(access_token=access_token, user=user_out)

@router.get("/me", response_model=UserOut)
def get_me(current_user: User = Depends(get_current_user)):
    return UserOut(
        id=current_user.id,
        email=current_user.email,
        full_name=current_user.full_name,
        role=current_user.role,
        firm_id=current_user.firm_id,
        client_id=current_user.client_id,
        firm_name=current_user.firm.name if current_user.firm else None
    )

@router.post("/logout")
def logout(current_user: User = Depends(get_current_user)):
    return {"message": "Successfully logged out"}
