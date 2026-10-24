import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";
import {
  createOrder,
  ORDER_STATUSES,
  updateOrderStatus,
  type OrderStatus,
} from "./orders.service.js";

const PAYMENT_METHODS = ["PIX", "CASH", "CREDIT", "DEBIT", "VR", "VA", "ONLINE"] as const;

import { maybeRunLateOrderSweep } from "../whatsapp/late-orders.service.js";

export const ordersRoutes = Router();
ordersRoutes.use(requireAuth);

const orderInclude = {
  items: { include: { addons: true, removals: true } },
  customer: true,
  table: true,
} as const;

ordersRoutes.get(
  "/",
  h(async (req, res) => {
    const { status, active, search, from, to, scheduled } = req.query as Record<string, string | undefined>;
    const tenantId = tenantOf(req);
    // Pedido agendado (feito com a loja fechada) só aparece nas listas "de agora" quando chega a hora; a aba
    // Agendamentos pede scheduled=only. scheduled=include traz tudo (relatórios).
    const now = new Date();
    const scheduleFilter =
      scheduled === "only"
        ? { scheduledFor: { gt: now } }
        : scheduled === "include"
          ? {}
          : { OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }] };
    // Painel aberto = ótima hora pra checar pedido atrasado (ver late-orders.service.ts).
    if (active === "true") void maybeRunLateOrderSweep(tenantId);

    const orders = await prisma.order.findMany({
      where: {
        tenantId,
        AND: [scheduleFilter],
        ...(status ? { status } : {}),
        ...(active === "true"
          ? { status: { notIn: ["DELIVERED", "SETTLED", "CANCELED"] } }
          : {}),
        ...(search
          ? {
              OR: [
                { customer: { name: { contains: search } } },
                { customer: { phone: { contains: search } } },
              ],
            }
          : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: orderInclude,
    });
    res.json(orders);
  }),
);

ordersRoutes.get(
  "/:id",
  h(async (req, res) => {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: { ...orderInclude, statusEvents: { orderBy: { createdAt: "asc" } } },
    });
    if (!order) throw new AppError(404, "Pedido não encontrado");
    res.json(order);
  }),
);

const createOrderSchema = z.object({
  type: z.enum(["DELIVERY", "PICKUP", "DINE_IN"]),
  source: z.enum(["MENU", "WHATSAPP", "POS", "TABLE"]).default("POS"),
  // Só pedidos "No local" podem nascer sem forma de pagamento — vira uma
  // comanda aberta, cobrada depois via PATCH /:id/charge quando ficar pronta.
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  changeForCents: z.number().int().optional(),
  notes: z.string().optional(),
  couponCode: z.string().optional(),
  redeemCashbackCents: z.number().int().min(0).optional(),
  customerId: z.string().optional(),
  customer: z
    .object({ name: z.string().min(1), phone: z.string().min(8), email: z.string().email().optional() })
    .optional(),
  tableId: z.string().optional(),
  address: z
    .object({
      label: z.string().optional(),
      street: z.string(),
      number: z.string(),
      neighborhood: z.string(),
      city: z.string(),
      complement: z.string().optional(),
      reference: z.string().optional(),
    })
    .optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().optional(),
        addonIds: z
          .array(z.object({ addonId: z.string(), quantity: z.number().int().min(1) }))
          .optional(),
        removedIngredientIds: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

ordersRoutes.post(
  "/",
  h(async (req, res) => {
    const data = createOrderSchema.parse(req.body);
    if (!data.paymentMethod && data.type !== "DINE_IN") {
      throw new AppError(400, "Forma de pagamento obrigatória para esse tipo de pedido");
    }
    const order = await createOrder({ ...data, tenantId: tenantOf(req) });
    res.status(201).json(order);
  }),
);

/**
 * Cobra uma comanda aberta — pedido "No local" lançado sem forma de
 * pagamento definida (Order.paymentMethod null). Define a forma escolhida
 * na hora de entregar/cobrar do cliente, sem mexer no status do pedido.
 */
ordersRoutes.patch(
  "/:id/charge",
  h(async (req, res) => {
    const { paymentMethod, changeForCents } = z
      .object({
        paymentMethod: z.enum(PAYMENT_METHODS),
        changeForCents: z.number().int().optional(),
      })
      .parse(req.body);
    const tenantId = tenantOf(req);

    const existing = await prisma.order.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new AppError(404, "Pedido não encontrado");
    if (existing.paymentMethod) throw new AppError(409, "Esse pedido já tem forma de pagamento definida");

    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { paymentMethod, changeForCents },
      include: orderInclude,
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "CHARGE",
      entity: "Order",
      entityId: order.id,
      detail: { paymentMethod, orderNumber: order.number },
    });
    res.json(order);
  }),
);

/**
 * Impressão automática: o primeiro aparelho a "reservar" o pedido é quem imprime (dois aparelhos abertos não imprimem
 * duas vezes, e um pedido que chegou com o painel fechado é impresso quando o painel abre). Se a impressão falhar,
 * o aparelho devolve a reserva (print-release) e o pedido volta pra fila de impressão.
 */
ordersRoutes.post(
  "/:id/print-claim",
  h(async (req, res) => {
    const claimed = await prisma.order.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req), printedAt: null },
      data: { printedAt: new Date() },
    });
    res.json({ claimed: claimed.count === 1 });
  }),
);

ordersRoutes.post(
  "/:id/print-release",
  h(async (req, res) => {
    await prisma.order.updateMany({ where: { id: req.params.id, tenantId: tenantOf(req) }, data: { printedAt: null } });
    res.json({ ok: true });
  }),
);

/** Cupom impresso à mão (botão Imprimir): marca como impresso pra a impressão automática não repetir. */
ordersRoutes.post(
  "/:id/printed",
  h(async (req, res) => {
    await prisma.order.updateMany({ where: { id: req.params.id, tenantId: tenantOf(req), printedAt: null }, data: { printedAt: new Date() } });
    res.json({ ok: true });
  }),
);

/** Libera um pedido agendado pra cozinha agora (sem esperar a abertura). */
ordersRoutes.post(
  "/:id/release-scheduled",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const released = await prisma.order.updateMany({
      where: { id: req.params.id, tenantId, scheduledFor: { gt: new Date() }, status: "NEW" },
      // Fica com a hora da liberação (e não vazio): é dela que se conta o atraso do pedido, não de quando o cliente pediu.
      data: { scheduledFor: new Date() },
    });
    if (released.count !== 1) throw new AppError(409, "Esse pedido não está mais agendado");
    await audit({ tenantId, userId: req.auth!.userId, action: "RELEASE_SCHEDULED_ORDER", entity: "Order", entityId: req.params.id, detail: {} });
    res.json({ ok: true });
  }),
);

ordersRoutes.patch(
  "/:id/status",
  h(async (req, res) => {
    const { status, cancelReason } = z
      .object({
        status: z.enum(ORDER_STATUSES),
        cancelReason: z.string().optional(),
      })
      .parse(req.body);

    const order = await updateOrderStatus({
      tenantId: tenantOf(req),
      orderId: req.params.id,
      toStatus: status as OrderStatus,
      userId: req.auth!.userId,
      cancelReason,
    });
    res.json(order);
  }),
);
