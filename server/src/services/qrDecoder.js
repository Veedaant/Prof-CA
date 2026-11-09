import jsQR from "jsqr";
import sharp from "sharp";

function decodeJwtPayloadUnverified(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

export function normalizeDate(s) {
  if (!s) return "";
  const v = String(s).trim();
  let m;
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2})$/.exec(v))) return `20${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  if ((m = /^(\d{1,2})[- ]([A-Za-z]{3})[A-Za-z]*[- ](\d{4})$/.exec(v)) && MONTHS[m[2].toLowerCase()])
    return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return v;
}

async function scan(image) {
  let r = jsQR(new Uint8ClampedArray(image.rgba), image.width, image.height, { inversionAttempts: "attemptBoth" });
  if (r?.data) return r.data;
  for (const width of [1600, 900]) {
    if (image.width <= width) continue;
    const { data, info } = await sharp(image.png).resize({ width }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    r = jsQR(new Uint8ClampedArray(data), info.width, info.height, { inversionAttempts: "attemptBoth" });
    if (r?.data) return r.data;
  }
  return null;
}

export async function decodeEinvoiceQr(images) {
  for (const img of images) {
    let raw;
    try {
      raw = await scan(img);
    } catch {
      raw = null;
    }
    if (!raw || raw.length <= 20) continue;

    let payload = null;
    if (raw.startsWith("{") && raw.endsWith("}")) {
      try { payload = JSON.parse(raw); } catch { /* not JSON */ }
    } else if (raw.includes(".")) {
      payload = decodeJwtPayloadUnverified(raw);
    }
    if (!payload || typeof payload !== "object") continue;

    const p = payload;
    const totRaw = p.TotInvVal ?? p.tot_inv_val ?? p.invoice_total;
    const tot = totRaw === undefined || totRaw === null || totRaw === "" ? null : Number(totRaw);
    const docNo = p.DocNo || p.doc_no || p.invoice_number;
    const docDt = p.DocDt || p.doc_dt || p.invoice_date;
    return {
      irn: p.Irn || p.IRN || p.irn || null,
      supplier_gstin: p.SellerGstin || p.supplier_gstin || p.sellerGstin || null,
      buyer_gstin: p.BuyerGstin || p.buyer_gstin || p.buyerGstin || null,
      invoice_number: docNo ? String(docNo) : null,
      invoice_date: docDt ? normalizeDate(docDt) : null,
      invoice_total: Number.isFinite(tot) ? tot : null,
      item_count: p.ItemCnt ?? p.item_cnt ?? null,
      main_hsn: p.MainHsnCode || p.main_hsn_code || null,
      raw_payload: payload,
    };
  }
  return null;
}
