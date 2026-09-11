import { Navigate } from "react-router-dom";
import { useAuth } from "../stores/auth";
import { LandingPage } from "./Landing";

/** Domínio raiz: visitante deslogado vê a página de vendas, quem já está logado cai direto no painel. */
export function Home() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  if (!user) return <LandingPage />;

  return <Navigate to={user.role === "COURIER" ? "/motoboy" : "/dashboard"} replace />;
}
