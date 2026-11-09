import { test } from "node:test";
import assert from "node:assert/strict";
import { gstinCheckChar, validateGstinChecksum, validateGstinFormat, validateInvoice, determineReviewStatus, extractStateCode } from "../src/services/validators.js";

const good = "27AAACA1234A1Z" + gstinCheckChar("27AAACA1234A1Z");

test("GSTIN checksum round-trips and detects tampering", () => {
  assert.ok(validateGstinFormat(good));
  assert.ok(validateGstinChecksum(good));
  const bad = good.slice(0, 14) + (good[14] === "A" ? "B" : "A");
  assert.ok(!validateGstinChecksum(bad));
  assert.ok(!validateGstinFormat("123"));
});

test("state code extraction", () => {
  assert.equal(extractStateCode("27-Maharashtra"), "27");
  assert.equal(extractStateCode(good), "27");
  assert.equal(extractStateCode(""), null);
});

test("tax math, place of supply, date and HSN checks", () => {
  const inv = { supplier_gstin: good, place_of_supply: "27", invoice_date: "2025-01-10", invoice_number: "A1", total_taxable_value: 1000, cgst_total: 90, sgst_total: 90, igst_total: 0, cess_total: 0, invoice_total: 1300 };
  const flags = validateInvoice(inv, [{ hsn_sac: "12" }], "2025-02");
  const types = flags.map((f) => f.type);
  assert.ok(types.includes("tax_calculation_mismatch"));
  assert.ok(types.includes("invalid_hsn_code"));
  assert.ok(types.includes("tax_period_mismatch"));

  const inter = validateInvoice({ ...inv, place_of_supply: "29", invoice_total: 1180 }, [], null).map((f) => f.type);
  assert.ok(inter.includes("pos_tax_mismatch"));

  assert.ok(validateInvoice({ ...inv, invoice_date: "2025-13-45" }, [], null).some((f) => f.type === "invalid_date_format"));
  assert.deepEqual(validateInvoice({ ...inv, invoice_total: 1180 }, [{ hsn_sac: "9405" }], "2025-01"), []);
});

test("auto-approve only when confident and clean", () => {
  assert.equal(determineReviewStatus(0.95, []), "auto_approved");
  assert.equal(determineReviewStatus(0.95, [{}]), "needs_review");
  assert.equal(determineReviewStatus(0.8, []), "needs_review");
});
