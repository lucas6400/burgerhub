import { prisma } from "../../lib/prisma.js";
import { isStoreOpenNow, minutesUntilCloseToday, nowInStoreTimezone } from "../../utils/storeTime.js";
import { waTransport } from "./transport.js";
import { recordOutboundMessage } from "./messages.service.js";
import { moveLead } from "./labels.service.js";

/**
 * Retomada de leads que sumiram, em até DUAS etapas: o cliente perguntou (o bot
 * respondeu) e nunca mais falou. Mensagens curtas, sem IA (texto fixo — custo
 * zero e nada de improviso), só pra quem ainda está "quente".
 * 1ª etapa: ~30 min de silêncio, texto genérico de retomada.
 * 2ª etapa ("últimos pedidos da noite"): só quem já recebeu a 1ª e continua em
 * silêncio, perto do horário de fechamento de hoje.
 *
 * Roda de carona nas mensagens que já chegam (ver whatsapp.routes.ts) — sem cron,
 * sem endpoint público. Cuidados por ser número não-oficial (risco de bloqueio):
 * no máx. 1 mensagem por etapa por silêncio, só com a loja aberta, só quem
 * escreveu há pouco, e poucos envios por rodada com intervalo entre eles.
 */

const MIN_SILENCE_MS = 30 * 60_000; // espera 30 min antes de puxar de volta
const MAX_SILENCE_MS = 5 * 3_600_000; // depois de 5h o lead esfriou — não incomoda
const HUMAN_RECENT_MS = 3 * 3_600_000;
const RECENT_ORDER_MS = 12 * 3_600_000;
const STAGE2_MAX_AGE_MS = 6 * 3_600_000; // "últimos pedidos DA NOITE" só pra quem falou hoje — nunca pra lead de dias atrás
const STAGE2_CLOSING_WINDOW_MIN = 45; // dispara a 2ª etapa quando faltam até 45 min pra fechar
const MAX_PER_SWEEP = 4; // orçamento total compartilhado entre as duas etapas por rodada
const GAP_BETWEEN_SENDS_MS = 6_000;

// Lead que já recusou / fechou a conversa — não insiste.
const DECLINED =
  /desist|deixa (quieto|pra l[aá])|n[ãa]o quero|cancela|obrigad[oa]|\bobg\b|valeu|tchau/i;
// Bot avisando que o endereço/quadra do cliente é fora da área de entrega (as duas frases reais que o
// código usa: singular "fora da nossa área" e plural "fora das nossas áreas", conforme a zona/faixa).
const OUT_OF_AREA_RE = /fora da[s]? nossa[s]? área[s]? de entrega|n[ãa]o conseguimos entregar a[íi]|infelizmente n[ãa]o (atendemos|entregamos)/i;
// Depois de uma recusa, se o cliente mandou outra localização que FOI aceita, ele volta a valer pra retomada.
const AREA_ACCEPTED_RE = /entregamos a[íi] ✅|endereço confirmado|localização recebida/i;

const lastSweepAt = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const phoneTail = (phone: string) => phone.replace(/\D/g, "").slice(-8);

/**
 * Cliente longe demais pra entregar mora fora da área mesmo — mandar "últimos pedidos da noite" ou
 * "vi que você começou..." pra ele é spam sem propósito, ele não tem como fechar o pedido. Olha as
 * últimas mensagens do BOT (não só a última da conversa inteira): se a coisa mais recente sobre
 * área/localização foi uma recusa, sem uma aceitação depois, pula a retomada pra esse número.
 */
async function recentlyRejectedArea(tenantId: string, phone: string, lookbackMs: number): Promise<boolean> {
  const msgs = await prisma.whatsAppMessage.findMany({
    where: { tenantId, phone, senderType: "BOT", createdAt: { gte: new Date(Date.now() - lookbackMs) } },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { body: true },
  });
  for (const m of msgs) {
    if (AREA_ACCEPTED_RE.test(m.body)) return false;
    if (OUT_OF_AREA_RE.test(m.body)) return true;
  }
  return false;
}

interface CartLine {
  name: string;
  quantity: number;
}

function cartItemsText(sessionData: string): string {
  try {
    const d = JSON.parse(sessionData) as { cart?: CartLine[]; draft?: { cart?: CartLine[] } };
    const cart = d.draft?.cart ?? d.cart ?? [];
    return cart.map((i) => `${i.quantity}x ${i.name}`).join(", ");
  } catch {
    return "";
  }
}

