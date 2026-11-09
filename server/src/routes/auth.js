import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { HttpError, authenticate, createAccessToken, verifyPassword, hashPassword } from "../auth.js";
import { validateGstinFormat, validateGstinChecksum, extractStateCode, STATE_CODES } from "../services/validators.js";
import { parseBody, wrap } from "../http.js";

const router = Router();
const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

export async function userWithFirm(u) {
  const firm = await db.one("select name from firms where id=$1", [u.firm_id]);
  return {
    id: u.id, email: u.email, full_name: u.full_name, role: u.role,
    firm_id: u.firm_id, client_id: u.client_id, firm_name: firm?.name ?? null,
  };
}

router.post("/login", wrap(async (req, res) => {
  const { email, password } = parseBody(loginSchema, req.body);
  const user = await db.one("select * from users where lower(email)=lower($1)", [email.trim()]);
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, "Incorrect email or password");
  if (!user.is_active) throw new HttpError(400, "Account is inactive");
  res.json({ access_token: createAccessToken(user.id), token_type: "bearer", user: await userWithFirm(user) });
}));

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  full_name: z.string().trim().min(2).max(255),
  company_name: z.string().trim().min(2).max(255),
  firm_id: z.string().uuid(),
  gstin: z.string().trim().optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
});

router.get("/firms", wrap(async (_req, res) => {
  res.json(await db.query("select id, name from firms order by name"));
}));

router.post("/register", wrap(async (req, res) => {
  const b = parseBody(registerSchema, req.body);
  const firm = await db.one("select id from firms where id=$1", [b.firm_id]);
  if (!firm) throw new HttpError(404, "Selected CA firm not found");
  const email = b.email.trim().toLowerCase();
  if (await db.one("select 1 as x from users where lower(email)=$1", [email])) throw new HttpError(409, "An account with this email already exists");
  const gstin = (b.gstin || "").replace(/\s+/g, "").toUpperCase();
  if (gstin && (!validateGstinFormat(gstin) || !validateGstinChecksum(gstin))) throw new HttpError(422, "GSTIN is not valid");
  const code = gstin ? extractStateCode(gstin) : null;
  const user = await db.tx(async (q) => {
    const client = (await q(
      "insert into clients (firm_id,name,gstin,email,phone,state,state_code) values ($1,$2,$3,$4,$5,$6,$7) returning id",
      [b.firm_id, b.company_name, gstin || null, email, b.phone || null, code ? STATE_CODES[code] : null, code],
    ))[0];
    return (await q(
      "insert into users (email,password_hash,full_name,role,firm_id,client_id) values ($1,$2,$3,'client',$4,$5) returning *",
      [email, hashPassword(b.password), b.full_name, b.firm_id, client.id],
    ))[0];
  });
  res.status(201).json({ access_token: createAccessToken(user.id), token_type: "bearer", user: await userWithFirm(user) });
}));

router.get("/me", authenticate, wrap(async (req, res) => res.json(await userWithFirm(req.user))));

router.post("/logout", authenticate, (_req, res) => res.json({ message: "Successfully logged out" }));

export default router;
