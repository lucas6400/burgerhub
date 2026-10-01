import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface ZonePoint {
  lat: number;
  lng: number;
}

export interface OtherZone {
  id: string;
  name: string;
  feeCents: number;
  polygon: ZonePoint[];
}

export const ZONE_COLORS = ["#ef4444", "#3b82f6", "#10b981", "#a855f7", "#f97316", "#14b8a6", "#eab308", "#ec4899"];

const vertexIcon = L.divIcon({
  html: `<div style="width:14px;height:14px;border-radius:50%;background:#f59e0b;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
  className: "",
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

interface Props {
  storeLat: number;
  storeLng: number;
  points: ZonePoint[];
  onChange?: (points: ZonePoint[]) => void;
  /** Outras zonas desenhadas por cima do mapa (semitransparentes) — a sobreposição fica visível. */
  otherZones?: OtherZone[];
  /** Só visualização: sem desenhar; clicar no mapa mostra em qual(is) zona(s) o ponto cai. */
  readOnly?: boolean;
  className?: string;
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function pointInPolygon(p: ZonePoint, poly: ZonePoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) inside = !inside;
  }
  return inside;
}

function centroid(poly: ZonePoint[]): [number, number] {
  return [poly.reduce((s, p) => s + p.lat, 0) / poly.length, poly.reduce((s, p) => s + p.lng, 0) / poly.length];
}

/**
 * Mapa pra desenhar o contorno de uma zona de entrega: clique no mapa adiciona
 * um vértice, arrastar um vértice reposiciona, clique com o botão direito num
 * vértice remove ele. As demais zonas aparecem sobrepostas em cores diferentes
 * (dá pra ver onde uma acaba e a outra começa, e onde ficou buraco). Sem plugin
 * externo — Leaflet puro, mesmo padrão do resto do app.
 */
export function ZonePolygonMap({ storeLat, storeLng, points, onChange, otherZones, readOnly, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const shapeRef = useRef<L.Polygon | L.Polyline | null>(null);
  const vertexMarkersRef = useRef<L.Marker[]>([]);
  const othersLayerRef = useRef<L.LayerGroup | null>(null);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const othersRef = useRef(otherZones ?? []);
  othersRef.current = otherZones ?? [];
  const readOnlyRef = useRef(!!readOnly);
  readOnlyRef.current = !!readOnly;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current).setView([storeLat, storeLng], 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    L.circleMarker([storeLat, storeLng], {
      radius: 8,
      color: "#1f2937",
      fillColor: "#1f2937",
      fillOpacity: 1,
    })
      .addTo(map)
      .bindTooltip("Loja");
    othersLayerRef.current = L.layerGroup().addTo(map);
    if (pointsRef.current.length >= 3) {
      map.fitBounds(L.latLngBounds(pointsRef.current.map((p) => [p.lat, p.lng] as [number, number])), { padding: [30, 30] });
    }

    map.on("click", (e: L.LeafletMouseEvent) => {
      const p = { lat: e.latlng.lat, lng: e.latlng.lng };
      if (readOnlyRef.current) {
        const hits = othersRef.current.filter((z) => pointInPolygon(p, z.polygon));
        const text = hits.length
          ? `Cai em: ${hits.map((z) => `<b>${z.name}</b> (${brl(z.feeCents)})`).join(" + ")}${hits.length > 1 ? "<br/>Sobreposto: vale a zona de menor área." : ""}`
          : "<b>Nenhuma zona</b> — esse ponto cai fora da área (ou nas faixas por km).";
        L.popup().setLatLng(e.latlng).setContent(text).openOn(map);
        return;
      }
      onChangeRef.current?.([...pointsRef.current, p]);
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outras zonas: contorno colorido + nome no centro
  useEffect(() => {
    const map = mapRef.current;
    const layer = othersLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    const zones = otherZones ?? [];
    zones.forEach((z, i) => {
      const color = ZONE_COLORS[i % ZONE_COLORS.length];
      L.polygon(
        z.polygon.map((p) => [p.lat, p.lng] as [number, number]),
        { color, weight: 2, fillColor: color, fillOpacity: 0.22, interactive: false },
      ).addTo(layer);
      L.marker(centroid(z.polygon), {
        interactive: false,
        icon: L.divIcon({
          html: `<div style="transform:translate(-50%,-50%);white-space:nowrap;font:600 11px sans-serif;color:${color};text-shadow:0 0 3px #fff,0 0 3px #fff">${z.name} · ${brl(z.feeCents)}</div>`,
          className: "",
        }),
      }).addTo(layer);
    });
    if (readOnly && zones.length > 0) {
      const bounds = L.latLngBounds(zones.flatMap((z) => z.polygon.map((p) => [p.lat, p.lng] as [number, number])));
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  }, [otherZones, readOnly]);

  // Redesenha o contorno + os marcadores de vértice sempre que os pontos mudam
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    vertexMarkersRef.current.forEach((m) => m.remove());
    vertexMarkersRef.current = readOnly
      ? []
      : points.map((p, i) => {
          const marker = L.marker([p.lat, p.lng], { draggable: true, icon: vertexIcon }).addTo(map);
          // Só confirma no "soltar" (dragend) — atualizar o estado a cada pixel
          // arrastado recriaria os marcadores no meio do gesto e interromperia o drag.
          marker.on("dragend", () => {
            const pos = marker.getLatLng();
            const next = [...pointsRef.current];
            next[i] = { lat: pos.lat, lng: pos.lng };
            onChangeRef.current?.(next);
          });
          marker.on("contextmenu", (e: L.LeafletMouseEvent) => {
            L.DomEvent.preventDefault(e.originalEvent);
            onChangeRef.current?.(pointsRef.current.filter((_, idx) => idx !== i));
          });
          return marker;
        });

    shapeRef.current?.remove();
    shapeRef.current = null;
    if (points.length >= 3) {
      shapeRef.current = L.polygon(
        points.map((p) => [p.lat, p.lng]),
        { color: "#111827", weight: 3, dashArray: "6 4", fillColor: "#f59e0b", fillOpacity: 0.3 },
      ).addTo(map);
    } else if (points.length === 2) {
      shapeRef.current = L.polyline(
        points.map((p) => [p.lat, p.lng]),
        { color: "#111827", weight: 3 },
      ).addTo(map);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, readOnly]);

  return <div ref={containerRef} className={className ?? "h-80 w-full rounded-xl"} />;
}
