import { prisma } from "../../lib/prisma.js";
import { distanceBetween, etaMinutesFor } from "./route.service.js";
import { delayRisk } from "./eta.service.js";

/**
 * GroupingService — detecta oportunidades de um mesmo entregador levar 2
 * pedidos numa única rota, quando os destinos são compatíveis. Só sugere,
 * nunca agrupa sozinho — o operador confirma (item 12/13 do módulo de despacho).
 */
export interface GroupingConfig {
  maxRouteDetourKm: number;
  maxExtraDeliveryMinutes: number;
  maxOrdersPerDriver: number;
  maxPreparationDifferenceMinutes: number;
}

export const DEFAULT_GROUPING_CONFIG: GroupingConfig = {
  maxRouteDetourKm: 1.5,
  maxExtraDeliveryMinutes: 8,
  maxOrdersPerDriver: 3,
  maxPreparationDifferenceMinutes: 15,
};

export async function getGroupingConfig(tenantId: string): Promise<GroupingConfig> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.groupingRules) return DEFAULT_GROUPING_CONFIG;
  try {
    return { ...DEFAULT_GROUPING_CONFIG, ...JSON.parse(settings.groupingRules) };
  } catch {
    return DEFAULT_GROUPING_CONFIG;
  }
}

export interface GroupingOpportunity {
  deliveryIds: [string, string];
  orderNumbers: [number, number];
  separateDistanceKm: number;
  groupedDistanceKm: number;
  savingsKm: number;
  extraMinutes: number;
}

/** Só pares (não N-a-N) — cobre o caso real mais comum sem virar um problema de otimização combinatória. */
export async function findGroupingOpportunities(tenantId: string): Promise<GroupingOpportunity[]> {
  const config = await getGroupingConfig(tenantId);

  const candidates = await prisma.delivery.findMany({
    where: { tenantId, status: "AWAITING_DRIVER", destinationLat: { not: null }, destinationLng: { not: null } },
    include: { order: { select: { number: true, readyAt: true, createdAt: true } } },
  });

  const opportunities: GroupingOpportunity[] = [];

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (a.estimatedDeliveryAt && delayRisk(a.estimatedDeliveryAt, a.promisedDeliveryAt) === "critical") continue;
      if (b.estimatedDeliveryAt && delayRisk(b.estimatedDeliveryAt, b.promisedDeliveryAt) === "critical") continue;

      const readyA = a.order.readyAt ?? a.order.createdAt;
      const readyB = b.order.readyAt ?? b.order.createdAt;
      const prepDiffMinutes = Math.abs(readyA.getTime() - readyB.getTime()) / 60_000;
      if (prepDiffMinutes > config.maxPreparationDifferenceMinutes) continue;

      const pickup = { lat: a.pickupLat, lng: a.pickupLng };
      const destA = { lat: a.destinationLat!, lng: a.destinationLng! };
      const destB = { lat: b.destinationLat!, lng: b.destinationLng! };

      const distToA = distanceBetween(pickup, destA);
      const distToB = distanceBetween(pickup, destB);
      const separateDistanceKm = Math.round((distToA + distToB) * 10) / 10;

      const viaA = distToA + distanceBetween(destA, destB);
      const viaB = distToB + distanceBetween(destB, destA);
      const groupedDistanceKm = Math.round(Math.min(viaA, viaB) * 10) / 10;

      const savingsKm = Math.round((separateDistanceKm - groupedDistanceKm) * 10) / 10;
      if (savingsKm <= 0) continue;

      const detourKm = groupedDistanceKm - Math.max(distToA, distToB);
      if (detourKm > config.maxRouteDetourKm) continue;

      const extraMinutes = etaMinutesFor(groupedDistanceKm, "MOTORCYCLE") - etaMinutesFor(Math.min(distToA, distToB), "MOTORCYCLE");
      if (extraMinutes > config.maxExtraDeliveryMinutes) continue;

      opportunities.push({
        deliveryIds: [a.id, b.id],
        orderNumbers: [a.order.number, b.order.number],
        separateDistanceKm,
        groupedDistanceKm,
        savingsKm,
        extraMinutes: Math.max(0, Math.round(extraMinutes)),
      });
    }
  }

  return opportunities.sort((x, y) => y.savingsKm - x.savingsKm).slice(0, 5);
}