function buildFollowUp(items: string, areas: string | null | undefined): string {
  if (items) {
    return `Oi! Vi que você começou a montar seu pedido (*${items}*) e não chegou a finalizar. 😊 Quer que eu continue de onde parou? É só me responder por aqui! 🍔`;
  }
  const areasLine = areas ? ` Lembrando que entregamos ${areas}.` : "";
  return `Oi! Ficou alguma dúvida sobre os combos ou a entrega? 😊${areasLine} Se quiser, eu já monto seu pedido por aqui — é só me falar o que vai querer! 🍔`;
}

function buildLastCallFollowUp(items: string, closeTimeStr: string): string {
  if (items) {
    return `⏰ Últimos pedidos da noite! Seu pedido (*${items}*) ainda tá disponível — fechamos às ${closeTimeStr}. Quer finalizar? 🍔`;
  }
  return `⏰ Últimos pedidos da noite! Fechamos às ${closeTimeStr} — se ainda quiser pedir, é só me chamar. 🍔`;
}

/** Chamada de carona em cada mensagem recebida; no máx. uma varredura a cada 2 min por loja. */
export async function maybeRunFollowUpSweep(tenantId: string, instance: string): Promise<void> {
  const last = lastSweepAt.get(tenantId) ?? 0;
  if (Date.now() - last < 2 * 60_000) return;
  lastSweepAt.set(tenantId, Date.now());
  try {
    await runFollowUpSweep(tenantId, instance);
  } catch (err) {
    console.error("Erro na retomada de leads:", err);
  }
}

