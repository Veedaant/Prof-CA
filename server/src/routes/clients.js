import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, authenticate, requireStaff } from "../auth.js";
import { parseBody, uuidParam, wrap } from "../http.js";

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  name: z.string().min(1).max(255),
  trade_name: z.string().max(255).nullish(),
  gstin: z.string().max(15).nullish(),
  email: z.string().max(255).nullish(),
  phone: z.string().max(20).nullish(),
  state: z.string().max(100).nullish(),
  state_code: z.string().max(2).nullish(),
  address: z.string().nullish(),
});

const withStats = `
  select c.*,
    (select count(*)::int from invoices i where i.client_id=c.id) as total_invoices,
    (select count(*)::int from invoices i where i.client_id=c.id and i.review_status='needs_review') as needs_review_count,
    (select count(*)::int from invoices i where i.client_id=c.id and i.review_status in ('approved','auto_approved')) as approved_count
  from clients c`;

router.get("/", wrap(async (req, res) => {
  const u = req.user;
  const rows = u.role === "client"
    ? await db.query(`${withStats} where c.firm_id=$1 and c.id=$2 order by c.name`, [u.firm_id, u.client_id])
    : await db.query(`${withStats} where c.firm_id=$1 order by c.name`, [u.firm_id]);
  res.json(rows);
}));

router.post("/", requireStaff, wrap(async (req, res) => {
  const b = parseBody(createSchema, req.body);
  const row = await db.one(
    `insert into clients (firm_id,name,trade_name,gstin,email,phone,state,state_code,address)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [req.user.firm_id, b.name, b.trade_name ?? null, b.gstin ? b.gstin.trim().toUpperCase() : null,
      b.email ?? null, b.phone ?? null, b.state ?? null, b.state_code ?? null, b.address ?? null],
  );
  res.status(201).json({ ...row, total_invoices: 0, needs_review_count: 0, approved_count: 0 });
}));

router.get("/:id", wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "Client");
  if (req.user.role === "client" && req.user.client_id !== id) throw new HttpError(403, "Access denied");
  const row = await db.one(`${withStats} where c.id=$1 and c.firm_id=$2`, [id, req.user.firm_id]);
  if (!row) throw new HttpError(404, "Client not found");
  res.json(row);
}));

export default router;
