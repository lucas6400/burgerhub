/**
 * Gera src/data/palmas-quadras.ts: pontos agrupados por quadra de Palmas, a partir do OpenStreetMap. O geocodificador
 * gratuito erra a quadra/bairro do pino (devolve "103 Norte" pra um ponto da 305 Norte), mas os NOMES das ruas
 * ("Quadra 305 Norte Rua 29") são confiáveis — então a quadra de um pino é a da rua nomeada mais próxima.
 * Amostra os pontos AO LONGO de cada rua (uns a cada ~30 m), não só o centro: ruas longas ficariam longe do pino.
 * Roda uma vez (ou quando o mapa mudar): node scripts/build-quadras.mjs
 */
import { writeFileSync } from "node:fs";

const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const NAME = `["name"~"Quadra [0-9]+ (Norte|Sul)",i]`;
// Duas consultas leves (a união das duas numa só estourava o servidor público): ruas com a geometria inteira, e o resto
// (praças, endereços com a quadra) só com o ponto central.
const HEAD = `[out:json][timeout:120];\narea["name"="Palmas"]["boundary"="administrative"]->.a;\n`;
const QUERY_WAYS = `${HEAD}way(area.a)${NAME};\nout geom tags;`;
const QUERY_EXTRAS = `${HEAD}(nwr(area.a)${NAME};nwr(area.a)["addr:suburb"~"[0-9]+ (Norte|Sul)",i];nwr(area.a)["addr:street"~"Quadra [0-9]+ (Norte|Sul)",i];);\nout tags center;`;
const MIN_SPACING_M = 30;

async function fetchOverpass(query, { required }) {
  for (let round = 0; round < (required ? 3 : 1); round++) {
    for (const url of MIRRORS) {
      try {
        const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "BurgerHub/1.0 (contato@burgerhub.app)" }, signal: AbortSignal.timeout(150_000) });
        const text = await res.text();
        if (text.trim().startsWith("{")) return JSON.parse(text);
        console.error(url, "respondeu algo que não é JSON:", text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160));
      } catch (err) {
        console.error(url, "falhou:", String(err).slice(0, 100));
      }
    }
    if (required) await new Promise((r) => setTimeout(r, 5000));
  }
  if (required) throw new Error("Nenhum espelho do Overpass respondeu");
  return { elements: [] };
}

const rad = (x) => (x * Math.PI) / 180;
const meters = (a, b) => 2 * 6371000 * Math.asin(Math.sqrt(Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2));

const data = { elements: [...(await fetchOverpass(QUERY_WAYS, { required: true })).elements, ...(await fetchOverpass(QUERY_EXTRAS, { required: false })).elements] };
const byQuadra = new Map();
const add = (key, point) => {
  const list = byQuadra.get(key) ?? [];
  if (!list.some((p) => meters(p, point) < MIN_SPACING_M)) list.push(point);
  byQuadra.set(key, list);
};
for (const el of data.elements ?? []) {
  const label = [el.tags?.name, el.tags?.["addr:street"], el.tags?.["addr:suburb"]].find((v) => v && /\d{2,4}\s+(Norte|Sul)/i.test(v)) ?? "";
  const m = /(\d{2,4})\s+(Norte|Sul)/i.exec(label);
  if (!m) continue;
  const key = `${m[1]} ${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()}`;
  const round = (n) => Math.round(n * 10000) / 10000;
  if (el.geometry?.length) for (const g of el.geometry) add(key, [round(g.lat), round(g.lon)]);
  else {
    const c = el.center ?? (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (c) add(key, [round(c.lat), round(c.lon)]);
  }
}
const obj = Object.fromEntries([...byQuadra.entries()].sort(([a], [b]) => a.localeCompare(b, "pt", { numeric: true })));
const total = Object.values(obj).reduce((s, l) => s + l.length, 0);
const ts = `// GERADO por scripts/build-quadras.mjs (OpenStreetMap) — não editar à mão.\n// ${Object.keys(obj).length} quadras, ${total} pontos.\nexport const PALMAS_QUADRAS: Record<string, [number, number][]> = ${JSON.stringify(obj)};\n`;
writeFileSync(new URL("../src/data/palmas-quadras.ts", import.meta.url), ts);
console.log(`ok: ${Object.keys(obj).length} quadras, ${total} pontos, ${(ts.length / 1024).toFixed(0)} KB`);
