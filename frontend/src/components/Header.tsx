import React from "react";
import { useAuth } from "@/context/AuthContext";
import { ShieldCheck, UserCheck, Building } from "lucide-react";

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { user } = useAuth();

  return (
    <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0">
      <div>
        <h1 className="text-lg font-bold text-slate-800 leading-tight">{title}</h1>
        {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        {user && (
          <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-full text-xs text-slate-700">
            {user.role === "admin" ? (
              <ShieldCheck className="w-4 h-4 text-slate-900" />
            ) : user.role === "staff" ? (
              <UserCheck className="w-4 h-4 text-slate-900" />
            ) : (
              <Building className="w-4 h-4 text-indigo-600" />
            )}
            <span className="font-medium capitalize">{user.role} Account</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-500 truncate max-w-[140px]">{user.email}</span>
          </div>
        )}
      </div>
    </header>
  );
}
