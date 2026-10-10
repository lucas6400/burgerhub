/** Cargos que veem números de faturamento (Dashboard e Relatórios): gerente e proprietário. */
const MANAGER_ROLES = ["MANAGER", "ADMIN"];

export const canSeeDashboard = (role: string): boolean => MANAGER_ROLES.includes(role);

/** Primeira tela depois do login: cada cargo cai numa tela que ele pode abrir. */
export function homePathFor(role: string): string {
  if (role === "COURIER") return "/motoboy";
  return canSeeDashboard(role) ? "/dashboard" : "/pedidos";
}
