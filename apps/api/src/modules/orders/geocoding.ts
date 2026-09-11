/**
 * Geocodificação de endereços (Nominatim/OpenStreetMap — gratuito, sem chave).
 * Usado para calcular a taxa de entrega automaticamente pela distância até
 * o estabelecimento, sem o cliente precisar escolher uma região manualmente.
 *
 * Nominatim pede no máximo 1 requisição/segundo e um User-Agent identificável.
 * Para grande volume em produção, troque por um provedor pago (Google/Mapbox)
 * mantendo a mesma assinatura de `geocodeAddress`.
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const FOUND_TTL_MS = 15 * 60_000;
// Resultados "não encontrado" expiram rápido: uma falha transitória de rede
// não pode ficar presa como se o endereço não existisse por 15 minutos.
const NOT_FOUND_TTL_MS = 20_000;
const MIN_INTERVAL_MS = 1100;

const cache = new Map<string, { point: GeoPoint | null; expiresAt: number }>();
let lastRequestAt = 0;

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export async function geocodeAddress(query: string): Promise<GeoPoint | null> {
  const key = query.trim().toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.point;

  await throttle();

  try {
    const url = `${NOMINATIM_SEARCH_URL}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "BurgerHub/1.0 (contato@burgerhub.app)" },
    });
    if (!res.ok) {
      console.error(`Geocodificação respondeu ${res.status} para "${query}"`);
      cache.set(key, { point: null, expiresAt: Date.now() + NOT_FOUND_TTL_MS });
      return null;
    }
    const results = (await res.json()) as { lat: string; lon: string }[];
    const first = results[0];
    const point = first ? { lat: parseFloat(first.lat), lng: parseFloat(first.lon) } : null;
    cache.set(key, { point, expiresAt: Date.now() + (point ? FOUND_TTL_MS : NOT_FOUND_TTL_MS) });
    return point;
  } catch (err) {
    console.error(`Falha de rede ao geocodificar "${query}":`, err);
    // Não guarda em cache: uma falha de rede pode ser resolvida na próxima tentativa
    return null;
  }
}

export interface ReverseGeocodeResult {
  street: string;
  number: string;
  neighborhood: string;
  city: string;
}

/**
 * Endereço legível a partir de coordenadas — usado quando o cliente marca a
 * localização no mapa (ou usa o GPS): preenche os campos de endereço para o
 * entregador, sem exigir que o cliente digite nada.
 */
export async function reverseGeocode(point: GeoPoint): Promise<ReverseGeocodeResult | null> {
  await throttle();
  try {
    const url = `${NOMINATIM_REVERSE_URL}?format=json&lat=${point.lat}&lon=${point.lng}&addressdetails=1&zoom=18`;
    const res = await fetch(url, {
      headers: { "User-Agent": "BurgerHub/1.0 (contato@burgerhub.app)" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      address?: Record<string, string>;
    };
    const a = body.address ?? {};
    return {
      street: a.road ?? a.pedestrian ?? a.residential ?? "",
      number: a.house_number ?? "",
      neighborhood: a.suburb ?? a.neighbourhood ?? a.city_district ?? "",
      city: a.city ?? a.town ?? a.municipality ?? a.village ?? "",
    };
  } catch (err) {
    console.error("Falha de rede ao geocodificar reverso:", err);
    return null;
  }
}

/** Distância em km entre dois pontos (fórmula de Haversine). */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
