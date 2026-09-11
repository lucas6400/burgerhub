import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { CheckCircle2, MapPinned, MessageCircle, Send } from "lucide-react";
import { api } from "../../lib/api";
import { brl } from "../../lib/format";
import { CustomerTrackingMap } from "../../components/delivery/CustomerTrackingMap";

interface TrackingData {
  tenant: { name: string; logoUrl?: string | null; address?: string | null; storeLat?: number | null; storeLng?: number | null };
  order: { number: number; totalCents: number; type: "DELIVERY" | "PICKUP" | "DINE_IN"; status: string };
  deliveryId: string | null;
  deliveryStatusLabel: string | null;
  driverName: string | null;
  driverLat: number | null;
  driverLng: number | null;
  destinationLat: number | null;
  destinationLng: number | null;
  estimatedDeliveryAt: string | null;
  otherOrdersInRoute: number;
  canChat: boolean;
}

interface ChatMessage {
  id: string;
  sender: "CUSTOMER" | "DRIVER";
  body: string;
  createdAt: string;
}

const STEP_LABELS = ["Recebido", "Em preparo", "A caminho", "Concluído"];

function stepFor(status: string): number {
  if (["DELIVERED", "SETTLED"].includes(status)) return 3;
  if (["READY", "OUT_FOR_DELIVERY"].includes(status)) return 2;
  if (["PREPARING", "FINISHING"].includes(status)) return 1;
  return 0;
}

/** Com lat/lng, aponta o pino exato; só cai pro texto (menos preciso — o Google recalcula sozinho) quando não há coordenada salva. */
function storeMapUrl(address?: string | null, lat?: number | null, lng?: number | null) {
  if (lat != null && lng != null) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}

function thirdStepLabel(type: TrackingData["order"]["type"]) {
  if (type === "DELIVERY") return "Saiu p/ entrega";
  if (type === "PICKUP") return "Pronto p/ retirar";
  return "Pronto";
}

function etaText(estimatedDeliveryAt: string | null, tick: number) {
  if (!estimatedDeliveryAt) return null;
  void tick; // força recalcular a cada re-render do relógio
  const diffMs = new Date(estimatedDeliveryAt).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin <= 0) return "a qualquer momento";
  if (diffMin === 1) return "em ~1 minuto";
  return `em ~${diffMin} minutos`;
}

