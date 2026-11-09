import React, { useEffect, useState } from "react";
import Link, { useRouter } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { FileText } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const { user, register } = useAuth();
  const [firms, setFirms] = useState<{ id: string; name: string }[]>([]);
  const [f, setF] = useState({ full_name: "", email: "", password: "", company_name: "", gstin: "", phone: "", firm_id: "" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.auth
      .firms()
      .then((list) => {
        setFirms(list);
        if (list.length === 1) setF((p) => ({ ...p, firm_id: list[0].id }));
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (user) router.push("/dashboard");
  }, [user, router]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const input =
    "w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-300 text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({
        ...f,
        gstin: f.gstin.trim() || undefined,
        phone: f.phone.trim() || undefined,
      });
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Sign up failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-2.5 font-semibold mb-8">
          <span className="w-8 h-8 rounded-lg bg-black text-white flex items-center justify-center">
            <FileText className="w-4 h-4" />
          </span>
          GST Invoice Automator
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-sm text-slate-500 mt-1">Register as a customer of your CA firm and start sending invoices.</p>

        {error && <div className="mt-5 p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs">{error}</div>}

        <form onSubmit={submit} className="mt-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Your CA firm</label>
            <select value={f.firm_id} onChange={set("firm_id")} required className={input}>
              <option value="">Select your CA firm</option>
              {firms.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Full name</label>
              <input value={f.full_name} onChange={set("full_name")} required minLength={2} className={input} />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Phone (optional)</label>
              <input value={f.phone} onChange={set("phone")} className={input} />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Company / business name</label>
            <input value={f.company_name} onChange={set("company_name")} required minLength={2} className={input} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">GSTIN (optional)</label>
            <input value={f.gstin} onChange={set("gstin")} maxLength={15} className={`${input} uppercase`} placeholder="22AAAAA0000A1Z5" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Email</label>
            <input type="email" value={f.email} onChange={set("email")} required className={input} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Password</label>
            <input type="password" value={f.password} onChange={set("password")} required minLength={8} className={input} placeholder="At least 8 characters" />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 rounded-lg bg-black hover:bg-neutral-800 text-white font-medium text-sm transition disabled:opacity-50"
          >
            {submitting ? "Creating account..." : "Create account"}
          </button>
        </form>
        <p className="text-sm text-slate-500 mt-6 text-center">
          Already registered?{" "}
          <Link href="/login" className="font-medium text-black underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
