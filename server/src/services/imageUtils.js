import path from "node:path";
import sharp from "sharp";

const MAX_PAGES = 10;

/** A loaded page/image: { width, height, rgba (Buffer), png (Buffer) } */
async function fromEncoded(buf) {
  const base = sharp(buf, { failOn: "none" }).rotate();
  const png = await base.clone().png().toBuffer();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: data, png };
}

export async function loadFileAsImages(fileBytes, filename, mime = "") {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf" || mime === "application/pdf") {
    const mupdf = await import("mupdf");
    const doc = mupdf.Document.openDocument(fileBytes, "application/pdf");
    const images = [];
    try {
      const pages = Math.min(doc.countPages(), MAX_PAGES);
      for (let i = 0; i < pages; i++) {
        const page = doc.loadPage(i);
        const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
        images.push(await fromEncoded(Buffer.from(pix.asPNG())));
        pix.destroy?.();
        page.destroy?.();
      }
    } finally {
      doc.destroy?.();
    }
    return images;
  }

  let buf = fileBytes;
  if ([".heic", ".heif"].includes(ext) || mime === "image/heic" || mime === "image/heif") {
    const { default: convert } = await import("heic-convert");
    buf = Buffer.from(await convert({ buffer: fileBytes, format: "JPEG", quality: 0.92 }));
  }
  return [await fromEncoded(buf)];
}

/** Returns { blurScore, isBlurry, isDark } using mean brightness and Laplacian variance. */
export async function assessImageQuality(image) {
  const { data, info } = await sharp(image.png).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const isDark = sum / data.length < 40;

  let blurScore = 1000;
  if (w > 10 && h > 10) {
    let n = 0, mean = 0, m2 = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = data[i - w] + data[i + w] + data[i - 1] + data[i + 1] - 4 * data[i];
        n++;
        const d = lap - mean;
        mean += d / n;
        m2 += d * (lap - mean);
      }
    }
    blurScore = n > 0 ? m2 / n : 1000;
  }
  return { blurScore, isBlurry: blurScore < 50, isDark };
}

export function imageToJpeg(image, maxDim = 1800, quality = 90) {
  return sharp(image.png)
    .resize({ width: maxDim, height: maxDim, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}
