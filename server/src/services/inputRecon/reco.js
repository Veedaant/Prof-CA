import { r2, monthsOfFy, monthLabel } from "../banking/common.js";
import { HEADS, zero4, sub4, total4 } from "./work3b.js";

/**
 * Input Reco: the ITC each month's GSTR-3B working claims, against the ITC in the GSTR-3B actually filed (as read from the portal files).
 * Both are the net ITC of Table 4: all of 4(A) less 4(B), by head.
 */

const TOLERANCE = 1; // rupees, per head: returns are filed in whole rupees

const sum4 = (list) => list.reduce((s, x) => (x ? { igst: s.igst + x.igst, cgst: s.cgst + x.cgst, sgst: s.sgst + x.sgst, cess: s.cess + x.cess } : s), zero4());
const round4 = (a) => ({ igst: r2(a.igst), cgst: r2(a.cgst), sgst: r2(a.sgst), cess: r2(a.cess) });

/** The ITC lines of a GSTR-3B working, grouped the way the portal's Table 4 is. */
export function workingLines(w) {
  const t = w.t4;
  return {
    a5: round4(sum4([t.a5])), a3: round4(sum4([t.a3])), other: round4(sum4([t.a1, t.a2, t.a4])), reversed: round4(sum4([t.b1, t.b2])),
    net: round4(w.claimed),
  };
}

/** The same lines from the figures read from a filed GSTR-3B. */
export function portalLines(figures) {
  const i = figures.itc;
  const a5 = sum4([i.other]), a3 = sum4([i.rcm]), other = sum4([i.import_goods, i.import_services, i.isd]), reversed = sum4([i.reversed_rules, i.reversed_others]);
  const net = sum4([a5, a3, other]);
  return { a5: round4(a5), a3: round4(a3), other: round4(other), reversed: round4(reversed), net: round4({ igst: net.igst - reversed.igst, cgst: net.cgst - reversed.cgst, sgst: net.sgst - reversed.sgst, cess: net.cess - reversed.cess }) };
}

const LINE_NAMES = { a5: "4(A)(5) All other ITC", a3: "4(A)(3) Reverse charge", other: "4(A)(1), (2), (4) Imports and ISD", reversed: "4(B) ITC reversed" };

/** The latest file of each month: a re-uploaded working replaces the earlier one. Files with no month are returned apart. */
export function latestByMonth(files) {
  const byMonth = new Map();
  const replaced = [];
  const unplaced = [];
  for (const f of files) {
    if (!f.period) { unplaced.push(f); continue; }
    const have = byMonth.get(f.period);
    if (!have) { byMonth.set(f.period, f); continue; }
    if ((f.at || 0) >= (have.at || 0)) { replaced.push(have); byMonth.set(f.period, f); } else replaced.push(f);
  }
  return { byMonth, replaced, unplaced };
}

export function buildReco({ fy, workFiles, portalFiles }) {
  const work = latestByMonth(workFiles.filter((f) => f.data));
  const portal = latestByMonth(portalFiles.filter((f) => f.data));
  const months = monthsOfFy(fy);
  const extra = [...new Set([...work.byMonth.keys(), ...portal.byMonth.keys()])].filter((m) => !months.includes(m)).sort();
  const rows = [...months, ...extra].map((m) => {
    const wf = work.byMonth.get(m) || null, pf = portal.byMonth.get(m) || null;
    const W = wf ? workingLines(wf.data) : null, P = pf ? portalLines(pf.data.figures) : null;
    const row = { month: m, label: monthLabel(m), outsideYear: !months.includes(m), workingFile: wf?.name || "", portalFile: pf?.name || "", working: W, portal: P, diff: null, lineDiffs: [], status: "", remark: "" };
    if (!W && !P) { row.status = "Not uploaded"; row.remark = "Neither the working nor the GSTR-3B is uploaded."; return row; }
    if (!W) { row.status = "No working"; row.remark = "The GSTR-3B working for this month is not uploaded."; return row; }
    if (!P) { row.status = "No GSTR-3B"; row.remark = "The GSTR-3B for this month is not uploaded under GST Portal."; return row; }
    row.diff = sub4(W.net, P.net);
    row.diffTotal = total4(row.diff);
    for (const k of ["a5", "a3", "other", "reversed"]) {
      const d = sub4(W[k], P[k]);
      if (HEADS.some((h) => Math.abs(d[h]) > TOLERANCE)) row.lineDiffs.push({ line: LINE_NAMES[k], working: total4(W[k]), portal: total4(P[k]), diff: total4(d) });
    }
    const matches = HEADS.every((h) => Math.abs(row.diff[h]) <= TOLERANCE);
    row.status = matches ? "Matches" : "Does not match";
    if (!matches) {
      const heads = HEADS.filter((h) => Math.abs(row.diff[h]) > TOLERANCE).map((h) => `${h === "sgst" ? "SGST" : h.toUpperCase().replace("CESS", "Cess")} ${row.diff[h] > 0 ? "+" : ""}${row.diff[h]}`).join(", ");
      row.remark = `The working ${row.diffTotal > 0 ? "claims more" : "claims less"} ITC than the GSTR-3B by Rs ${Math.abs(row.diffTotal)} (${heads}).${row.lineDiffs.length ? ` Lines that differ: ${row.lineDiffs.map((l) => `${l.line} (working ${l.working}, GSTR-3B ${l.portal})`).join("; ")}.` : ""}`;
    } else if (wf.data.warnings?.length) row.remark = wf.data.warnings[0];
    return row;
  });

  const compared = rows.filter((r) => r.diff);
  const summary = {
    months: rows.filter((r) => !r.outsideYear || r.working || r.portal).length, compared: compared.length,
    matching: compared.filter((r) => r.status === "Matches").length, differing: compared.filter((r) => r.status !== "Matches").length,
    noWorking: rows.filter((r) => r.status === "No working").length, noPortal: rows.filter((r) => r.status === "No GSTR-3B").length, none: rows.filter((r) => r.status === "Not uploaded" && !r.outsideYear).length,
    workingTotal: r2(compared.reduce((a, r) => a + total4(r.working.net), 0)), portalTotal: r2(compared.reduce((a, r) => a + total4(r.portal.net), 0)),
  };
  summary.diffTotal = r2(summary.workingTotal - summary.portalTotal);
  return {
    fy, rows, summary,
    replaced: [...work.replaced.map((f) => ({ ...f, side: "working" })), ...portal.replaced.map((f) => ({ ...f, side: "portal" }))],
    unplaced: [...work.unplaced.map((f) => ({ ...f, side: "working" })), ...portal.unplaced.map((f) => ({ ...f, side: "portal" }))],
  };
}
