import os
import uuid
import hashlib
from pathlib import Path
from typing import Optional, BinaryIO
from datetime import datetime, timedelta, timezone
import jwt

from app.config import settings

class StorageService:
    """
    Abstracted storage interface. Currently uses local filesystem object storage,
    designed to easily swap with AWS S3, Cloudflare R2, or Google Cloud Storage.
    """
    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = Path(base_dir or settings.STORAGE_DIR)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def save_file(self, content: bytes, original_filename: str, firm_id: str, client_id: str) -> tuple[str, str, int]:
        """
        Saves file under: <base_dir>/firms/<firm_id>/clients/<client_id>/<file_uuid>_<filename>
        Returns: (storage_path, file_hash, file_size)
        """
        file_hash = hashlib.sha256(content).hexdigest()
        ext = Path(original_filename).suffix.lower()
        file_uuid = uuid.uuid4().hex[:12]
        
        target_dir = self.base_dir / "firms" / firm_id / "clients" / client_id
        target_dir.mkdir(parents=True, exist_ok=True)
        
        safe_filename = f"{file_uuid}{ext}"
        target_path = target_dir / safe_filename
        
        with open(target_path, "wb") as f:
            f.write(content)
            
        relative_path = str(target_path.relative_to(self.base_dir)).replace("\\", "/")
        return relative_path, file_hash, len(content)

    def get_absolute_path(self, storage_path: str) -> Path:
        return self.base_dir / storage_path

    def read_file(self, storage_path: str) -> bytes:
        abs_path = self.get_absolute_path(storage_path)
        if not abs_path.exists():
            raise FileNotFoundError(f"Stored file not found: {storage_path}")
        with open(abs_path, "rb") as f:
            return f.read()

    def generate_signed_token(self, file_id: str, expires_in_minutes: int = 60) -> str:
        """
        Generates short-lived signed token to view/download private files securely.
        """
        payload = {
            "file_id": file_id,
            "exp": datetime.now(timezone.utc) + timedelta(minutes=expires_in_minutes),
            "type": "file_access"
        }
        return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)

    def verify_signed_token(self, token: str) -> Optional[str]:
        """
        Verifies signed token and returns the file_id if valid.
        """
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            if payload.get("type") == "file_access":
                return payload.get("file_id")
        except jwt.PyJWTError:
            pass
        return None

storage_service = StorageService()
