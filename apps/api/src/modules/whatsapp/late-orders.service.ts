import { prisma } from "../../lib/prisma.js";
import { getWhatsAppSenderFor } from "./transport.js";
import { recordOutboundMessage } from "./messages.service.js";

/**
 * Aviso de pedido atrasado — pro DONO, no WhatsApp dele (o mesmo número dos
 * avisos de pedido novo), antes de o cliente reclamar. "Atrasado" = passou do
 * limite do tempo prometido ao cliente (preparo padrão + 20 min, a mesma faixa
 * "45 a 65 min" que o bot informa). Um aviso por pedido.
 *
 * Sem cron: roda quando chega mensagem no WhatsApp e quando o painel de pedidos
 * está aberto (ver whatsapp.routes.ts e orders.routes.ts).
 */

const CHECK_EVERY_MS = 3 * 60_000;
const MAX_AGE_MS = 6 * 3_600_000; // pedido muito antigo é sobra de teste/esquecido, não atraso real
const ACTIVE = ["NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"];

const STATUS_LABELS: Record<string, string> = {
  NEW: "na fila da cozinha",
  PREPARING: "em preparo",
  FINISHING: "finalizando",
  READY: "pronto, aguardando entregador",
  OUT_FOR_DELIVERY: "saiu para entrega",
};

const lastCheckAt = new Map<string, number>();

export async function maybeRunLateOrderSweep(tenantId: string): Promise<void> {
  if (Date.now() - (lastCheckAt.get(tenantId) ?? 0) < CHECK_EVERY_MS) return;
  lastCheckAt.set(tenantId, Date.now());
  try {
    await runLateOrderSweep(tenantId);
  } catch (err) {
    console.error("Erro no aviso de pedido atrasado:", err);
  }
}

export async function runLateOrderSweep(tenantId: string): Promise<number> {
  const settings = await prisma.tenantSettings.findUnique({
    where: { tenantId },
    select: { lateOrderAlertEnabled: true, lateOrderNotifyCustomer: true, msgOrderLate: true, orderAlertPhone: true, defaultPrepMinutes: true, waEnabled: true },
  });
  if (!settings?.waEnabled) return 0;
  const alertOwner = settings.lateOrderAlertEnabled && !!settings.orderAlertPhone;
  const notifyCustomer = settings.lateOrderNotifyCustomer;
  if (!alertOwner && !notifyCustomer) return 0;

  const now = Date.now();
  const limitMin = settings.defaultPrepMinutes + 20;
  const late = await prisma.order.findMany({
    where: {
      tenantId,
      status: { in: ACTIVE },
      type: { in: ["DELIVERY", "PICKUP"] },
      source: { in: ["MENU", "WHATSAPP"] },
      lateAlertSentAt: null,
      createdAt: { lt: new Date(now - limitMin * 60_000), gte: new Date(now - MAX_AGE_MS) },
    },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: {
      id: true,
      number: true,
      status: true,
      type: true,
      createdAt: true,
      addressNeighborhood: true,
      customer: { select: { name: true, phone: true } },
    },
  });
  if (late.length === 0) return 0;

  // Reserva atômica: se duas verificações rodarem juntas, cada pedido é avisado uma vez só.
  const claimed = [];
  for (const o of late) {
    const r = await prisma.order.updateMany({ where: { id: o.id, lateAlertSentAt: null }, data: { lateAlertSentAt: new Date() } });
    if (r.count === 1) claimed.push(o);
  }
  if (claimed.length === 0) return 0;

  const sender = await getWhatsAppSenderFor(tenantId);
  if (!sender) return 0;

  if (notifyCustomer) {
    for (const o of claimed) {
      const phone = o.customer?.phone;
      if (!phone) continue;
      // Se você (ou a equipe) já está falando com o cliente, não manda aviso automático por cima.
      const humanRecent = await prisma.whatsAppMessage.findFirst({
        where: { tenantId, phone: { endsWith: phone.replace(/\D/g, "").slice(-8) }, senderType: "HUMAN", createdAt: { gte: new Date(now - 30 * 60_000) } },
        select: { id: true },
      });
      if (humanRecent) continue;
      const text =
        o.status === "OUT_FOR_DELIVERY"
          ? `🛵 Seu pedido #${o.number} já está a caminho — o movimento atrasou um pouquinho, mas estamos chegando! Obrigado pela paciência. 🙏`
          : settings.msgOrderLate.replace("{n}", String(o.number));
      try {
        await sender.sendText(phone, text);
        await recordOutboundMessage(tenantId, phone, text, { senderType: "SYSTEM" });
      } catch (err) {
        console.error("Falha ao avisar cliente do atraso:", err);
      }
    }
  }

  if (!alertOwner) return claimed.length;

  const lines = claimed.map((o) => {
    const min = Math.round((now - o.createdAt.getTime()) / 60_000);
    const who = o.customer ? `${o.customer.name} — ${o.customer.phone}` : "cliente não identificado";
    const where = o.type === "DELIVERY" ? `entrega${o.addressNeighborhood ? ` (${o.addressNeighborhood})` : ""}` : "retirada";
    return `• *Pedido #${o.number}* — há ${min} min (prometido até ${limitMin}) · ${STATUS_LABELS[o.status] ?? o.status}\n  ${where} · ${who}`;
  });
  await sender.sendText(settings.orderAlertPhone!, `⏰ *Pedido${claimed.length > 1 ? "s" : ""} ${claimed.length > 1 ? "passaram" : "passou"} do tempo prometido*\n\n${lines.join("\n")}`);
  return claimed.length;
}
