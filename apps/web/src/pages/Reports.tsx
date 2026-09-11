import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Star } from "lucide-react";
import { api } from "../lib/api";
import { brl, timeAgo } from "../lib/format";
import { Card, PageHeader, Skeleton } from "../components/ui";

interface Charts {
  salesByDay: { date: string; revenueCents: number; orders: number }[];
  ordersByHour: { hour: number; orders: number }[];
  topProducts: { name: string; quantity: number }[];
  bottomProducts: { name: string; quantity: number }[];
}

interface CustomerRow {
  id: string;
  name: string;
  ordersCount: number;
  totalSpentCents: number;
}

interface ReviewsSummary {
  avgRating: number | null;
  avgNpsScore: number | null;
  totalReviews: number;
  recent: {
    id: string;
    rating: number;
    npsScore: number | null;
    comment: string | null;
    createdAt: string;
    orderNumber: number;
    customerName: string | null;
  }[];
}

export function ReportsPage() {
  const [charts, setCharts] = useState<Charts | null>(null);
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [reviews, setReviews] = useState<ReviewsSummary | null>(null);

  useEffect(() => {
    api.get<Charts>("/dashboard/charts").then(setCharts).catch(console.error);
    api.get<CustomerRow[]>("/customers").then(setCustomers).catch(console.error);
    api.get<ReviewsSummary>("/reviews").then(setReviews).catch(console.error);
  }, []);

  if (!charts || !customers || !reviews) {
    return (
      <div>
        <PageHeader title="Relatórios" />
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-72" />
          ))}
        </div>
      </div>
    );
  }

  const topCustomers = [...customers]
    .sort((a, b) => b.totalSpentCents - a.totalSpentCents)
    .slice(0, 10);

  const daily = charts.salesByDay.map((d) => ({
    ...d,
    label: new Date(d.date + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
  }));

  return (
    <div className="animate-fade-in">
      <PageHeader title="Relatórios" subtitle="Análises dos últimos 14–30 dias" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Pedidos por dia</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={30} />
              <Tooltip
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
                formatter={(v: number) => [v, "Pedidos"]}
              />
              <Bar dataKey="orders" fill="#f59e0b" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Clientes mais ativos</h3>
          <div className="space-y-2">
            {topCustomers.map((c, i) => (
              <div
                key={c.id}
                className="flex items-center justify-between rounded-xl bg-surface-50 px-4 py-2 text-sm dark:bg-surface-850"
              >
                <span>
                  <span className="mr-2 font-semibold text-surface-400">{i + 1}º</span>
                  {c.name}
                </span>
                <span className="text-surface-500">
                  {c.ordersCount} pedidos · <strong>{brl(c.totalSpentCents)}</strong>
                </span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Receita diária</h3>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {[...daily].reverse().map((d) => (
              <div
                key={d.date}
                className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm odd:bg-surface-50 dark:odd:bg-surface-850"
              >
                <span className="text-surface-500">{d.label}</span>
                <span className="font-medium">{brl(d.revenueCents)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Ranking de produtos (30d)</h3>
          <div className="max-h-72 space-y-1 overflow-y-auto">
            {charts.topProducts.map((p, i) => (
              <div
                key={p.name}
                className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm odd:bg-surface-50 dark:odd:bg-surface-850"
              >
                <span>
                  <span className="mr-2 font-semibold text-surface-400">{i + 1}º</span>
                  {p.name}
                </span>
                <span className="font-medium">{p.quantity} un</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Avaliações dos clientes</h3>
          {reviews.totalReviews === 0 ? (
            <p className="py-8 text-center text-sm text-surface-400">
              Nenhuma avaliação recebida ainda.
            </p>
          ) : (
            <>
              <div className="mb-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-surface-50 p-3 text-center dark:bg-surface-850">
                  <div className="flex items-center justify-center gap-1">
                    <Star size={16} className="fill-amber-400 text-amber-400" />
                    <span className="text-lg font-bold">{reviews.avgRating?.toFixed(1) ?? "—"}</span>
                  </div>
                  <p className="text-xs text-surface-400">{reviews.totalReviews} avaliações</p>
                </div>
                <div className="rounded-xl bg-surface-50 p-3 text-center dark:bg-surface-850">
                  <p className="text-lg font-bold">
                    {reviews.avgNpsScore != null ? reviews.avgNpsScore.toFixed(1) : "—"}
                  </p>
                  <p className="text-xs text-surface-400">NPS médio</p>
                </div>
              </div>
              <div className="max-h-56 space-y-2 overflow-y-auto">
                {reviews.recent
                  .filter((r) => r.comment)
                  .map((r) => (
                    <div key={r.id} className="rounded-xl bg-surface-50 px-3 py-2 text-sm dark:bg-surface-850">
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-medium">{r.customerName ?? `Pedido #${r.orderNumber}`}</span>
                        <span className="flex items-center gap-0.5 text-xs text-surface-400">
                          {r.rating} <Star size={11} className="fill-amber-400 text-amber-400" />
                        </span>
                      </div>
                      <p className="text-surface-500">“{r.comment}”</p>
                      <p className="mt-1 text-xs text-surface-400">{timeAgo(r.createdAt)}</p>
                    </div>
                  ))}
                {reviews.recent.every((r) => !r.comment) && (
                  <p className="py-2 text-center text-xs text-surface-400">
                    Nenhum comentário recente — só notas.
                  </p>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
