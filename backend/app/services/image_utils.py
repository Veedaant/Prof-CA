import io
from pathlib import Path
from typing import List, Tuple
from PIL import Image, ImageOps, ImageFilter
import numpy as np

# Register HEIF opener for HEIC images
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except Exception:
    pass

# Import PyMuPDF (fitz)
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

def assess_image_quality(image: Image.Image) -> Tuple[float, bool, bool]:
    """
    Assesses image quality for blurriness and darkness.
    Returns: (blur_score, is_blurry, is_dark)
    """
    # Convert to grayscale
    gray = image.convert("L")
    arr = np.array(gray, dtype=np.float32)

    # Darkness check (mean brightness from 0 to 255)
    mean_brightness = float(np.mean(arr))
    is_dark = mean_brightness < 40.0  # Very dark capture

    # Blurriness check using Laplacian variance
    # Discrete Laplacian kernel
    # [ 0,  1,  0]
    # [ 1, -4,  1]
    # [ 0,  1,  0]
    if arr.shape[0] > 10 and arr.shape[1] > 10:
        # Fast 2D discrete Laplacian via slicing
        laplacian = (
            arr[:-2, 1:-1] + arr[2:, 1:-1] +
            arr[1:-1, :-2] + arr[1:-1, 2:] -
            4.0 * arr[1:-1, 1:-1]
        )
        blur_score = float(np.var(laplacian))
    else:
        blur_score = 1000.0

    # Low variance means edges are soft/blurry.
    # A threshold of 50.0 identifies severely blurry images.
    is_blurry = blur_score < 50.0

    return blur_score, is_blurry, is_dark

def load_file_as_images(file_bytes: bytes, filename: str) -> List[Image.Image]:
    """
    Loads PDF, HEIC, PNG, or JPG file bytes into a list of PIL Images.
    For PDFs, renders each page at high resolution (150-200 DPI).
    """
    ext = Path(filename).suffix.lower()
    images = []

    if ext == ".pdf":
        if fitz is None:
            raise RuntimeError("PyMuPDF (fitz) is required to process PDF files")
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        for page_num in range(len(doc)):
            page = doc.load_page(page_num)
            # Render at 2x resolution (144 DPI) for clarity
            mat = fitz.Matrix(2.0, 2.0)
            pix = page.get_pixmap(matrix=mat)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            images.append(img)
        doc.close()
    else:
        # Image file (JPG, PNG, HEIC, etc.)
        bio = io.BytesIO(file_bytes)
        img = Image.open(bio)
        # Apply EXIF rotation if needed
        try:
            img = ImageOps.exif_transpose(img)
        except Exception:
            pass
        images.append(img.convert("RGB"))

    return images

def image_to_jpeg_bytes(image: Image.Image, quality: int = 90) -> bytes:
    """Helper to convert PIL Image to JPEG bytes"""
    out = io.BytesIO()
    image.save(out, format="JPEG", quality=quality)
    return out.getvalue()
