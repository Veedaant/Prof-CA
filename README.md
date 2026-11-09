# GST Invoice Automator (CA Portal)

React (Vite) + Express + Node.js, with Supabase (managed Postgres + Storage). AI extraction via Gemini.

## Run locally
```bash
npm run install:all
npm run dev        # API on :8000; with no DATABASE_URL it uses an embedded Postgres (PGlite) and seeds demo data
npm run dev:web    # Vite on :3000, proxies /api to :8000
```
Demo logins: admin@example.com/admin123, staff@example.com/staff123, client1@example.com/client123.

## Production on Supabase
1. Create a Supabase project and a private Storage bucket named `invoices`.
2. Copy `.env.example` to `.env`; set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, a 32+ char `JWT_SECRET`, `GEMINI_API_KEY`.
3. `npm run migrate` (creates tables; RLS is enabled with no policies, so the public Supabase REST API cannot read them — only this server can).
4. `SEED_DEMO_DATA=true npm run seed` once if you want demo data, otherwise create the first firm/admin yourself via SQL.
5. `npm run install:all && npm run build && npm start` (or build the Dockerfile). The server also serves `frontend/dist`.

Tests: `npm test`.
