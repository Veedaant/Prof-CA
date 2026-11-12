import ExcelJS from "exceljs";
import { table, title } from "../banking/xl.js";

/** The checklist as an Excel for the CA firm: what is still pending first, then every document with its status, then every period. */

const GREY = "FFF3F4F6", AMBER = "FFFEF3C7", GREEN = "FFDCFCE7", RED = "FFFEE2E2";
const mask = (a) => (String(a || "").length > 4 ? `xxxx${String(a).slice(-4)}` : String(a || ""));
const label = (g) => `${g.name}${g.bank || g.account ? ` (${[g.bank, g.account && mask(g.account)].filter(Boolean).join(" ")})` : ""}`;
const head2 = (client, c) => [`Client: ${client.name}${client.gstin ? ` (GSTIN ${client.gstin})` : ""}`, `Financial year: ${c.fy}`, `Checklist: ${c.sourceName}${c.status === "sent" ? `; sent to the client on ${String(c.sentAt || "").slice(0, 10)}` : "; not yet sent to the client"}`];

export async function auditWorkbook({ client, checklist: c }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "GST Automator";
  const t = c.summary.totals;

  // 1. what is still pending
  const ws = wb.addWorksheet("1 Pending Documents");
  const r0 = title(ws, "Documents still pending from the client", [...head2(client, c), `${t.pending} of ${t.items} items pending, across ${t.documentsPending} of ${t.documents} documents. Uploaded: ${t.received}. Not applicable: ${t.na}.`]);
  const pending = c.summary.groups.filter((g) => g.pending > 0);
  const cols = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Section", key: "section", width: 26, wrap: true }, { header: "Document", key: "doc", width: 46, wrap: true }, { header: "Kind", key: "categoryLabel", width: 26, wrap: true },
    { header: "Asked for", key: "total", width: 10 }, { header: "Uploaded", key: "received", width: 10 }, { header: "Pending", key: "pending", width: 10 }, { header: "Pending for", key: "pendingText", width: 70, wrap: true },
  ];
  if (!pending.length) ws.getCell(r0, 1).value = "Nothing is pending: every document is in hand.";
  else table(ws, r0, cols, pending.map((g, i) => ({ ...g, sr: i + 1, doc: label(g) })), { rowFill: (g) => (g.received === 0 ? RED : AMBER) });

  // 2. every document, with how much of it is in hand
  const w2 = wb.addWorksheet("2 Checklist Status");
  const r2 = title(w2, "Every document asked for, and how much of it is in hand", head2(client, c));
  const c2 = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Section", key: "section", width: 26, wrap: true }, { header: "Document", key: "doc", width: 46, wrap: true }, { header: "Kind", key: "categoryLabel", width: 26, wrap: true },
    { header: "Asked for", key: "total", width: 10 }, { header: "Uploaded", key: "received", width: 10 }, { header: "Pending", key: "pending", width: 10 }, { header: "Not applicable", key: "na", width: 10 }, { header: "Status", key: "statusText", width: 14 }, { header: "Remarks in the sheet", key: "note", width: 40, wrap: true },
  ];
  table(w2, r2, c2, c.summary.groups.map((g, i) => ({ ...g, sr: i + 1, doc: label(g), statusText: g.state === "complete" ? "Complete" : g.state === "partial" ? "Partly in hand" : "Pending" })), { rowFill: (g) => (g.state === "complete" ? GREEN : g.state === "pending" ? RED : AMBER) });

  // 3. every period of every document
  const w3 = wb.addWorksheet("3 All Items");
  const r3 = title(w3, "Every item: document, period, status and where it came from", head2(client, c));
  const c3 = [
    { header: "Sr", key: "sr", width: 6 }, { header: "Section", key: "section", width: 24, wrap: true }, { header: "Document", key: "name", width: 40, wrap: true }, { header: "Period", key: "periodLabel", width: 20 },
    { header: "Bank", key: "bank", width: 22 }, { header: "Account", key: "account", width: 16 }, { header: "Status", key: "statusText", width: 12 }, { header: "Uploaded from", key: "source", width: 24, wrap: true }, { header: "Detail", key: "detail", width: 50, wrap: true }, { header: "Files uploaded", key: "files", width: 40, wrap: true },
  ];
  table(w3, r3, c3, c.states.map((s, i) => ({ ...s, sr: i + 1, bank: s.bank || "", account: mask(s.account), statusText: s.status === "received" ? "Uploaded" : s.status === "na" ? "Not applicable" : "Pending", files: s.files.map((f) => f.name).join(", ") })), { rowFill: (s) => (s.status === "pending" ? AMBER : s.status === "na" ? GREY : null) });

  // 4. the audit programme, and 5. every query and reply
  const points = c.points || [];
  if (points.length) {
    const p = c.programme;
    const w4 = wb.addWorksheet("4 Audit Programme");
    const r4 = title(w4, "Audit programme: what is checked, what is pending, and what is queried", [...head2(client, c), `${p.points} points: ${p.checked} checked, ${p.pending} pending, ${p.query} with a query (${p.awaitingClient} waiting for the client, ${p.awaitingStaff} waiting for the CA firm).`]);
    const STATUS = { checked: "Checked", pending: "Pending", query: "Query" };
    const c4 = [
      { header: "Sr", key: "ref", width: 7 }, { header: "Section", key: "section", width: 28, wrap: true }, { header: "Audit point", key: "name", width: 56, wrap: true }, { header: "Detail", key: "detail", width: 40, wrap: true },
      { header: "Status", key: "statusText", width: 12 }, { header: "Waiting for", key: "waiting", width: 14 }, { header: "Updated by", key: "statusBy", width: 20 }, { header: "Queries", key: "n", width: 9 }, { header: "Last message", key: "last", width: 60, wrap: true },
    ];
    table(w4, r4, c4, points.map((x) => {
      const last = x.queries[x.queries.length - 1];
      return { ...x, ref: x.ref || x.seq, statusText: STATUS[x.status], waiting: x.awaiting === "client" ? "Client" : x.awaiting === "staff" && x.queries.length ? "CA firm" : "", n: x.queries.length, last: last ? `${last.role === "client" ? "Client" : "CA firm"}: ${last.body}` : "", statusBy: x.statusBy || "" };
    }), { rowFill: (x) => (x.status === "checked" ? GREEN : x.status === "query" ? AMBER : null) });

    const w5 = wb.addWorksheet("5 Queries and Replies");
    const r5 = title(w5, "Every query the CA firm raised and every reply of the client", head2(client, c));
    const rows5 = points.flatMap((x) => x.queries.map((m) => ({ ref: x.ref || x.seq, name: x.name, at: String(m.at instanceof Date ? m.at.toISOString() : m.at).slice(0, 10), from: m.role === "client" ? "Client" : "CA firm", by: m.by || "", body: m.body, statusText: STATUS[x.status] })));
    const c5 = [
      { header: "Sr", key: "ref", width: 7 }, { header: "Audit point", key: "name", width: 50, wrap: true }, { header: "Date", key: "at", width: 12 }, { header: "From", key: "from", width: 10 }, { header: "Name", key: "by", width: 20 }, { header: "Message", key: "body", width: 80, wrap: true }, { header: "Point status", key: "statusText", width: 12 },
    ];
    if (!rows5.length) w5.getCell(r5, 1).value = "No query has been raised yet.";
    else table(w5, r5, c5, rows5, {});
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
