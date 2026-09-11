import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut, MapPin, MessageCircle, Navigation, Phone, Send } from "lucide-react";
import { api } from "../../lib/api";
import { brl } from "../../lib/format";
import { Button, Card } from "../../components/ui";
import { useAuth } from "../../stores/auth";
import { DRIVER_STATUS_LABELS, type DeliveryRow, type DriverRow, type DriverStatus } from "./types";

const POLL_MS = 10_000;
/** Intervalo de localização (item 8 do módulo de entregas): mais frequente enquanto ocupado. */
const LOCATION_TICK_MS = 5_000;
const LOCATION_INTERVAL_IDLE_MS = 45_000;
const LOCATION_INTERVAL_BUSY_MS = 15_000;

const NEXT_ACTION: Partial<Record<DeliveryRow["status"], { label: string; next: string }>> = {
  HEADING_TO_STORE: { label: "Cheguei na loja", next: "WAITING_PICKUP" },
  WAITING_PICKUP: { label: "Retirei o pedido", next: "PICKED_UP" },
  PICKED_UP: { label: "Saí para entrega", next: "OUT_FOR_DELIVERY" },
  OUT_FOR_DELIVERY: { label: "Cheguei no cliente", next: "ARRIVING" },
  ARRIVING: { label: "Entreguei o pedido", next: "DELIVERED" },
};

