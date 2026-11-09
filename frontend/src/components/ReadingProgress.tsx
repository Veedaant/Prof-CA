import { useEffect, useRef, useState } from "react";

/** Progress bar for a document being read. The server reports milestones; between them the bar eases forward so the long AI step still visibly moves. */
export function ReadingProgress({ pct, label }: { pct: number; label?: string | null }) {
  const [shown, setShown] = useState(pct);
  const base = useRef({ pct, at: Date.now() });

  useEffect(() => {
    base.current = { pct, at: Date.now() };
    setShown((s) => Math.max(s, pct));
  }, [pct]);

  useEffect(() => {
    const t = setInterval(() => {
      const { pct: p, at } = base.current;
      const cap = p >= 50 && p < 80 ? 78 : Math.min(p + 8, 98);
      const eased = p + (cap - p) * (1 - Math.exp(-(Date.now() - at) / 12000));
      setShown((s) => Math.max(s, Math.min(eased, 99)));
    }, 400);
    return () => clearInterval(t);
  }, []);

  const value = Math.round(shown);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label="Reading document">
      <div className="flex items-center justify-between text-xs text-slate-600 mb-1.5">
        <span>{label || "Waiting to start"}</span>
        <span className="font-medium tabular-nums">{value}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
        <div className="h-full rounded-full bg-black transition-all duration-500 ease-out" style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}
