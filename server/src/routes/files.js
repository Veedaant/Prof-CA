import path from "node:path";
import { Router } from "express";
import { db } from "../db/index.js";
import { HttpError } from "../auth.js";
import { isUuid, wrap } from "../http.js";
import { readFile, verifySignedToken } from "../services/storage.js";
import { imageToJpeg, loadFileAsImages } from "../services/imageUtils.js";

const router = Router();

router.get("/:id/view", wrap(async (req, res) => {
  const { id } = req.params;
  const tokenFileId = verifySignedToken(String(req.query.token || ""));
  if (!tokenFileId || tokenFileId !== id) throw new HttpError(403, "Invalid or expired file access token");
  const file = isUuid(id) ? await db.one("select * from invoice_files where id=$1", [id]) : null;
  if (!file) throw new HttpError(404, "File record not found");

  let bytes;
  try { bytes = await readFile(file.storage_path); } catch { throw new HttpError(404, "File not found in storage"); }

  const ext = path.extname(file.original_filename).toLowerCase();
  const isHeic = [".heic", ".heif"].includes(ext);
  const asImage = ["1", "true"].includes(String(req.query.as_image));
  res.setHeader("Cache-Control", "private, max-age=300");
  if (asImage || isHeic) {
    const pages = await loadFileAsImages(bytes, file.original_filename, file.mime_type);
    const idx = Math.min(Math.max(parseInt(req.query.page) || 0, 0), pages.length - 1);
    res.setHeader("X-Total-Pages", String(pages.length));
    res.type("image/jpeg").send(await imageToJpeg(pages[idx]));
    return;
  }
  res.setHeader("Content-Disposition", `inline; filename="${file.original_filename.replace(/[^\w.\- ]/g, "_")}"`);
  res.type(file.mime_type).send(bytes);
}));

export default router;
