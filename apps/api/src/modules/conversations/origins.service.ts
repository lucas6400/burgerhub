import { prisma } from "../../lib/prisma.js";

/**
 * De onde vieram os pedidos. Sem rastreio de anúncio (a Meta não repassa o clique),
 * a origem é deduzida: WhatsApp cuja PRIMEIRA fala do cliente é o texto pré-preenchido
 * do anúncio ("Quero pedir o combo...") = anúncio; cardápio online = link/Instagram;
 * PDV = venda de balcão/porta.
 */

export const AD_SPEND_CATEGORY = "Tráfego pago";

// Textos que o botão do anúncio pré-preenche na conversa.
const AD_PREFILL = /^\s*(boa noite[!,.]?\s*)?(quero (pedir|saber|mais)|ol[aá]! posso ter mais informa|vi no insta|link:)/i;

export type OriginKey = "AD" | "WHATSAPP" | "MENU" | "DOOR";

const LABELS: Record<OriginKey, string> = {
  AD: "Anúncio (WhatsApp)",
  WHATSAPP: "WhatsApp direto / indicação",
  MENU: "Cardápio online (link / Instagram)",
  DOOR: "Balcão / porta",
};

export interface OriginsReport {
  days: number;
  rows: { key: OriginKey; label: string; orders: number; revenueCents: number }[];
  totalOrders: number;
  totalRevenueCents: number;
  adSpendCents: number;
  adSpendAllTimeCents: number;
  adOrders: number;
  adRevenueCents: number;
  costPerAdOrderCents: number | null;
  returnPerReal: number | null;
}

const phoneTail = (phone: string) => phone.replace(/\D/g, "").slice(-8);

export async function computeOrigins(tenantId: string, days: number): Promise<OriginsReport> {
  const since = new Date(Date.now() - days * 86_400_000);
  const orders = await prisma.order.findMany({
    where: { tenantId, status: { not: "CANCELED" }, createdAt: { gte: since } },
    select: { source: true, totalCents: true, customer: { select: { phone: true } } },
  });

  const whatsappTails = new Set(orders.filter((o) => o.source === "WHATSAPP" && o.customer?.phone).map((o) => phoneTail(o.customer!.phone)));
  const firstBodyByTail = new Map<string, string>();
  if (whatsappTails.size > 0) {
    const firsts = await prisma.whatsAppMessage.findMany({
      where: { tenantId, senderType: "CUSTOMER" },
      orderBy: { createdAt: "asc" },
      select: { phone: true, body: true },
    });
    for (const m of firsts) {
      const t = phoneTail(m.phone);
      if (whatsappTails.has(t) && !firstBodyByTail.has(t)) firstBodyByTail.set(t, m.body);
    }
  }

  const acc = new Map<OriginKey, { orders: number; revenueCents: number }>();
  const add = (key: OriginKey, cents: number) => {
    const r = acc.get(key) ?? { orders: 0, revenueCents: 0 };
    r.orders++;
    r.revenueCents += cents;
    acc.set(key, r);
  };
  for (const o of orders) {
    if (o.source === "MENU") add("MENU", o.totalCents);
    else if (o.source === "WHATSAPP") {
      const first = o.customer?.phone ? firstBodyByTail.get(phoneTail(o.customer.phone)) ?? "" : "";
      add(AD_PREFILL.test(first) ? "AD" : "WHATSAPP", o.totalCents);
    } else add("DOOR", o.totalCents);
  }

  const [spendPeriod, spendAll] = await Promise.all([
    prisma.financialEntry.aggregate({ _sum: { amountCents: true }, where: { tenantId, type: "EXPENSE", category: AD_SPEND_CATEGORY, OR: [{ paidAt: { gte: since } }, { paidAt: null, createdAt: { gte: since } }] } }),
    prisma.financialEntry.aggregate({ _sum: { amountCents: true }, where: { tenantId, type: "EXPENSE", category: AD_SPEND_CATEGORY } }),
  ]);
  const adSpendCents = spendPeriod._sum.amountCents ?? 0;
  const ad = acc.get("AD") ?? { orders: 0, revenueCents: 0 };
  const keys: OriginKey[] = ["AD", "WHATSAPP", "MENU", "DOOR"];
  return {
    days,
    rows: keys.map((k) => ({ key: k, label: LABELS[k], orders: acc.get(k)?.orders ?? 0, revenueCents: acc.get(k)?.revenueCents ?? 0 })),
    totalOrders: orders.length,
    totalRevenueCents: orders.reduce((s, o) => s + o.totalCents, 0),
    adSpendCents,
    adSpendAllTimeCents: spendAll._sum.amountCents ?? 0,
    adOrders: ad.orders,
    adRevenueCents: ad.revenueCents,
    costPerAdOrderCents: ad.orders > 0 && adSpendCents > 0 ? Math.round(adSpendCents / ad.orders) : null,
    returnPerReal: adSpendCents > 0 ? Math.round((ad.revenueCents / adSpendCents) * 100) / 100 : null,
  };
}