function wazeUrl(lat: number, lng: number) {
  return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
function googleMapsUrl(lat: number, lng: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

interface ChatMessage {
  id: string;
  sender: "CUSTOMER" | "DRIVER";
  body: string;
}

/** Chat da entrega — cliente acompanha pelo link do pedido, entregador responde por aqui. */
function DeliveryChat({ deliveryId }: { deliveryId: string }) {
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    function load() {
      api
        .get<ChatMessage[]>(`/driver/me/deliveries/${deliveryId}/messages`)
        .then((list) => !stop && setMessages(list))
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, 5000);
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [deliveryId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      const message = await api.post<ChatMessage>(`/driver/me/deliveries/${deliveryId}/messages`, { body });
      setMessages((prev) => [...(prev ?? []), message]);
    } catch {
      setText(body);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-surface-200 dark:border-surface-700">
      <div className="max-h-48 space-y-2 overflow-y-auto p-2.5">
        {!messages || messages.length === 0 ? (
          <p className="py-3 text-center text-xs text-surface-400">Nenhuma mensagem ainda.</p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex ${m.sender === "DRIVER" ? "justify-end" : "justify-start"}`}>
              <p
                className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                  m.sender === "DRIVER"
                    ? "bg-brand-500 text-white"
                    : "bg-surface-100 text-surface-700 dark:bg-surface-800 dark:text-surface-200"
                }`}
              >
                {m.body}
              </p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
      <div className="flex items-center gap-2 border-t border-surface-200 p-2 dark:border-surface-700">
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Escreva uma mensagem..."
          className="flex-1 rounded-xl border border-surface-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-brand-500 dark:border-surface-700 dark:bg-surface-850"
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white disabled:opacity-40"
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}

export function DriverAppPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [driver, setDriver] = useState<DriverRow | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [chatOpenId, setChatOpenId] = useState<string | null>(null);
  const statusRef = useRef<DriverStatus>("OFFLINE");
  const lastLocationAtRef = useRef(0);

  function load() {
    api
      .get<DriverRow>("/driver/me")
      .then((d) => {
        setDriver(d);
        statusRef.current = d.status;
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar"));
    api
      .get<DeliveryRow[]>("/driver/me/deliveries")
      .then(setDeliveries)
      .catch(() => {});
  }

  useEffect(() => {
    if (user && user.role !== "COURIER") {
      navigate("/dashboard");
      return;
    }
    load();
    const poll = setInterval(load, POLL_MS);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Envia localização periodicamente enquanto não estiver offline/pausado —
  // intervalo curto quando ocupado, mais espaçado quando só disponível (item 8).
  useEffect(() => {
    const tick = setInterval(() => {
      const status = statusRef.current;
      if (status === "OFFLINE" || status === "PAUSED") return;
      const interval = status === "AVAILABLE" ? LOCATION_INTERVAL_IDLE_MS : LOCATION_INTERVAL_BUSY_MS;
      if (Date.now() - lastLocationAtRef.current < interval) return;
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          lastLocationAtRef.current = Date.now();
          api
            .post("/driver/me/location", {
              lat: pos.coords.latitude,
              lng: pos.coords.longitude,
              speed: pos.coords.speed ?? undefined,
              heading: pos.coords.heading ?? undefined,
              accuracy: pos.coords.accuracy ?? undefined,
            })
            .catch(() => {});
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000 },
      );
    }, LOCATION_TICK_MS);
    return () => clearInterval(tick);
  }, []);

  async function toggleOnline() {
    if (!driver) return;
    const nextStatus: DriverStatus = driver.status === "OFFLINE" ? "AVAILABLE" : "OFFLINE";
    setDriver({ ...driver, status: nextStatus });
    statusRef.current = nextStatus;
    try {
      await api.patch("/driver/me/status", { status: nextStatus });
    } catch {
      load();
    }
  }

  async function accept(delivery: DeliveryRow) {
    setBusyId(delivery.id);
    try {
      await api.patch(`/driver/me/deliveries/${delivery.id}/accept`, {});
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao aceitar");
    } finally {
      setBusyId(null);
    }
  }

  async function reject(delivery: DeliveryRow) {
    if (!confirm(`Recusar a entrega do pedido #${delivery.order.number}?`)) return;
    setBusyId(delivery.id);
    try {
      await api.patch(`/driver/me/deliveries/${delivery.id}/reject`, {});
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao recusar");
    } finally {
      setBusyId(null);
    }
  }

  async function advance(delivery: DeliveryRow, next: string) {
    setBusyId(delivery.id);
    try {
      await api.patch(`/driver/me/deliveries/${delivery.id}/status`, { status: next });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao atualizar");
    } finally {
      setBusyId(null);
    }
  }

  if (!driver) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-50 dark:bg-surface-950">
        {error ? (
          <p className="max-w-xs text-center text-sm text-red-500">{error}</p>
        ) : (
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        )}
      </div>
    );
  }

  const isOnline = driver.status !== "OFFLINE";

  return (
    <div className="min-h-screen bg-surface-50 pb-8 dark:bg-surface-950">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-200 bg-white/90 px-4 py-3 backdrop-blur-md dark:border-surface-800 dark:bg-surface-900/90">
        <div>
          <p className="text-sm font-bold">{driver.name}</p>
          <p className="text-xs text-surface-400">{DRIVER_STATUS_LABELS[driver.status]}</p>
        </div>
        <button onClick={logout} className="p-2 text-surface-400 hover:text-red-500">
          <LogOut size={18} />
        </button>
      </header>

      <div className="mx-auto max-w-lg space-y-4 p-4">
        <Card className="flex items-center justify-between p-4">
          <div>
            <p className="text-sm font-semibold">{isOnline ? "Você está online" : "Você está offline"}</p>
            <p className="text-xs text-surface-400">
              {isOnline ? "Recebendo entregas normalmente" : "Fique online pra começar a receber pedidos"}
            </p>
          </div>
          <button
            onClick={toggleOnline}
            className={`relative h-8 w-14 shrink-0 rounded-full transition-colors ${isOnline ? "bg-emerald-500" : "bg-surface-300 dark:bg-surface-700"}`}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-transform ${isOnline ? "translate-x-7" : "translate-x-1"}`}
            />
          </button>
        </Card>

        {error && (
          <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        {deliveries.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-surface-400">
              {isOnline ? "Nenhuma entrega no momento — aguardando novo pedido." : "Fique online pra receber entregas."}
            </p>
          </Card>
        ) : (
          deliveries.map((d) => {
            const isPending = d.status === "DRIVER_ASSIGNED";
            const action = NEXT_ACTION[d.status];
            const totalStops = deliveries.filter((x) => x.stopSequence != null).length;
            const destination =
              d.status === "HEADING_TO_STORE"
                ? { lat: d.pickupLat, lng: d.pickupLng, label: "loja" }
                : d.destinationLat != null && d.destinationLng != null
                  ? { lat: d.destinationLat, lng: d.destinationLng, label: "cliente" }
                  : null;

            return (
              <Card key={d.id} className={`p-4 ${isPending ? "border-2 border-brand-400" : ""}`}>
                {isPending && (
                  <p className="mb-2 text-xs font-bold uppercase tracking-wide text-brand-600 dark:text-brand-400">
                    🔔 Nova entrega
                  </p>
                )}
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-base font-bold">Pedido #{d.order.number}</p>
                    {d.stopSequence != null && totalStops > 1 && (
                      <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] font-bold text-blue-600 dark:text-blue-400">
                        {d.stopSequence}ª parada de {totalStops}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-semibold text-brand-600 dark:text-brand-400">{brl(d.order.totalCents)}</p>
                </div>
                <p className="text-sm font-medium">{d.order.customer?.name ?? "Cliente"}</p>
                <p className="mb-3 flex items-center gap-1 text-xs text-surface-500">
                  <MapPin size={12} />
                  {d.order.addressStreet}, {d.order.addressNumber} — {d.order.addressNeighborhood}
                </p>

                <div className="mb-3 flex gap-2">
                  {d.order.customer?.phone && (
                    <a
                      href={`tel:${d.order.customer.phone}`}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-surface-200 py-2 text-xs font-medium text-surface-600 dark:border-surface-700 dark:text-surface-300"
                    >
                      <Phone size={13} /> Ligar
                    </a>
                  )}
                  {destination && (
                    <>
                      <a
                        href={wazeUrl(destination.lat, destination.lng)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-surface-200 py-2 text-xs font-medium text-surface-600 dark:border-surface-700 dark:text-surface-300"
                      >
                        <Navigation size={13} /> Waze
                      </a>
                      <a
                        href={googleMapsUrl(destination.lat, destination.lng)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-surface-200 py-2 text-xs font-medium text-surface-600 dark:border-surface-700 dark:text-surface-300"
                      >
                        <Navigation size={13} /> Maps
                      </a>
                    </>
                  )}
                  <button
                    onClick={() => setChatOpenId(chatOpenId === d.id ? null : d.id)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-medium ${
                      chatOpenId === d.id
                        ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                        : "border-surface-200 text-surface-600 dark:border-surface-700 dark:text-surface-300"
                    }`}
                  >
                    <MessageCircle size={13} /> Chat
                  </button>
                </div>

                {chatOpenId === d.id && <DeliveryChat deliveryId={d.id} />}

                {isPending ? (
                  <div className="flex gap-2">
                    <Button variant="secondary" className="flex-1" onClick={() => reject(d)} disabled={busyId === d.id}>
                      Recusar
                    </Button>
                    <Button className="flex-1" onClick={() => accept(d)} disabled={busyId === d.id}>
                      {busyId === d.id ? "..." : "Aceitar corrida"}
                    </Button>
                  </div>
                ) : action ? (
                  <Button className="w-full" onClick={() => advance(d, action.next)} disabled={busyId === d.id}>
                    {busyId === d.id ? "..." : action.label}
                  </Button>
                ) : null}
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}
