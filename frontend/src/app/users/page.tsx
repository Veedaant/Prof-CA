import React, { useState, useEffect } from "react";
import { useRouter } from "@/lib/router";
import {
  Users,
  UserPlus,
  ShieldCheck,
  User,
  Trash2,
  Mail,
  Building,
  Key,
  X,
  Plus,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
} from "lucide-react";

import { useAuth } from "@/context/AuthContext";
import { api, User as UserType, Client } from "@/lib/api";
import { Sidebar } from "@/components/Sidebar";
import { Header } from "@/components/Header";

export default function UsersPage() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [users, setUsers] = useState<UserType[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form states
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "staff" | "client">("staff");
  const [selectedClientId, setSelectedClientId] = useState<string>("");

  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [uList, cList] = await Promise.all([
        api.users.list(),
        api.clients.list(),
      ]);
      setUsers(uList);
      setClients(cList);
      if (cList.length > 0) {
        setSelectedClientId(cList[0].id);
      }
    } catch (err: any) {
      console.error("Failed to load users:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setCreating(true);

    try {
      await api.users.create({
        full_name: fullName,
        email,
        password,
        role,
        client_id: role === "client" ? selectedClientId : null,
      });

      setIsModalOpen(false);
      setFullName("");
      setEmail("");
      setPassword("");
      setRole("staff");
      await loadData();
      alert("New user created successfully!");
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to create user");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteUser = async (userId: string, userFullName: string) => {
    if (!confirm(`Are you sure you want to delete user ${userFullName}?`)) {
      return;
    }
    try {
      await api.users.delete(userId);
      await loadData();
    } catch (err: any) {
      alert(err.message || "Failed to delete user");
    }
  };

  const getClientName = (clientId?: string | null) => {
    if (!clientId) return null;
    const cl = clients.find((c) => c.id === clientId);
    return cl ? cl.name : "Assigned Client";
  };

  return (
    <div className="min-h-screen flex bg-slate-50">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <Header
          title="User & Team Management"
          subtitle="Manage CA firm partners, review staff, and client upload portal accounts"
        />

        <div className="p-6 max-w-6xl mx-auto w-full space-y-6">
          {/* Top Bar */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-white p-5 rounded-2xl border border-slate-200 shadow-sm">
            <div>
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-600" />
                Active Firm Users ({users.length})
              </h2>
              <p className="text-xs text-slate-500">
                Firm-scoped access control with role-based permissions (Admin, Staff, Client).
              </p>
            </div>

            <button
              onClick={() => setIsModalOpen(true)}
              className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-md shadow-blue-600/20 transition flex items-center gap-2 shrink-0"
            >
              <UserPlus className="w-4 h-4" />
              Add New User
            </button>
          </div>

          {/* Users Table */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {loading ? (
              <div className="p-8 text-center text-xs text-slate-400 flex items-center justify-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin text-blue-600" />
                Loading users...
              </div>
            ) : users.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs min-w-[650px]">
                  <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 text-[11px] font-semibold">
                    <tr>
                      <th className="p-3.5">User</th>
                      <th className="p-3.5">Email Address</th>
                      <th className="p-3.5">Role</th>
                      <th className="p-3.5">Client Access</th>
                      <th className="p-3.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {users.map((u) => {
                      const isCurrentUser = u.id === user?.id;
                      return (
                        <tr key={u.id} className="hover:bg-slate-50/50 transition">
                          <td className="p-3.5">
                            <div className="flex items-center gap-2.5">
                              <div
                                className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
                                  u.role === "admin"
                                    ? "bg-purple-100 text-purple-700"
                                    : u.role === "staff"
                                    ? "bg-blue-100 text-blue-700"
                                    : "bg-emerald-100 text-emerald-700"
                                }`}
                              >
                                {u.full_name ? u.full_name[0].toUpperCase() : "U"}
                              </div>
                              <div>
                                <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                                  {u.full_name}
                                  {isCurrentUser && (
                                    <span className="text-[10px] bg-blue-50 text-blue-600 px-1.5 py-0.2 rounded font-normal">
                                      (You)
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-slate-400">ID: {u.id.substring(0, 8)}...</div>
                              </div>
                            </div>
                          </td>

                          <td className="p-3.5 font-medium text-slate-600">
                            <div className="flex items-center gap-1.5">
                              <Mail className="w-3.5 h-3.5 text-slate-400" />
                              <span>{u.email}</span>
                            </div>
                          </td>

                          <td className="p-3.5">
                            <span
                              className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                                u.role === "admin"
                                  ? "bg-purple-50 text-purple-700 border border-purple-200"
                                  : u.role === "staff"
                                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                                  : "bg-emerald-50 text-emerald-700 border border-emerald-200"
                              }`}
                            >
                              {u.role === "admin"
                                ? "CA Admin"
                                : u.role === "staff"
                                ? "CA Reviewer"
                                : "Client Taxpayer"}
                            </span>
                          </td>

                          <td className="p-3.5">
                            {u.role === "client" ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-medium text-[11px]">
                                <Building className="w-3 h-3 text-slate-400" />
                                {getClientName(u.client_id) || "Client Restricted"}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-[11px]">All Firm Clients</span>
                            )}
                          </td>

                          <td className="p-3.5 text-right">
                            {user?.role === "admin" && !isCurrentUser ? (
                              <button
                                onClick={() => handleDeleteUser(u.id, u.full_name)}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                                title="Delete user"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            ) : (
                              <span className="text-[11px] text-slate-300">Protected</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-slate-400">No users found.</div>
            )}
          </div>
        </div>

        {/* Create User Modal */}
        {isModalOpen && (
          <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-md w-full overflow-hidden animate-in fade-in zoom-in-95 duration-150">
              <div className="p-5 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                    <UserPlus className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">Add New User</h3>
                    <p className="text-[11px] text-slate-500">Create login credentials for CA staff or client</p>
                  </div>
                </div>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleCreateUser} className="p-5 space-y-4 text-xs">
                {errorMsg && (
                  <div className="p-3 rounded-lg bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-500" />
                    <span>{errorMsg}</span>
                  </div>
                )}

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Full Name</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Ramesh Kumar"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Email Address</label>
                  <input
                    type="email"
                    required
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Password</label>
                  <input
                    type="password"
                    required
                    placeholder="Minimum 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">User Role</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="staff">CA Staff / Reviewer (Can review and export)</option>
                    {user?.role === "admin" && (
                      <option value="admin">CA Firm Admin (Full management access)</option>
                    )}
                    <option value="client">Client User (Upload invoices for specific business)</option>
                  </select>
                </div>

                {role === "client" && (
                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Assign to Client Business
                    </label>
                    <select
                      value={selectedClientId}
                      onChange={(e) => setSelectedClientId(e.target.value)}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-800 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      {clients.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} — GSTIN: {c.gstin || "None"}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="pt-2 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-3.5 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={creating}
                    className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {creating ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Creating...
                      </>
                    ) : (
                      "Create User"
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
