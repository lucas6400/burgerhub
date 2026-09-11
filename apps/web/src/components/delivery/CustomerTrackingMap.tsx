import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

function emojiIcon(emoji: string, bg: string) {
  return L.divIcon({
    html: `<div style="background:${bg};width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 1px 4px rgba(0,0,0,.35);border:2px solid white">${emoji}</div>`,
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

const DRIVER_ICON = emojiIcon("🏍️", "#2563eb");
const HOME_ICON = emojiIcon("📍", "#f59e0b");

interface Props {
  driverLat?: number | null;
  driverLng?: number | null;
  destinationLat?: number | null;
  destinationLng?: number | null;
}

/** Mapa simples pro cliente acompanhar a própria entrega — só a moto do entregador e o próprio destino, nada de outros pedidos. */
export function CustomerTrackingMap({ driverLat, driverLng, destinationLat, destinationLng }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center: [number, number] =
      driverLat != null && driverLng != null
        ? [driverLat, driverLng]
        : destinationLat != null && destinationLng != null
          ? [destinationLat, destinationLng]
          : [-15.793889, -47.882778];
    const map = L.map(containerRef.current).setView(center, 15);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    const points: [number, number][] = [];
    if (destinationLat != null && destinationLng != null) {
      L.marker([destinationLat, destinationLng], { icon: HOME_ICON }).bindTooltip("Você").addTo(layer);
      points.push([destinationLat, destinationLng]);
    }
    if (driverLat != null && driverLng != null) {
      L.marker([driverLat, driverLng], { icon: DRIVER_ICON }).bindTooltip("Entregador").addTo(layer);
      points.push([driverLat, driverLng]);
    }
    if (points.length === 2) {
      map.fitBounds(points, { padding: [40, 40] });
    } else if (points.length === 1) {
      map.setView(points[0], 15);
    }
  }, [driverLat, driverLng, destinationLat, destinationLng]);

  return <div ref={containerRef} className="h-64 w-full rounded-2xl" />;
}
