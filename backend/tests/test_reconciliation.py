import io
import pytest
from app.routers.reconciliation import normalize_inv_num, normalize_gstin

def test_normalization():
    assert normalize_inv_num("INV/2025-001") == "INV2025001"
    assert normalize_inv_num("inv # 1234") == "INV1234"
    assert normalize_gstin("27-AAACA1234A1ZK ") == "27AAACA1234A1ZK"
