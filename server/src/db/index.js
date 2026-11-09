import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let backend = null;

async function createPgBackend() {
  const { default: pg } = await import("pg");
  const url = config.databaseUrl;
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    ssl: local ? false : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("[db] idle client error", e.message));
  const run = (c) => async (text, params = []) => (await c.query(text, params)).rows;
  return {
    kind: "supabase-postgres",
    query: run(pool),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(run(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPgliteBackend(memory) {
  const { PGlite } = await import("@electric-sql/pglite");
  let dir;
  if (!memory) {
    dir = config.pgliteDir;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  }
  const pg = new PGlite(dir);
  await pg.waitReady;
  const run = (c) => async (text, params = []) => (await c.query(text, params)).rows;
  return {
    kind: "pglite-local-postgres",
    query: run(pg),
    exec: (sql) => pg.exec(sql),
    tx: (fn) => pg.transaction(async (t) => fn(run(t))),
    close: () => pg.close(),
  };
}

export async function initDb({ memory = false } = {}) {
  if (backend) return backend;
  backend = config.databaseUrl ? await createPgBackend() : await createPgliteBackend(memory);
  await backend.exec(fs.readFileSync(path.join(here, "schema.sql"), "utf8"));
  return backend;
}

export const db = {
  query: (text, params) => backend.query(text, params),
  one: async (text, params) => (await backend.query(text, params))[0] ?? null,
  tx: (fn) => backend.tx(fn),
  get kind() {
    return backend?.kind;
  },
  close: async () => {
    await backend?.close();
    backend = null;
  },
};
