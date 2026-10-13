import { PALMAS_QUADRAS } from "../../data/palmas-quadras.js";

/**
 * Quadra de um pino em Palmas. O geocodificador gratuito costuma devolver a rua sem a quadra ("Alameda 11") e um
 * "bairro" errado ("103 Norte" pra um ponto da 305 Norte), então a quadra vem de duas fontes confiáveis:
 *  1. o nome da própria rua, quando traz a quadra ("Quadra 305 Norte Rua 29") — exata;
 *  2. a rua nomeada mais próxima do pino (tabela gerada do OpenStreetMap, ver scripts/build-quadras.mjs) — aproximada.
 */
const MAX_DISTANCE_M = 150;
const EARTH_RADIUS_M = 6_371_000;

const rad = (deg: number) => (deg * Math.PI) / 180;

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const QUADRA_RE = /Quadra\s+(\d{2,4})\s+(Norte|Sul)/i;

/** "Quadra 305 Norte" se o texto (nome de rua) já traz a quadra; senão null. */
export function quadraFromText(text: string): string | null {
  const m = QUADRA_RE.exec(text);
  return m ? `Quadra ${m[1]} ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}` : null;
}

const SAMPLES = Object.entries(PALMAS_QUADRAS).flatMap(([label, points]) => points.map(([lat, lng]) => ({ label, lat, lng })));

/** Quadra da rua nomeada mais próxima do ponto (até 150 m); null se não há nenhuma — nunca chuta longe. */
export function nearestQuadra(point: { lat: number; lng: number }): { label: string; distanceM: number } | null {
  let best: { label: string; distanceM: number } | null = null;
  for (const s of SAMPLES) {
    // Filtro barato antes do haversine: 150 m ≈ 0,0014° de latitude.
    if (Math.abs(s.lat - point.lat) > 0.002 || Math.abs(s.lng - point.lng) > 0.002) continue;
    const distanceM = metersBetween(point, s);
    if (distanceM <= MAX_DISTANCE_M && (!best || distanceM < best.distanceM)) best = { label: s.label, distanceM };
  }
  return best ? { label: `Quadra ${best.label}`, distanceM: best.distanceM } : null;
}

/**
 * Texto da quadra pra escrever no endereço do pedido. Vazio quando o nome da rua já traz a quadra (aparece sozinha)
 * ou quando não há dado confiável; "(aprox.)" quando veio da rua mais próxima.
 */
export function quadraLabelForPin(street: string, point: { lat: number; lng: number }): string {
  if (quadraFromText(street)) return "";
  const near = nearestQuadra(point);
  return near ? `${near.label} (aprox.)` : "";
}
