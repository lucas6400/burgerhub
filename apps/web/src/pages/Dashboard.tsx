import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  CircleDollarSign,
  ChefHat,
  PackageCheck,
  PackageX,
  Repeat,
  ShoppingBag,
  TicketPercent,
  UserPlus,
} from "lucide-react";
import { api } from "../lib/api";
import { brl } from "../lib/format";
import { Card, PageHeader, Skeleton } from "../components/ui";

interface Summary {
  revenueTodayCents: number;
  revenueWeekCents: number;
  revenueMonthCents: number;
  ordersToday: number;
  avgTicketCents: number;
  newCustomers30d: number;
  recurringCustomers30d: number;
  ordersInProduction: number;
  ordersCompletedToday: number;
  ordersCanceledToday: number;
}

interface Charts {
  salesByDay: { date: string; revenueCents: number; orders: number }[];
  ordersByHour: { hour: number; orders: number }[];
  topProducts: { name: string; quantity: number }[];
  bottomProducts: { name: string; quantity: number }[];
}

function KpiCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium text-surface-500">{label}</p>
          <p className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{value}</p>
        </div>
        <span
          className={`flex h-9 w-9 items-center justify-center rounded-xl ${accent ?? "bg-brand-500/10 text-brand-500"}`}
        >
          {icon}
        </span>
      </div>
    </Card>
  );
}

const tooltipStyle = {
  borderRadius: 12,
  border: "1px solid rgba(128,128,128,0.2)",
  background: "var(--tooltip-bg, #fff)",
  fontSize: 12,
};

export function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [charts, setCharts] = useState<Charts | null>(null);

  useEffect(() => {
    api.get<Summary>("/dashboard/summary").then(setSummary).catch(console.error);
    api.get<Charts>("/dashboard/charts").then(setCharts).catch(console.error);
  }, []);

  if (!summary || !charts) {
    return (
      <div>
        <PageHeader title="Dashboard" subtitle="Visão geral do seu negócio" />
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-72" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  const salesData = charts.salesByDay.map((d) => ({
    ...d,
    label: new Date(d.date + "T12:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
    revenue: d.revenueCents / 100,
  }));

  return (
    <div className="animate-fade-in">
      <PageHeader title="Dashboard" subtitle="Visão geral do seu negócio" />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <KpiCard
          label="Receita hoje"
          value={brl(summary.revenueTodayCents)}
          icon={<CircleDollarSign size={18} />}
        />
        <KpiCard
          label="Receita 7 dias"
          value={brl(summary.revenueWeekCents)}
          icon={<CircleDollarSign size={18} />}
        />
        <KpiCard
          label="Receita 30 dias"
          value={brl(summary.revenueMonthCents)}
          icon={<CircleDollarSign size={18} />}
        />
        <KpiCard
          label="Ticket médio hoje"
          value={brl(summary.avgTicketCents)}
          icon={<TicketPercent size={18} />}
        />
        <KpiCard
          label="Pedidos hoje"
          value={summary.ordersToday}
          icon={<ShoppingBag size={18} />}
          accent="bg-blue-500/10 text-blue-500"
        />
        <KpiCard
          label="Em produção"
          value={summary.ordersInProduction}
          icon={<ChefHat size={18} />}
          accent="bg-amber-500/10 text-amber-500"
        />
        <KpiCard
          label="Concluídos hoje"
          value={summary.ordersCompletedToday}
          icon={<PackageCheck size={18} />}
          accent="bg-emerald-500/10 text-emerald-500"
        />
        <KpiCard
          label="Cancelados hoje"
          value={summary.ordersCanceledToday}
          icon={<PackageX size={18} />}
          accent="bg-red-500/10 text-red-500"
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:gap-4">
        <KpiCard
          label="Clientes novos (30d)"
          value={summary.newCustomers30d}
          icon={<UserPlus size={18} />}
          accent="bg-purple-500/10 text-purple-500"
        />
        <KpiCard
          label="Clientes recorrentes (30d)"
          value={summary.recurringCustomers30d}
          icon={<Repeat size={18} />}
          accent="bg-purple-500/10 text-purple-500"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Vendas — últimos 14 dias</h3>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={salesData}>
              <defs>
                <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#f59e0b" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `R$${v}`}
                width={55}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => [brl(Math.round(v * 100)), "Receita"]}
              />
              <Area type="monotone" dataKey="revenue" stroke="#f59e0b" strokeWidth={2} fill="url(#rev)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Horários de pico — pedidos por hora</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={charts.ordersByHour}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.15)" vertical={false} />
              <XAxis
                dataKey="hour"
                tick={{ fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(h) => `${h}h`}
              />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} width={30} />
              <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [v, "Pedidos"]} labelFormatter={(h) => `${h}:00`} />
              <Bar dataKey="orders" radius={[6, 6, 0, 0]}>
                {charts.ordersByHour.map((d, i) => (
                  <Cell key={i} fill={d.orders > 0 ? "#f59e0b" : "rgba(128,128,128,0.15)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Produtos mais vendidos (30d)</h3>
          <div className="space-y-3">
            {charts.topProducts.map((p, i) => {
              const max = charts.topProducts[0]?.quantity || 1;
              return (
                <div key={p.name} className="flex items-center gap-3">
                  <span className="w-5 text-xs font-semibold text-surface-400">{i + 1}º</span>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex justify-between text-sm">
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="ml-2 text-surface-500">{p.quantity}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-100 dark:bg-surface-800">
                      <div
                        className="h-full rounded-full bg-brand-500 transition-all"
                        style={{ width: `${(p.quantity / max) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="mb-4 text-sm font-semibold">Menos vendidos (30d) — oportunidades</h3>
          <div className="space-y-2">
            {charts.bottomProducts.map((p) => (
              <div
                key={p.name}
                className="flex items-center justify-between rounded-xl bg-surface-50 px-4 py-2.5 dark:bg-surface-850"
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-sm text-surface-500">{p.quantity} vendidos</span>
              </div>
            ))}
            <p className="pt-2 text-xs text-surface-400">
              💡 Considere criar promoções ou combos com estes itens.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
