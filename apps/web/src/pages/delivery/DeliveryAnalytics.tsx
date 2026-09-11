import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bike, Clock, DollarSign, PackageCheck, Target } from "lucide-react";
import { api } from "../../lib/api";
import { brl } from "../../lib/format";
import { Button, Card, EmptyState, PageHeader, Skeleton } from "../../components/ui";

interface DriverAnalyticsRow {
  driverId: string;
  driverName: string;
  deliveries: number;
  avgMinutes: number | null;
  totalCostCents: number;
  totalDistanceKm: number;
  hoursOnline: number;
}

interface DeliveryAnalyticsData {
  summary: {
    totalDeliveries: number;
    avgDeliveryMinutes: number | null;
    onTimeRate: number | null;
    totalCostCents: number;
    avgCostCents: number | null;
  };
  byDriver: DriverAnalyticsRow[];
  byDay: { date: string; deliveries: number; delayedCount: number }[];
}

const PERIODS = [
  { label: "7 dias", days: 7 },
  { label: "30 dias", days: 30 },
  { label: "90 dias", days: 90 },
];

function StatCard({ icon: Icon, label, value, sub }: { icon: typeof Clock; label: string; value: string; sub?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
        <Icon size={20} />
      </span>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-[11px] text-surface-400">{label}</p>
        {sub && <p className="text-[11px] text-surface-400">{sub}</p>}
      </div>
    </Card>
  );
}

export function DeliveryAnalyticsPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<DeliveryAnalyticsData | null>(null);

  useEffect(() => {
    setData(null);
    api
      .get<DeliveryAnalyticsData>(`/deliveries/analytics?days=${days}`)
      .then(setData)
      .catch(console.error);
  }, [days]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Métricas de Entrega"
        subtitle="Tempo, pontualidade, custo e turnos da operação de delivery"
        actions={
          <div className="flex gap-1.5">
            {PERIODS.map((p) => (
              <Button key={p.days} size="sm" variant={days === p.days ? "primary" : "secondary"} onClick={() => setDays(p.days)}>
                {p.label}
              </Button>
            ))}
          </div>
        }
      />

      {!data ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
          <Skeleton className="h-64" />
        </div>
      ) : data.summary.totalDeliveries === 0 ? (
        <Card className="p-6">
          <EmptyState
            icon={<PackageCheck size={22} />}
            title="Sem entregas concluídas no período"
            description="As métricas aparecem aqui assim que houver entregas finalizadas."
          />
        </Card>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatCard icon={PackageCheck} label="Entregas concluídas" value={String(data.summary.totalDeliveries)} />
            <StatCard
              icon={Clock}
              label="Tempo médio (pronto → entregue)"
              value={data.summary.avgDeliveryMinutes != null ? `${data.summary.avgDeliveryMinutes} min` : "—"}
            />
            <StatCard
              icon={Target}
              label="Pontualidade"
              value={data.summary.onTimeRate != null ? `${data.summary.onTimeRate}%` : "—"}
            />
            <StatCard icon={DollarSign} label="Custo total c/ entregadores" value={brl(data.summary.totalCostCents)} />
            <StatCard
              icon={DollarSign}
              label="Custo médio por entrega"
              value={data.summary.avgCostCents != null ? brl(data.summary.avgCostCents) : "—"}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="mb-4 text-sm font-semibold">Entregas por dia</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.byDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(d: string) => new Date(d + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}
                  />
                  <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={30} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, fontSize: 12 }}
                    labelFormatter={(d: string) => new Date(d + "T12:00:00").toLocaleDateString("pt-BR")}
                    formatter={(v: number, name: string) => [v, name === "deliveries" ? "Entregas" : "Atrasadas"]}
                  />
                  <Bar dataKey="deliveries" fill="#f59e0b" radius={[6, 6, 0, 0]} />
                  <Bar dataKey="delayedCount" fill="#dc2626" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card className="p-5">
              <h3 className="mb-4 flex items-center gap-1.5 text-sm font-semibold">
                <Bike size={15} className="text-brand-500" /> Desempenho por entregador
              </h3>
              {data.byDriver.length === 0 ? (
                <p className="py-8 text-center text-sm text-surface-400">Nenhuma entrega concluída com entregador no período.</p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {data.byDriver.map((d) => (
                    <div key={d.driverId} className="rounded-xl border border-surface-200 px-3 py-2.5 dark:border-surface-700">
                      <div className="mb-1 flex items-center justify-between">
                        <p className="text-sm font-semibold">{d.driverName}</p>
                        <p className="text-sm font-semibold text-brand-600 dark:text-brand-400">{brl(d.totalCostCents)}</p>
                      </div>
                      <p className="text-[11px] text-surface-400">
                        {d.deliveries} entregas · {d.avgMinutes != null ? `${d.avgMinutes} min méd.` : "—"} · {d.totalDistanceKm} km ·{" "}
                        {d.hoursOnline}h online
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
