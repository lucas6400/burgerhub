import type { Order } from "../types";
import { brl, formatPhoneBR, PAYMENT_LABELS } from "./format";
import { wazeUrl, type RoutePoint } from "./route";

export interface DispatchStop {
  order: Order;
  /** Pino do cliente; null quando o pedido não tem coordenadas (vai no fim da lista). */
  point: RoutePoint | null;
}

/** "Alameda 11, 5 — Quadra 503 Norte (aprox.)" — rua, número e quadra; sem nada disso o entregador segue o pino. */
export function placeLabel(order: Order): string {
  const street = order.addressStreet ? `${order.addressStreet}${order.addressNumber ? `, ${order.addressNumber}` : ""}` : "";
  return [street, order.addressNeighborhood].filter(Boolean).join(" — ");
}

/** O que o entregador precisa levar/cobrar: já pago, ou valor + forma (com o troco a levar no dinheiro). */
export function collectLine(order: Order): string {
  const method = order.paymentMethod ? (PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod) : null;
  if (order.paymentStatus === "PAID") return `✅ JÁ PAGO${method ? ` (${method})` : ""} — não cobrar`;
  const change = order.changeForCents ? ` — troco p/ ${brl(order.changeForCents)}, levar ${brl(Math.max(order.changeForCents - order.totalCents, 0))}` : "";
  return `💰 COBRAR ${brl(order.totalCents)}${method ? ` no ${method}` : " (forma a combinar)"}${change}`;
}

/** Mensagem pronta pro entregador: link da rota completa + cada parada com endereço, quadra, cobrança e Waze. */
export function buildDispatchMessage(storeName: string, stops: DispatchStop[], routeUrl: string | null): string {
  const header = `🛵 *ROTA — ${stops.length} ${stops.length === 1 ? "entrega" : "entregas"}* (saída: ${storeName})`;
  const routeLine = routeUrl ? `\n🗺️ Rota completa no Google Maps:\n${routeUrl}` : "";
  const body = stops
    .map(({ order, point }, i) => {
      const place = placeLabel(order);
      const lines = [
        `*${i + 1}) Pedido #${order.number}* — ${order.customer?.name ?? "Cliente"}${order.customer?.phone ? ` · ${formatPhoneBR(order.customer.phone)}` : ""}`,
        place ? `📍 ${place}${order.addressComplement ? ` — ${order.addressComplement}` : ""}` : order.addressComplement ? `📍 ${order.addressComplement}` : "",
        collectLine(order),
        point ? `Waze: ${wazeUrl(point)}` : "⚠️ Sem pino — confirmar o endereço com o cliente",
      ];
      return lines.filter(Boolean).join("\n");
    })
    .join("\n\n");
  return `${header}${routeLine}\n\n${body}`;
}
