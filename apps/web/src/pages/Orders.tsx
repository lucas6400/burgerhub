import { useEffect, useState } from "react";
import { DollarSign, Printer, Search, ShoppingBag } from "lucide-react";
import { api } from "../lib/api";
import { printOrder } from "../lib/print";
import { useAuth } from "../stores/auth";
import {
  brl,
  formatDateTime,
  ORDER_STATUS_LABELS,
  ORDER_TYPE_LABELS,
  PAYMENT_LABELS,
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
          {orders.map((order) => (
            <button
              key={order.id}
              onClick={() => setSelected(order)}
              className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-surface-50 dark:hover:bg-surface-850"
            >
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
          ))}
        </Card>
      )}

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
              <Badge color={selected.source === "WHATSAPP" ? "green" : "blue"}>
                {selected.source === "WHATSAPP" ? "WhatsApp" : selected.source === "MENU" ? "Cardápio" : selected.source}
              </Badge>
            </div>

            <div className="rounded-xl bg-surface-50 p-3 text-sm dark:bg-surface-850">
              <p className="font-medium">{selected.customer?.name}</p>
              <p className="text-surface-500">{selected.customer?.phone}</p>
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
                  <Button
                    className="sm:flex-1"
                    disabled={!selected.paymentMethod}
                    title={!selected.paymentMethod ? "Cobre a comanda antes de concluir o pedido" : undefined}
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
                    Marcar como concluído
                  </Button>
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
