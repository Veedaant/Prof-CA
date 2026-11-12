import { fyStartYear, monthsOfFy, monthLabel } from "../output/readers.js";

export { fyStartYear, monthsOfFy, monthLabel };

export const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const fyValid = (fy) => /^\d{4}-\d{2}$/.test(String(fy || "")) && Number(String(fy).slice(5)) === (Number(String(fy).slice(0, 4)) + 1) % 100;
export const fyFrom = (fy) => `${fyStartYear(fy)}-04-01`;
export const fyTo = (fy) => `${fyStartYear(fy) + 1}-03-31`;
export const monthOf = (d) => String(d || "").slice(0, 7);
export const inFy = (date, fy) => Boolean(date) && date >= fyFrom(fy) && date <= fyTo(fy);

/** "2025-04-30" for a "2025-04" month. */
export function monthEnd(m) {
  const [y, mo] = m.split("-").map(Number);
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
}
export const addMonthsIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

export const accountKey = (s) => String(s || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
export const money = (v) => Number(v || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
