import { HttpError } from "./auth.js";

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID.test(v);

/** Throws 404 for malformed ids so Postgres never sees an invalid uuid. */
export function uuidParam(v, what = "Resource") {
  if (!isUuid(v)) throw new HttpError(404, `${what} not found`);
  return v;
}

export function parseBody(schema, body) {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw new HttpError(422, detail);
  }
  return r.data;
}

export function errorHandler(err, _req, res, _next) {
  if (err instanceof HttpError) return res.status(err.status).json({ detail: err.detail });
  if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ detail: "File too large" });
  if (err?.type === "entity.parse.failed") return res.status(400).json({ detail: "Invalid JSON body" });
  if (err?.name === "MulterError") return res.status(400).json({ detail: err.message });
  console.error("[error]", err);
  res.status(500).json({ detail: "Internal server error" });
}

export function createQueue(concurrency = 2) {
  const pending = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && pending.length) {
      const job = pending.shift();
      active++;
      job().catch((e) => console.error("[queue]", e)).finally(() => { active--; pump(); });
    }
  };
  return { add(job) { pending.push(job); pump(); } };
}
