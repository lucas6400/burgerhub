import { useEffect, useMemo, useState } from "react";
import { CalendarClock, MessageCircle, Printer } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatDateTime, waLink } from "../lib/format";
import { collectLine, placeLabel } from "../lib/dispatch";
import { printOrderByHand } from "../lib/print";
import { useAuth } from "../stores/auth";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton } from "../components/ui";
import type { Order } from "../types";

const POLL_MS = 30_000;
const STORE_TZ = "America/Sao_Paulo";

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: STORE_TZ, weekday: "long", day: "2-digit", month: "2-digit" });
const timeLabel = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { timeZone: STORE_TZ, hour: "2-digit", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: STORE_TZ });

/**
 * Pedidos feitos com a loja fechada ficam aqui, separados dos pedidos "de agora" (Pedidos, Cozinha, Entregas). Quando
 * chega a hora de abrir eles entram sozinhos na fila de pedidos (e são impressos); dá pra liberar antes ou cancelar.
 */
export function ScheduledPage() {
  const { tenant } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  function load() {
    api
      .get<Order[]>("/orders?scheduled=only")
      .then((list) => setOrders(list.sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "") || a.createdAt.localeCompare(b.createdAt))))
      .catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar os agendamentos"));
  }
  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  async function run(order: Order, action: () => Promise<unknown>) {
    setBusyId(order.id);
    setError("");
    try {
      await action();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui concluir a ação");
    } finally {
      setBusyId(null);
    }
  }

  const groups = useMemo(() => {
    const byDay = new Map<string, { label: string; time: string; orders: Order[] }>();
    for (const o of orders ?? []) {
      if (!o.scheduledFor) continue;
      const key = dayKey(o.scheduledFor);
      const group = byDay.get(key) ?? { label: dayLabel(o.scheduledFor), time: timeLabel(o.scheduledFor), orders: [] };
      group.orders.push(o);
      byDay.set(key, group);
    }
    return [...byDay.values()];
  }, [orders]);

  return (
    <div className="animate-fade-in">
      <PageHeader title="Agendamentos" subtitle="Pedidos feitos com a loja fechada — entram na fila sozinhos quando a loja abrir" />
      {error && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {!orders ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={<CalendarClock size={24} />}
            title="Nenhum pedido agendado"
            description="Quando um cliente fechar o pedido com a loja fechada, ele aparece aqui até a hora de abrir."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.label}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold capitalize">
                <CalendarClock size={16} className="text-brand-500" /> {group.label} · abre às {group.time}
                <Badge color="blue">{group.orders.length}</Badge>
              </h2>
              <div className="space-y-3">
                {group.orders.map((order) => (
                  <Card key={order.id} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="font-semibold">
                          #{order.number} · {order.customer?.name ?? "Cliente"} · {brl(order.totalCents)}
                        </p>
                        <p className="text-xs text-surface-500">
                          Pedido feito em {formatDateTime(order.createdAt)} · {order.type === "DELIVERY" ? "Entrega" : order.type === "PICKUP" ? "Retirada" : "No local"}
                        </p>
                      </div>
                      <Badge color="amber">Agendado</Badge>
                    </div>

                    <ul className="space-y-0.5 text-sm">
                      {order.items.map((i) => (
                        <li key={i.id}>
                          <span className="font-medium">
                            {i.quantity}x {i.nameSnapshot}
                          </span>
                          {i.addons.map((a) => (
                            <span key={a.id} className="text-surface-500"> + {a.quantity}x {a.nameSnapshot}</span>
                          ))}
                          {i.removals.map((r) => (
                            <span key={r.id} className="font-semibold"> · SEM {r.nameSnapshot}</span>
                          ))}
                          {i.notes && <span className="font-semibold"> · OBS: {i.notes}</span>}
                        </li>
                      ))}
                    </ul>

                    {order.type === "DELIVERY" && <p className="text-sm text-surface-600 dark:text-surface-300">📍 {placeLabel(order) || "Só o pino do mapa"}{order.addressComplement ? ` — ${order.addressComplement}` : ""}</p>}
                    <p className="text-sm">{collectLine(order)}</p>

                    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                      <Button size="sm" disabled={busyId === order.id} onClick={() => run(order, () => api.post(`/orders/${order.id}/release-scheduled`, {}))}>
                        Liberar agora pra cozinha
                      </Button>
                      {order.customer?.phone && (
                        <a
                          href={waLink(order.customer.phone, `Olá ${order.customer.name}! Aqui é da ${tenant?.name ?? "loja"}. Seu pedido #${order.number} está agendado — começamos a preparar quando abrirmos 🍔`)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white"
                        >
                          <MessageCircle size={14} /> Falar com o cliente
                        </a>
                      )}
                      <Button size="sm" variant="secondary" onClick={() => tenant && printOrderByHand(order, tenant)}>
                        <Printer size={14} /> Imprimir
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={busyId === order.id}
                        onClick={() => {
                          if (!window.confirm(`Cancelar o pedido #${order.number} de ${order.customer?.name ?? "cliente"}?`)) return;
                          void run(order, () => api.patch(`/orders/${order.id}/status`, { status: "CANCELED", cancelReason: "Agendamento cancelado pelo painel" }));
                        }}
                      >
                        Cancelar
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
