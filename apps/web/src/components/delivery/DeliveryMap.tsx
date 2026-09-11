import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "leaflet.heat";
import type { DeliveryRow, DriverRow } from "../../pages/delivery/types";

/** Ícones simples via divIcon (emoji) — evita depender de mais assets/CDN. */
function emojiIcon(emoji: string, bg: string) {
  return L.divIcon({
    html: `<div style="background:${bg};width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 1px 4px rgba(0,0,0,.35);border:2px solid white">${emoji}</div>`,
    className: "",
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

const STORE_ICON = emojiIcon("🏪", "#1f2937");
const DRIVER_ICON = emojiIcon("🏍️", "#2563eb");
const ORDER_ICON = emojiIcon("📦", "#f59e0b");
const ORDER_DELAYED_ICON = emojiIcon("📦", "#dc2626");

interface HeatPoint {
  lat: number;
  lng: number;
}

interface Props {
  storeLat?: number | null;
  storeLng?: number | null;
  drivers: DriverRow[];
  deliveries: DeliveryRow[];
  onSelectDelivery?: (delivery: DeliveryRow) => void;
  onSelectDriver?: (driver: DriverRow) => void;
  heatPoints?: HeatPoint[];
  showHeatmap?: boolean;
}

/** Cor por entregador (ciclo fixo) — usada nas linhas de rota das paradas agrupadas. */
const ROUTE_COLORS = ["#2563eb", "#db2777", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];
function colorForDriver(driverId: string) {
  let hash = 0;
  for (let i = 0; i < driverId.length; i++) hash = (hash * 31 + driverId.charCodeAt(i)) >>> 0;
  return ROUTE_COLORS[hash % ROUTE_COLORS.length];
}

/** Mapa em tempo real da operação — loja, entregadores, pedidos aguardando/em rota e rotas multi-parada. */
export function DeliveryMap({
  storeLat,
  storeLng,
  drivers,
  deliveries,
  onSelectDelivery,
  onSelectDriver,
  heatPoints,
  showHeatmap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const routesLayerRef = useRef<L.LayerGroup | null>(null);
  const heatLayerRef = useRef<L.HeatLayer | null>(null);
  const callbacksRef = useRef({ onSelectDelivery, onSelectDriver });
  callbacksRef.current = { onSelectDelivery, onSelectDriver };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] =
      storeLat != null && storeLng != null ? [storeLat, storeLng] : [-15.793889, -47.882778];
    const map = L.map(containerRef.current).setView(center, 13);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    routesLayerRef.current = L.layerGroup().addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      routesLayerRef.current = null;
      heatLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redesenha só os marcadores e rotas a cada atualização — não recria o mapa
  // (evita piscar/perder zoom a cada polling, item 45 do pedido: performance).
  useEffect(() => {
    const layer = markersLayerRef.current;
    const routesLayer = routesLayerRef.current;
    if (!layer || !routesLayer) return;
    layer.clearLayers();
    routesLayer.clearLayers();

    if (storeLat != null && storeLng != null) {
      L.marker([storeLat, storeLng], { icon: STORE_ICON })
        .bindTooltip("Loja")
        .addTo(layer);
    }

    for (const d of drivers) {
      if (d.currentLat == null || d.currentLng == null) continue;
      const marker = L.marker([d.currentLat, d.currentLng], { icon: DRIVER_ICON })
        .bindTooltip(d.name)
        .addTo(layer);
      marker.on("click", () => callbacksRef.current.onSelectDriver?.(d));
    }

    for (const delivery of deliveries) {
      if (delivery.destinationLat == null || delivery.destinationLng == null) continue;
      const icon = delivery.risk === "critical" ? ORDER_DELAYED_ICON : ORDER_ICON;
      const marker = L.marker([delivery.destinationLat, delivery.destinationLng], { icon })
        .bindTooltip(`Pedido #${delivery.order.number}${delivery.stopSequence ? ` · ${delivery.stopSequence}ª parada` : ""}`)
        .addTo(layer);
      marker.on("click", () => callbacksRef.current.onSelectDelivery?.(delivery));
    }

    // Rotas multi-parada: liga loja → parada 1 → parada 2 ... por entregador (item de rota otimizada, Fase 2).
    const grouped = new Map<string, DeliveryRow[]>();
    for (const delivery of deliveries) {
      if (!delivery.driverId || delivery.stopSequence == null) continue;
      if (delivery.destinationLat == null || delivery.destinationLng == null) continue;
      const list = grouped.get(delivery.driverId) ?? [];
      list.push(delivery);
      grouped.set(delivery.driverId, list);
    }
    for (const [driverId, stops] of grouped) {
      if (stops.length < 2) continue;
      stops.sort((a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0));
      const points: [number, number][] = [];
      if (storeLat != null && storeLng != null) points.push([storeLat, storeLng]);
      for (const s of stops) points.push([s.destinationLat as number, s.destinationLng as number]);
      L.polyline(points, { color: colorForDriver(driverId), weight: 3, dashArray: "6 6", opacity: 0.8 }).addTo(routesLayer);
    }
  }, [storeLat, storeLng, drivers, deliveries]);

  // Camada de calor — histórico de pontos de entrega (item de heatmap, Fase 2). Independente do polling em tempo real.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (heatLayerRef.current) {
      map.removeLayer(heatLayerRef.current);
      heatLayerRef.current = null;
    }
    if (showHeatmap && heatPoints && heatPoints.length > 0) {
      const heat = L.heatLayer(
        heatPoints.map((p) => [p.lat, p.lng, 0.6]),
        { radius: 22, blur: 18, maxZoom: 16 },
      );
      heat.addTo(map);
      heatLayerRef.current = heat;
    }
  }, [showHeatmap, heatPoints]);

  return <div ref={containerRef} className="h-full min-h-[420px] w-full rounded-2xl" />;
}
