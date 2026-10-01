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

export interface GeocodeResult {
  point: GeoPoint;
  /**
   * false quando o Nominatim não achou rua/número pro endereço e devolveu só
   * o centro de um bairro/distrito (comum em cidades com endereçamento por
   * quadra, ex.: Palmas, Brasília) — o ponto pode estar a centenas de metros
   * do endereço real, mesmo a busca "tendo dado certo".
   */
  precise: boolean;
}

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
const FOUND_TTL_MS = 15 * 60_000;
// Resultados "não encontrado" expiram rápido: uma falha transitória de rede
// não pode ficar presa como se o endereço não existisse por 15 minutos.
const NOT_FOUND_TTL_MS = 20_000;
const MIN_INTERVAL_MS = 1100;

const cache = new Map<string, { result: GeocodeResult | null; expiresAt: number }>();
let lastRequestAt = 0;

async function throttle() {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/**
 * Ponto usado pra enviesar a busca (ex.: a loja) — quando informado, resultados
 * próximos a ele são preferidos. Essencial pra bairros com nomes comuns em
 * várias cidades do Brasil (ex.: "Bela Vista" existe em dezenas de cidades):
 * sem viés, o Nominatim pode casar com um lugar a centenas de km de distância.
 */
export async function geocodeAddress(query: string, bias?: GeoPoint): Promise<GeocodeResult | null> {
  const key = `${query.trim().toLowerCase()}|${bias ? `${bias.lat.toFixed(2)},${bias.lng.toFixed(2)}` : ""}`;
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  await throttle();

  try {
    // addressdetails=1 devolve a estrutura (rua, bairro, cidade...) do que
    // realmente foi encontrado — sem isso não dá pra saber se o resultado é
    // no nível da rua ou só o centro do bairro/distrito.
    // viewbox+bounded=0: prefere resultados perto do "bias" sem excluir o
    // resto do país (bounded=1 excluiria de vez, ruim se o cliente realmente
    // estiver fora da área — melhor deixar quoteDelivery recusar pela distância).
    const viewboxParam = bias
      ? `&viewbox=${bias.lng - 1},${bias.lat + 1},${bias.lng + 1},${bias.lat - 1}&bounded=0`
      : "";
    const url = `${NOMINATIM_SEARCH_URL}?format=json&limit=1&addressdetails=1&countrycodes=br${viewboxParam}&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "BurgerHub/1.0 (contato@burgerhub.app)" },
    });
    if (!res.ok) {
      console.error(`Geocodificação respondeu ${res.status} para "${query}"`);
      cache.set(key, { result: null, expiresAt: Date.now() + NOT_FOUND_TTL_MS });
      return null;
    }
    const results = (await res.json()) as { lat: string; lon: string; address?: Record<string, string> }[];
    const first = results[0];
    const result: GeocodeResult | null = first
      ? {
          point: { lat: parseFloat(first.lat), lng: parseFloat(first.lon) },
          precise: Boolean(first.address?.road || first.address?.house_number),
        }
      : null;
    cache.set(key, { result, expiresAt: Date.now() + (result ? FOUND_TTL_MS : NOT_FOUND_TTL_MS) });
    return result;
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

/**
 * Testa se um ponto está dentro de um polígono (algoritmo de ray casting).
 * Usado pelas zonas de entrega desenhadas no mapa — mais preciso do que raio
 * em linha reta pra áreas com contorno irregular (rio, avenida, etc).
 */
export function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.lat > point.lat !== pj.lat > point.lat &&
      point.lng < ((pj.lng - pi.lng) * (point.lat - pi.lat)) / (pj.lat - pi.lat) + pi.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}
