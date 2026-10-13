import { useEffect, useState } from "react";
import { Bike, DollarSign, MessageCircle, Printer, Search, ShoppingBag } from "lucide-react";
import { api } from "../lib/api";
import { DispatchRouteModal } from "../components/DispatchRouteModal";
import { printOrder } from "../lib/print";
import { useAuth } from "../stores/auth";
import {
  brl,
  formatDateTime,
  ORDER_STATUS_LABELS,
  ORDER_TYPE_LABELS,
  PAYMENT_LABELS,
  waLink,
} from "../lib/format";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  statusBadgeColor,
} from "../components/ui";
import type { Order } from "../types";

/** Entregas que ainda podem sair com o entregador (já dá pra montar a rota enquanto o último lanche fica pronto). */
const ROUTABLE_STATUSES = ["NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"];

/** Próxima etapa do pedido pra quem trabalha sem a tela de Cozinha (KDS): tudo pelo celular. */
function nextStepFor(order: Order): { to: string; label: string } | null {
  switch (order.status) {
    case "NEW":
      return { to: "PREPARING", label: "🔥 Iniciar preparo" };
    case "PREPARING":
    case "FINISHING":
      return { to: "READY", label: "✅ Pedido pronto" };
    case "READY":
      return order.type === "DELIVERY"
        ? { to: "OUT_FOR_DELIVERY", label: "🛵 Saiu para entrega" }
        : { to: "DELIVERED", label: "🤝 Entregue ao cliente" };
    case "OUT_FOR_DELIVERY":
      return { to: "DELIVERED", label: "🏠 Entregue" };
    default:
      return null;
  }
}

