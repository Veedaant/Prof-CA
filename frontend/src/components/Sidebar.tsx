import React, { useEffect, useState } from "react";
import Link from "@/lib/router";
import { usePathname } from "@/lib/router";
import { useAuth } from "@/context/AuthContext";
import { FileText, Upload, FileCheck, Users, Download, LogOut, Layers, GitCompare, UserCheck, ListChecks, ShieldCheck, Bell } from "lucide-react";
import { notificationsApi } from "@/lib/api";

const DEMO = [
  { role: "admin", label: "CA Admin" },
  { role: "staff", label: "CA Staff" },
  { role: "client1", label: "Client 1" },
  { role: "client2", label: "Client 2" },
] as const;

export function Sidebar({ className = "" }: { className?: string }) {
  const pathname = usePathname();
  const { user, logout, switchDemoRole } = useAuth();
  const isStaffOrAdmin = user?.role === "admin" || user?.role === "staff";
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!user) return;
    const load = () => notificationsApi.unread().then(setUnread).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [user, pathname]);

  const navItems = [
    { label: "Dashboard", href: "/dashboard", icon: Layers, show: true },
    { label: "Requests", href: "/requests", icon: ListChecks, show: true },
    { label: "Notifications", href: "/notifications", icon: Bell, show: true },
    { label: "Needs Review", href: "/dashboard?status=needs_review", icon: FileCheck, show: isStaffOrAdmin },
    { label: "GST Details", href: "/gst", icon: FileText, show: !isStaffOrAdmin },
    { label: "GST", href: "/gst", icon: FileText, show: isStaffOrAdmin },
    { label: "Upload Invoices", href: "/upload", icon: Upload, show: isStaffOrAdmin },
    { label: "GSTR-1 Export", href: "/exports", icon: Download, show: isStaffOrAdmin },
    { label: "GSTR-3B Verification", href: "/verify-3b", icon: ShieldCheck, show: isStaffOrAdmin },
    { label: "GSTR-3B Export", href: "/exports-3b", icon: Download, show: isStaffOrAdmin },
    { label: "GSTR-2B Reconciliation", href: "/itc-2b", icon: GitCompare, show: isStaffOrAdmin },
    { label: "Output GST Reconciliation", href: "/output-recon", icon: GitCompare, show: isStaffOrAdmin },
    { label: "Reconciliation", href: "/reconciliation", icon: GitCompare, show: isStaffOrAdmin },
    { label: "Clients", href: "/clients", icon: Users, show: isStaffOrAdmin },
    { label: "Users", href: "/users", icon: UserCheck, show: isStaffOrAdmin },
  ];

  return (
    <aside className={`w-64 bg-white text-slate-900 flex flex-col justify-between shrink-0 border-r border-slate-200 ${className}`}>
      <div>
        <div className="px-5 py-5 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-black flex items-center justify-center text-white">
              <FileText className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-sm tracking-tight">GST Automator</div>
              <p className="text-xs text-slate-500 truncate">{user?.firm_name || "CA workspace"}</p>
            </div>
          </div>
        </div>

        <nav className="p-3 space-y-0.5">
          {navItems
            .filter((i) => i.show)
            .map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href || (item.href !== "/dashboard" && !item.href.includes("?") && pathname.startsWith(item.href + "/"));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    active ? "bg-black text-white" : "text-slate-600 hover:bg-slate-100 hover:text-black"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                  {item.href === "/notifications" && unread > 0 && (
                    <span className={`ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded-full ${active ? "bg-white text-black" : "bg-rose-600 text-white"}`}>{unread > 99 ? "99+" : unread}</span>
                  )}
                </Link>
              );
            })}
        </nav>
      </div>

      <div className="p-4 border-t border-slate-200 space-y-3">
        {import.meta.env.DEV && (
          <div className="rounded-lg border border-dashed border-slate-300 p-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1.5">Dev: switch role</p>
            <div className="grid grid-cols-2 gap-1.5">
              {DEMO.map((d) => (
                <button
                  key={d.role}
                  onClick={() => switchDemoRole(d.role)}
                  className="px-2 py-1 rounded border border-slate-200 text-[11px] font-medium text-slate-600 hover:bg-slate-100"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-full bg-black text-white flex items-center justify-center text-xs font-semibold uppercase shrink-0">
              {user?.full_name ? user.full_name[0] : "U"}
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold truncate">{user?.full_name || "Signed in"}</p>
              <p className="text-[11px] text-slate-500 capitalize">{user?.role}</p>
            </div>
          </div>
          <button onClick={logout} title="Log out" className="text-slate-500 hover:text-black p-1.5 rounded-lg hover:bg-slate-100">
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
