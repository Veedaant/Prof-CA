import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { db, initDb } from "./db/index.js";
import { errorHandler } from "./http.js";
import { storageKind } from "./services/storage.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import clientRoutes from "./routes/clients.js";
import invoiceRoutes from "./routes/invoices.js";
import fileRoutes from "./routes/files.js";
import exportRoutes from "./routes/exports.js";
import reconciliationRoutes from "./routes/reconciliation.js";
import gstRoutes from "./routes/gst.js";
import reconRoutes from "./routes/recon.js";
import gstr3bRoutes from "./routes/gstr3b.js";
import itc2bRoutes, { resumeGstr1Reads } from "./routes/itc2b.js";
import outputRoutes from "./routes/output.js";
import notificationRoutes from "./routes/notifications.js";
import { seedDatabase } from "./seeds/seed.js";
import { resumeUnfinished } from "./routes/invoices.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (config.isProd) app.set("trust proxy", 1);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins, credentials: false }));
  app.use(express.json({ limit: "2mb" }));

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isProd ? 20 : 1000, standardHeaders: true, legacyHeaders: false, message: { detail: "Too many login attempts. Try again later." } });
  const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: config.isProd ? 600 : 100000, standardHeaders: true, legacyHeaders: false, message: { detail: "Too many requests" } });

  app.get("/health", (_req, res) =>
    res.json({ status: "healthy", project: "GST Invoice Automator", version: "1.0.0", database: db.kind, storage: storageKind() }));

  app.use("/api", apiLimiter);
  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth/register", loginLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/clients", clientRoutes);
  app.use("/api/invoices", invoiceRoutes);
  app.use("/api/files", fileRoutes);
  app.use("/api/exports", exportRoutes);
  app.use("/api/reconciliation", reconciliationRoutes);
  app.use("/api/gst", gstRoutes);
  app.use("/api/recon", reconRoutes);
  app.use("/api/gstr3b", gstr3bRoutes);
  app.use("/api/itc2b", itc2bRoutes);
  app.use("/api/output", outputRoutes);
  app.use("/api/notifications", notificationRoutes);
  app.use("/api", (_req, res) => res.status(404).json({ detail: "Not found" }));

  const index = path.join(config.clientDist, "index.html");
  if (fs.existsSync(index)) {
    app.use(express.static(config.clientDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|health).*/, (_req, res) => res.sendFile(index));
  }

  app.use(errorHandler);
  return app;
}

export async function start() {
  await initDb();
  if (config.seedOnEmpty) await seedDatabase();
  const app = createApp();
  resumeUnfinished().catch((e) => console.error("[resume]", e));
  resumeGstr1Reads().catch((e) => console.error("[resume gstr1]", e));
  const server = app.listen(config.port, () => {
    console.log(`GST Invoice Automator API on :${config.port} (db: ${db.kind}, storage: ${storageKind()}, env: ${config.isProd ? "production" : "development"})`);
  });
  const shutdown = async () => {
    server.close();
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch((e) => {
    console.error("Failed to start:", e);
    process.exit(1);
  });
}
