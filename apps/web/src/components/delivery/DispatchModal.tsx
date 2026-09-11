import { useEffect, useState } from "react";
import { Bike, MapPin, Trophy } from "lucide-react";
import { api } from "../../lib/api";
import { brl } from "../../lib/format";
import { Button, Modal } from "../ui";
import type { DeliveryRow, DriverRow } from "../../pages/delivery/types";

interface Suggestion {
  driverId: string;
  driverName: string;
  score: number;
  distanceToStoreKm: number;
  etaToStoreMinutes: number;
  currentOrdersCount: number;
  estimatedDeliveryMinutes: number;
}

interface Props {
  delivery: DeliveryRow | null;
  drivers: DriverRow[];
  onClose: () => void;
  onDispatched: () => void;
}

const RANK_LABEL = ["🏆 Melhor opção", "2ª opção", "3ª opção"];

/** Modal de despacho manual — item 9 (escolher) + item 11 (sugestão automática ranqueada). */
export function DispatchModal({ delivery, drivers, onClose, onDispatched }: Props) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!delivery) {
      setSuggestions(null);
      return;
    }
    api
      .get<Suggestion[]>(`/deliveries/${delivery.id}/suggestions`)
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, [delivery]);

  async function dispatch(driverId: string) {
    if (!delivery) return;
    setAssigning(driverId);
    setError("");
    try {
      await api.patch(`/deliveries/${delivery.id}/assign`, { driverId });
      onDispatched();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao despachar");
    } finally {
      setAssigning(null);
    }
  }

  // Fallback caso a sugestão falhe: lista simples ordenada por carga atual.
  const fallbackDrivers = drivers
    .filter((d) => d.status !== "OFFLINE" && d.status !== "PAUSED")
    .sort((a, b) => a.currentOrdersCount - b.currentOrdersCount);

  return (
    <Modal open={!!delivery} onClose={onClose} title={delivery ? `Despachar pedido #${delivery.order.number}` : ""}>
      {delivery && (
        <div className="space-y-4">
          <div className="rounded-xl bg-surface-50 p-3 text-sm dark:bg-surface-850">
            <p className="font-medium">{delivery.order.customer?.name ?? "Cliente"}</p>
            <p className="flex items-center gap-1 text-xs text-surface-500">
              <MapPin size={12} />
              {delivery.order.addressStreet}, {delivery.order.addressNumber} — {delivery.order.addressNeighborhood}
            </p>
            <p className="mt-1 text-xs text-surface-400">
              {brl(delivery.order.totalCents)}
              {delivery.estimatedDistanceKm != null && ` · ${delivery.estimatedDistanceKm} km`}
            </p>
          </div>

          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
              Melhores entregadores pra esse pedido
            </h4>
            {suggestions === null ? (
              <p className="py-6 text-center text-xs text-surface-400">Calculando sugestões...</p>
            ) : suggestions.length === 0 ? (
              fallbackDrivers.length === 0 ? (
                <p className="py-6 text-center text-sm text-surface-400">Nenhum entregador online agora.</p>
              ) : (
                <div className="space-y-2">
                  {fallbackDrivers.map((d) => (
                    <div key={d.id} className="flex items-center justify-between rounded-xl border border-surface-200 px-3 py-2.5 dark:border-surface-700">
                      <p className="text-sm font-medium">{d.name}</p>
                      <Button size="sm" onClick={() => dispatch(d.id)} disabled={assigning !== null}>
                        {assigning === d.id ? "Despachando..." : `Despachar para ${d.name.split(" ")[0]}`}
                      </Button>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="space-y-2">
                {suggestions.map((s, i) => (
                  <div
                    key={s.driverId}
                    className={`rounded-xl border p-3 ${
                      i === 0 ? "border-amber-400 bg-amber-500/5" : "border-surface-200 dark:border-surface-700"
                    }`}
                  >
                    <div className="mb-2 flex items-center justify-between">
                      <span className={`flex items-center gap-1 text-xs font-semibold ${i === 0 ? "text-amber-600 dark:text-amber-400" : "text-surface-400"}`}>
                        {i === 0 && <Trophy size={12} />}
                        {RANK_LABEL[i] ?? `${i + 1}ª opção`}
                      </span>
                      <span className="flex items-center gap-1.5 text-sm font-semibold">
                        <Bike size={14} /> {s.driverName}
                      </span>
                    </div>
                    <div className="mb-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-surface-500">
                      <span>Distância até loja: {s.distanceToStoreKm < 1 ? `${Math.round(s.distanceToStoreKm * 1000)} m` : `${s.distanceToStoreKm} km`}</span>
                      <span>ETA até loja: {s.etaToStoreMinutes} min</span>
                      <span>Pedidos atuais: {s.currentOrdersCount}</span>
                      <span>Entrega estimada: {s.estimatedDeliveryMinutes} min</span>
                    </div>
                    <Button
                      size="sm"
                      className="w-full"
                      variant={i === 0 ? "primary" : "secondary"}
                      onClick={() => dispatch(s.driverId)}
                      disabled={assigning !== null}
                    >
                      {assigning === s.driverId ? "Despachando..." : `Despachar para ${s.driverName.split(" ")[0]}`}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
