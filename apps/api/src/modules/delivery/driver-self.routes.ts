import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { updateOrderStatus } from "../orders/orders.service.js";
import {
  advanceDeliveryStatus,
  createDeliveryMessage,
  listDeliveryMessages,
  rejectDelivery,
  type DeliveryStatus,
} from "./delivery.service.js";
import { recordDriverLocation, setDriverStatus } from "./driver.service.js";

/**
 * Área do próprio entregador — diferente de driver.routes.ts (operador vê
 * todos). Aqui cada usuário só enxerga e mexe no que é dele mesmo (item 40
 * do módulo de entregas: RBAC — entregador só vê pedidos atribuídos a ele).
 */
export const driverSelfRoutes = Router();
driverSelfRoutes.use(requireAuth);

async function myDriver(req: Request) {
  if (req.auth!.role !== "COURIER") {
    throw new AppError(403, "Essa área é exclusiva de entregadores");
  }
  const driver = await prisma.driver.findFirst({ where: { userId: req.auth!.userId, tenantId: tenantOf(req) } });
  if (!driver) throw new AppError(404, "Sua conta não está vinculada a um cadastro de entregador");
  return driver;
}

driverSelfRoutes.get(
  "/me",
  h(async (req, res) => {
    const driver = await myDriver(req);
    res.json(driver);
  }),
);

/** Ficar online/offline/em pausa — os demais status são derivados do avanço das entregas. */
const SELF_DRIVER_STATUSES = ["OFFLINE", "AVAILABLE", "PAUSED"] as const;
driverSelfRoutes.patch(
  "/me/status",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const { status } = z.object({ status: z.enum(SELF_DRIVER_STATUSES) }).parse(req.body);
    await setDriverStatus(tenantOf(req), driver.id, status);
    res.json({ ok: true });
  }),
);

driverSelfRoutes.post(
  "/me/location",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const data = z
      .object({
        lat: z.number(),
        lng: z.number(),
        speed: z.number().optional(),
        heading: z.number().optional(),
        accuracy: z.number().optional(),
      })
      .parse(req.body);
    await recordDriverLocation(tenantOf(req), driver.id, data);
    res.json({ ok: true });
  }),
);

/** Entregas atribuídas a mim, ainda não finalizadas — a "corrida" atual do entregador. */
driverSelfRoutes.get(
  "/me/deliveries",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const deliveries = await prisma.delivery.findMany({
      where: { driverId: driver.id, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
      include: { order: { include: { customer: true, items: true } } },
      orderBy: [{ stopSequence: "asc" }, { assignedAt: "asc" }],
    });
    res.json(deliveries);
  }),
);

driverSelfRoutes.patch(
  "/me/deliveries/:id/accept",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) } });
    if (!delivery || delivery.driverId !== driver.id) throw new AppError(403, "Essa entrega não está atribuída a você");
    const updated = await advanceDeliveryStatus({
      tenantId: tenantOf(req),
      deliveryId: delivery.id,
      toStatus: "HEADING_TO_STORE",
      userId: req.auth!.userId,
    });
    res.json(updated);
  }),
);

driverSelfRoutes.patch(
  "/me/deliveries/:id/reject",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const updated = await rejectDelivery({
      tenantId: tenantOf(req),
      deliveryId: req.params.id,
      driverId: driver.id,
      userId: req.auth!.userId,
    });
    res.json(updated);
  }),
);

/** Chat da entrega — entregador consulta as mensagens trocadas com o cliente. */
driverSelfRoutes.get(
  "/me/deliveries/:id/messages",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) } });
    if (!delivery || delivery.driverId !== driver.id) throw new AppError(403, "Essa entrega não está atribuída a você");
    const messages = await listDeliveryMessages(tenantOf(req), delivery.id);
    res.json(messages);
  }),
);

/** Chat da entrega — entregador responde o cliente. */
driverSelfRoutes.post(
  "/me/deliveries/:id/messages",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const { body } = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body);
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, tenantId: tenantOf(req) } });
    if (!delivery || delivery.driverId !== driver.id) throw new AppError(403, "Essa entrega não está atribuída a você");
    const message = await createDeliveryMessage({ tenantId: tenantOf(req), deliveryId: delivery.id, sender: "DRIVER", body });
    res.status(201).json(message);
  }),
);

/** Transições que o próprio entregador pode disparar durante a corrida. */
const SELF_ADVANCE_STATUSES = ["WAITING_PICKUP", "PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVING", "DELIVERED", "FAILED"] as const;
const ORDER_SYNC_STATUS: Partial<Record<DeliveryStatus, "OUT_FOR_DELIVERY" | "DELIVERED">> = {
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
};

driverSelfRoutes.patch(
  "/me/deliveries/:id/status",
  h(async (req, res) => {
    const driver = await myDriver(req);
    const { status, failedReason } = z
      .object({ status: z.enum(SELF_ADVANCE_STATUSES), failedReason: z.string().optional() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const delivery = await prisma.delivery.findFirst({ where: { id: req.params.id, tenantId } });
    if (!delivery || delivery.driverId !== driver.id) throw new AppError(403, "Essa entrega não está atribuída a você");

    const updated = await advanceDeliveryStatus({
      tenantId,
      deliveryId: delivery.id,
      toStatus: status,
      userId: req.auth!.userId,
      failedReason,
    });

    const orderSyncStatus = ORDER_SYNC_STATUS[status as DeliveryStatus];
    if (orderSyncStatus) {
      await updateOrderStatus({ tenantId, orderId: updated.orderId, toStatus: orderSyncStatus, userId: req.auth!.userId }).catch(
        (err) => console.warn(`Não foi possível sincronizar Order.status para ${updated.orderId}:`, err),
      );
    }
    res.json(updated);
  }),
);
