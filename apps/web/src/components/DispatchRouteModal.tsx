import { useEffect, useMemo, useState } from "react";
import { Copy, Map as MapIcon, Send } from "lucide-react";
import { api } from "../lib/api";
import { brl, waLink } from "../lib/format";
import { buildDispatchMessage, collectLine, placeLabel, type DispatchStop } from "../lib/dispatch";
import { googleMapsRouteUrl, planRoute, type RoutePoint } from "../lib/route";
import type { Order } from "../types";
import { Button, Input, Modal, Select } from "./ui";

const COURIER_PHONE_KEY = "burgerhub.courierPhone";

interface DriverOption {
  id: string;
  name: string;
  phone: string;
  active: boolean;
}

interface StoreOrigin {
  point: RoutePoint | null;
}

const readSavedPhone = (): string => {
  try {
    return localStorage.getItem(COURIER_PHONE_KEY) ?? "";
  } catch {
    return "";
  }
};

/**
 * Monta a saída do entregador: ordena as entregas selecionadas pelo caminho mais curto a partir da loja e gera a mensagem
 * pronta (rota completa + endereço com quadra + quanto cobrar + Waze de cada parada) pra mandar no WhatsApp dele.
 */
export function DispatchRouteModal({
  open,
  onClose,
  orders,
  storeName,
  onMarkedOut,
}: {
  open: boolean;
  onClose: () => void;
  orders: Order[];
  storeName: string;
  /** Pedidos atualizados depois de "saiu para entrega" (cada um avisa o cliente no WhatsApp). */
  onMarkedOut: (updated: Order[]) => void;
}) {
  const [origin, setOrigin] = useState<StoreOrigin | null>(null);
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [driverId, setDriverId] = useState("");
  const [customPhone, setCustomPhone] = useState(readSavedPhone);
  const [copied, setCopied] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setCopied(false);
    api
      .get<{ settings: { storeLat?: number | null; storeLng?: number | null } | null }>("/settings")
      .then((d) => setOrigin({ point: d.settings?.storeLat != null && d.settings.storeLng != null ? { lat: d.settings.storeLat, lng: d.settings.storeLng } : null }))
      .catch(() => setOrigin({ point: null }));
    api.get<DriverOption[]>("/drivers").then((list) => setDrivers(list.filter((d) => d.active && d.phone))).catch(() => setDrivers([]));
  }, [open]);

  const plan = useMemo(() => {
    const withPoint = orders
      .filter((o) => o.deliveryLat != null && o.deliveryLng != null)
      .map<DispatchStop & { point: RoutePoint }>((o) => ({ order: o, point: { lat: o.deliveryLat!, lng: o.deliveryLng! } }));
    const withoutPoint = orders.filter((o) => o.deliveryLat == null || o.deliveryLng == null).map<DispatchStop>((o) => ({ order: o, point: null }));
    // Sem a localização da loja cadastrada, a primeira entrega da lista vira o ponto de partida só pra ordenar.
    const start = origin?.point ?? withPoint[0]?.point ?? null;
    const ordered = start ? planRoute(start, withPoint) : withPoint;
    const stops: DispatchStop[] = [...ordered, ...withoutPoint];
    const routeUrl = start ? googleMapsRouteUrl(start, ordered.map((s) => s.point)) : null;
    return { stops, routeUrl, hasStoreOrigin: !!origin?.point };
  }, [orders, origin]);

  const message = useMemo(() => buildDispatchMessage(storeName, plan.stops, plan.routeUrl), [storeName, plan]);
  const selectedDriver = drivers.find((d) => d.id === driverId);
  const phone = selectedDriver?.phone ?? customPhone;
  const phoneOk = phone.replace(/\D/g, "").length >= 10;
  const readyOrders = orders.filter((o) => o.status === "READY");

  function sendWhatsApp() {
    if (!phoneOk) return;
    if (!selectedDriver) {
      try {
        localStorage.setItem(COURIER_PHONE_KEY, customPhone);
      } catch {
        /* sem armazenamento: só não lembra o número */
      }
    }
    window.open(waLink(phone, message), "_blank", "noopener,noreferrer");
  }

  async function copyMessage() {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Não consegui copiar — selecione o texto e copie manualmente.");
    }
  }

  async function markOut() {
    setMarking(true);
    setError("");
    try {
      const updated = await Promise.all(readyOrders.map((o) => api.patch<Order>(`/orders/${o.id}/status`, { status: "OUT_FOR_DELIVERY" })));
      onMarkedOut(updated);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui marcar como saiu para entrega");
    } finally {
      setMarking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Rota do entregador — ${orders.length} ${orders.length === 1 ? "entrega" : "entregas"}`} wide>
      <div className="space-y-4">
        {!plan.hasStoreOrigin && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            A localização da loja não está cadastrada (Configurações → Entrega): a ordem das paradas parte da primeira entrega.
          </p>
        )}

        <ol className="space-y-2">
          {plan.stops.map(({ order, point }, i) => (
            <li key={order.id} className="rounded-xl bg-surface-50 p-3 text-sm dark:bg-surface-850">
              <p className="font-semibold">
                {i + 1}. Pedido #{order.number} — {order.customer?.name ?? "Cliente"}
              </p>
              <p className="text-surface-500">{placeLabel(order) || (point ? "Só o pino do mapa" : "⚠️ Sem endereço nem pino")}</p>
              <p className="text-xs">{collectLine(order)}</p>
            </li>
          ))}
        </ol>

        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
            <option value="">Outro número…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          {!selectedDriver && <Input placeholder="WhatsApp do entregador" value={customPhone} onChange={(e) => setCustomPhone(e.target.value)} inputMode="tel" />}
        </div>

        <textarea readOnly value={message} rows={9} className="w-full rounded-xl border border-surface-200 bg-white p-3 font-mono text-xs dark:border-surface-700 dark:bg-surface-900" />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button onClick={sendWhatsApp} disabled={!phoneOk} className="sm:flex-1">
            <Send size={16} /> Enviar no WhatsApp
          </Button>
          <Button variant="secondary" onClick={copyMessage} className="sm:flex-1">
            <Copy size={16} /> {copied ? "Copiado!" : "Copiar mensagem"}
          </Button>
          {plan.routeUrl && (
            <Button variant="secondary" className="sm:flex-1" onClick={() => window.open(plan.routeUrl!, "_blank", "noopener,noreferrer")}>
              <MapIcon size={16} /> Abrir rota no mapa
            </Button>
          )}
        </div>

        {readyOrders.length > 0 && (
          <Button variant="secondary" onClick={markOut} disabled={marking} className="w-full">
            🛵 Marcar {readyOrders.length === 1 ? "o pedido pronto" : `os ${readyOrders.length} pedidos prontos`} como "saiu para entrega" (avisa o cliente) · {brl(readyOrders.reduce((s, o) => s + o.totalCents, 0))}
          </Button>
        )}
      </div>
    </Modal>
  );
}
