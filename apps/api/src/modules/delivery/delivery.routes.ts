import { Router } from "express";
import { z } from "zod";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { audit } from "../../utils/audit.js";
import { updateOrderStatus } from "../orders/orders.service.js";
import {
  DELIVERY_STATUSES,
  advanceDeliveryStatus,
  assignDriver,
  assignGroupedDeliveries,
  getDeliveryAnalytics,
  getDeliveryHeatmapPoints,
  getDispatchBoard,
  type DeliveryStatus,
} from "./delivery.service.js";
import { suggestDrivers } from "./dispatch.service.js";
import { findGroupingOpportunities } from "./grouping.service.js";

export const deliveriesRoutes = Router();
deliveriesRoutes.use(requireAuth);
deliveriesRoutes.use(requireRole("DISPATCHER"));

deliveriesRoutes.get(
  "/board",
  h(async (req, res) => {
    const board = await getDispatchBoard(tenantOf(req));
    res.json(board);
  }),
);

/** Ranking dos melhores entregadores pra um pedido — item 10/11 do módulo de despacho. */
deliveriesRoutes.get(
  "/:id/suggestions",
  h(async (req, res) => {
    const suggestions = await suggestDrivers(tenantOf(req), req.params.id);
    res.json(suggestions);
  }),
);

/** Oportunidades de agrupar 2+ pedidos aguardando despacho num mesmo entregador. */
deliveriesRoutes.get(
  "/grouping-opportunities",
  h(async (req, res) => {
    const opportunities = await findGroupingOpportunities(tenantOf(req));
    res.json(opportunities);
  }),
);

deliveriesRoutes.patch(
  "/:id/assign",
  h(async (req, res) => {
    const { driverId } = z.object({ driverId: z.string() }).parse(req.body);
    const delivery = await assignDriver({
      tenantId: tenantOf(req),
      deliveryId: req.params.id,
      driverId,
      userId: req.auth!.userId,
    });
    await audit({
      tenantId: tenantOf(req),
      userId: req.auth!.userId,
      action: "DISPATCH",
      entity: "Delivery",
      entityId: delivery.id,
      detail: { driverId, orderNumber: delivery.order.number },
    });
    res.json(delivery);
  }),
);

/**
 * Confirma uma oportunidade de agrupamento: atribui os pedidos ao mesmo
 * entregador numa única rota, na ordem que minimiza a distância total
 * (vizinho mais próximo a partir da loja) — item de rota multi-parada da Fase 2.
 */
deliveriesRoutes.post(
  "/group-assign",
  h(async (req, res) => {
    const { deliveryIds, driverId } = z
      .object({ deliveryIds: z.array(z.string()).min(2).max(4), driverId: z.string() })
      .parse(req.body);
    const tenantId = tenantOf(req);
    const assigned = await assignGroupedDeliveries({ tenantId, deliveryIds, driverId, userId: req.auth!.userId });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "GROUP_DISPATCH",
      entity: "Delivery",
      detail: { deliveryIds, driverId, order: assigned.map((d) => d.order.number) },
    });
    res.json(assigned);
  }),
);

/** Pontos históricos de entrega pra visualizar zonas de maior demanda no mapa. */
deliveriesRoutes.get(
  "/heatmap",
  h(async (req, res) => {
    const points = await getDeliveryHeatmapPoints(tenantOf(req));
    res.json(points);
  }),
);

/** Métricas de tempo, pontualidade, custo e turnos — dashboard de desempenho (Fase 5). */
deliveriesRoutes.get(
  "/analytics",
  h(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const analytics = await getDeliveryAnalytics(tenantOf(req), days);
    res.json(analytics);
  }),
);

/**
 * Avança o status da entrega e mantém o Order.status do pedido em sincronia
 * — reaproveita updateOrderStatus (única fonte de verdade da máquina de
 * estados do pedido) em vez de duplicar a lógica aqui.
 */
const ORDER_SYNC_STATUS: Partial<Record<DeliveryStatus, "OUT_FOR_DELIVERY" | "DELIVERED">> = {
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
};

deliveriesRoutes.patch(
  "/:id/status",
  h(async (req, res) => {
    const { status, failedReason } = z
      .object({ status: z.enum(DELIVERY_STATUSES), failedReason: z.string().optional() })
      .parse(req.body);
    const tenantId = tenantOf(req);

    const delivery = await advanceDeliveryStatus({
      tenantId,
      deliveryId: req.params.id,
      toStatus: status,
      userId: req.auth!.userId,
      failedReason,
    });

    const orderSyncStatus = ORDER_SYNC_STATUS[status];
    if (orderSyncStatus) {
      await updateOrderStatus({
        tenantId,
        orderId: delivery.orderId,
        toStatus: orderSyncStatus,
        userId: req.auth!.userId,
      }).catch((err) => {
        // O pedido pode já estar nesse status (ex.: marcado manualmente antes) —
        // não derruba o avanço da entrega, que já foi confirmado.
        console.warn(`Não foi possível sincronizar Order.status para ${delivery.orderId}:`, err);
      });
    }

    res.json(delivery);
  }),
);
