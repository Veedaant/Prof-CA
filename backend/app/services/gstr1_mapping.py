"""
GSTR-1 Excel Offline Utility Column Mappings Configuration.
Update this file whenever GSTN / CBIC updates the official GSTR-1 offline utility format.
"""

GSTR1_SHEET_CONFIGS = {
    "b2b": {
        "sheet_title": "b2b",
        "header_fill_color": "002060",
        "header_font_color": "FFFFFF",
        "columns": [
            {"key": "buyer_gstin", "header": "GSTIN/UIN of Recipient", "width": 20},
            {"key": "buyer_name", "header": "Receiver Name", "width": 28},
            {"key": "invoice_number", "header": "Invoice Number", "width": 18},
            {"key": "invoice_date", "header": "Invoice date", "width": 14},
            {"key": "invoice_total", "header": "Invoice Value", "width": 16, "format": "#,##0.00"},
            {"key": "place_of_supply", "header": "Place Of Supply", "width": 16},
            {"key": "reverse_charge", "header": "Reverse Charge", "width": 15},
            {"key": "applicable_tax_rate", "header": "Applicable % of Tax Rate", "width": 22},
            {"key": "invoice_type", "header": "Invoice Type", "width": 15},
            {"key": "ecommerce_gstin", "header": "E-Commerce GSTIN", "width": 18},
            {"key": "rate", "header": "Rate", "width": 12, "format": "0.00"},
            {"key": "taxable_value", "header": "Taxable Value", "width": 16, "format": "#,##0.00"},
            {"key": "cess_amount", "header": "Cess Amount", "width": 14, "format": "#,##0.00"},
        ]
    },
    "b2cl": {
        "sheet_title": "b2cl",
        "header_fill_color": "002060",
        "header_font_color": "FFFFFF",
        "columns": [
            {"key": "invoice_number", "header": "Invoice Number", "width": 18},
            {"key": "invoice_date", "header": "Invoice date", "width": 14},
            {"key": "invoice_total", "header": "Invoice Value", "width": 16, "format": "#,##0.00"},
            {"key": "place_of_supply", "header": "Place Of Supply", "width": 16},
            {"key": "applicable_tax_rate", "header": "Applicable % of Tax Rate", "width": 22},
            {"key": "rate", "header": "Rate", "width": 12, "format": "0.00"},
            {"key": "taxable_value", "header": "Taxable Value", "width": 16, "format": "#,##0.00"},
            {"key": "cess_amount", "header": "Cess Amount", "width": 14, "format": "#,##0.00"},
            {"key": "ecommerce_gstin", "header": "E-Commerce GSTIN", "width": 18},
        ]
    },
    "b2cs": {
        "sheet_title": "b2cs",
        "header_fill_color": "002060",
        "header_font_color": "FFFFFF",
        "columns": [
            {"key": "type", "header": "Type", "width": 12},
            {"key": "place_of_supply", "header": "Place Of Supply", "width": 16},
            {"key": "applicable_tax_rate", "header": "Applicable % of Tax Rate", "width": 22},
            {"key": "rate", "header": "Rate", "width": 12, "format": "0.00"},
            {"key": "taxable_value", "header": "Taxable Value", "width": 16, "format": "#,##0.00"},
            {"key": "cess_amount", "header": "Cess Amount", "width": 14, "format": "#,##0.00"},
            {"key": "ecommerce_gstin", "header": "E-Commerce GSTIN", "width": 18},
        ]
    },
    "cdnr": {
        "sheet_title": "cdnr",
        "header_fill_color": "002060",
        "header_font_color": "FFFFFF",
        "columns": [
            {"key": "buyer_gstin", "header": "GSTIN/UIN of Recipient", "width": 20},
            {"key": "buyer_name", "header": "Receiver Name", "width": 28},
            {"key": "invoice_number", "header": "Note Number", "width": 18},
            {"key": "invoice_date", "header": "Note Date", "width": 14},
            {"key": "note_type", "header": "Note Type", "width": 12},
            {"key": "place_of_supply", "header": "Place Of Supply", "width": 16},
            {"key": "reverse_charge", "header": "Reverse Charge", "width": 15},
            {"key": "note_supply_type", "header": "Note Supply Type", "width": 18},
            {"key": "invoice_total", "header": "Note Value", "width": 16, "format": "#,##0.00"},
            {"key": "applicable_tax_rate", "header": "Applicable % of Tax Rate", "width": 22},
            {"key": "rate", "header": "Rate", "width": 12, "format": "0.00"},
            {"key": "taxable_value", "header": "Taxable Value", "width": 16, "format": "#,##0.00"},
            {"key": "cess_amount", "header": "Cess Amount", "width": 14, "format": "#,##0.00"},
        ]
    },
    "hsn": {
        "sheet_title": "hsn",
        "header_fill_color": "002060",
        "header_font_color": "FFFFFF",
        "columns": [
            {"key": "hsn", "header": "HSN", "width": 14},
            {"key": "description", "header": "Description", "width": 30},
            {"key": "uqc", "header": "UQC", "width": 12},
            {"key": "total_quantity", "header": "Total Quantity", "width": 16, "format": "#,##0.00"},
            {"key": "total_value", "header": "Total Value", "width": 16, "format": "#,##0.00"},
            {"key": "taxable_value", "header": "Taxable Value", "width": 16, "format": "#,##0.00"},
            {"key": "igst_amount", "header": "Integrated Tax Amount", "width": 20, "format": "#,##0.00"},
            {"key": "cgst_amount", "header": "Central Tax Amount", "width": 18, "format": "#,##0.00"},
            {"key": "sgst_amount", "header": "State/UT Tax Amount", "width": 18, "format": "#,##0.00"},
            {"key": "cess_amount", "header": "Cess Amount", "width": 14, "format": "#,##0.00"},
        ]
    }
}
