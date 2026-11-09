import { ChevronLeft, ChevronRight } from "lucide-react";
import { currentPeriod, periodLabel, shiftPeriod } from "@/lib/period";

export function PeriodPicker({ value, onChange }: { value: string; onChange: (p: string) => void }) {
  const btn = "p-2 rounded-lg border border-slate-300 bg-white hover:border-black";
  return (
    <div className="inline-flex items-center gap-2">
      <button type="button" aria-label="Previous month" className={btn} onClick={() => onChange(shiftPeriod(value, -1))}>
        <ChevronLeft className="w-4 h-4" />
      </button>
      <input
        type="month"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        aria-label="Return period"
        className="px-3 py-2 rounded-lg border border-slate-300 text-sm font-medium bg-white focus:outline-none focus:ring-2 focus:ring-black"
      />
      <button type="button" aria-label="Next month" className={btn} onClick={() => onChange(shiftPeriod(value, 1))}>
        <ChevronRight className="w-4 h-4" />
      </button>
      {value !== currentPeriod() && (
        <button type="button" onClick={() => onChange(currentPeriod())} className="text-xs underline underline-offset-4 text-slate-600 hover:text-black">
          This month ({periodLabel(currentPeriod())})
        </button>
      )}
    </div>
  );
}
