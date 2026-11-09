import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");

dotenv.config({ path: path.join(SERVER_ROOT, ".env") });
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });

const env = process.env;
const isProd = env.NODE_ENV === "production";

const DEV_SECRET = "dev-only-insecure-secret-change-me";
if (isProd && (!env.JWT_SECRET || env.JWT_SECRET === DEV_SECRET || env.JWT_SECRET.length < 32)) {
  throw new Error("JWT_SECRET must be set to a random string of at least 32 characters in production");
}
if (isProd && !env.DATABASE_URL) {
  throw new Error("DATABASE_URL (Supabase Postgres connection string) is required in production");
}

export const config = {
  isProd,
  port: Number(env.PORT || 8000),
  databaseUrl: env.DATABASE_URL || "",
  pgliteDir: env.PGLITE_DIR || path.join(SERVER_ROOT, ".data", "pglite"),
  jwtSecret: env.JWT_SECRET || DEV_SECRET,
  accessTokenMinutes: Number(env.ACCESS_TOKEN_MINUTES || 60 * 12),
  geminiApiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "",
  geminiModel: env.GEMINI_MODEL || "gemini-3.8-flash",
  supabaseUrl: env.SUPABASE_URL || "",
  supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || "",
  supabaseBucket: env.SUPABASE_BUCKET || "invoices",
  storageDir: env.STORAGE_DIR || path.join(SERVER_ROOT, "storage"),
  corsOrigins: (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  clientDist: env.CLIENT_DIST || path.join(PROJECT_ROOT, "frontend", "dist"),
  maxUploadMb: Number(env.MAX_UPLOAD_MB || 15),
  seedOnEmpty: env.SEED_DEMO_DATA ? env.SEED_DEMO_DATA === "true" : !isProd,
};
