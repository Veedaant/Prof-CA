import pytest
from app.services.validators import (
    validate_gstin_format,
    validate_gstin_checksum,
    extract_state_code,
    validate_invoice,
    determine_review_status
)

def test_gstin_format():
    # Valid formats
    assert validate_gstin_format("27AAACA1234A1ZK") is True
    assert validate_gstin_format("29AABCZ9876K1Z9") is True
    # Invalid formats
    assert validate_gstin_format("27AAACA1234") is False  # too short
    assert validate_gstin_format("27AAACA1234A123") is False  # wrong pattern
    assert validate_gstin_format("") is False
    assert validate_gstin_format(None) is False

def test_gstin_checksum():
    # Valid Indian GSTINs with verified checksum
    assert validate_gstin_checksum("27AAACA1234A1ZK") is True
    assert validate_gstin_checksum("29AABCZ9876K1Z9") is True
    assert validate_gstin_checksum("27AAACG1234G1Z2") is True
    # Corrupted last check character
    assert validate_gstin_checksum("27AAACA1234A1Z9") is False

def test_extract_state_code():
    assert extract_state_code("27AAACA1234A1ZK") == "27"
    assert extract_state_code("29AABCZ9876K1Z9") == "29"
    assert extract_state_code("Maharashtra") == "27"
    assert extract_state_code("Karnataka") == "29"

def test_tax_math_validation():
    # Taxable (100) + CGST (9) + SGST (9) = 118, Invoice total = 118 -> Valid (0 flags)
    inv_valid = {
        "supplier_gstin": "27AAACA1234A1ZK",
        "buyer_gstin": "27AAACG1234G1Z2",
        "place_of_supply": "27",
        "invoice_number": "INV-01",
        "invoice_date": "2025-01-10",
        "total_taxable_value": 100.0,
        "cgst_total": 9.0,
        "sgst_total": 9.0,
        "igst_total": 0.0,
        "cess_total": 0.0,
        "total_tax": 18.0,
        "invoice_total": 118.0
    }
    flags = validate_invoice(inv_valid, [])
    assert len(flags) == 0

    # Taxable (100) + Taxes (18) = 118, but Invoice Total = 130 -> Flagged with tax_calculation_mismatch
    inv_invalid_math = dict(inv_valid, invoice_total=130.0)
    flags_math = validate_invoice(inv_invalid_math, [])
    assert any(f["type"] == "tax_calculation_mismatch" for f in flags_math)

def test_pos_rule_intra_vs_inter():
    # Intra-state (27 to 27) with IGST instead of CGST/SGST -> Flagged with pos_tax_mismatch
    inv_intra_err = {
        "supplier_gstin": "27AAACA1234A1ZK",
        "buyer_gstin": "27AAACG1234G1Z2",
        "place_of_supply": "27",
        "invoice_number": "INV-02",
        "invoice_date": "2025-01-10",
        "total_taxable_value": 100.0,
        "cgst_total": 0.0,
        "sgst_total": 0.0,
        "igst_total": 18.0,
        "invoice_total": 118.0
    }
    flags = validate_invoice(inv_intra_err, [])
    assert any(f["type"] == "pos_tax_mismatch" for f in flags)

def test_auto_approval():
    assert determine_review_status(0.95, []) == "auto_approved"
    assert determine_review_status(0.85, []) == "needs_review"  # confidence < 0.9
    assert determine_review_status(0.95, [{"type": "some_warning", "severity": "error"}]) == "needs_review"
