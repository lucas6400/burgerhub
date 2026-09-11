import { useCallback, useEffect, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { AlertTriangle, Bike, Clock, Volume2, VolumeX } from "lucide-react";
import { api } from "../lib/api";
import { elapsedMinutes, ORDER_TYPE_LABELS } from "../lib/format";
import { Badge, PageHeader } from "../components/ui";
import type { Order } from "../types";

const COLUMNS = [
  { status: "NEW", label: "Novos", color: "border-t-blue-500" },
  { status: "PREPARING", label: "Preparando", color: "border-t-amber-500" },
  { status: "FINISHING", label: "Finalizando", color: "border-t-orange-500" },
  { status: "READY", label: "Prontos", color: "border-t-emerald-500" },
  { status: "OUT_FOR_DELIVERY", label: "Em entrega", color: "border-t-purple-500" },
  { status: "DELIVERED", label: "Entregues", color: "border-t-surface-300" },
];

// Transições permitidas (espelha a regra do backend)
const ALLOWED: Record<string, string[]> = {
  NEW: ["PREPARING", "DELIVERED", "CANCELED"],
  PREPARING: ["FINISHING", "READY", "DELIVERED", "CANCELED"],
  FINISHING: ["READY", "DELIVERED", "CANCELED"],
  READY: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "CANCELED"],
};

function playBeep() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  gain.gain.setValueAtTime(0.25, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  osc.start();
  osc.stop(ctx.currentTime + 0.6);
}

function OrderCard({ order, dragging }: { order: Order; dragging?: boolean }) {
  const minutes = elapsedMinutes(order.createdAt);
  const late = minutes > 40 && !["DELIVERED", "SETTLED", "CANCELED"].includes(order.status);
  const warning =
    minutes > 25 && minutes <= 40 && !["DELIVERED", "SETTLED", "CANCELED"].includes(order.status);

  return (
    <div
      className={`rounded-xl border bg-white p-3 shadow-sm transition-shadow dark:bg-surface-850 ${
        dragging ? "rotate-2 shadow-xl" : ""
      } ${
        late
          ? "border-red-400 ring-1 ring-red-400/40"
          : warning
            ? "border-amber-400 ring-1 ring-amber-400/30"
            : "border-surface-200 dark:border-surface-700"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-bold">#{order.number}</span>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
            late
              ? "bg-red-500/10 text-red-500"
              : warning
                ? "bg-amber-500/10 text-amber-600"
                : "bg-surface-100 text-surface-500 dark:bg-surface-800"
          }`}
        >
          {late ? <AlertTriangle size={11} /> : <Clock size={11} />}
          {minutes} min
        </span>
      </div>
      <div className="mb-2 space-y-1">
        {order.items.map((item) => (
          <div key={item.id} className="text-xs leading-snug">
            <span className="font-semibold">{item.quantity}×</span> {item.nameSnapshot}
            {item.addons.length > 0 && (
              <p className="pl-4 text-[11px] text-emerald-600 dark:text-emerald-400">
                + {item.addons.map((a) => `${a.quantity}× ${a.nameSnapshot}`).join(", ")}
              </p>
            )}
            {item.removals.length > 0 && (
              <p className="pl-4 text-[11px] text-red-500">
                − sem {item.removals.map((r) => r.nameSnapshot).join(", ")}
              </p>
            )}
            {item.notes && <p className="pl-4 text-[11px] italic text-surface-400">“{item.notes}”</p>}
          </div>
        ))}
      </div>
      {order.notes && (
        <p className="mb-2 rounded-lg bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
          📝 {order.notes}
        </p>
      )}
      <div className="flex items-center justify-between text-[11px] text-surface-400">
        <span className="flex items-center gap-1.5">
          {order.type === "DELIVERY" && <Bike size={11} />}
          {ORDER_TYPE_LABELS[order.type]}
          {order.paymentMethod === "ONLINE" &&
            (order.paymentStatus === "PAID" ? (
              <span className="rounded-full bg-emerald-500/15 px-1.5 py-px font-semibold text-emerald-600 dark:text-emerald-400">
                ✓ pago
              </span>
            ) : (
              <span className="rounded-full bg-amber-500/15 px-1.5 py-px font-semibold text-amber-600 dark:text-amber-400">
                aguard. pagto
              </span>
            ))}
        </span>
        <span className="truncate pl-2">{order.customer?.name}</span>
      </div>
    </div>
  );
}

function DraggableCard({ order }: { order: Order }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: order.id,
    data: { order },
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`cursor-grab touch-none active:cursor-grabbing ${isDragging ? "opacity-30" : ""}`}
    >
      <OrderCard order={order} />
    </div>
  );
}

function Column({ status, label, color, orders }: { status: string; label: string; color: string; orders: Order[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`flex w-64 shrink-0 flex-col rounded-2xl border-t-4 ${color} bg-surface-100/70 transition-colors dark:bg-surface-900 ${
        isOver ? "ring-2 ring-brand-500/50" : ""
      }`}
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-surface-500">{label}</span>
        <Badge>{orders.length}</Badge>
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {orders.map((order) => (
          <DraggableCard key={order.id} order={order} />
        ))}
        {orders.length === 0 && (
          <p className="py-8 text-center text-xs text-surface-400">Nenhum pedido</p>
        )}
      </div>
    </div>
  );
}

/** Próxima coluna da sequência visual que ainda é uma transição válida — usada no botão "Avançar" do mobile. */
function nextStatusFor(status: string): string | null {
  const currentIndex = COLUMNS.findIndex((c) => c.status === status);
  for (let i = currentIndex + 1; i < COLUMNS.length; i++) {
    if (ALLOWED[status]?.includes(COLUMNS[i].status)) return COLUMNS[i].status;
  }
  return null;
}

