import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Outlet, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { getCustomerToken, setCustomerToken } from "../lib/customerAuth";

export interface CustomerAddress {
  id: string;
  label: string;
  street: string;
  number: string;
  complement?: string | null;
  neighborhood: string;
  city: string;
  state?: string;
  cep?: string | null;
  reference?: string | null;
  isDefault: boolean;
  lat?: number | null;
  lng?: number | null;
}

export interface CustomerProfile {
  id: string;
  name: string;
  phone: string;
  tier: string;
  loyaltyPoints: number;
  cashbackCents: number;
  addresses?: CustomerAddress[];
}

interface CustomerAuthContextValue {
  customer: CustomerProfile | null;
  loading: boolean;
  login: (phone: string, password: string) => Promise<CustomerProfile>;
  register: (name: string, phone: string, password: string) => Promise<CustomerProfile>;
  logout: () => void;
  refresh: () => void;
}

// Contexto separado do AuthContext de staff (stores/auth.tsx) — token, ciclo de
// vida e páginas diferentes. Nunca deve ser aninhado dentro do AuthProvider.
const CustomerAuthContext = createContext<CustomerAuthContextValue | null>(null);

export function CustomerAuthProvider({ slug, children }: { slug: string; children: ReactNode }) {
  const [customer, setCustomer] = useState<CustomerProfile | null>(null);
  const [loading, setLoading] = useState(!!getCustomerToken(slug));

  function load() {
    if (!getCustomerToken(slug)) {
      setLoading(false);
      return;
    }
    api
      .get<CustomerProfile>(`/public/${slug}/account/me`)
      .then(setCustomer)
      .catch(() => setCustomerToken(slug, null))
      .finally(() => setLoading(false));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [slug]);

  async function login(phone: string, password: string) {
    const data = await api.post<{ token: string; customer: CustomerProfile }>(
      `/public/${slug}/account/login`,
      { phone, password },
    );
    setCustomerToken(slug, data.token);
    setCustomer(data.customer);
    load(); // busca o perfil completo (com endereços salvos) logo em seguida
    return data.customer;
  }

  async function register(name: string, phone: string, password: string) {
    const data = await api.post<{ token: string; customer: CustomerProfile }>(
      `/public/${slug}/account/register`,
      { name, phone, password },
    );
    setCustomerToken(slug, data.token);
    setCustomer(data.customer);
    load();
    return data.customer;
  }

  function logout() {
    setCustomerToken(slug, null);
    setCustomer(null);
  }

  return (
    <CustomerAuthContext.Provider value={{ customer, loading, login, register, logout, refresh: load }}>
      {children}
    </CustomerAuthContext.Provider>
  );
}

export function useCustomerAuth() {
  const ctx = useContext(CustomerAuthContext);
  if (!ctx) throw new Error("useCustomerAuth deve ser usado dentro de CustomerAuthProvider");
  return ctx;
}

/** Rota de layout — lê :slug da URL e monta o CustomerAuthProvider em volta das páginas do cardápio. */
export function CustomerAuthLayout() {
  const { slug } = useParams();
  if (!slug) return <Outlet />;
  return (
    <CustomerAuthProvider slug={slug}>
      <Outlet />
    </CustomerAuthProvider>
  );
}