export function TrackOrderPage() {
  const { slug, orderId } = useParams<{ slug: string; orderId: string }>();
  const [data, setData] = useState<TrackingData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [chatText, setChatText] = useState("");
  const [sending, setSending] = useState(false);
  const [clock, setClock] = useState(0);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop = false;
    function load() {
      api
        .get<TrackingData>(`/public/${slug}/orders/${orderId}/tracking`)
        .then((d) => !stop && setData(d))
        .catch(() => !stop && setNotFound(true));
    }
    load();
    const interval = setInterval(load, 8000);
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [slug, orderId]);

  // Relógio só pra recalcular o "chega em ~X min" sem esperar o próximo poll.
  useEffect(() => {
    const t = setInterval(() => setClock((c) => c + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!data?.canChat) return;
    let stop = false;
    function loadMessages() {
      api
        .get<ChatMessage[]>(`/public/${slug}/orders/${orderId}/messages`)
        .then((list) => !stop && setMessages(list))
        .catch(() => {});
    }
    loadMessages();
    const interval = setInterval(loadMessages, 5000);
    return () => {
      stop = true;
      clearInterval(interval);
    };
  }, [slug, orderId, data?.canChat]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  async function sendMessage() {
    const body = chatText.trim();
    if (!body || sending) return;
    setSending(true);
    setChatText("");
    try {
      const message = await api.post<ChatMessage>(`/public/${slug}/orders/${orderId}/messages`, { body });
      setMessages((prev) => [...(prev ?? []), message]);
    } catch {
      setChatText(body);
    } finally {
      setSending(false);
    }
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-5xl">🍔</span>
        <h1 className="text-xl font-bold">Pedido não encontrado</h1>
        <p className="text-sm text-surface-500">Confira o link e tente novamente.</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <div className="h-24 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
        <div className="h-48 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
      </div>
    );
  }

  const { tenant, order } = data;
  const canceled = order.status === "CANCELED";
  const step = stepFor(order.status);
  const showMap = order.type === "DELIVERY" && (data.driverLat != null || data.destinationLat != null);
  const eta = etaText(data.estimatedDeliveryAt, clock);

  return (
    <div className="flex min-h-screen flex-col items-center bg-surface-50 p-4 dark:bg-surface-950 sm:p-6">
      <div className="w-full max-w-md animate-fade-in space-y-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl bg-brand-500 text-2xl shadow-md">
            {tenant.logoUrl ? <img src={tenant.logoUrl} alt="" className="h-full w-full object-cover" /> : "🍔"}
          </span>
          <h1 className="text-lg font-bold">{tenant.name}</h1>
          <p className="text-sm text-surface-500">
            Pedido #{order.number} · {brl(order.totalCents)}
          </p>
        </div>

        {canceled ? (
          <div className="rounded-2xl border border-red-200 bg-red-500/5 p-6 text-center text-sm text-red-600 dark:border-red-800 dark:text-red-400">
            Esse pedido foi cancelado.
          </div>
        ) : (
          <>
            {/* Linha do tempo */}
            <div className="rounded-2xl border border-surface-200 bg-white p-5 dark:border-surface-800 dark:bg-surface-900">
              <div className="flex items-center justify-between">
                {STEP_LABELS.map((label, i) => (
                  <div key={label} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="flex w-full items-center">
                      <div
                        className={`h-1 flex-1 rounded-full ${i === 0 ? "opacity-0" : i <= step ? "bg-brand-500" : "bg-surface-200 dark:bg-surface-700"}`}
                      />
                      <span
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          i <= step
                            ? "bg-brand-500 text-white"
                            : "bg-surface-100 text-surface-400 dark:bg-surface-800"
                        }`}
                      >
                        {i < step ? <CheckCircle2 size={15} /> : i + 1}
                      </span>
                      <div
                        className={`h-1 flex-1 rounded-full ${i === STEP_LABELS.length - 1 ? "opacity-0" : i < step ? "bg-brand-500" : "bg-surface-200 dark:bg-surface-700"}`}
                      />
                    </div>
                    <span className={`text-center text-[10px] font-medium leading-tight ${i <= step ? "text-brand-600 dark:text-brand-400" : "text-surface-400"}`}>
                      {i === 2 ? thirdStepLabel(order.type) : label}
                    </span>
                  </div>
                ))}
              </div>
              {data.deliveryStatusLabel && step < 3 && (
                <p className="mt-4 text-center text-sm text-surface-500">
                  {data.driverName ? `${data.driverName} — ` : ""}
                  {data.deliveryStatusLabel}
                  {eta && <span className="font-semibold text-brand-600 dark:text-brand-400"> · chega {eta}</span>}
                </p>
              )}
              {!data.deliveryStatusLabel && eta && step < 3 && (
                <p className="mt-4 text-center text-sm font-semibold text-brand-600 dark:text-brand-400">
                  Chega {eta}
                </p>
              )}
              {data.otherOrdersInRoute > 0 && step < 3 && (
                <p className="mt-2 text-center text-xs text-surface-400">
                  Seu entregador está levando mais {data.otherOrdersInRoute}{" "}
                  {data.otherOrdersInRoute === 1 ? "pedido" : "pedidos"} nessa rota.
                </p>
              )}
            </div>

            {/* Retirada: endereço da loja */}
            {order.type === "PICKUP" && (
              <div className="rounded-2xl border border-brand-300 bg-brand-500/5 px-4 py-3 text-sm dark:border-brand-700">
                <p className="mb-1 flex items-center justify-center gap-1.5 font-semibold text-brand-700 dark:text-brand-400">
                  <MapPinned size={14} /> Retire em:
                </p>
                {tenant.address ? (
                  <>
                    <p className="text-center text-surface-600 dark:text-surface-300">{tenant.address}</p>
                    <p className="text-center">
                      <a
                        href={storeMapUrl(tenant.address, tenant.storeLat, tenant.storeLng) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block text-xs font-semibold text-brand-600 underline dark:text-brand-400"
                      >
                        Ver rota no mapa
                      </a>
                    </p>
                  </>
                ) : (
                  <p className="text-center text-surface-500">Endereço não informado — confirme por telefone.</p>
                )}
              </div>
            )}

            {/* Mapa ao vivo */}
            {showMap && (
              <div className="overflow-hidden rounded-2xl border border-surface-200 dark:border-surface-800">
                <CustomerTrackingMap
                  driverLat={data.driverLat}
                  driverLng={data.driverLng}
                  destinationLat={data.destinationLat}
                  destinationLng={data.destinationLng}
                />
              </div>
            )}

            {/* Chat com o entregador */}
            {data.canChat && (
              <div className="rounded-2xl border border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900">
                <p className="flex items-center gap-1.5 border-b border-surface-100 px-4 py-2.5 text-sm font-semibold dark:border-surface-800">
                  <MessageCircle size={15} /> Fale com {data.driverName ?? "o entregador"}
                </p>
                <div className="max-h-56 space-y-2 overflow-y-auto p-3">
                  {!messages || messages.length === 0 ? (
                    <p className="py-4 text-center text-xs text-surface-400">
                      Nenhuma mensagem ainda — pode perguntar algo sobre a entrega.
                    </p>
                  ) : (
                    messages.map((m) => (
                      <div key={m.id} className={`flex ${m.sender === "CUSTOMER" ? "justify-end" : "justify-start"}`}>
                        <p
                          className={`max-w-[80%] rounded-2xl px-3 py-1.5 text-sm ${
                            m.sender === "CUSTOMER"
                              ? "bg-brand-500 text-white"
                              : "bg-surface-100 text-surface-700 dark:bg-surface-800 dark:text-surface-200"
                          }`}
                        >
                          {m.body}
                        </p>
                      </div>
                    ))
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div className="flex items-center gap-2 border-t border-surface-100 p-2.5 dark:border-surface-800">
                  <input
                    value={chatText}
                    onChange={(e) => setChatText(e.target.value.slice(0, 500))}
                    onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                    placeholder="Escreva uma mensagem..."
                    className="flex-1 rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-surface-700 dark:bg-surface-850"
                  />
                  <button
                    onClick={sendMessage}
                    disabled={sending || !chatText.trim()}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white disabled:opacity-40"
                  >
                    <Send size={15} />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
