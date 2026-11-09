import { useEffect, useState } from "react";
import Link, { useParams, useRouter } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { api, API_ORIGIN, Invoice } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";
import { Stepper } from "@/components/Stepper";
import { ArrowLeft, CheckCircle2 } from "lucide-react";

const inr = (n: number | undefined | null) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function stepOf(inv: Invoice) {
  if (inv.client_approved_at) return 3;
  return 2;
}

export default function RequestDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [inv, setInv] = useState<Invoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [changing, setChanging] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authLoading && !user) router.push("/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (!user || !id) return;
    api.invoices.get(id).then(setInv).catch((e) => setError(e.message));
  }, [user, id]);

  const respond = async (action: "confirm" | "request_changes") => {
    if (!inv) return;
    setBusy(true);
    setError(null);
    try {
      setInv(await api.invoices.confirm(inv.id, action, note.trim() || undefined));
      setChanging(false);
      setNote("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const row = (label: string, value?: string | number | null) => (
    <div className="flex justify-between gap-4 py-2 border-b border-slate-100 last:border-0 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-right break-words min-w-0">{value || "—"}</span>
    </div>
  );

  const awaiting = inv && ["approved", "auto_approved"].includes(inv.review_status) && inv.client_confirmation === "pending";
  const canRespond = awaiting && user?.role === "client";

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header title="Confirm invoice" subtitle="Check request from your CA firm" />
        <div className="p-6 max-w-4xl mx-auto w-full space-y-5">
          <Link href="/requests" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-black">
            <ArrowLeft className="w-4 h-4" /> Back to requests
          </Link>
          {error && <div className="p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-sm">{error}</div>}
          {!inv ? (
            <p className="text-sm text-slate-500">{error ? "" : "Loading..."}</p>
          ) : (
            <>
              <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                <Stepper step={stepOf(inv)} />
              </div>

              {inv.client_confirmation === "confirmed" && (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 flex gap-3 text-sm text-emerald-800">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <div>
                    <p className="font-semibold">Final approval complete</p>
                    <p>
                      You confirmed these details{inv.client_confirmed_at ? ` on ${new Date(inv.client_confirmed_at).toLocaleString()}` : ""}. This invoice is ready for GSTR-1.
                    </p>
                  </div>
                </div>
              )}
              {inv.client_confirmation === "changes_requested" && (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800">
                  <p className="font-semibold">Changes requested</p>
                  <p>Your CA is correcting the invoice. Your note: {inv.client_note}</p>
                </div>
              )}

              <div className="grid md:grid-cols-2 gap-5">
                <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                  <h3 className="font-semibold text-sm mb-2">Invoice details</h3>
                  {row("Invoice number", inv.invoice_number)}
                  {row("Invoice date", inv.invoice_date)}
                  {row("Place of supply", inv.place_of_supply)}
                  {row("Supplier", inv.supplier_name)}
                  {row("Supplier GSTIN", inv.supplier_gstin)}
                  {row("Buyer", inv.buyer_name)}
                  {row("Buyer GSTIN", inv.buyer_gstin)}
                </div>
                <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
                  <h3 className="font-semibold text-sm mb-2">Amounts</h3>
                  {row("Taxable value", inr(inv.total_taxable_value))}
                  {row("CGST", inr(inv.cgst_total))}
                  {row("SGST", inr(inv.sgst_total))}
                  {row("IGST", inr(inv.igst_total))}
                  {row("Total tax", inr(inv.total_tax))}
                  <div className="flex justify-between pt-3 text-base font-semibold">
                    <span>Invoice total</span>
                    <span>{inr(inv.invoice_total)}</span>
                  </div>
                </div>
              </div>

              {inv.line_items && inv.line_items.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                        <th className="px-5 py-3 font-medium">Description</th>
                        <th className="px-3 py-3 font-medium">HSN/SAC</th>
                        <th className="px-3 py-3 font-medium text-right">Qty</th>
                        <th className="px-3 py-3 font-medium text-right">Taxable</th>
                        <th className="px-5 py-3 font-medium text-right">Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inv.line_items.map((li, i) => (
                        <tr key={li.id || i} className="border-b border-slate-100 last:border-0">
                          <td className="px-5 py-3">{li.description || "—"}</td>
                          <td className="px-3 py-3">{li.hsn_sac || "—"}</td>
                          <td className="px-3 py-3 text-right">{li.quantity}</td>
                          <td className="px-3 py-3 text-right">{inr(li.taxable_value)}</td>
                          <td className="px-5 py-3 text-right">{inr(Number(li.cgst_amount) + Number(li.sgst_amount) + Number(li.igst_amount))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {inv.file_preview_url && (
                <a
                  href={`${API_ORIGIN}${inv.file_preview_url}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-block text-sm font-medium underline underline-offset-4"
                >
                  View the original uploaded document
                </a>
              )}

              {canRespond && (
                <div className="bg-white border-2 border-black rounded-2xl p-6 space-y-4">
                  <div>
                    <h3 className="font-semibold">Final confirmation</h3>
                    <p className="text-sm text-slate-500 mt-1">Your CA has approved this invoice. Please confirm that every detail above is correct.</p>
                  </div>
                  {changing ? (
                    <>
                      <textarea
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        rows={3}
                        placeholder="What is wrong? e.g. buyer GSTIN should be ..."
                        className="w-full px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                      />
                      <div className="flex gap-2">
                        <button
                          disabled={busy || !note.trim()}
                          onClick={() => respond("request_changes")}
                          className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium disabled:opacity-40"
                        >
                          Send to CA
                        </button>
                        <button onClick={() => setChanging(false)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium">
                          Cancel
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="flex items-start gap-2.5 text-sm cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 accent-black w-4 h-4" />
                        <span>I have checked all the details and they are filled in correctly.</span>
                      </label>
                      <div className="flex gap-2 flex-wrap">
                        <button
                          disabled={busy || !checked}
                          onClick={() => respond("confirm")}
                          className="px-4 py-2 rounded-lg bg-black text-white text-sm font-medium hover:bg-neutral-800 disabled:opacity-40"
                        >
                          Yes, I approve
                        </button>
                        <button onClick={() => setChanging(true)} className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium hover:border-black">
                          Something is wrong
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}

              {!canRespond && inv.client_confirmation !== "confirmed" && inv.client_confirmation !== "changes_requested" && (
                <p className="text-sm text-slate-500">Your CA is still reviewing this invoice. You will be asked to confirm once it is approved.</p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
