import Link from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import {
  ArrowRight, FileText, Receipt, ClipboardCheck, BookOpen, Users, Building2, Archive, Landmark,
  ScanText, ShieldCheck, FileSpreadsheet, Layers,
} from "lucide-react";

const COMING = [
  { icon: Landmark, name: "Income Tax Filing", text: "Prepare and file ITRs for individuals, firms and companies from client documents." },
  { icon: Receipt, name: "TDS & TCS Manager", text: "Track deductions, challans and returns with automatic mismatch checks." },
  { icon: ClipboardCheck, name: "Audit & Compliance", text: "Checklists, working papers and due-date tracking for every client." },
  { icon: BookOpen, name: "Bookkeeping & Accounts", text: "Ledgers, bank reconciliation and monthly books without re-typing." },
  { icon: Users, name: "Payroll, PF & ESI", text: "Salary processing and statutory filings for your clients' staff." },
  { icon: Building2, name: "ROC & Company Law", text: "Annual filings, director records and event-based forms in one place." },
  { icon: Archive, name: "Client Document Vault", text: "One secure place for every client's papers, with requests and reminders." },
];

const GST_POINTS = [
  { icon: ScanText, text: "Reads invoices, credit notes, debit notes and purchase bills with AI" },
  { icon: ShieldCheck, text: "Your client checks and approves every document before it reaches you" },
  { icon: Layers, text: "Separate GSTR-1 and GSTR-3B workspaces with reconciliations" },
  { icon: FileSpreadsheet, text: "HSN-wise Excel for each return, ready to download" },
];

export default function HomePage() {
  const { user } = useAuth();
  const enter = user ? "/dashboard" : "/login";

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <section className="bg-black text-white">
        <div className="max-w-6xl mx-auto px-6">
          <nav className="flex items-center justify-between py-6">
            <div className="flex items-center gap-2.5 font-semibold tracking-tight">
              <span className="w-8 h-8 rounded-lg bg-white text-black flex items-center justify-center text-sm font-bold">P</span>
              ProfCA
            </div>
            <div className="flex items-center gap-2 text-sm">
              <a href="#modules" className="hidden sm:inline px-3 py-2 text-neutral-300 hover:text-white">Modules</a>
              {user ? (
                <Link href="/dashboard" className="px-4 py-2 rounded-lg bg-white text-black font-medium hover:bg-neutral-200">Go to dashboard</Link>
              ) : (
                <>
                  <Link href="/signup" className="hidden sm:inline px-3 py-2 text-neutral-300 hover:text-white">Create an account</Link>
                  <Link href="/login" className="px-4 py-2 rounded-lg border border-neutral-600 hover:border-white font-medium">Sign in</Link>
                </>
              )}
            </div>
          </nav>

          <div className="py-16 sm:py-24 max-w-3xl">
            <p className="inline-block text-xs font-medium tracking-wide uppercase border border-neutral-700 text-neutral-300 rounded-full px-3 py-1">
              For CA firms and their clients
            </p>
            <h1 className="mt-6 text-4xl sm:text-6xl font-semibold tracking-tight leading-[1.05]">
              Your whole practice,
              <br />
              one workspace.
            </h1>
            <p className="mt-6 text-lg text-neutral-400 leading-relaxed max-w-2xl">
              ProfCA brings the everyday work of a chartered accountancy firm into a single place. Clients send their documents,
              your team reviews and files, and everyone can see where each piece of work stands.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link href={enter} className="inline-flex items-center gap-2 px-5 py-3 rounded-lg bg-white text-black text-sm font-semibold hover:bg-neutral-200">
                Open GST Automator <ArrowRight className="w-4 h-4" />
              </Link>
              <a href="#modules" className="inline-flex items-center gap-2 px-5 py-3 rounded-lg border border-neutral-600 text-sm font-medium hover:border-white">
                See all modules
              </a>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-6 border-t border-neutral-800 py-8 text-sm max-w-xl">
            {[["1", "module live"], ["7", "more on the way"], ["1", "login for your whole team"]].map(([n, l]) => (
              <div key={l}>
                <dt className="text-3xl font-semibold tracking-tight">{n}</dt>
                <dd className="text-neutral-500 mt-1">{l}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <section id="modules" className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
        <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Modules</h2>
        <p className="mt-2 text-slate-500 max-w-2xl">Start with GST today. The rest of the practice joins the same workspace, so clients and staff never learn a second tool.</p>

        <div className="mt-8 rounded-2xl border border-black p-6 sm:p-8 grid lg:grid-cols-2 gap-8 items-center">
          <div>
            <div className="flex items-center gap-3">
              <span className="w-11 h-11 rounded-xl bg-black text-white flex items-center justify-center"><FileText className="w-5 h-5" /></span>
              <span className="text-[11px] font-semibold uppercase tracking-wide bg-black text-white rounded-full px-2.5 py-1">Live</span>
            </div>
            <h3 className="mt-5 text-2xl font-semibold tracking-tight">GST Automator</h3>
            <p className="mt-2 text-slate-600 leading-relaxed">
              Clients upload invoices and notes, the data is read for them to verify, and your team gets approved, return-wise data for GSTR-1 and GSTR-3B.
            </p>
            <Link href={enter} className="mt-6 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-black text-white text-sm font-semibold hover:bg-neutral-800">
              {user ? "Open GST Automator" : "Sign in to GST Automator"} <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <ul className="space-y-3">
            {GST_POINTS.map((p) => (
              <li key={p.text} className="flex items-start gap-3 rounded-xl bg-slate-50 border border-slate-200 p-4 text-sm">
                <p.icon className="w-5 h-5 shrink-0 mt-0.5" />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {COMING.map((m) => (
            <div key={m.name} className="rounded-2xl border border-slate-200 p-5 bg-white">
              <div className="flex items-center justify-between">
                <span className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center"><m.icon className="w-5 h-5" /></span>
                <span className="text-[11px] font-medium text-slate-500 border border-slate-200 rounded-full px-2.5 py-1">Coming soon</span>
              </div>
              <h3 className="mt-4 font-semibold tracking-tight">{m.name}</h3>
              <p className="mt-1.5 text-sm text-slate-500 leading-relaxed">{m.text}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
          <span>ProfCA</span>
          <span>Built for chartered accountancy firms and their clients</span>
        </div>
      </footer>
    </div>
  );
}
