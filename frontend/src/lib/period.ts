export function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(p: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (!m) return p;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
}

export function shiftPeriod(p: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (!m) return currentPeriod();
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
