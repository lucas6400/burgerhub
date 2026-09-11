import type { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { distanceBetween, etaMinutesFor, orderStopsByNearestNeighbor } from "./route.service.js";
import { estimateDeliveryTime, delayRisk, type DelayRisk } from "./eta.service.js";
import { assertCapacityAvailable } from "./driver.service.js";

export const DELIVERY_STATUSES = [
  "AWAITING_DRIVER",
  "DRIVER_ASSIGNED",
  "HEADING_TO_STORE",
  "WAITING_PICKUP",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
  "DELIVERED",
  "FAILED",
  "CANCELED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const VALID_DELIVERY_TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  AWAITING_DRIVER: ["DRIVER_ASSIGNED", "CANCELED"],
  DRIVER_ASSIGNED: ["HEADING_TO_STORE", "AWAITING_DRIVER", "CANCELED"], // volta pra fila se reatribuído
  HEADING_TO_STORE: ["WAITING_PICKUP", "AWAITING_DRIVER", "CANCELED"],
  WAITING_PICKUP: ["PICKED_UP", "AWAITING_DRIVER", "CANCELED"],
  PICKED_UP: ["OUT_FOR_DELIVERY", "CANCELED"],
  // CANCELED sempre alcançável, mesmo já em rota — espelha Order (que permite
  // cancelar até de OUT_FOR_DELIVERY) e fecha o chat/tracking de pedidos cancelados.
  OUT_FOR_DELIVERY: ["ARRIVING", "DELIVERED", "FAILED", "CANCELED"],
  ARRIVING: ["DELIVERED", "FAILED", "CANCELED"],
  DELIVERED: [],
  FAILED: ["AWAITING_DRIVER"], // pode ser redespachado
  CANCELED: [],
};

/** Nomes amigáveis em português — único lugar que traduz o status pra tela. */
export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  AWAITING_DRIVER: "Aguardando entregador",
  DRIVER_ASSIGNED: "Entregador atribuído",
  HEADING_TO_STORE: "Indo para loja",
  WAITING_PICKUP: "Aguardando retirada",
  PICKED_UP: "Retirado",
  OUT_FOR_DELIVERY: "Saiu para entrega",
  ARRIVING: "Chegando",
  DELIVERED: "Entregue",
  FAILED: "Entrega falhou",
  CANCELED: "Cancelada",
};

/**
 * Cria o registro de entrega quando o pedido fica pronto (chamado de dentro
 * da MESMA transação de updateOrderStatus — orders.service.ts). Se a loja não
 * tiver localização configurada ou o pedido não tiver coordenadas resolvidas,
 * não bloqueia o pedido: só não entra na Central de Despacho.
 */
export async function createDeliveryForOrder(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    orderId: string;
    deliveryLat: number | null;
    deliveryLng: number | null;
    prepMinutesRemaining: number;
    promisedDeliveryAt?: Date | null;
  },
) {
  const settings = await tx.tenantSettings.findUnique({ where: { tenantId: params.tenantId } });
  if (settings?.storeLat == null || settings?.storeLng == null) {
    console.warn(`Tenant ${params.tenantId}: sem localização da loja — pedido não entra na Central de Despacho`);
    return null;
  }
  if (params.deliveryLat == null || params.deliveryLng == null) {
    console.warn(`Pedido ${params.orderId}: sem coordenadas de entrega — não entra na Central de Despacho`);
    return null;
  }

  const pickup = { lat: settings.storeLat, lng: settings.storeLng };
  const destination = { lat: params.deliveryLat, lng: params.deliveryLng };
  const distance = distanceBetween(pickup, destination);
  const travelMinutes = etaMinutesFor(distance, "MOTORCYCLE");
  const { estimatedMinutes, estimatedAt } = estimateDeliveryTime({
    prepMinutesRemaining: params.prepMinutesRemaining,
    driverToStoreMinutes: 0, // sem entregador atribuído ainda
    travelMinutes,
  });

  const delivery = await tx.delivery.create({
    data: {
      tenantId: params.tenantId,
      orderId: params.orderId,
      status: "AWAITING_DRIVER",
      pickupLat: pickup.lat,
      pickupLng: pickup.lng,
      destinationLat: destination.lat,
      destinationLng: destination.lng,
      estimatedDistanceKm: distance,
      estimatedDurationMin: estimatedMinutes,
      estimatedDeliveryAt: estimatedAt,
      promisedDeliveryAt: params.promisedDeliveryAt ?? null,
      events: { create: { type: "CREATED", toStatus: "AWAITING_DRIVER" } },
    },
  });
  return delivery;
}

