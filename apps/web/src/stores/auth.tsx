import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, setToken } from "../lib/api";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}
interface TenantSettings {
  address?: string | null;
  kdsEnabled?: boolean;
  autoPrint?: boolean;
}
interface Tenant {
  id: string;
  slug: string;
  name: string;
  phone?: string | null;
  settings?: TenantSettings | null;
}

interface AuthContextValue {
  user: User | null;
  tenant: Tenant | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<User>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => void;
  setSession: (data: { token: string; user: User; tenant: Tenant }) => void;
  updateTenantName: (name: string) => void;
  updateTenantSlug: (slug: string) => void;
  updateTenantSettings: (patch: Partial<TenantSettings>) => void;
}

interface RegisterPayload {
  restaurantName: string;
  slug: string;
  name: string;
  email: string;
  password: string;
  phone?: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!getToken()) return;
    api
      .get<{ user: User; tenant: Tenant }>("/auth/me")
      .then((data) => {
        setUser(data.user);
        setTenant(data.tenant);
      })
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  function setSession(data: { token: string; user: User; tenant: Tenant }) {
    setToken(data.token);
    setUser(data.user);
    setTenant(data.tenant);
  }

  async function login(email: string, password: string) {
    const data = await api.post<{ token: string; user: User; tenant: Tenant }>("/auth/login", {
      email,
      password,
    });
    setSession(data);
    return data.user;
  }

  async function register(payload: RegisterPayload) {
    const data = await api.post<{ token: string; user: User; tenant: Tenant }>(
      "/auth/register",
      payload,
    );
    setSession(data);
  }

  function logout() {
    setToken(null);
    setUser(null);
    setTenant(null);
    window.location.href = "/login";
  }

  function updateTenantName(name: string) {
    setTenant((prev) => (prev ? { ...prev, name } : prev));
  }

  function updateTenantSlug(slug: string) {
    setTenant((prev) => (prev ? { ...prev, slug } : prev));
  }

  function updateTenantSettings(patch: Partial<TenantSettings>) {
    setTenant((prev) => (prev ? { ...prev, settings: { ...prev.settings, ...patch } } : prev));
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        tenant,
        loading,
        login,
        register,
        logout,
        setSession,
        updateTenantName,
        updateTenantSlug,
        updateTenantSettings,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return ctx;
}
