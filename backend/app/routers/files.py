import io
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import InvoiceFile
from app.services.storage import storage_service
from app.services.image_utils import load_file_as_images, image_to_jpeg_bytes

router = APIRouter(prefix="/files", tags=["files"])

@router.get("/{file_id}/view")
def view_file(
    file_id: str,
    token: str = Query(...),
    as_image: bool = Query(False),
    page: int = Query(0),
    db: Session = Depends(get_db)
):
    """
    Serves a stored file privately using a short-lived signed token.
    If as_image=true and file is a PDF, renders the requested page as JPEG.
    """
    verified_file_id = storage_service.verify_signed_token(token)
    if not verified_file_id or verified_file_id != file_id:
        raise HTTPException(status_code=403, detail="Invalid or expired file access token")

    inv_file = db.query(InvoiceFile).filter(InvoiceFile.id == file_id).first()
    if not inv_file:
        raise HTTPException(status_code=404, detail="File record not found")

    file_bytes = storage_service.read_file(inv_file.storage_path)

    # If requested as image (e.g. for split-screen preview of PDF pages)
    if as_image or inv_file.original_filename.lower().endswith(".heic"):
        try:
            images = load_file_as_images(file_bytes, inv_file.original_filename)
            target_idx = min(page, len(images) - 1) if images else 0
            if images:
                jpg_bytes = image_to_jpeg_bytes(images[target_idx])
                return Response(
                    content=jpg_bytes,
                    media_type="image/jpeg",
                    headers={"Content-Disposition": f'inline; filename="{inv_file.original_filename}.jpg"'}
                )
        except Exception:
            pass

    return Response(
        content=file_bytes,
        media_type=inv_file.mime_type or "application/octet-stream",
        headers={"Content-Disposition": f'inline; filename="{inv_file.original_filename}"'}
    )