export async function assignDriver(params: {
  tenantId: string;
  deliveryId: string;
  driverId: string;
  userId?: string;
}) {
  const delivery = await prisma.delivery.findFirst({
    where: { id: params.deliveryId, tenantId: params.tenantId },
  });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");
  if (!["AWAITING_DRIVER", "FAILED"].includes(delivery.status)) {
    throw new AppError(409, `Não é possível despachar uma entrega com status "${delivery.status}"`);
  }

  await assertCapacityAvailable(params.driverId);

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.delivery.update({
      where: { id: delivery.id },
      data: {
        driverId: params.driverId,
        status: "DRIVER_ASSIGNED",
        assignedAt: now,
        events: {
          create: {
            type: "DRIVER_ASSIGNED",
            fromStatus: delivery.status,
            toStatus: "DRIVER_ASSIGNED",
            byUserId: params.userId,
          },
        },
      },
      include: { driver: true, order: true },
    });
    return result;
  }, { timeout: 15_000 });
  return updated;
}

/**
 * Atribui 2+ entregas ao mesmo entregador numa única rota, na ordem que
 * minimiza a distância total (vizinho mais próximo a partir da loja) —
 * fecha o item de rota multi-parada da Fase 2. Cada entrega recebe um
 * `stopSequence` (1, 2, 3...) que o app do entregador e o mapa usam pra
 * mostrar a sequência de paradas.
 */
export async function assignGroupedDeliveries(params: {
  tenantId: string;
  deliveryIds: string[];
  driverId: string;
  userId?: string;
}) {
  const deliveries = await prisma.delivery.findMany({
    where: { id: { in: params.deliveryIds }, tenantId: params.tenantId },
  });
  if (deliveries.length !== params.deliveryIds.length) {
    throw new AppError(404, "Uma ou mais entregas não foram encontradas");
  }
  for (const d of deliveries) {
    if (!["AWAITING_DRIVER", "FAILED"].includes(d.status)) {
      throw new AppError(409, `Uma das entregas não está mais aguardando despacho (status "${d.status}")`);
    }
    if (d.destinationLat == null || d.destinationLng == null) {
      throw new AppError(409, "Entrega sem coordenadas de destino não pode entrar numa rota agrupada");
    }
  }

  await assertCapacityAvailable(params.driverId, deliveries.length);

  const origin = { lat: deliveries[0].pickupLat, lng: deliveries[0].pickupLng };
  const ordered = orderStopsByNearestNeighbor(
    origin,
    deliveries.map((d) => ({ point: { lat: d.destinationLat!, lng: d.destinationLng! }, delivery: d })),
  );

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const results = [];
    for (let i = 0; i < ordered.length; i++) {
      const { delivery } = ordered[i];
      const result = await tx.delivery.update({
        where: { id: delivery.id },
        data: {
          driverId: params.driverId,
          status: "DRIVER_ASSIGNED",
          assignedAt: now,
          stopSequence: i + 1,
          events: {
            create: {
              type: "DRIVER_ASSIGNED",
              fromStatus: delivery.status,
              toStatus: "DRIVER_ASSIGNED",
              byUserId: params.userId,
              detail: JSON.stringify({ grouped: true, stopSequence: i + 1, totalStops: ordered.length }),
            },
          },
        },
        include: { driver: true, order: true },
      });
      results.push(result);
    }
    return results;
  }, { timeout: 15_000 });

  return updated;
}