export async function runFollowUpSweep(tenantId: string, instance: string): Promise<number> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { settings: true, businessHours: true },
  });
  const settings = tenant?.settings;
  if (!tenant || !settings?.followUpEnabled || !settings.waEnabled || !settings.botEnabled) return 0;
  if (!isStoreOpenNow({ isOpenOverride: settings.isOpenOverride, businessHours: tenant.businessHours })) return 0;

  const now = Date.now();
  const recent = await prisma.whatsAppMessage.findMany({
    where: { tenantId, senderType: "CUSTOMER", createdAt: { gte: new Date(now - MAX_SILENCE_MS) } },
    distinct: ["phone"],
    orderBy: { createdAt: "desc" },
    select: { phone: true },
    take: 80,
  });

  let sent = 0;
  // O mesmo número aparece com e sem o 9º dígito (55 63 9 8400-0289 / 55 63 8400-0289) como duas
  // conversas; sem isso a pessoa recebia a retomada duas vezes na mesma rodada.
  const sentTails = new Set<string>();
  for (const { phone } of recent) {
    if (sent >= MAX_PER_SWEEP) break;
    if (sentTails.has(phoneTail(phone))) continue;

    const lastMsg = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, phone },
      orderBy: { createdAt: "desc" },
      select: { senderType: true, body: true, createdAt: true },
    });
    // Só quando a última fala foi do BOT (a bola está com o cliente) e já passou o tempo.
    if (!lastMsg || lastMsg.senderType !== "BOT" || now - lastMsg.createdAt.getTime() < MIN_SILENCE_MS) continue;

    const lastCustomer = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, phone, senderType: "CUSTOMER" },
      orderBy: { createdAt: "desc" },
      select: { body: true, createdAt: true },
    });
    if (!lastCustomer || now - lastCustomer.createdAt.getTime() > MAX_SILENCE_MS) continue;
    if (DECLINED.test(lastCustomer.body) || DECLINED.test(lastMsg.body)) continue;
    if (await recentlyRejectedArea(tenantId, phone, MAX_SILENCE_MS)) continue;

    const humanRecent = await prisma.whatsAppMessage.findFirst({
      where: { tenantId, phone, senderType: "HUMAN", createdAt: { gte: new Date(now - HUMAN_RECENT_MS) } },
      select: { id: true },
    });
    if (humanRecent) continue;

    const recentOrder = await prisma.order.findFirst({
      where: {
        tenantId,
        customer: { phone: { endsWith: phoneTail(phone) } },
        status: { not: "CANCELED" },
        createdAt: { gte: new Date(now - RECENT_ORDER_MS) },
      },
      select: { id: true },
    });
    if (recentOrder) continue;

    const session = await prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
    if (session?.botPausedUntil && session.botPausedUntil.getTime() > now) continue;
    if (session?.followUpSentAt && session.followUpSentAt.getTime() >= lastCustomer.createdAt.getTime()) continue;

    // Reserva atômica: se duas varreduras rodarem juntas, só uma envia.
    const claimed = session
      ? await prisma.chatSession.updateMany({
          where: {
            id: session.id,
            OR: [{ followUpSentAt: null }, { followUpSentAt: { lt: lastCustomer.createdAt } }],
          },
          data: { followUpSentAt: new Date() },
        })
      : await prisma.chatSession
          .create({ data: { tenantId, phone, data: "{}", followUpSentAt: new Date() } })
          .then(() => ({ count: 1 }))
          .catch(() => ({ count: 0 }));
    if (claimed.count !== 1) continue;

    const text = buildFollowUp(cartItemsText(session?.data ?? "{}"), settings.deliveryAreasDescription);
    try {
      if (sent > 0) await sleep(GAP_BETWEEN_SENDS_MS);
      await waTransport.sendText(instance, phone, text);
      await recordOutboundMessage(tenantId, phone, text, { senderType: "BOT" });
      await moveLead(tenantId, phone, "GHOSTED");
      sentTails.add(phoneTail(phone));
      sent++;
    } catch (err) {
      console.error("Falha ao enviar retomada de lead:", err);
    }
  }

  // ---- 2ª etapa: "últimos pedidos da noite", só perto do fechamento de hoje.
  if (sent < MAX_PER_SWEEP) {
    const closeMinutes = minutesUntilCloseToday(tenant.businessHours);
    if (closeMinutes != null && closeMinutes <= STAGE2_CLOSING_WINDOW_MIN) {
      const { weekday } = nowInStoreTimezone();
      const closeTimeStr = tenant.businessHours.find((h) => h.weekday === weekday && !h.closed)?.closeTime ?? "";

      const stage1Sent = await prisma.chatSession.findMany({
        // O `< new Date(now - 60_000)` evita que a 1ª etapa enviada NESTA MESMA varredura
        // (que acabou de comitar `followUpSentAt` no loop acima) já dispare a 2ª em seguida —
        // as duas etapas precisam ficar separadas no tempo, nunca nas costas uma da outra.
        where: { tenantId, followUpSentAt: { not: null, lt: new Date(now - 60_000), gt: new Date(now - STAGE2_MAX_AGE_MS) }, followUpStage2SentAt: null },
        take: 40,
      });

      for (const session of stage1Sent) {
        if (sent >= MAX_PER_SWEEP) break;
        const { phone } = session;
        if (sentTails.has(phoneTail(phone))) continue;

        const lastCustomer = await prisma.whatsAppMessage.findFirst({
          where: { tenantId, phone, senderType: "CUSTOMER" },
          orderBy: { createdAt: "desc" },
          select: { body: true, createdAt: true },
        });
        // Sem mensagem de cliente, ou cliente já respondeu depois da 1ª etapa: não é mais um silêncio a recuperar.
        if (!lastCustomer || session.followUpSentAt!.getTime() < lastCustomer.createdAt.getTime()) continue;
        if (now - lastCustomer.createdAt.getTime() > STAGE2_MAX_AGE_MS) continue;
        if (DECLINED.test(lastCustomer.body)) continue;
        if (await recentlyRejectedArea(tenantId, phone, STAGE2_MAX_AGE_MS)) continue;

        const humanRecent = await prisma.whatsAppMessage.findFirst({
          where: { tenantId, phone, senderType: "HUMAN", createdAt: { gte: new Date(now - HUMAN_RECENT_MS) } },
          select: { id: true },
        });
        if (humanRecent) continue;

        const recentOrder = await prisma.order.findFirst({
          where: {
            tenantId,
            customer: { phone: { endsWith: phoneTail(phone) } },
            status: { not: "CANCELED" },
            createdAt: { gte: new Date(now - RECENT_ORDER_MS) },
          },
          select: { id: true },
        });
        if (recentOrder) continue;
        if (session.botPausedUntil && session.botPausedUntil.getTime() > now) continue;

        // Reserva atômica: se duas varreduras rodarem juntas, só uma envia.
        const claimed = await prisma.chatSession.updateMany({
          where: { id: session.id, followUpStage2SentAt: null },
          data: { followUpStage2SentAt: new Date() },
        });
        if (claimed.count !== 1) continue;

        const text = buildLastCallFollowUp(cartItemsText(session.data), closeTimeStr);
        try {
          if (sent > 0) await sleep(GAP_BETWEEN_SENDS_MS);
          await waTransport.sendText(instance, phone, text);
          await recordOutboundMessage(tenantId, phone, text, { senderType: "BOT" });
          sentTails.add(phoneTail(phone));
          sent++;
        } catch (err) {
          console.error("Falha ao enviar 2ª retomada de lead:", err);
        }
      }
    }
  }

  return sent;
}
