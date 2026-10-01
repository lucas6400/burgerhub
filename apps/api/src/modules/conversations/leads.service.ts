import { prisma } from "../../lib/prisma.js";

/**
 * Situação de cada lead do WhatsApp, calculada na hora a partir do que já existe
 * (mensagens, pedidos, carrinho salvo, retomada enviada) — sem depender de
 * etiqueta do WhatsApp nem de nada gravado antes, então já funciona pras
 * conversas de ontem.
 */

export type LeadStage = "ORDERED" | "OUT_OF_AREA" | "HUMAN" | "GHOSTED" | "BUILDING" | "ASKING";

export interface Lead {
  phone: string;
  name: string;
  stage: LeadStage;
  lastAt: string;
  lastFrom: "CUSTOMER" | "BOT" | "HUMAN" | "SYSTEM";
  snippet: string;
  items?: string;
  orderNumber?: number;
  orderStatus?: string;
  followUpSent?: boolean;
  declined?: boolean;
}

const GHOST_AFTER_MS = 30 * 60_000;
const ORDER_WINDOW_MS = 12 * 3_600_000;
const HUMAN_WINDOW_MS = 2 * 3_600_000;
// Só a resposta a uma LOCALIZAÇÃO fora da zona — o aviso geral ("não atendemos Taquaralto") vai pra todo mundo.
const OUT_OF_AREA_RE = /fora da nossa área de entrega|não conseguimos entregar aí/i;
const DECLINED_RE = /desist|pr[oó]xima vez|deixa (pra|para) l[aá]|deixa quieto|n[ãa]o quero mais|n[ãa]o vou (querer|pedir)|mudei de ideia|cancela/i;
const tail = (phone: string) => phone.replace(/\D/g, "").slice(-8);

function cartText(sessionData: string): string {
  try {
    const d = JSON.parse(sessionData) as { cart?: { name: string; quantity: number }[]; draft?: { cart?: { name: string; quantity: number }[] } };
    const cart = d.draft?.cart ?? d.cart ?? [];
    return cart.map((i) => `${i.quantity}x ${i.name}`).join(", ");
  } catch {
    return "";
  }
}

export async function computeLeads(tenantId: string, hours = 30): Promise<Lead[]> {
  const now = Date.now();
  const since = new Date(now - hours * 3_600_000);

  const msgs = await prisma.whatsAppMessage.findMany({
    where: { tenantId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { phone: true, senderType: true, body: true, createdAt: true, customer: { select: { name: true } } },
    take: 5000,
  });
  const byPhone = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byPhone.has(m.phone)) byPhone.set(m.phone, []);
    byPhone.get(m.phone)!.push(m);
  }
  const phones = [...byPhone.keys()];
  if (phones.length === 0) return [];

  const [orders, sessions] = await Promise.all([
    prisma.order.findMany({
      where: { tenantId, status: { not: "CANCELED" }, createdAt: { gte: new Date(now - Math.max(ORDER_WINDOW_MS, hours * 3_600_000)) } },
      orderBy: { createdAt: "desc" },
      select: { number: true, status: true, createdAt: true, customer: { select: { phone: true } } },
    }),
    prisma.chatSession.findMany({
      where: { tenantId, phone: { in: phones } },
      select: { phone: true, data: true, botPausedUntil: true, followUpSentAt: true },
    }),
  ]);
  const ordersByTail = new Map<string, (typeof orders)[number]>();
  for (const o of orders) {
    const t = o.customer ? tail(o.customer.phone) : "";
    if (t && !ordersByTail.has(t)) ordersByTail.set(t, o); // o mais recente (orders vem desc)
  }
  const sessionByPhone = new Map(sessions.map((s) => [s.phone, s]));

  const leads: Lead[] = [];
  for (const [phone, list] of byPhone) {
    const last = list[list.length - 1];
    const lastCustomer = [...list].reverse().find((m) => m.senderType === "CUSTOMER");
    if (!lastCustomer) continue; // só mensagens do sistema (ex.: aviso de pedido) — não é lead
    const session = sessionByPhone.get(phone);
    const items = session ? cartText(session.data) : "";
    const order = ordersByTail.get(tail(phone));
    const lastBot = [...list].reverse().find((m) => m.senderType === "BOT");
    const humanRecent = list.some((m) => m.senderType === "HUMAN" && now - m.createdAt.getTime() < HUMAN_WINDOW_MS);
    const paused = !!session?.botPausedUntil && session.botPausedUntil.getTime() > now;

    // "Fora da área" só vale enquanto for a ÚLTIMA fala do bot e ninguém da equipe tiver falado
    // depois — se você assumiu e entregou mesmo assim, o lead não fica preso nessa lista.
    const outOfArea = !!lastBot && OUT_OF_AREA_RE.test(lastBot.body) && !list.some((m) => m.senderType === "HUMAN" && m.createdAt > lastBot.createdAt);
    const declined = DECLINED_RE.test(lastCustomer.body);
    let stage: LeadStage;
    if (order && now - order.createdAt.getTime() < Math.max(ORDER_WINDOW_MS, hours * 3_600_000)) stage = "ORDERED";
    else if (outOfArea) stage = "OUT_OF_AREA";
    else if (paused || humanRecent || last.senderType === "HUMAN") stage = "HUMAN";
    else if (declined) stage = "GHOSTED";
    else if (last.senderType !== "CUSTOMER" && now - last.createdAt.getTime() > GHOST_AFTER_MS) stage = "GHOSTED";
    else if (items) stage = "BUILDING";
    else stage = "ASKING";

    leads.push({
      phone,
      name: last.customer?.name ?? phone,
      stage,
      lastAt: last.createdAt.toISOString(),
      lastFrom: last.senderType as Lead["lastFrom"],
      snippet: last.body.replace(/\s+/g, " ").slice(0, 140),
      items: items || undefined,
      orderNumber: stage === "ORDERED" ? order?.number : undefined,
      orderStatus: stage === "ORDERED" ? order?.status : undefined,
      followUpSent: !!session?.followUpSentAt && session.followUpSentAt >= lastCustomer.createdAt,
      declined: declined || undefined,
    });
  }
  return leads.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
