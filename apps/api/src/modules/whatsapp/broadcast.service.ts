import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { getWhatsAppSenderFor } from "./transport.js";
import { recordOutboundMessage } from "./messages.service.js";

/**
 * Disparo "agora entregamos na sua região": só pra quem o bot RECUSOU por estar
 * fora da área e nunca comprou. O envio é uma mensagem por chamada (o painel espera
 * um intervalo aleatório entre elas) — em serverless não dá pra segurar uma fila
 * longa, e o espaçamento é o que evita o bloqueio do número.
 */

const REFUSED = /fica fora da nossa área|fora da nossa área de entrega|n[ãa]o conseguimos entregar|n[ãa]o entregamos (na|no|em|aí)|infelizmente n[ãa]o (atendemos|entregamos)/i;
// Regiões que a loja continua não atendendo (depois da ponte / muito longe).
const FAR_AWAY = /taquaralto|aureny|alreny|aurenny|taquari|santa f[eé]|sol nascente|morada do sol|vila uni[ãa]o|serra do carmo/i;
const DEDUPE_MS = 24 * 3_600_000;

const phoneTail = (phone: string) => phone.replace(/\D/g, "").slice(-8);

export interface BroadcastRecipient {
  phone: string;
  name: string;
  wrote: string;
  refusedAt: string;
  /** Itens do último pedido, em texto limpo pro cliente ler (ex.: "1x Combo 3 X-Tudo + Guaraná 1L") — só existe pra audience "buyers". */
  lastItems?: string;
}

/** Troca {nome} e {ultimo_pedido} pelos dados DESTE cliente — cada um recebe o próprio último pedido, não um texto genérico igual pra todo mundo. */
function applyTemplate(text: string, recipient: BroadcastRecipient): string {
  return text.replace(/\{nome\}/gi, recipient.name || "").replace(/\{ultimo_pedido\}/gi, recipient.lastItems ?? "");
}

export type BroadcastAudience = "refused" | "buyers";
const MIN_DAYS_SINCE_ORDER = 3;

/** Quem já comprou e não pede há alguns dias — recompra (a base que mais barato volta a vender). */
async function computePastBuyers(tenantId: string): Promise<BroadcastRecipient[]> {
  const orders = await prisma.order.findMany({
    where: { tenantId, status: { not: "CANCELED" }, customerId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, totalCents: true, customer: { select: { name: true, phone: true } }, items: { select: { nameSnapshot: true, quantity: true } } },
  });
  const seen = new Set<string>();
  const cutoff = Date.now() - MIN_DAYS_SINCE_ORDER * 86_400_000;
  const result: BroadcastRecipient[] = [];
  for (const o of orders) {
    const phone = o.customer?.phone?.replace(/\D/g, "");
    if (!phone || phone.length < 10) continue;
    const tail = phoneTail(phone);
    if (seen.has(tail)) continue; // só o pedido mais recente de cada cliente
    seen.add(tail);
    if (o.createdAt.getTime() > cutoff) continue;
    const days = Math.round((Date.now() - o.createdAt.getTime()) / 86_400_000);
    const items = o.items.map((i) => `${i.quantity}x ${i.nameSnapshot}`).join(", ");
    result.push({
      phone: phone.length <= 11 ? `55${phone}` : phone,
      name: o.customer?.name ?? "",
      wrote: `Último pedido há ${days} dia(s): ${items} (R$ ${(o.totalCents / 100).toFixed(0)})`,
      refusedAt: o.createdAt.toISOString(),
      lastItems: items,
    });
  }
  return result;
}

export async function computeBroadcastRecipients(tenantId: string, audience: BroadcastAudience = "refused"): Promise<BroadcastRecipient[]> {
  if (audience === "buyers") return computePastBuyers(tenantId);
  const msgs = await prisma.whatsAppMessage.findMany({
    where: { tenantId },
    orderBy: { createdAt: "asc" },
    select: { phone: true, senderType: true, body: true, createdAt: true },
  });
  const byPhone = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const list = byPhone.get(m.phone);
    if (list) list.push(m);
    else byPhone.set(m.phone, [m]);
  }

  const orders = await prisma.order.findMany({
    where: { tenantId, status: { not: "CANCELED" }, customer: { isNot: null } },
    select: { customer: { select: { phone: true } } },
  });
  const buyers = new Set(orders.map((o) => phoneTail(o.customer?.phone ?? "")));

  const result: BroadcastRecipient[] = [];
  for (const [phone, list] of byPhone) {
    const refusals = list.filter((m) => m.senderType === "BOT" && REFUSED.test(m.body));
    if (refusals.length === 0 || buyers.has(phoneTail(phone))) continue;
    const wrote = list.filter((m) => m.senderType === "CUSTOMER").map((m) => m.body).join(" | ");
    if (FAR_AWAY.test(wrote)) continue;
    const customer = await prisma.customer.findFirst({
      where: { tenantId, phone: { endsWith: phoneTail(phone) } },
      select: { name: true },
    });
    result.push({
      phone,
      name: customer?.name ?? "",
      wrote: wrote.replace(/\s+/g, " ").slice(0, 140),
      refusedAt: refusals[refusals.length - 1].createdAt.toISOString(),
    });
  }
  return result;
}

export async function sendBroadcastMessage(tenantId: string, phone: string, text: string, audience: BroadcastAudience = "refused"): Promise<{ status: "sent" | "skipped"; reason?: string }> {
  const recipients = await computeBroadcastRecipients(tenantId, audience);
  const recipient = recipients.find((r) => r.phone === phone);
  if (!recipient) {
    throw new AppError(400, "Esse número não está na lista do disparo.");
  }
  const personalizedText = applyTemplate(text, recipient);
  const already = await prisma.whatsAppMessage.findFirst({
    where: { tenantId, phone, senderType: "BOT", body: personalizedText, createdAt: { gte: new Date(Date.now() - DEDUPE_MS) } },
    select: { id: true },
  });
  if (already) return { status: "skipped", reason: "já recebeu essa mensagem nas últimas 24h" };

  const sender = await getWhatsAppSenderFor(tenantId);
  if (!sender) throw new AppError(409, "Conecte o WhatsApp antes de fazer o disparo.");
  await sender.sendText(phone, personalizedText);
  await recordOutboundMessage(tenantId, phone, personalizedText, { senderType: "BOT" });
  return { status: "sent" };
}
