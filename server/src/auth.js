import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { config } from "./config.js";
import { db } from "./db/index.js";

export class HttpError extends Error {
  constructor(status, detail) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const verifyPassword = (pw, hash) => bcrypt.compareSync(pw, hash);

export function createAccessToken(userId) {
  return jwt.sign({ sub: userId, typ: "access" }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: `${config.accessTokenMinutes}m`,
  });
}

export async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) throw new HttpError(401, "Not authenticated");
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    } catch {
      throw new HttpError(401, "Could not validate credentials");
    }
    if (payload.typ !== "access") throw new HttpError(401, "Could not validate credentials");
    const user = await db.one("select * from users where id = $1", [payload.sub]);
    if (!user || !user.is_active) throw new HttpError(401, "User not found or inactive");
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

export const requireRoles = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role)
    ? next()
    : next(new HttpError(403, `Operation not permitted. Required roles: ${roles.join(", ")}`));

export const requireStaff = requireRoles("admin", "staff");
export const requireAdmin = requireRoles("admin");

export function publicUser(u) {
  return {
    id: u.id, email: u.email, full_name: u.full_name, role: u.role,
    firm_id: u.firm_id, client_id: u.client_id, is_active: u.is_active, created_at: u.created_at,
  };
}
