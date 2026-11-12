/** Financial years (April to March) and their months, for the pickers. */

const pad = (n: number) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2025-26" for the financial year that today falls in. */
export function currentFy(now = new Date()): string {
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${pad((y + 1) % 100)}`;
}

/** The current financial year and the six before it, latest first. */
export function fyOptions(now = new Date()): string[] {
  const y = Number(currentFy(now).slice(0, 4));
  return Array.from({ length: 7 }, (_, i) => `${y - i}-${pad((y - i + 1) % 100)}`);
}

/** "2025-04" ... "2026-03" */
export function monthsOfFy(fy: string): string[] {
  const y = Number(fy.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => (i < 9 ? `${y}-${pad(i + 4)}` : `${y + 1}-${pad(i - 8)}`));
}

/** "Apr-25" */
export function monthLabel(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return `${MON[mo - 1]}-${String(y).slice(2)}`;
}

/** An account number as compared across uploads: letters and digits only, upper case. */
export const acctKey = (s: string): string => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