/** Entregador recusa uma entrega recém-atribuída — volta pra fila de despacho, sem entregador. */
export async function rejectDelivery(params: { tenantId: string; deliveryId: string; driverId: string; userId?: string }) {
  const delivery = await prisma.delivery.findFirst({ where: { id: params.deliveryId, tenantId: params.tenantId } });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");
  if (delivery.driverId !== params.driverId) throw new AppError(403, "Essa entrega não está atribuída a você");
  if (delivery.status !== "DRIVER_ASSIGNED") {
    throw new AppError(409, "Só é possível recusar antes de sair pra loja");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.delivery.update({
      where: { id: delivery.id },
      data: {
        driverId: null,
        status: "AWAITING_DRIVER",
        assignedAt: null,
        stopSequence: null,
        events: {
          create: { type: "DRIVER_REJECTED", fromStatus: "DRIVER_ASSIGNED", toStatus: "AWAITING_DRIVER", byUserId: params.userId },
        },
      },
    });
    const stillActive = await tx.delivery.count({
      where: { driverId: params.driverId, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
    });
    await tx.driver.update({
      where: { id: params.driverId },
      data: { status: stillActive > 0 ? "DELIVERING" : "AVAILABLE" },
    });
    return result;
  }, { timeout: 15_000 });
  return updated;
}

export interface PayoutConfig {
  perDeliveryCents: number;
  perKmCents: number;
}

/** R$5 fixo + R$1/km — referência de mercado pra motoboy avulso, ajustável por tenant. */
export const DEFAULT_PAYOUT_CONFIG: PayoutConfig = { perDeliveryCents: 500, perKmCents: 100 };

export async function getPayoutConfig(tenantId: string): Promise<PayoutConfig> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.driverPayoutRules) return DEFAULT_PAYOUT_CONFIG;
  try {
    return { ...DEFAULT_PAYOUT_CONFIG, ...JSON.parse(settings.driverPayoutRules) };
  } catch {
    return DEFAULT_PAYOUT_CONFIG;
  }
}

export async function advanceDeliveryStatus(params: {
  tenantId: string;
  deliveryId: string;
  toStatus: DeliveryStatus;
  userId?: string;
  failedReason?: string;
}) {
  const delivery = await prisma.delivery.findFirst({
    where: { id: params.deliveryId, tenantId: params.tenantId },
    include: { order: true },
  });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");

  if (!VALID_DELIVERY_TRANSITIONS[delivery.status as DeliveryStatus]?.includes(params.toStatus)) {
    throw new AppError(409, `Transição inválida: ${delivery.status} → ${params.toStatus}`);
  }

  // Compensação do entregador (Fase 5 — custo/turnos): calculada só na entrega
  // efetiva, fora da transação principal (não depende dela pra nada mais).
  let costCents: number | undefined;
  if (params.toStatus === "DELIVERED" && delivery.driverId) {
    const payout = await getPayoutConfig(params.tenantId);
    const distanceKmValue = delivery.actualDistanceKm ?? delivery.estimatedDistanceKm ?? 0;
    costCents = Math.round(payout.perDeliveryCents + payout.perKmCents * distanceKmValue);
  }

  const now = new Date();
  const timestamps: Partial<Record<DeliveryStatus, object>> = {
    HEADING_TO_STORE: { headingToStoreAt: now },
    PICKED_UP: { pickedUpAt: now },
    OUT_FOR_DELIVERY: { startedAt: now },
    DELIVERED: { deliveredAt: now, ...(costCents != null ? { costCents } : {}) },
    FAILED: { failedReason: params.failedReason },
  };

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.delivery.update({
      where: { id: delivery.id },
      data: {
        status: params.toStatus,
        ...(timestamps[params.toStatus] ?? {}),
        events: {
          create: {
            type: "STATUS_CHANGED",
            fromStatus: delivery.status,
            toStatus: params.toStatus,
            byUserId: params.userId,
          },
        },
      },
      include: { driver: true, order: true },
    });

    if (delivery.driverId && ["DELIVERED", "FAILED", "CANCELED"].includes(params.toStatus)) {
      const stillActive = await tx.delivery.count({
        where: { driverId: delivery.driverId, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
      });
      await tx.driver.update({
        where: { id: delivery.driverId },
        data: { status: stillActive > 0 ? "DELIVERING" : "AVAILABLE" },
      });
    } else if (delivery.driverId && params.toStatus === "HEADING_TO_STORE") {
      await tx.driver.update({ where: { id: delivery.driverId }, data: { status: "HEADING_TO_STORE" } });
    } else if (delivery.driverId && params.toStatus === "WAITING_PICKUP") {
      await tx.driver.update({ where: { id: delivery.driverId }, data: { status: "WAITING_PICKUP" } });
    } else if (delivery.driverId && ["PICKED_UP", "OUT_FOR_DELIVERY", "ARRIVING"].includes(params.toStatus)) {
      await tx.driver.update({ where: { id: delivery.driverId }, data: { status: "DELIVERING" } });
    }

    return result;
  }, { timeout: 15_000 });
  return updated;
}