/** Card do KDS pra tela pequena: sem arrastar — avança de status com um toque. */
function MobileOrderCard({ order, onAdvance, onCancel }: { order: Order; onAdvance: (toStatus: string) => void; onCancel: () => void }) {
  const next = nextStatusFor(order.status);
  const nextLabel = COLUMNS.find((c) => c.status === next)?.label;
  const canCancel = ALLOWED[order.status]?.includes("CANCELED");

  return (
    <div className="space-y-2">
      <OrderCard order={order} />
      {(next || canCancel) && (
        <div className="flex gap-2">
          {next && (
            <button
              onClick={() => onAdvance(next)}
              className="flex-1 rounded-xl bg-brand-500 px-3 py-2.5 text-sm font-semibold text-white active:scale-[0.98]"
            >
              Avançar → {nextLabel}
            </button>
          )}
          {canCancel && (
            <button
              onClick={onCancel}
              className="rounded-xl border border-surface-200 px-3 py-2.5 text-sm font-medium text-surface-500 active:scale-[0.98] dark:border-surface-700"
            >
              Cancelar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Visão do KDS pra celular: abas por status em vez de colunas lado a lado, sem depender de arrastar. */
function MobileBoard({
  orders,
  onChangeStatus,
}: {
  orders: Order[];
  onChangeStatus: (orderId: string, toStatus: string) => void;
}) {
  const [activeStatus, setActiveStatus] = useState(COLUMNS[0].status);
  const filtered = orders.filter((o) => o.status === activeStatus);

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 overflow-x-auto pb-2">
        {COLUMNS.map((col) => {
          const count = orders.filter((o) => o.status === col.status).length;
          const active = col.status === activeStatus;
          return (
            <button
              key={col.status}
              onClick={() => setActiveStatus(col.status)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-xs font-semibold transition-colors ${
                active
                  ? "border-brand-500 bg-brand-500 text-white"
                  : "border-surface-200 text-surface-500 dark:border-surface-700"
              }`}
            >
              {col.label}
              <span className={`rounded-full px-1.5 ${active ? "bg-white/25" : "bg-surface-100 dark:bg-surface-800"}`}>{count}</span>
            </button>
          );
        })}
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto pt-2">
        {filtered.map((order) => (
          <MobileOrderCard
            key={order.id}
            order={order}
            onAdvance={(toStatus) => onChangeStatus(order.id, toStatus)}
            onCancel={() => onChangeStatus(order.id, "CANCELED")}
          />
        ))}
        {filtered.length === 0 && <p className="py-8 text-center text-xs text-surface-400">Nenhum pedido aqui</p>}
      </div>
    </div>
  );
}

export function KdsPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const knownIds = useRef<Set<string>>(new Set());
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const load = useCallback(async () => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const data = await api.get<Order[]>(`/orders?from=${today.toISOString()}`);
      // Pedidos com só itens sem preparo (ex.: bebidas) não precisam passar pela cozinha
      const needsKitchen = (o: Order) => o.items.length === 0 || o.items.some((i) => i.showInKds !== false);
      const visible = data.filter((o) => o.status !== "CANCELED" && needsKitchen(o));
      // Toca som quando entra pedido novo
      const isFirstLoad = knownIds.current.size === 0;
      const newOnes = visible.filter((o) => o.status === "NEW" && !knownIds.current.has(o.id));
      if (!isFirstLoad && newOnes.length > 0 && soundRef.current) playBeep();
      knownIds.current = new Set(visible.map((o) => o.id));
      setOrders(visible);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10_000);
    return () => clearInterval(interval);
  }, [load]);

  // Re-render a cada 30s para atualizar cronômetros
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  async function changeStatus(orderId: string, toStatus: string) {
    // Atualização otimista
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, status: toStatus } : o)));
    try {
      await api.patch(`/orders/${orderId}/status`, { status: toStatus });
    } catch (err) {
      console.error(err);
      load(); // reverte para o estado do servidor
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveOrder(null);
    const orderId = String(event.active.id);
    const toStatus = event.over?.id ? String(event.over.id) : null;
    if (!toStatus) return;

    const order = orders.find((o) => o.id === orderId);
    if (!order || order.status === toStatus) return;
    if (!ALLOWED[order.status]?.includes(toStatus)) return;

    changeStatus(orderId, toStatus);
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Cozinha — KDS"
        subtitle="Acompanhe e avance o preparo dos pedidos"
        actions={
          <button
            onClick={() => setSoundOn(!soundOn)}
            className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              soundOn
                ? "bg-brand-500/10 text-brand-600 dark:text-brand-400"
                : "bg-surface-100 text-surface-400 dark:bg-surface-800"
            }`}
          >
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            Som
          </button>
        }
      />
      {/* Celular: abas por status + lista vertical, sem depender de arrastar */}
      <div className="min-h-0 flex-1 md:hidden">
        <MobileBoard orders={orders} onChangeStatus={changeStatus} />
      </div>

      {/* Tablet/desktop: quadro Kanban com arrastar-e-soltar */}
      <DndContext
        sensors={sensors}
        onDragStart={(e) => setActiveOrder((e.active.data.current?.order as Order) ?? null)}
        onDragEnd={handleDragEnd}
      >
        <div className="hidden flex-1 gap-3 overflow-x-auto pb-2 md:flex">
          {COLUMNS.map((col) => (
            <Column
              key={col.status}
              {...col}
              orders={orders.filter((o) => o.status === col.status)}
            />
          ))}
        </div>
        <DragOverlay>{activeOrder && <OrderCard order={activeOrder} dragging />}</DragOverlay>
      </DndContext>
    </div>
  );
}
