import json
import base64
from typing import Optional, Dict, Any, List
from datetime import datetime
from PIL import Image

try:
    import zxingcpp
except ImportError:
    zxingcpp = None

try:
    from pyzbar.pyzbar import decode as pyzbar_decode
except ImportError:
    pyzbar_decode = None

def _decode_jwt_payload_unverified(token: str) -> Optional[Dict[str, Any]]:
    """Decodes JWT payload without verifying signature (for reading signed e-invoice QR)"""
    try:
        parts = token.split(".")
        if len(parts) >= 2:
            payload_b64 = parts[1]
            # Add padding if needed
            rem = len(payload_b64) % 4
            if rem > 0:
                payload_b64 += "=" * (4 - rem)
            payload_bytes = base64.urlsafe_b64decode(payload_b64)
            data = json.loads(payload_bytes.decode("utf-8"))
            return data
    except Exception:
        pass
    return None

def _normalize_date(date_str: str) -> str:
    """Normalizes dates like DD/MM/YYYY or DD-MM-YYYY to YYYY-MM-DD"""
    if not date_str:
        return ""
    date_str = str(date_str).strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%y", "%d-%b-%Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return date_str

def decode_einvoice_qr(images: List[Image.Image]) -> Optional[Dict[str, Any]]:
    """
    Scans images for an Indian e-invoice QR code using zxing-cpp or pyzbar.
    Parses signed JWT or raw JSON payload.
    """
    for img in images:
        raw_text = None

        # 1. Try zxing-cpp first (fast and robust on rotated/skewed QRs)
        if zxingcpp is not None:
            try:
                results = zxingcpp.read_barcodes(img)
                for res in results:
                    if res.text and len(res.text) > 20:
                        raw_text = res.text
                        break
            except Exception:
                pass

        # 2. Try pyzbar if not found
        if not raw_text and pyzbar_decode is not None:
            try:
                decoded = pyzbar_decode(img)
                for item in decoded:
                    text = item.data.decode("utf-8", errors="ignore")
                    if text and len(text) > 20:
                        raw_text = text
                        break
            except Exception:
                pass

        if not raw_text:
            continue

        # Parse QR contents
        payload = None
        if "." in raw_text and len(raw_text.split(".")) >= 2:
            payload = _decode_jwt_payload_unverified(raw_text)
        elif raw_text.startswith("{") and raw_text.endswith("}"):
            try:
                payload = json.loads(raw_text)
            except Exception:
                pass

        if payload:
            # Map Indian NIC/GSTN e-invoice QR keys
            irn = payload.get("Irn") or payload.get("IRN") or payload.get("irn")
            seller_gstin = payload.get("SellerGstin") or payload.get("supplier_gstin") or payload.get("sellerGstin")
            buyer_gstin = payload.get("BuyerGstin") or payload.get("buyer_gstin") or payload.get("buyerGstin")
            doc_no = payload.get("DocNo") or payload.get("doc_no") or payload.get("invoice_number")
            doc_dt = payload.get("DocDt") or payload.get("doc_dt") or payload.get("invoice_date")
            tot_val = payload.get("TotInvVal") or payload.get("tot_inv_val") or payload.get("invoice_total")
            item_cnt = payload.get("ItemCnt") or payload.get("item_cnt")
            main_hsn = payload.get("MainHsnCode") or payload.get("main_hsn_code")

            try:
                tot_val_float = float(tot_val) if tot_val is not None else None
            except ValueError:
                tot_val_float = None

            return {
                "irn": irn,
                "supplier_gstin": seller_gstin,
                "buyer_gstin": buyer_gstin,
                "invoice_number": str(doc_no) if doc_no else None,
                "invoice_date": _normalize_date(doc_dt) if doc_dt else None,
                "invoice_total": tot_val_float,
                "item_count": item_cnt,
                "main_hsn": main_hsn,
                "raw_payload": payload
            }

    return None
