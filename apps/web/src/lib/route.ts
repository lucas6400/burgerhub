export interface RoutePoint {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_KM = 6371;
const MAX_GOOGLE_WAYPOINTS = 9;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceKm(a: RoutePoint, b: RoutePoint): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/** Tamanho do caminho aberto: origem → paradas na ordem dada. */
function pathLength(origin: RoutePoint, points: RoutePoint[]): number {
  let total = 0;
  let prev = origin;
  for (const p of points) {
    total += distanceKm(prev, p);
    prev = p;
  }
  return total;
}

/**
 * Ordem das entregas pra uma saída só: parte da loja, vai sempre pra mais próxima e depois tenta trocar trechos
 * (2-opt) enquanto encurtar o caminho. Pra poucas paradas (o entregador leva 3–4 por vez) fica praticamente ótimo.
 * Linha reta, não rua — suficiente pra decidir a ordem; o app de mapa do entregador traça o caminho de verdade.
 */
export function planRoute<T extends { point: RoutePoint }>(origin: RoutePoint, stops: T[]): T[] {
  const remaining = [...stops];
  const ordered: T[] = [];
  let current = origin;
  while (remaining.length > 0) {
    let bestIndex = 0;
    for (let i = 1; i < remaining.length; i++) {
      if (distanceKm(current, remaining[i].point) < distanceKm(current, remaining[bestIndex].point)) bestIndex = i;
    }
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    current = next.point;
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < ordered.length - 1; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const candidate = [...ordered.slice(0, i), ...ordered.slice(i, j + 1).reverse(), ...ordered.slice(j + 1)];
        if (pathLength(origin, candidate.map((s) => s.point)) + 1e-9 < pathLength(origin, ordered.map((s) => s.point))) {
          ordered.splice(0, ordered.length, ...candidate);
          improved = true;
        }
      }
    }
  }
  return ordered;
}

/** Rota completa no Google Maps (origem na loja, todas as paradas na ordem). O Google aceita até 9 paradas intermediárias. */
export function googleMapsRouteUrl(origin: RoutePoint, ordered: RoutePoint[]): string | null {
  if (ordered.length === 0) return null;
  const stops = ordered.slice(0, MAX_GOOGLE_WAYPOINTS + 1);
  const destination = stops[stops.length - 1];
  const waypoints = stops.slice(0, -1).map((p) => `${p.lat},${p.lng}`).join("|");
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: "driving",
  });
  if (waypoints) params.set("waypoints", waypoints);
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export const wazeUrl = (p: RoutePoint): string => `https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes`;
