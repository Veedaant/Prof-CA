import { db } from "../db/index.js";

/**
 * In-app notification for the other side. audience "staff" is seen by the CA firm (admin and staff);
 * audience "client" is seen by the users of that client. Never throws: a failed notification must not fail the request itself.
 */
export async function notify({ firmId, audience, clientId, kind, title, body = "", link = "", actor = null }) {
  try {
    await db.query(
      `insert into notifications (firm_id, audience, client_id, kind, title, body, link, actor_name, actor_role)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [firmId, audience, clientId, kind, String(title).slice(0, 300), String(body || "").slice(0, 1000), link || null, actor?.full_name || null, actor?.role || null],
    );
  } catch (e) {
    console.error("[notify]", e.message);
  }
}
