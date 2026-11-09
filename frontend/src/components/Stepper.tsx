import { Check } from "lucide-react";

export const STEPS = ["Uploaded", "Data retrieved", "Your verification", "Sent to CA", "Excel downloaded"];

export function Stepper({ step, failed = false }: { step: number; failed?: boolean }) {
  return (
    <ol className="flex items-center w-full">
      {STEPS.map((label, i) => {
        const done = i < step || (i === step && step === STEPS.length - 1);
        const current = i === step && !done;
        return (
          <li key={label} className={`flex items-center ${i < STEPS.length - 1 ? "flex-1" : ""}`}>
            <div className="flex flex-col items-center gap-1.5">
              <span
                className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold border ${
                  done
                    ? "bg-black border-black text-white"
                    : current
                    ? failed
                      ? "bg-rose-600 border-rose-600 text-white"
                      : "bg-white border-black text-black ring-4 ring-slate-200"
                    : "bg-white border-slate-300 text-slate-400"
                }`}
              >
                {done ? <Check className="w-3.5 h-3.5" /> : i + 1}
              </span>
              <span className={`text-[11px] whitespace-nowrap ${done || current ? "text-slate-900 font-medium" : "text-slate-400"}`}>{label}</span>
            </div>
            {i < STEPS.length - 1 && <div className={`h-px flex-1 mx-2 mb-5 ${i < step ? "bg-black" : "bg-slate-200"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export function stageBadge(key: string) {
  const map: Record<string, string> = {
    completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
    awaiting_client: "bg-black text-white border-black",
    client_review: "bg-black text-white border-black",
    with_staff: "bg-amber-50 text-amber-700 border-amber-200",
    ca_review: "bg-amber-50 text-amber-700 border-amber-200",
    changes_requested: "bg-amber-50 text-amber-700 border-amber-200",
    processing: "bg-slate-100 text-slate-700 border-slate-200",
    failed: "bg-rose-50 text-rose-700 border-rose-200",
    rejected: "bg-rose-50 text-rose-700 border-rose-200",
  };
  return map[key] || "bg-slate-100 text-slate-700 border-slate-200";
}
