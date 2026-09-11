import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bike, Clock, Flame, MapPin, Maximize2, Minimize2, PackageCheck, Route, ShoppingBag, Truck } from "lucide-react";
import { api } from "../../lib/api";
import { brl, timeAgo } from "../../lib/format";
import { Badge, Button, Card, EmptyState, Modal, PageHeader, Skeleton } from "../../components/ui";
import { DeliveryMap } from "../../components/delivery/DeliveryMap";
import { DispatchModal } from "../../components/delivery/DispatchModal";
import { DeliveryStatusBadge, DelayRiskBadge } from "../../components/delivery/DeliveryStatusBadge";
import { DRIVER_STATUS_LABELS, type DispatchBoardData, type DeliveryRow, type DriverRow, type GroupingOpportunity } from "./types";

const POLL_MS = 15_000;

interface HeatPoint {
  lat: number;
  lng: number;
}

function StatTile({ icon: Icon, label, value, tone }: { icon: typeof ShoppingBag; label: string; value: number; tone?: "amber" | "red" }) {
  return (
    <Card className="flex items-center gap-3 p-3.5">
      <span
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
          tone === "red"
            ? "bg-red-500/10 text-red-600 dark:text-red-400"
            : tone === "amber"
              ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              : "bg-brand-500/10 text-brand-600 dark:text-brand-400"
        }`}
      >
        <Icon size={18} />
      </span>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-[11px] text-surface-400">{label}</p>
      </div>
    </Card>
  );
}

export function DispatchBoardPage() {
  const [board, setBoard] = useState<DispatchBoardData | null>(null);
  const [store, setStore] = useState<{ lat: number | null; lng: number | null } | null>(null);
  const [dispatchTarget, setDispatchTarget] = useState<DeliveryRow | null>(null);
  const [opportunities, setOpportunities] = useState<GroupingOpportunity[]>([]);
  const [groupTarget, setGroupTarget] = useState<GroupingOpportunity | null>(null);
  const [error, setError] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [heatPoints, setHeatPoints] = useState<HeatPoint[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  function toggleFullscreen() {
    if (!rootRef.current) return;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      rootRef.current.requestFullscreen();
    }
  }

  function toggleHeatmap() {
    setShowHeatmap((prev) => {
      const next = !prev;
      if (next && !heatPoints) {
        api
          .get<HeatPoint[]>("/deliveries/heatmap")
          .then(setHeatPoints)
          .catch(() => setHeatPoints([]));
      }
      return next;
    });
  }

  useEffect(() => {
    const handler = () => setIsFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  function load() {
    api
      .get<DispatchBoardData>("/deliveries/board")
      .then(setBoard)
      .catch((err) => setError(err instanceof Error ? err.message : "Erro ao carregar"));
    api
      .get<GroupingOpportunity[]>("/deliveries/grouping-opportunities")
      .then(setOpportunities)
      .catch(() => setOpportunities([]));
  }

  useEffect(() => {
    load();
    api
      .get<{ settings: { storeLat: number | null; storeLng: number | null } }>("/settings")
      .then((d) => setStore({ lat: d.settings.storeLat, lng: d.settings.storeLng }))
      .catch(() => {});
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div>
        <PageHeader title="Entregas" />
        <Card className="p-6 text-sm text-red-500">{error}</Card>
      </div>
    );
  }

  if (!board) {
    return (
      <div>
        <PageHeader title="Entregas" subtitle="Operação ao vivo" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    );
  }

  const allDeliveries = [...board.awaitingDispatch, ...board.onRoute];

  return (
    <div
      ref={rootRef}
      className={
        isFullscreen
          ? "flex h-screen flex-col overflow-y-auto bg-surface-50 p-4 dark:bg-surface-950"
          : "animate-fade-in"
      }
    >
      <PageHeader
        title="Entregas"
        subtitle={isFullscreen ? "Central Operacional — atualiza a cada 15s" : "Operação ao vivo — atualiza a cada 15s"}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant={showHeatmap ? "primary" : "secondary"} onClick={toggleHeatmap}>
              <Flame size={14} /> Mapa de calor
            </Button>
            <Button size="sm" variant="secondary" onClick={toggleFullscreen}>
              {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              {isFullscreen ? "Sair da tela cheia" : "Central Operacional"}
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <StatTile icon={ShoppingBag} label="Pedidos ativos" value={board.counts.activeOrders} />
        <StatTile icon={Clock} label="Em preparo" value={board.counts.preparing} />
        <StatTile icon={PackageCheck} label="Aguard. despacho" value={board.counts.awaitingDispatch} />
        <StatTile icon={Truck} label="Em rota" value={board.counts.onRoute} />
        <StatTile icon={AlertTriangle} label="Atrasados" value={board.counts.delayed} tone={board.counts.delayed > 0 ? "red" : undefined} />
        <StatTile icon={Bike} label="Motoboys ativos" value={board.counts.driversActive} />
        <StatTile icon={Bike} label="Motoboys livres" value={board.counts.driversAvailable} tone={board.counts.driversAvailable === 0 ? "amber" : undefined} />
      </div>

      {opportunities.length > 0 && (
        <Card className="mb-4 p-3.5">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            <Route size={15} className="text-brand-500" /> Oportunidades de rota
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {opportunities.map((o) => (
              <div key={`${o.deliveryIds[0]}-${o.deliveryIds[1]}`} className="rounded-xl border border-brand-200 bg-brand-500/5 p-3 dark:border-brand-800">
                <p className="mb-1 text-sm font-semibold">
                  Pedidos #{o.orderNumbers[0]} e #{o.orderNumbers[1]}
                </p>
                <p className="text-xs text-surface-500">
                  Separado: {o.separateDistanceKm} km · Agrupado: {o.groupedDistanceKm} km
                </p>
                <p className="mb-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  Economia de {o.savingsKm} km · +{o.extraMinutes} min
                </p>
                <Button size="sm" variant="secondary" className="w-full" onClick={() => setGroupTarget(o)}>
                  Agrupar pedidos
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className={`grid gap-4 lg:grid-cols-[340px_1fr_320px] ${isFullscreen ? "flex-1 lg:overflow-hidden" : ""}`}>
        {/* Fila aguardando despacho */}
        <Card className={isFullscreen ? "h-full overflow-y-auto p-3" : "max-h-80 overflow-y-auto p-3 lg:max-h-[70vh]"}>
          <h3 className="mb-2 px-1 text-sm font-semibold">Aguardando despacho</h3>
          {board.awaitingDispatch.length === 0 ? (
            <EmptyState icon={<PackageCheck size={22} />} title="Tudo despachado" description="Nenhum pedido pronto esperando entregador." />
          ) : (
            <div className="space-y-2">
              {board.awaitingDispatch.map((d) => (
                <button
                  key={d.id}
                  onClick={() => setDispatchTarget(d)}
                  className="w-full rounded-xl border border-surface-200 p-3 text-left transition-colors hover:border-brand-400 dark:border-surface-700"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-sm font-semibold">#{d.order.number}</span>
                    <DelayRiskBadge risk={d.risk} />
                  </div>
                  <p className="line-clamp-1 text-xs text-surface-500">
                    {d.order.customer?.name ?? "Cliente"} · {brl(d.order.totalCents)}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-surface-400">
                    <MapPin size={11} /> {d.order.addressNeighborhood} · pronto {timeAgo(d.order.readyAt ?? d.order.createdAt)}
                  </p>
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Mapa */}
        <Card className={isFullscreen ? "h-full p-2" : "p-2"}>
          <DeliveryMap
            storeLat={store?.lat}
            storeLng={store?.lng}
            drivers={board.drivers}
            deliveries={allDeliveries}
            onSelectDelivery={(d) => (d.status === "AWAITING_DRIVER" ? setDispatchTarget(d) : undefined)}
            heatPoints={heatPoints ?? undefined}
            showHeatmap={showHeatmap}
          />
        </Card>

        {/* Entregadores + em rota */}
        <div className={isFullscreen ? "h-full space-y-4 overflow-y-auto" : "space-y-4 lg:max-h-[70vh] lg:overflow-y-auto"}>
          <Card className="p-3">
            <h3 className="mb-2 px-1 text-sm font-semibold">Entregadores</h3>
            {board.drivers.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-surface-400">Nenhum entregador cadastrado.</p>
            ) : (
              <div className="space-y-2">
                {board.drivers.map((d) => (
                  <div key={d.id} className="flex items-center justify-between rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-700">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          d.status === "AVAILABLE" ? "bg-emerald-500" : d.status === "OFFLINE" || d.status === "PAUSED" ? "bg-surface-300" : "bg-blue-500"
                        }`}
                      />
                      <div>
                        <p className="text-sm font-medium">{d.name}</p>
                        <p className="text-[11px] text-surface-400">{DRIVER_STATUS_LABELS[d.status]}</p>
                      </div>
                    </div>
                    <Badge color={d.currentOrdersCount > 0 ? "blue" : "gray"}>{d.currentOrdersCount}/{d.maxSimultaneousOrders}</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-3">
            <h3 className="mb-2 px-1 text-sm font-semibold">Em rota</h3>
            {board.onRoute.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-surface-400">Nenhuma entrega em rota agora.</p>
            ) : (
              <div className="space-y-2">
                {board.onRoute.map((d) => (
                  <div key={d.id} className="rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-700">
                    <div className="mb-1 flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-semibold">#{d.order.number}</span>
                        {d.stopSequence != null && (
                          <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-bold text-blue-600 dark:text-blue-400">
                            {d.stopSequence}ª parada
                          </span>
                        )}
                      </div>
                      <DeliveryStatusBadge status={d.status} />
                    </div>
                    <p className="text-[11px] text-surface-400">{d.driver?.name ?? "—"}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      <DispatchModal
        delivery={dispatchTarget}
        drivers={board.drivers}
        onClose={() => setDispatchTarget(null)}
        onDispatched={() => {
          setDispatchTarget(null);
          load();
        }}
      />

      <GroupAssignModal
        opportunity={groupTarget}
        drivers={board.drivers}
        onClose={() => setGroupTarget(null)}
        onGrouped={() => {
          setGroupTarget(null);
          load();
        }}
      />
    </div>
  );
}

/** Confirma o agrupamento — escolhe o entregador que vai levar os dois pedidos juntos (item 12). */
function GroupAssignModal({
  opportunity,
  drivers,
  onClose,
  onGrouped,
}: {
  opportunity: GroupingOpportunity | null;
  drivers: DriverRow[];
  onClose: () => void;
  onGrouped: () => void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState("");
  const available = drivers.filter((d) => d.status === "AVAILABLE");

  async function confirm(driverId: string) {
    if (!opportunity) return;
    setAssigning(true);
    setError("");
    try {
      await api.post("/deliveries/group-assign", { deliveryIds: opportunity.deliveryIds, driverId });
      onGrouped();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao agrupar");
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Modal
      open={!!opportunity}
      onClose={onClose}
      title={opportunity ? `Agrupar pedidos #${opportunity.orderNumbers[0]} e #${opportunity.orderNumbers[1]}` : ""}
    >
      {opportunity && (
        <div className="space-y-3">
          <p className="text-sm text-surface-500">
            Escolha quem vai levar os dois pedidos nessa rota — economia estimada de {opportunity.savingsKm} km.
          </p>
          {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
          {available.length === 0 ? (
            <p className="py-6 text-center text-sm text-surface-400">Nenhum entregador disponível agora.</p>
          ) : (
            <div className="space-y-2">
              {available.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-xl border border-surface-200 px-3 py-2.5 dark:border-surface-700">
                  <p className="text-sm font-medium">{d.name}</p>
                  <Button size="sm" onClick={() => confirm(d.id)} disabled={assigning}>
                    {assigning ? "Agrupando..." : `Agrupar com ${d.name.split(" ")[0]}`}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
