import { Router } from "express";
import { db } from "../db/index.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { isUuid, wrap } from "../http.js";
import { categorize, isSalesSide } from "../services/gstr1Exporter.js";

const router = Router();
router.use(authenticate, requireStaff);

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sum = (rows, k) => r2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
const totals = (rows) => ({
  count: rows.length,
  taxable: sum(rows, "total_taxable_value"), cgst: sum(rows, "cgst_total"), sgst: sum(rows, "sgst_total"),
  igst: sum(rows, "igst_total"), cess: sum(rows, "cess_total"), tax: sum(rows, "total_tax"), total: sum(rows, "invoice_total"),
});

router.get("/working", wrap(async (req, res) => {
  const { client_id, tax_period } = req.query;
  if (!isUuid(client_id)) throw new HttpError(422, "client_id is required");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(tax_period || ""))) throw new HttpError(422, "tax_period must be YYYY-MM");
  const client = await db.one("select id, name, gstin from clients where id=$1 and firm_id=$2", [client_id, req.user.firm_id]);
  if (!client) throw new HttpError(404, "Client not found in your firm");

  const all = await db.query(
    "select * from invoices where firm_id=$1 and client_id=$2 and tax_period=$3 order by invoice_date, invoice_number",
    [req.user.firm_id, client.id, String(tax_period)],
  );
  const approved = all.filter((i) => i.client_approved_at && i.review_status !== "rejected");
  const waiting = all.length - approved.length;
  const items = approved.length ? await db.query("select * from line_items where invoice_id = any($1::uuid[]) order by item_index", [approved.map((i) => i.id)]) : [];
  const withItems = approved.map((i) => ({ ...i, line_items: items.filter((l) => l.invoice_id === i.id) }));
  const strip = ({ raw_extraction, qr_data, ...rest }) => rest;

  const returnOf = (i) => i.return_type || (i.invoice_type === "purchase" ? "gstr3b" : "gstr1");
  const g1 = withItems.filter((i) => returnOf(i) === "gstr1");
  const g3 = withItems.filter((i) => returnOf(i) === "gstr3b");
  const sales = g1.filter((i) => i.invoice_type === "sales");
  const notes = g1.filter((i) => ["credit_note", "debit_note"].includes(i.invoice_type));
  const salesNotes = notes.filter((i) => isSalesSide(i, client.gstin));
  const creditNotes = salesNotes.filter((i) => i.invoice_type === "credit_note");
  const debitNotes = salesNotes.filter((i) => i.invoice_type === "debit_note");
  const purchases = g3.filter((i) => i.invoice_type === "purchase");
  const purchaseNotes = notes.filter((i) => !isSalesSide(i, client.gstin));
  const others = g1.filter((i) => i.invoice_type === "other");

  const cat = categorize([...sales, ...salesNotes]);
  const section = (rows, key) => ({ key, count: rows.length, taxable: r2(rows.reduce((a, r) => a + (Number(r.taxable_value) || 0), 0)) });
  const net = (k) => r2(sum(sales, k) + sum(debitNotes, k) - sum(creditNotes, k));

  res.json({
    client, tax_period: String(tax_period),
    pending_client_approval: waiting,
    gstr3b: {
      purchases: purchases.map(strip),
      credit_notes: g3.filter((i) => i.invoice_type === "credit_note").map(strip),
      debit_notes: g3.filter((i) => i.invoice_type === "debit_note").map(strip),
      others: g3.filter((i) => i.invoice_type === "other").map(strip),
    },
    all_credit_notes: notes.filter((i) => i.invoice_type === "credit_note").map(strip),
    all_debit_notes: notes.filter((i) => i.invoice_type === "debit_note").map(strip),
    sales: sales.map(strip), credit_notes: creditNotes.map(strip), debit_notes: debitNotes.map(strip),
    purchases: purchases.map(strip), purchase_notes: purchaseNotes.map(strip), others: others.map(strip),
    working: {
      sections: [section(cat.b2b, "b2b"), section(cat.b2cl, "b2cl"), section(cat.b2cs, "b2cs"), section(cat.cdnr, "cdnr")],
      hsn: cat.hsn,
      sales: totals(sales), credit_notes: totals(creditNotes), debit_notes: totals(debitNotes),
      net: { taxable: net("total_taxable_value"), cgst: net("cgst_total"), sgst: net("sgst_total"), igst: net("igst_total"), cess: net("cess_total"), tax: net("total_tax"), total: net("invoice_total") },
    },
  });
}));

export default router;
