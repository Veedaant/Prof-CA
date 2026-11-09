import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

let supabase = null;
async function getSupabase() {
  if (!config.supabaseUrl || !config.supabaseServiceKey) return null;
  if (!supabase) {
    const { createClient } = await import("@supabase/supabase-js");
    supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, { auth: { persistSession: false } });
    const { data } = await supabase.storage.getBucket(config.supabaseBucket);
    if (!data) await supabase.storage.createBucket(config.supabaseBucket, { public: false });
  }
  return supabase;
}

export const storageKind = () => (config.supabaseUrl && config.supabaseServiceKey ? "supabase-storage" : "local-disk");

function localPath(storagePath) {
  const base = path.resolve(config.storageDir);
  const full = path.resolve(base, storagePath);
  if (!full.startsWith(base + path.sep)) throw new Error("Invalid storage path");
  return full;
}

export async function putObject(storagePath, content, contentType = "application/octet-stream") {
  const sb = await getSupabase();
  if (sb) {
    const { error } = await sb.storage.from(config.supabaseBucket).upload(storagePath, content, { contentType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    return;
  }
  const full = localPath(storagePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

export async function saveFile(content, originalFilename, firmId, clientId, mime) {
  const fileHash = crypto.createHash("sha256").update(content).digest("hex");
  const ext = path.extname(originalFilename).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const storagePath = `firms/${firmId}/clients/${clientId}/${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}${ext}`;
  await putObject(storagePath, content, mime);
  return { storagePath, fileHash, fileSize: content.length };
}

export async function readFile(storagePath) {
  const sb = await getSupabase();
  if (sb) {
    const { data, error } = await sb.storage.from(config.supabaseBucket).download(storagePath);
    if (error) throw new Error(`Stored file not found: ${storagePath}`);
    return Buffer.from(await data.arrayBuffer());
  }
  try {
    return await fs.readFile(localPath(storagePath));
  } catch {
    throw new Error(`Stored file not found: ${storagePath}`);
  }
}

export const generateSignedToken = (fileId, minutes = 60) =>
  jwt.sign({ file_id: fileId, type: "file_access" }, config.jwtSecret, { algorithm: "HS256", expiresIn: `${minutes}m` });

export function verifySignedToken(token) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
    return p.type === "file_access" ? p.file_id : null;
  } catch {
    return null;
  }
}
