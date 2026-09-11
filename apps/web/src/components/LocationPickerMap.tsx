import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// O bundler do Vite não resolve os ícones padrão do Leaflet automaticamente;
// aponta explicitamente para os assets publicados pelo próprio pacote.
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

const defaultIcon = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface Props {
  lat: number;
  lng: number;
  onChange: (lat: number, lng: number) => void;
  className?: string;
}

/** Mapa clicável (OpenStreetMap, sem chave de API) para marcar uma localização com precisão. */
export function LocationPickerMap({ lat, lng, onChange, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current).setView([lat, lng], 16);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    const marker = L.marker([lat, lng], { draggable: true, icon: defaultIcon }).addTo(map);
    marker.on("dragend", () => {
      const pos = marker.getLatLng();
      onChangeRef.current(pos.lat, pos.lng);
    });
    map.on("click", (e: L.LeafletMouseEvent) => {
      marker.setLatLng(e.latlng);
      onChangeRef.current(e.latlng.lat, e.latlng.lng);
    });

    mapRef.current = map;
    markerRef.current = marker;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sincroniza o pino quando lat/lng mudam por fora (ex.: após geocodificar por texto)
  useEffect(() => {
    if (!markerRef.current || !mapRef.current) return;
    const current = markerRef.current.getLatLng();
    if (Math.abs(current.lat - lat) > 1e-9 || Math.abs(current.lng - lng) > 1e-9) {
      markerRef.current.setLatLng([lat, lng]);
      mapRef.current.setView([lat, lng]);
    }
  }, [lat, lng]);

  return <div ref={containerRef} className={className ?? "h-72 w-full rounded-xl"} />;
}