export interface BoardCounts {
  activeOrders: number;
  preparing: number;
  awaitingDispatch: number;
  onRoute: number;
  delayed: number;
  driversActive: number;
  driversAvailable: number;
}

/** Consulta central da tela de despacho — pedidos, entregadores e contadores do topo. */
export async function getDispatchBoard(tenantId: string) {
  const [awaitingDispatch, onRoute, drivers] = await Promise.all([
    prisma.delivery.findMany({
      where: { tenantId, status: "AWAITING_DRIVER" },
      include: { order: { include: { customer: true, items: true } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.delivery.findMany({
      where: { tenantId, status: { notIn: ["AWAITING_DRIVER", "DELIVERED", "FAILED", "CANCELED"] } },
      include: { order: { include: { customer: true, items: true } }, driver: true },
      orderBy: [{ driverId: "asc" }, { stopSequence: "asc" }, { createdAt: "asc" }],
    }),
    prisma.driver.findMany({
      where: { tenantId, active: true },
      include: { _count: { select: { deliveries: { where: { status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } } } } } },
    }),
  ]);

  const now = new Date();
  const deliveriesWithRisk = (list: typeof awaitingDispatch | typeof onRoute) =>
    list.map((d) => ({
      ...d,
      risk: d.estimatedDeliveryAt
        ? delayRisk(d.estimatedDeliveryAt, d.promisedDeliveryAt, now)
        : ("normal" as DelayRisk),
    }));

  const awaiting = deliveriesWithRisk(awaitingDispatch);
  const route = deliveriesWithRisk(onRoute);
  const delayedCount = [...awaiting, ...route].filter((d) => d.risk === "critical").length;

  const [preparingCount, activeOrdersCount] = await Promise.all([
    prisma.order.count({ where: { tenantId, status: { in: ["NEW", "PREPARING", "FINISHING"] } } }),
    prisma.order.count({ where: { tenantId, status: { notIn: ["DELIVERED", "SETTLED", "CANCELED"] } } }),
  ]);

  const counts: BoardCounts = {
    activeOrders: activeOrdersCount,
    preparing: preparingCount,
    awaitingDispatch: awaiting.length,
    onRoute: route.length,
    delayed: delayedCount,
    driversActive: drivers.filter((d) => d.status !== "OFFLINE").length,
    driversAvailable: drivers.filter((d) => d.status === "AVAILABLE").length,
  };

  return {
    counts,
    awaitingDispatch: awaiting,
    onRoute: route,
    drivers: drivers.map((d) => ({ ...d, currentOrdersCount: d._count.deliveries, _count: undefined })),
  };
}

/** Métricas de operação — tempo médio, pontualidade, desempenho por entregador e turnos (Fase 5 — analytics). */
export async function getDeliveryAnalytics(tenantId: string, days = 30) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const delivered = await prisma.delivery.findMany({
    where: { tenantId, status: "DELIVERED", deliveredAt: { gte: since } },
    include: { driver: true },
    orderBy: { deliveredAt: "asc" },
  });

  const minutesFor = (d: (typeof delivered)[number]) =>
    d.deliveredAt ? (d.deliveredAt.getTime() - d.createdAt.getTime()) / 60_000 : null;

  const withPromise = delivered.filter((d) => d.promisedDeliveryAt != null);
  const onTimeCount = withPromise.filter((d) => d.deliveredAt! <= d.promisedDeliveryAt!).length;

  const totalCostCents = delivered.reduce((sum, d) => sum + (d.costCents ?? 0), 0);
  const allMinutes = delivered.map(minutesFor).filter((m): m is number => m != null);
  const avgMinutes = (list: number[]) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);

  const summary = {
    totalDeliveries: delivered.length,
    avgDeliveryMinutes: avgMinutes(allMinutes),
    onTimeRate: withPromise.length ? Math.round((onTimeCount / withPromise.length) * 1000) / 10 : null,
    totalCostCents,
    avgCostCents: delivered.length ? Math.round(totalCostCents / delivered.length) : null,
  };

  const byDriverMap = new Map<
    string,
    { driverId: string; driverName: string; deliveries: number; minutes: number[]; totalCostCents: number; totalDistanceKm: number }
  >();
  for (const d of delivered) {
    if (!d.driverId || !d.driver) continue;
    const entry = byDriverMap.get(d.driverId) ?? {
      driverId: d.driverId,
      driverName: d.driver.name,
      deliveries: 0,
      minutes: [],
      totalCostCents: 0,
      totalDistanceKm: 0,
    };
    entry.deliveries += 1;
    const m = minutesFor(d);
    if (m != null) entry.minutes.push(m);
    entry.totalCostCents += d.costCents ?? 0;
    entry.totalDistanceKm += d.actualDistanceKm ?? d.estimatedDistanceKm ?? 0;
    byDriverMap.set(d.driverId, entry);
  }

  const driverIds = [...byDriverMap.keys()];
  const shifts = driverIds.length
    ? await prisma.driverShift.findMany({ where: { driverId: { in: driverIds }, startedAt: { gte: since } } })
    : [];
  const hoursByDriver = new Map<string, number>();
  const now = Date.now();
  for (const s of shifts) {
    const hours = ((s.endedAt ?? new Date(now)).getTime() - s.startedAt.getTime()) / 3_600_000;
    hoursByDriver.set(s.driverId, (hoursByDriver.get(s.driverId) ?? 0) + hours);
  }

  const byDriver = [...byDriverMap.values()]
    .map((d) => ({
      driverId: d.driverId,
      driverName: d.driverName,
      deliveries: d.deliveries,
      avgMinutes: avgMinutes(d.minutes),
      totalCostCents: d.totalCostCents,
      totalDistanceKm: Math.round(d.totalDistanceKm * 10) / 10,
      hoursOnline: Math.round((hoursByDriver.get(d.driverId) ?? 0) * 10) / 10,
    }))
    .sort((a, b) => b.deliveries - a.deliveries);

  const byDayMap = new Map<string, { deliveries: number; delayedCount: number }>();
  for (const d of delivered) {
    const date = d.deliveredAt!.toISOString().slice(0, 10);
    const entry = byDayMap.get(date) ?? { deliveries: 0, delayedCount: 0 };
    entry.deliveries += 1;
    if (d.promisedDeliveryAt && d.deliveredAt! > d.promisedDeliveryAt) entry.delayedCount += 1;
    byDayMap.set(date, entry);
  }
  const byDay = [...byDayMap.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { summary, byDriver, byDay };
}

const HEATMAP_WINDOW_DAYS = 90;
const HEATMAP_MAX_POINTS = 3000;

/** Pontos de entrega dos últimos meses pra visualizar zonas de maior demanda no mapa (Fase 2 — heatmap). */
export async function getDeliveryHeatmapPoints(tenantId: string) {
  const since = new Date(Date.now() - HEATMAP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const orders = await prisma.order.findMany({
    where: {
      tenantId,
      type: "DELIVERY",
      deliveryLat: { not: null },
      deliveryLng: { not: null },
      createdAt: { gte: since },
    },
    select: { deliveryLat: true, deliveryLng: true },
    take: HEATMAP_MAX_POINTS,
    orderBy: { createdAt: "desc" },
  });
  return orders.map((o) => ({ lat: o.deliveryLat as number, lng: o.deliveryLng as number }));
}

const OPEN_DELIVERY_STATUSES = ["DELIVERED", "FAILED", "CANCELED"];

/**
 * Acompanhamento do pedido pro cliente no cardápio digital (item "tipo iFood"):
 * status, localização atual do entregador, ETA e quantas outras entregas ele
 * tem na mesma rota — sem nunca expor endereço/dados de outros pedidos.
 */
export async function getDeliveryTracking(tenantId: string, orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, tenantId } });
  if (!order) throw new AppError(404, "Pedido não encontrado");

  const delivery = await prisma.delivery.findUnique({ where: { orderId }, include: { driver: true } });
  if (!delivery) {
    return {
      orderStatus: order.status,
      deliveryId: null,
      deliveryStatus: null,
      deliveryStatusLabel: null,
      driverName: null,
      driverLat: null,
      driverLng: null,
      destinationLat: null,
      destinationLng: null,
      estimatedDeliveryAt: null,
      otherOrdersInRoute: 0,
      canChat: false,
    };
  }

  const otherOrdersInRoute = delivery.driverId
    ? await prisma.delivery.count({
        where: {
          driverId: delivery.driverId,
          id: { not: delivery.id },
          status: { notIn: OPEN_DELIVERY_STATUSES },
        },
      })
    : 0;

  return {
    orderStatus: order.status,
    deliveryId: delivery.id,
    deliveryStatus: delivery.status,
    deliveryStatusLabel: DELIVERY_STATUS_LABELS[delivery.status as DeliveryStatus] ?? delivery.status,
    driverName: delivery.driver?.name ?? null,
    driverLat: delivery.driver?.currentLat ?? null,
    driverLng: delivery.driver?.currentLng ?? null,
    destinationLat: delivery.destinationLat,
    destinationLng: delivery.destinationLng,
    estimatedDeliveryAt: delivery.estimatedDeliveryAt,
    otherOrdersInRoute,
    canChat: !!delivery.driverId && !OPEN_DELIVERY_STATUSES.includes(delivery.status),
  };
}

