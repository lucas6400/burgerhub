import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";

export const DRIVER_STATUSES = [
  "OFFLINE",
  "AVAILABLE",
  "HEADING_TO_STORE",
  "WAITING_PICKUP",
  "DELIVERING",
  "RETURNING",
  "PAUSED",
] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const VEHICLE_TYPES = ["MOTORCYCLE", "BICYCLE", "CAR", "ON_FOOT"] as const;

/** Grava uma nova posição (nunca sobrescreve o histórico) e atualiza o snapshot atual do entregador. */
export async function recordDriverLocation(
  tenantId: string,
  driverId: string,
  point: { lat: number; lng: number; speed?: number; heading?: number; accuracy?: number },
) {
  const driver = await prisma.driver.findFirst({ where: { id: driverId, tenantId } });
  if (!driver) throw new AppError(404, "Entregador não encontrado");

  const now = new Date();
  await prisma.$transaction([
    prisma.driverLocation.create({
      data: {
        driverId,
        lat: point.lat,
        lng: point.lng,
        speed: point.speed,
        heading: point.heading,
        accuracy: point.accuracy,
        recordedAt: now,
      },
    }),
    prisma.driver.update({
      where: { id: driverId },
      data: { currentLat: point.lat, currentLng: point.lng, lastLocationAt: now },
    }),
  ]);
}

/** Quantos pedidos o entregador está carregando agora (não finalizados/cancelados/falhos). */
export async function activeDeliveryCount(driverId: string): Promise<number> {
  return prisma.delivery.count({
    where: {
      driverId,
      status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] },
    },
  });
}

export async function assertCapacityAvailable(driverId: string, additional = 1) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw new AppError(404, "Entregador não encontrado");
  if (!driver.active) throw new AppError(409, "Entregador inativo");
  const count = await activeDeliveryCount(driverId);
  if (count + additional > driver.maxSimultaneousOrders) {
    throw new AppError(409, `${driver.name} já está no limite de ${driver.maxSimultaneousOrders} pedidos simultâneos`);
  }
}

/**
 * Muda o status do entregador e abre/fecha turno (DriverShift) quando ele
 * entra ou sai de OFFLINE — é a única porta de entrada pra status que vem de
 * fora do fluxo de entrega (toggle do operador ou do próprio entregador no
 * app). Pausas (PAUSED) e transições internas de uma corrida não mexem no
 * turno, só entrar/sair de OFFLINE conta como bater ponto (Fase 5 — turnos).
 */
export async function setDriverStatus(tenantId: string, driverId: string, status: DriverStatus) {
  const driver = await prisma.driver.findFirst({ where: { id: driverId, tenantId } });
  if (!driver) throw new AppError(404, "Entregador não encontrado");

  await prisma.$transaction(async (tx) => {
    await tx.driver.update({ where: { id: driverId }, data: { status } });

    if (status !== "OFFLINE" && driver.status === "OFFLINE") {
      await tx.driverShift.create({ data: { driverId } });
    } else if (status === "OFFLINE" && driver.status !== "OFFLINE") {
      const openShift = await tx.driverShift.findFirst({
        where: { driverId, endedAt: null },
        orderBy: { startedAt: "desc" },
      });
      if (openShift) {
        await tx.driverShift.update({ where: { id: openShift.id }, data: { endedAt: new Date() } });
      }
    }
  });
}
