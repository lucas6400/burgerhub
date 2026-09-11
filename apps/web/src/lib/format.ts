export function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function parseBrl(value: string): number {
  const clean = value.replace(/[^\d,.-]/g, "").replace(".", "").replace(",", ".");
  return Math.round(parseFloat(clean || "0") * 100);
}

/**
 * Formata dígitos como telefone BR: (XX) XXXX-XXXX ou (XX) XXXXX-XXXX,
 * dependendo da quantidade digitada. Recebe qualquer string (com ou sem
 * máscara) e sempre re-deriva a partir dos dígitos — não trava o cursor
 * nem impede apagar/corrigir o DDD.
 */
export function formatPhoneBR(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7, 11)}`;
}

/** Formata dígitos como CEP: XXXXX-XXX. Recebe qualquer string (com ou sem máscara). */
export function formatCep(value: string): string {
  const d = value.replace(/\D/g, "").slice(0, 8);
  if (d.length <= 5) return d;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString("pt-BR");
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeAgo(date: string | Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return formatDate(date);
}

export function elapsedMinutes(date: string | Date): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000);
}

export const ORDER_STATUS_LABELS: Record<string, string> = {
  NEW: "Novo",
  PREPARING: "Preparando",
  FINISHING: "Finalizando",
  READY: "Pronto",
  OUT_FOR_DELIVERY: "Saiu p/ entrega",
  DELIVERED: "Entregue",
  SETTLED: "Conta fechada",
  CANCELED: "Cancelado",
};

export const PAYMENT_LABELS: Record<string, string> = {
  PIX: "Pix",
  CASH: "Dinheiro",
  CREDIT: "Crédito",
  DEBIT: "Débito",
  VR: "VR",
  VA: "VA",
  ONLINE: "Online",
};

export const ORDER_TYPE_LABELS: Record<string, string> = {
  DELIVERY: "Entrega",
  PICKUP: "Retirada",
  DINE_IN: "No local",
};

export const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  MANAGER: "Gerente",
  CASHIER: "Caixa",
  ATTENDANT: "Atendente",
  DISPATCHER: "Despachante",
  KITCHEN: "Cozinha",
  COURIER: "Entregador",
};
