import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { distanceBetween, etaMinutesFor } from "./route.service.js";
import { delayRisk } from "./eta.service.js";
import { activeDeliveryCount } from "./driver.service.js";

/**
 * DispatchService — calcula o dispatch_score de cada entregador candidato pra
 * um pedido. Quanto MENOR o score, melhor a sugestão. Nenhum peso "mágico"
 * solto no código: tudo vem de DEFAULT_DISPATCH_CONFIG ou de
 * TenantSettings.dispatchWeights (JSON), preparado pra virar configurável
 * pela área administrativa sem mudar essa lógica.
 */
export interface DispatchConfig {
  distanceToStoreWeight: number;
  availabilityWeight: number;
  activeOrdersWeight: number;
  routeCompatibilityWeight: number;
  delayWeight: number;
}

export const DEFAULT_DISPATCH_CONFIG: DispatchConfig = {
  distanceToStoreWeight: 1,
  availabilityWeight: 1.5,
  activeOrdersWeight: 2,
  routeCompatibilityWeight: 2,
  delayWeight: 3,
};

/** Penalidade por status — entregador ocupado custa mais que um livre, mas nunca é excluído aqui (isso é feito no filtro de candidatos). */
const STATUS_AVAILABILITY_PENALTY: Record<string, number> = {
  AVAILABLE: 0,
  HEADING_TO_STORE: 2,
  WAITING_PICKUP: 3,
  DELIVERING: 5,
  RETURNING: 4,
  PAUSED: 8,
  OFFLINE: 999, // não deveria chegar aqui (filtrado antes), mas nunca deixa vencer por engano
};

export async function getDispatchConfig(tenantId: string): Promise<DispatchConfig> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.dispatchWeights) return DEFAULT_DISPATCH_CONFIG;
  try {
    return { ...DEFAULT_DISPATCH_CONFIG, ...JSON.parse(settings.dispatchWeights) };
  } catch {
    return DEFAULT_DISPATCH_CONFIG;
  }
}

export interface DriverCandidate {
  id: string;
  name: string;
  status: string;
  currentLat: number | null;
  currentLng: number | null;
  currentOrdersCount: number;
  maxSimultaneousOrders: number;
  vehicleType: string;
  activeDestinations: { lat: number; lng: number }[];
}

export interface DeliveryForScoring {
  pickupLat: number;
  pickupLng: number;
  destinationLat: number | null;
  destinationLng: number | null;
  estimatedDeliveryAt: Date | null;
  promisedDeliveryAt: Date | null;
}

export interface DispatchScoreBreakdown {
  driverId: string;
  driverName: string;
  score: number;
  distanceToStoreKm: number;
  etaToStoreMinutes: number;
  currentOrdersCount: number;
  estimatedDeliveryMinutes: number;
}

/**
 * Calcula o score de um único entregador pra um pedido. Sem posição
 * conhecida, assume uma distância padrão conservadora (não exclui o
 * entregador, só penaliza — mostra que a estimativa é incerta).
 */
export function computeDispatchScore(
  driver: DriverCandidate,
  delivery: DeliveryForScoring,
  config: DispatchConfig,
): DispatchScoreBreakdown {
  const UNKNOWN_POSITION_KM = 5;
  const distanceToStoreKm =
    driver.currentLat != null && driver.currentLng != null
      ? distanceBetween({ lat: driver.currentLat, lng: driver.currentLng }, { lat: delivery.pickupLat, lng: delivery.pickupLng })
      : UNKNOWN_POSITION_KM;
  const etaToStoreMinutes = etaMinutesFor(distanceToStoreKm, driver.vehicleType);

  const availabilityPenalty = STATUS_AVAILABILITY_PENALTY[driver.status] ?? 5;
  const loadRatio = driver.maxSimultaneousOrders > 0 ? driver.currentOrdersCount / driver.maxSimultaneousOrders : 1;

  // Compatibilidade de rota: se o entregador já tem entregas ativas, prefere
  // quem já está indo mais ou menos na mesma direção do novo destino.
  let routeCompatibilityPenalty = 0;
  if (driver.activeDestinations.length > 0 && delivery.destinationLat != null && delivery.destinationLng != null) {
    const dest = { lat: delivery.destinationLat, lng: delivery.destinationLng };
    routeCompatibilityPenalty = Math.min(...driver.activeDestinations.map((d) => distanceBetween(d, dest)));
  }

  // Urgência: se o pedido já está em risco de atraso, distância importa mais
  // (penaliza entregadores longe proporcionalmente à urgência).
  const risk = delivery.estimatedDeliveryAt ? delayRisk(delivery.estimatedDeliveryAt, delivery.promisedDeliveryAt) : "normal";
  const urgencyMultiplier = risk === "critical" ? 2 : risk === "attention" ? 1 : 0;

  const score =
    config.distanceToStoreWeight * distanceToStoreKm +
    config.availabilityWeight * availabilityPenalty +
    config.activeOrdersWeight * loadRatio +
    config.routeCompatibilityWeight * routeCompatibilityPenalty +
    config.delayWeight * urgencyMultiplier * distanceToStoreKm;

  const destinationDistance =
    delivery.destinationLat != null && delivery.destinationLng != null
      ? distanceBetween({ lat: delivery.pickupLat, lng: delivery.pickupLng }, { lat: delivery.destinationLat, lng: delivery.destinationLng })
      : 0;
  const estimatedDeliveryMinutes = etaToStoreMinutes + etaMinutesFor(destinationDistance, driver.vehicleType);

  return {
    driverId: driver.id,
    driverName: driver.name,
    score: Math.round(score * 10) / 10,
    distanceToStoreKm,
    etaToStoreMinutes,
    currentOrdersCount: driver.currentOrdersCount,
    estimatedDeliveryMinutes,
  };
}

/** Ranking dos entregadores pra um pedido pronto — menor score primeiro. */
export async function suggestDrivers(tenantId: string, deliveryId: string, limit = 3) {
  const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, tenantId } });
  if (!delivery) throw new AppError(404, "Entrega não encontrada");

  const drivers = await prisma.driver.findMany({
    where: { tenantId, active: true, status: { notIn: ["OFFLINE", "PAUSED"] } },
    include: { deliveries: { where: { status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } } } },
  });

  const config = await getDispatchConfig(tenantId);
  const candidates: DriverCandidate[] = [];
  for (const d of drivers) {
    const count = await activeDeliveryCount(d.id);
    if (count >= d.maxSimultaneousOrders) continue; // sem capacidade — nem entra no ranking
    candidates.push({
      id: d.id,
      name: d.name,
      status: d.status,
      currentLat: d.currentLat,
      currentLng: d.currentLng,
      currentOrdersCount: count,
      maxSimultaneousOrders: d.maxSimultaneousOrders,
      vehicleType: d.vehicleType,
      activeDestinations: d.deliveries
        .filter((del) => del.destinationLat != null && del.destinationLng != null)
        .map((del) => ({ lat: del.destinationLat!, lng: del.destinationLng! })),
    });
  }

  const ranked = candidates
    .map((c) => computeDispatchScore(c, delivery, config))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);

  return ranked;
}
