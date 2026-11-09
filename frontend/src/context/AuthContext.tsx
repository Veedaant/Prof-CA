import React, { createContext, useContext, useEffect, useState } from "react";
import { api, RegisterInput, User } from "@/lib/api";

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (email: string, pass: string) => Promise<void>;
  register: (data: RegisterInput) => Promise<void>;
  logout: () => void;
  switchDemoRole: (role: "admin" | "staff" | "client1" | "client2") => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem("auth_token");
    if (savedToken) {
      setToken(savedToken);
      api.auth
        .me()
        .then((u) => setUser(u))
        .catch(() => {
          localStorage.removeItem("auth_token");
          setToken(null);
          setUser(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, pass: string) => {
    setLoading(true);
    try {
      const data = await api.auth.login(email, pass);
      localStorage.setItem("auth_token", data.access_token);
      setToken(data.access_token);
      setUser(data.user);
    } finally {
      setLoading(false);
    }
  };

  const register = async (input: RegisterInput) => {
    const data = await api.auth.register(input);
    localStorage.setItem("auth_token", data.access_token);
    setToken(data.access_token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem("auth_token");
    setToken(null);
    setUser(null);
  };

  const switchDemoRole = async (role: "admin" | "staff" | "client1" | "client2") => {
    const creds: Record<string, { email: string; pass: string }> = {
      admin: { email: "admin@example.com", pass: "admin123" },
      staff: { email: "staff@example.com", pass: "staff123" },
      client1: { email: "client1@example.com", pass: "client123" },
      client2: { email: "client2@example.com", pass: "client123" },
    };
    const c = creds[role];
    if (c) {
      await login(c.email, c.pass);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        login,
        register,
        logout,
        switchDemoRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
