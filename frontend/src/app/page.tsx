import React, { useState, useEffect } from "react";
import Link, { useRouter } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { FileText, ArrowRight } from "lucide-react";

const DEMOS = [
  { role: "admin", name: "CA Admin", email: "admin@example.com" },
  { role: "staff", name: "CA Staff", email: "staff@example.com" },
  { role: "client1", name: "Client 1 (Apex)", email: "client1@example.com" },
  { role: "client2", name: "Client 2 (Zenith)", email: "client2@example.com" },
] as const;

export default function LoginPage() {
  const router = useRouter();
  const { user, login, switchDemoRole } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) router.push("/dashboard");
  }, [user, router]);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setSubmitting(true);
    try {
      await fn();
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message || "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  };

  const input =
    "w-full px-3.5 py-2.5 rounded-lg bg-white border border-slate-300 text-slate-900 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-black focus:border-black transition";

  return (
    <div className="min-h-screen bg-white grid lg:grid-cols-2">
      <div className="hidden lg:flex flex-col justify-between bg-black text-white p-12">
        <div className="flex items-center gap-2.5 font-semibold">
          <FileText className="w-5 h-5" /> GST Invoice Automator
        </div>
        <div>
          <h2 className="text-4xl font-semibold tracking-tight leading-tight">
            Upload. Review.
            <br />
            Approve. File.
          </h2>
          <p className="mt-4 text-neutral-400 max-w-sm text-sm leading-relaxed">
            Send invoices to your CA, follow every step of the review, and give the final confirmation before anything is filed.
          </p>
        </div>
        <p className="text-xs text-neutral-500">AI extraction · e-Invoice QR · GSTR-1 ready</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-sm text-slate-500 mt-1">Welcome back to your firm workspace.</p>

          {error && <div className="mt-5 p-3 rounded-lg border border-rose-200 bg-rose-50 text-rose-700 text-xs">{error}</div>}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => login(email, password));
            }}
            className="mt-6 space-y-4"
          >
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={input} placeholder="you@company.com" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className={input} placeholder="Your password" />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 rounded-lg bg-black hover:bg-neutral-800 text-white font-medium text-sm transition flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {submitting ? "Signing in..." : "Sign in"} <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <p className="text-sm text-slate-500 mt-6 text-center">
            New customer?{" "}
            <Link href="/signup" className="font-medium text-black underline underline-offset-4">
              Create an account
            </Link>
          </p>

          {import.meta.env.DEV && (
            <div className="mt-8 pt-6 border-t border-slate-200">
              <p className="text-[11px] uppercase tracking-wider text-slate-400 mb-2">Demo accounts (dev only)</p>
              <div className="grid grid-cols-2 gap-2">
                {DEMOS.map((d) => (
                  <button
                    key={d.role}
                    type="button"
                    disabled={submitting}
                    onClick={() => run(() => switchDemoRole(d.role))}
                    className="p-2.5 rounded-lg border border-slate-200 hover:border-black text-left transition"
                  >
                    <div className="text-xs font-semibold">{d.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{d.email}</div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
