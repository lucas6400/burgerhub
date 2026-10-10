import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../stores/auth";
import { canSeeDashboard, homePathFor } from "../lib/access";

/** Tela só de gerente/proprietário: os demais cargos voltam pra tela inicial deles (mesmo digitando o endereço). */
export function RequireManager({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null; // o AppShell já cuida de mandar pro login
  if (!canSeeDashboard(user.role)) return <Navigate to={homePathFor(user.role)} replace />;
  return <>{children}</>;
}
