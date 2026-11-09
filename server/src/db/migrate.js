import { initDb, db } from "./index.js";

await initDb();
console.log(`Schema applied on ${db.kind}`);
await db.close();