export function OrdersPage() {
  const { tenant } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Order | null>(null);
  const [chargeMethod, setChargeMethod] = useState("PIX");
  const [chargeChangeFor, setChargeChangeFor] = useState("");
  const [charging, setCharging] = useState(false);
  const [chargeError, setChargeError] = useState("");
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const [routeIds, setRouteIds] = useState<Set<string>>(new Set());
  const [routeOpen, setRouteOpen] = useState(false);
  const [actionError, setActionError] = useState("");

  /** Avança o pedido uma etapa (cada etapa avisa o cliente pelo WhatsApp) direto da lista, sem abrir o pedido. */
  async function advanceOrder(order: Order, to: string) {
    setAdvancingId(order.id);
    setActionError("");
    try {
      const updated = await api.patch<Order>(`/orders/${order.id}/status`, { status: to });
      setOrders((prev) => prev?.map((o) => (o.id === order.id ? updated : o)) ?? null);
      setSelected((cur) => (cur?.id === order.id ? updated : cur));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Não consegui atualizar o pedido");
    } finally {
      setAdvancingId(null);
    }
  }

  function toggleRoute(id: string) {
    setRouteIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const routeOrders = (orders ?? []).filter((o) => routeIds.has(o.id));

  useEffect(() => {
    setChargeMethod("PIX");
    setChargeChangeFor("");
    setChargeError("");
  }, [selected?.id]);

  async function handleCharge() {
    if (!selected) return;
    setCharging(true);
    setChargeError("");
    try {
      const updated = await api.patch<Order>(`/orders/${selected.id}/charge`, {
        paymentMethod: chargeMethod,
        changeForCents:
          chargeMethod === "CASH" && chargeChangeFor
            ? Math.round(parseFloat(chargeChangeFor.replace(",", ".")) * 100)
            : undefined,
      });
      setSelected(updated);
      setOrders((prev) => prev?.map((o) => (o.id === selected.id ? updated : o)) ?? null);
      setChargeChangeFor("");
    } catch (err) {
      setChargeError(err instanceof Error ? err.message : "Erro ao cobrar pedido");
    } finally {
      setCharging(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams();
    if (statusFilter) params.set("status", statusFilter);
    if (search) params.set("search", search);
    const t = setTimeout(() => {
      api.get<Order[]>(`/orders?${params}`).then(setOrders).catch(console.error);
    }, 300);
    return () => clearTimeout(t);
  }, [statusFilter, search]);

  return (
    <div className="animate-fade-in">
      <PageHeader title="Pedidos" subtitle="Todos os pedidos do estabelecimento" />

      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-52 flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
          <Input
            placeholder="Buscar por cliente ou telefone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="w-44"
        >
          <option value="">Todos os status</option>
          {Object.entries(ORDER_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>

      {actionError && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{actionError}</p>}

      {!orders ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <EmptyState
            icon={<ShoppingBag size={24} />}
            title="Nenhum pedido encontrado"
            description="Os pedidos do cardápio digital e do WhatsApp aparecem aqui em tempo real."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
          {orders.map((order) => {
            const step = order.status === "AWAITING_PAYMENT" ? null : nextStepFor(order);
            const needsCharge = step?.to === "DELIVERED" && !order.paymentMethod;
            const routable = order.type === "DELIVERY" && ROUTABLE_STATUSES.includes(order.status);
            return (
              <div key={order.id} className="flex flex-col transition-colors hover:bg-surface-50 sm:flex-row sm:items-center sm:gap-2 sm:pr-3 dark:hover:bg-surface-850">
                <div className="flex min-w-0 flex-1 items-center">
                  {routable ? (
                    <label className="flex shrink-0 items-center pl-4" title="Incluir na rota do entregador">
                      <input type="checkbox" className="h-5 w-5 accent-brand-500" checked={routeIds.has(order.id)} onChange={() => toggleRoute(order.id)} />
                    </label>
                  ) : (
                    <span className="w-9 shrink-0" />
                  )}
                <button onClick={() => setSelected(order)} className="flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left">
                  <span className="w-14 shrink-0 font-semibold">#{order.number}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{order.customer?.name ?? "Sem cliente"}</p>
                    <p className="text-xs text-surface-400">
                      {formatDateTime(order.createdAt)} · {ORDER_TYPE_LABELS[order.type]} ·{" "}
                      {order.items.length} {order.items.length === 1 ? "item" : "itens"}
                    </p>
                  </div>
                  <Badge color={statusBadgeColor[order.status]}>{ORDER_STATUS_LABELS[order.status]}</Badge>
                  <span className="hidden w-24 text-right font-semibold sm:block">{brl(order.totalCents)}</span>
                </button>
                </div>
                {step && (
                  <Button
                    size="sm"
                    className="mx-4 mb-3 sm:m-0 sm:shrink-0 sm:whitespace-nowrap"
                    disabled={needsCharge || advancingId === order.id}
                    title={needsCharge ? "Cobre a comanda antes de concluir o pedido" : "Avança o pedido e avisa o cliente no WhatsApp"}
                    onClick={() => advanceOrder(order, step.to)}
                  >
                    {step.label}
                  </Button>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {routeIds.size > 0 && (
        <div className="sticky bottom-3 z-10 mt-3 flex items-center justify-between gap-3 rounded-2xl bg-brand-500 px-4 py-3 text-white shadow-lg">
          <span className="text-sm font-semibold">
            {routeIds.size} {routeIds.size === 1 ? "entrega marcada" : "entregas marcadas"}
          </span>
          <div className="flex gap-2">
            <button onClick={() => setRouteIds(new Set())} className="rounded-xl px-3 py-1.5 text-xs font-medium text-white/90 underline">
              Limpar
            </button>
            <button onClick={() => setRouteOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-brand-600">
              <Bike size={16} /> Montar rota
            </button>
          </div>
        </div>
      )}

      <DispatchRouteModal
        open={routeOpen}
        onClose={() => setRouteOpen(false)}
        orders={routeOrders}
        storeName={tenant?.name ?? "Loja"}
        onMarkedOut={(updated) => {
          setOrders((prev) => prev?.map((o) => updated.find((u) => u.id === o.id) ?? o) ?? null);
          setRouteIds(new Set());
        }}
      />

      <Modal open={!!selected} onClose={() => setSelected(null)} title={`Pedido #${selected?.number ?? ""}`}>
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge color={statusBadgeColor[selected.status]}>
                {ORDER_STATUS_LABELS[selected.status]}
              </Badge>
              <Badge>{ORDER_TYPE_LABELS[selected.type]}</Badge>
              {selected.paymentMethod ? (
                <Badge>{PAYMENT_LABELS[selected.paymentMethod]}</Badge>
              ) : (
                <Badge color="amber">🧾 Comanda aberta</Badge>
              )}
              {selected.paymentMethod === "ONLINE" && (
                <Badge color={selected.paymentStatus === "PAID" ? "green" : "amber"}>
                  {selected.paymentStatus === "PAID" ? "✓ Pago online" : "Aguardando pagamento"}
                </Badge>
              )}
              {selected.paymentReviewRequired && <Badge color="red">⚠️ Revisar pagamento</Badge>}
              <Badge color={selected.source === "WHATSAPP" ? "green" : "blue"}>
                {selected.source === "WHATSAPP" ? "WhatsApp" : selected.source === "MENU" ? "Cardápio" : selected.source}
              </Badge>
            </div>

            <div className="rounded-xl bg-surface-50 p-3 text-sm dark:bg-surface-850">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium">{selected.customer?.name}</p>
                  <p className="text-surface-500">{selected.customer?.phone}</p>
                </div>
                {selected.customer?.phone && (
                  <a
                    href={waLink(
                      selected.customer.phone,
                      `Olá ${selected.customer.name}! Vi aqui que chegou seu pedido #${selected.number} (${brl(selected.totalCents)}) 🍔 Já estamos cuidando dele!`,
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    <MessageCircle size={13} /> WhatsApp
                  </a>
                )}
              </div>
              {selected.type === "DELIVERY" && selected.deliveryLat != null && selected.deliveryLng != null && (
                <div className="mt-1 flex flex-wrap gap-3">
                  <a
                    href={`https://waze.com/ul?ll=${selected.deliveryLat},${selected.deliveryLng}&navigate=yes`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-brand-600 underline"
                  >
                    🗺️ Abrir no Waze
                  </a>
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${selected.deliveryLat},${selected.deliveryLng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-semibold text-brand-600 underline"
                  >
                    🗺️ Abrir no Google Maps
                  </a>
                </div>
              )}
              {selected.addressStreet && (
                <p className="mt-1 text-surface-500">
                  📍 {selected.addressStreet}, {selected.addressNumber} — {selected.addressNeighborhood}
                  {selected.addressComplement && ` (${selected.addressComplement})`}
                </p>
              )}
            </div>

            <div className="space-y-2">
              {selected.items.map((item) => (
                <div key={item.id} className="flex justify-between text-sm">
                  <div>
                    <p>
                      <span className="font-semibold">{item.quantity}×</span> {item.nameSnapshot}
                    </p>
                    {item.addons.map((a) => (
                      <p key={a.id} className="pl-4 text-xs text-emerald-600 dark:text-emerald-400">
                        + {a.quantity}× {a.nameSnapshot} ({brl(a.unitPriceCents * a.quantity)})
                      </p>
                    ))}
                    {item.removals.map((r) => (
                      <p key={r.id} className="pl-4 text-xs text-red-500">
                        − sem {r.nameSnapshot}
                      </p>
                    ))}
                    {item.notes && <p className="pl-4 text-xs italic text-surface-400">“{item.notes}”</p>}
                  </div>
                  <span className="shrink-0 font-medium">{brl(item.unitPriceCents * item.quantity)}</span>
                </div>
              ))}
            </div>

            <div className="space-y-1 border-t border-surface-200 pt-3 text-sm dark:border-surface-800">
              <div className="flex justify-between text-surface-500">
                <span>Subtotal</span>
                <span>{brl(selected.subtotalCents)}</span>
              </div>
              {selected.discountCents > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span>Desconto {selected.couponCode && `(${selected.couponCode})`}</span>
                  <span>−{brl(selected.discountCents)}</span>
                </div>
              )}
              {selected.deliveryFeeCents > 0 && (
                <div className="flex justify-between text-surface-500">
                  <span>Taxa de entrega</span>
                  <span>{brl(selected.deliveryFeeCents)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-semibold">
                <span>Total</span>
                <span>{brl(selected.totalCents)}</span>
              </div>
            </div>

            {!selected.paymentMethod && !["NEW", "PREPARING", "FINISHING"].includes(selected.status) && (
              <div className="space-y-2.5 rounded-xl border border-amber-300 bg-amber-500/5 p-3 dark:border-amber-800">
                <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 dark:text-amber-400">
                  <DollarSign size={15} /> Cobrar comanda
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(PAYMENT_LABELS)
                    .filter(([value]) => value !== "ONLINE")
                    .map(([value, label]) => (
                      <button
                        key={value}
                        onClick={() => setChargeMethod(value)}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          chargeMethod === value
                            ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                            : "border-surface-200 text-surface-500 dark:border-surface-700"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                </div>
                {chargeMethod === "CASH" && (
                  <Field label="Troco para (R$)">
                    <Input
                      value={chargeChangeFor}
                      onChange={(e) => setChargeChangeFor(e.target.value)}
                      placeholder="100,00"
                    />
                  </Field>
                )}
                {chargeError && <p className="text-xs text-red-500">{chargeError}</p>}
                <Button className="w-full" onClick={handleCharge} disabled={charging}>
                  {charging ? "Cobrando..." : `Cobrar ${brl(selected.totalCents)}`}
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="secondary"
                className="sm:flex-1"
                onClick={() => tenant && printOrder(selected, tenant)}
              >
                <Printer size={16} /> Imprimir
              </Button>
              {!["DELIVERED", "SETTLED", "CANCELED"].includes(selected.status) && (
                <>
                  {selected.status === "AWAITING_PAYMENT" ? (
                    <Button
                      className="sm:flex-1"
                      onClick={async () => {
                        const updated = await api.patch<Order>(`/orders/${selected.id}/status`, {
                          status: "NEW",
                        });
                        setSelected(updated);
                        setOrders((prev) =>
                          prev?.map((o) => (o.id === selected.id ? updated : o)) ?? null,
                        );
                      }}
                    >
                      Liberar pedido
                    </Button>
                  ) : (
                    <>
                      {nextStepFor(selected) && (
                        <Button
                          className="sm:flex-1"
                          disabled={nextStepFor(selected)!.to === "DELIVERED" && !selected.paymentMethod}
                          title={nextStepFor(selected)!.to === "DELIVERED" && !selected.paymentMethod ? "Cobre a comanda antes de concluir o pedido" : undefined}
                          onClick={async () => {
                            const updated = await api.patch<Order>(`/orders/${selected.id}/status`, {
                              status: nextStepFor(selected)!.to,
                            });
                            setSelected(updated);
                            setOrders((prev) =>
                              prev?.map((o) => (o.id === selected.id ? updated : o)) ?? null,
                            );
                          }}
                        >
                          {nextStepFor(selected)!.label}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        className="sm:flex-1"
                        disabled={!selected.paymentMethod}
                        title={!selected.paymentMethod ? "Cobre a comanda antes de concluir o pedido" : "Fecha o pedido direto, sem passar pelas etapas — o cliente só recebe o aviso de \"entregue\" (sem preparo, pronto nem saiu para entrega)"}
                        onClick={async () => {
                          const updated = await api.patch<Order>(`/orders/${selected.id}/status`, {
                            status: "DELIVERED",
                          });
                          setSelected(updated);
                          setOrders((prev) =>
                            prev?.map((o) => (o.id === selected.id ? updated : o)) ?? null,
                          );
                        }}
                      >
                        Concluir direto
                      </Button>
                    </>
                  )}
                  <Button
                    variant="danger"
                    className="sm:flex-1"
                    onClick={async () => {
                      await api.patch(`/orders/${selected.id}/status`, {
                        status: "CANCELED",
                        cancelReason: "Cancelado pelo painel",
                      });
                      setSelected(null);
                      setOrders((prev) =>
                        prev?.map((o) => (o.id === selected.id ? { ...o, status: "CANCELED" } : o)) ?? null,
                      );
                    }}
                  >
                    Cancelar
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