export async function findDeliveryByOrder(tenantId: string, orderId: string) {
  return prisma.delivery.findFirst({ where: { orderId, tenantId } });
}

/** Sempre exige tenantId, mesmo sendo chamada só a partir de rotas já escopadas hoje — evita vazamento cross-tenant se um novo call-site esquecer de validar o tenant antes. */
export async function listDeliveryMessages(tenantId: string, deliveryId: string) {
  const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, tenantId } });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");
  return prisma.deliveryMessage.findMany({ where: { deliveryId }, orderBy: { createdAt: "asc" } });
}

/** Chat entrega — cliente e entregador, só enquanto a entrega estiver em andamento. */
export async function createDeliveryMessage(params: {
  tenantId: string;
  deliveryId: string;
  sender: "CUSTOMER" | "DRIVER";
  body: string;
}) {
  const delivery = await prisma.delivery.findFirst({ where: { id: params.deliveryId, tenantId: params.tenantId } });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");
  if (OPEN_DELIVERY_STATUSES.includes(delivery.status)) {
    throw new AppError(409, "Essa entrega já foi encerrada — não é mais possível enviar mensagens.");
  }
  return prisma.deliveryMessage.create({
    data: { deliveryId: params.deliveryId, sender: params.sender, body: params.body },
  });
}
