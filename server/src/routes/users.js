import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, authenticate, hashPassword, publicUser, requireAdmin, requireStaff } from "../auth.js";
import { isUuid, parseBody, uuidParam, wrap } from "../http.js";

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  full_name: z.string().min(1).max(255),
  role: z.enum(["admin", "staff", "client"]),
  client_id: z.string().nullish(),
});

router.get("/", requireStaff, wrap(async (req, res) => {
  const rows = await db.query("select * from users where firm_id=$1 order by created_at desc", [req.user.firm_id]);
  res.json(rows.map(publicUser));
}));

router.post("/", requireStaff, wrap(async (req, res) => {
  const b = parseBody(createSchema, req.body);
  if (b.role === "admin" && req.user.role !== "admin") throw new HttpError(403, "Only admins can create admin users");
  if (await db.one("select 1 from users where lower(email)=lower($1)", [b.email])) throw new HttpError(400, "Email already registered");
  let clientId = null;
  if (b.role === "client") {
    if (!b.client_id || !isUuid(b.client_id)) throw new HttpError(400, "client_id is required for client users");
    const c = await db.one("select id from clients where id=$1 and firm_id=$2", [b.client_id, req.user.firm_id]);
    if (!c) throw new HttpError(400, "Client not found in your firm");
    clientId = c.id;
  }
  const row = await db.one(
    `insert into users (email, password_hash, full_name, role, firm_id, client_id)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [b.email.trim(), hashPassword(b.password), b.full_name, b.role, req.user.firm_id, clientId],
  );
  res.status(201).json(publicUser(row));
}));

router.delete("/:id", requireAdmin, wrap(async (req, res) => {
  const id = uuidParam(req.params.id, "User");
  if (id === req.user.id) throw new HttpError(400, "You cannot delete your own account");
  const u = await db.one("select id from users where id=$1 and firm_id=$2", [id, req.user.firm_id]);
  if (!u) throw new HttpError(404, "User not found");
  await db.query("delete from users where id=$1", [id]);
  res.status(204).end();
}));

export default router;
