import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";
import { computeLeads } from "./leads.service.js";
import { computeReview } from "./review.service.js";
import { computeOrigins } from "./origins.service.js";

export const conversationsRoutes = Router();
conversationsRoutes.use(requireAuth);

/** Leads por situação (perguntando, montando pedido, pediu, sumiu...), calculados na hora. */
conversationsRoutes.get(
  "/leads",
  h(async (req, res) => {
    const hours = Math.min(72, Math.max(1, Number((req.query as Record<string, string | undefined>).hours) || 30));
    res.json(await computeLeads(tenantOf(req), hours));
  }),
);

/** Pedidos e faturamento por origem (anúncio, WhatsApp, cardápio, balcão) + custo por pedido do tráfego pago. */
conversationsRoutes.get(
  "/origins",
  h(async (req, res) => {
    const days = Math.min(365, Math.max(1, Number((req.query as Record<string, string | undefined>).days) || 30));
    res.json(await computeOrigins(tenantOf(req), days));
  }),
);

/** Conversas do bot com sinais de problema (taxa sem localização, correção humana, alteração de pedido, loop...). */
conversationsRoutes.get(
  "/review",
  h(async (req, res) => {
    const hours = Math.min(96, Math.max(1, Number((req.query as Record<string, string | undefined>).hours) || 30));
    res.json(await computeReview(tenantOf(req), hours));
  }),
);

/** Lista as conversas do tenant, uma por telefone, ordenadas pela mensagem mais recente. */
conversationsRoutes.get(
  "/",
  h(async (req, res) => {
    const tenantId = tenantOf(req);

    const lastMessages = await prisma.whatsAppMessage.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      distinct: ["phone"],
      include: { customer: { select: { id: true, name: true, phone: true, tier: true } } },
      take: 200,
    });

    const unreadCounts = await prisma.whatsAppMessage.groupBy({
      by: ["phone"],
      where: { tenantId, direction: "IN", readAt: null },
      _count: { _all: true },
    });
    const unreadByPhone = new Map(unreadCounts.map((u) => [u.phone, u._count._all]));

    res.json(
      lastMessages.map((m) => ({
        phone: m.phone,
        customer: m.customer,
        lastMessage: { body: m.body, direction: m.direction, senderType: m.senderType, createdAt: m.createdAt },
        unreadCount: unreadByPhone.get(m.phone) ?? 0,
      })),
    );
  }),
);

/** Detalhe de uma conversa: cliente, histórico de mensagens, pedidos recentes e estado do bot. */
conversationsRoutes.get(
  "/:phone",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const phone = req.params.phone;

    const [customer, messages, session] = await Promise.all([
      prisma.customer.findUnique({
        where: { tenantId_phone: { tenantId, phone } },
        include: {
          addresses: true,
          orders: { orderBy: { createdAt: "desc" }, take: 10, include: { items: true } },
        },
      }),
      prisma.whatsAppMessage.findMany({
        where: { tenantId, phone },
        orderBy: { createdAt: "asc" },
        take: 200,
      }),
      prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } } }),
    ]);

    const botPaused = !!session?.botPausedUntil && session.botPausedUntil > new Date();
    res.json({ phone, customer, messages, botPaused });
  }),
);

/** Marca as mensagens recebidas dessa conversa como lidas. */
conversationsRoutes.patch(
  "/:phone/read",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const phone = req.params.phone;
    await prisma.whatsAppMessage.updateMany({
      where: { tenantId, phone, direction: "IN", readAt: null },
      data: { readAt: new Date() },
    });
    res.json({ ok: true });
  }),
);

/** Pausa ou reativa o bot manualmente pra essa conversa. */
conversationsRoutes.patch(
  "/:phone/bot",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const phone = req.params.phone;
    const { paused } = z.object({ paused: z.boolean() }).parse(req.body);

    const botPausedUntil = paused ? new Date(Date.now() + 24 * 60 * 60_000) : null;
    await prisma.chatSession.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      update: { botPausedUntil },
      create: { tenantId, phone, botPausedUntil },
    });
    res.json({ ok: true, botPaused: paused });
  }),
);
