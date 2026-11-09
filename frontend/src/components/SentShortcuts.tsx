import React from "react";
import { SentGroup } from "@/lib/sent";
import { periodLabel } from "@/lib/period";

/** Quick links to the client and month that documents were sent for, so nothing is missed by looking at the wrong client or month. */
export function SentShortcuts({ groups, ret, clientId, period, onPick }: {
  groups: SentGroup[] | null;
  ret?: "gstr1" | "gstr3b";
  clientId: string;
  period: string;
  onPick: (g: SentGroup) => void;
}) {
  const list = (groups || []).filter((g) => !ret || g.return_type === ret);
  if (groups && list.length === 0) {
    return <p className="text-xs text-slate-500">No client has sent {ret === "gstr3b" ? "GSTR-3B" : ret === "gstr1" ? "GSTR-1" : ""} documents yet.</p>;
  }
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-slate-500">Sent by clients:</span>
      {list.slice(0, 12).map((g) => {
        const on = g.client_id === clientId && g.tax_period === period;
        return (
          <button
            key={`${g.client_id}|${g.tax_period}|${g.return_type}`}
            onClick={() => onPick(g)}
            className={`px-3 py-1.5 rounded-full border transition ${on ? "bg-black text-white border-black" : "bg-white text-slate-700 border-slate-200 hover:border-black"}`}
          >
            {g.client_name} · {periodLabel(g.tax_period)} · {g.count}
          </button>
        );
      })}
    </div>
  );
}
