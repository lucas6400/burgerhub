import { distanceKm, type GeoPoint } from "../orders/geocoding.js";

/**
 * RouteService — cálculo de distância, ETA e (futuramente) rotas otimizadas
 * com múltiplas paradas. Mantido separado da UI: nenhum componente de tela
 * deve calcular distância/ETA por conta própria.
 */

/** Velocidade média por tipo de veículo em trânsito urbano (km/h) — usada só
 *  como estimativa quando não há um provedor de rotas real (Fase 3+). */
const AVERAGE_SPEED_KMH: Record<string, number> = {
  MOTORCYCLE: 28,
  BICYCLE: 15,
  CAR: 22,
  ON_FOOT: 5,
};

/** Minutos fixos por parada (parar, estacionar, subir/descer) somados ao deslocamento. */
const STOP_OVERHEAD_MINUTES = 3;

export function distanceBetween(a: GeoPoint, b: GeoPoint): number {
  return Math.round(distanceKm(a, b) * 10) / 10;
}

/** Tempo estimado de deslocamento (minutos) para uma distância e veículo dados. */
export function etaMinutesFor(distanceKmValue: number, vehicleType: string): number {
  const speed = AVERAGE_SPEED_KMH[vehicleType] ?? AVERAGE_SPEED_KMH.MOTORCYCLE;
  const travelMinutes = (distanceKmValue / speed) * 60;
  return Math.round(travelMinutes + STOP_OVERHEAD_MINUTES);
}

/**
 * Ordena um conjunto de paradas pela heurística do vizinho mais próximo a
 * partir da origem — suficiente pra poucas paradas (agrupamento, Fase 3).
 * Não é uma otimização exata (TSP), é uma aproximação rápida e determinística.
 */
export function orderStopsByNearestNeighbor<T extends { point: GeoPoint }>(
  origin: GeoPoint,
  stops: T[],
): T[] {
  const remaining = [...stops];
  const ordered: T[] = [];
  let current = origin;
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = distanceKm(current, remaining[i].point);
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = i;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = next.point;
  }
  return ordered;
}
