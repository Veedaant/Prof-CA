import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { authenticate } from "../auth.js";
import { isUuid, parseBody, wrap } from "../http.js";

const router = Router();
router.use(authenticate);

/** Which notifications this user may see: a client sees what concerns their own client; staff and admin see the firm's staff notifications. */
function scope(req) {
  if (req.user.role === "client") return { where: "n.firm_id=$1 and n.audience='client' and n.client_id=$2", params: [req.user.firm_id, req.user.client_id] };
  return { where: "n.firm_id=$1 and n.audience='staff' and $2::text is null", params: [req.user.firm_id, null] };
}

router.get("/", wrap(async (req, res) => {
  const s = scope(req);
  const rows = await db.query(
    `select n.id, n.kind, n.title, n.body, n.link, n.actor_name, n.actor_role, n.client_id, n.created_at, (r.user_id is not null) as read
       from notifications n left join notification_reads r on r.notification_id=n.id and r.user_id=$3
      where ${s.where} order by n.created_at desc limit 150`,
    [...s.params, req.user.id],
  );
  res.json({ unread: rows.filter((r) => !r.read).length, notifications: rows });
}));

router.get("/unread-count", wrap(async (req, res) => {
  const s = scope(req);
  const row = await db.one(
    `select count(*)::int as c from notifications n left join notification_reads r on r.notification_id=n.id and r.user_id=$3
      where ${s.where} and r.user_id is null`,
    [...s.params, req.user.id],
  );
  res.json({ unread: row?.c || 0 });
}));

router.post("/read", wrap(async (req, res) => {
  const b = parseBody(z.object({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }), req.body);
  const s = scope(req);
  const ids = (b.ids || []).filter(isUuid);
  if (!b.all && !ids.length) return res.json({ ok: true });
  await db.query(
    `insert into notification_reads (notification_id, user_id)
     select n.id, $3 from notifications n
      where ${s.where} ${b.all ? "" : "and n.id = any($4::uuid[])"}
        and not exists (select 1 from notification_reads r where r.notification_id=n.id and r.user_id=$3)
     on conflict do nothing`,
    b.all ? [...s.params, req.user.id] : [...s.params, req.user.id, ids],
  );
  res.json({ ok: true });
}));

export default router;
