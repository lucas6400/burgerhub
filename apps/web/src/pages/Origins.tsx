import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { brl, parseBrl } from "../lib/format";
import { Button, Card, Input, PageHeader, Skeleton } from "../components/ui";

interface Report {
  days: number;
  rows: { key: string; label: string; orders: number; revenueCents: number }[];
  totalOrders: number;
  totalRevenueCents: number;
  adSpendCents: number;
  adSpendAllTimeCents: number;
  adOrders: number;
  adRevenueCents: number;
  costPerAdOrderCents: number | null;
  returnPerReal: number | null;
}

const PERIODS = [
  { value: 7, label: "7 dias" },
  { value: 30, label: "30 dias" },
  { value: 365, label: "Tudo" },
];

export function OriginsPage() {
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  const [spend, setSpend] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api.get<Report>(`/conversations/origins?days=${days}`).then(setReport).catch(() => setError("Não consegui carregar agora."));
  }, [days]);
  useEffect(load, [load]);

  async function addSpend() {
    const cents = parseBrl(spend);
    if (cents <= 0) return;
    setSaving(true);
    setError("");
    try {
      await api.post("/finance/entries", {
        type: "EXPENSE",
        category: "Tráfego pago",
        description: "Tráfego pago (anúncios)",
        amountCents: cents,
        paidAt: new Date().toISOString(),
      });
      setSpend("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui registrar o gasto.");
    } finally {
      setSaving(false);
    }
  }

  const maxOrders = Math.max(1, ...(report?.rows.map((r) => r.orders) ?? [1]));

  return (
    <div className="animate-fade-in">
      <PageHeader title="Origem dos pedidos" subtitle="De onde vêm as vendas e quanto custa cada pedido de anúncio" />

      <div className="mb-3 flex gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setDays(p.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${
              days === p.value ? "bg-brand-500 text-white" : "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {error && <p className="mb-3 text-xs text-amber-600">{error}</p>}

      {!report ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="space-y-3">
          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Pedidos por origem</h3>
            <div className="space-y-3">
              {report.rows.map((r) => (
                <div key={r.key}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium">{r.label}</span>
                    <span className="text-surface-500">
                      {r.orders} pedido(s) · {brl(r.revenueCents)}
                    </span>
                  </div>
                  <div className="mt-1 h-2 rounded-full bg-surface-100 dark:bg-surface-800">
                    <div className="h-2 rounded-full bg-brand-500" style={{ width: `${(r.orders / maxOrders) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-surface-500">
              Total: {report.totalOrders} pedidos · {brl(report.totalRevenueCents)}
              {report.totalOrders > 0 ? ` · ticket médio ${brl(Math.round(report.totalRevenueCents / report.totalOrders))}` : ""}
            </p>
          </Card>

          <Card className="p-4">
            <h3 className="mb-3 text-sm font-semibold">Tráfego pago</h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-surface-500">Gasto no período</p>
                <p className="text-lg font-bold">{brl(report.adSpendCents)}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500">Gasto total registrado</p>
                <p className="text-lg font-bold">{brl(report.adSpendAllTimeCents)}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500">Custo por pedido de anúncio</p>
                <p className="text-lg font-bold">{report.costPerAdOrderCents != null ? brl(report.costPerAdOrderCents) : "—"}</p>
              </div>
              <div>
                <p className="text-xs text-surface-500">Faturou por R$ 1 gasto</p>
                <p className="text-lg font-bold">{report.returnPerReal != null ? `R$ ${report.returnPerReal.toFixed(2).replace(".", ",")}` : "—"}</p>
              </div>
            </div>
            <p className="mt-3 text-xs text-surface-500">
              "Pedido de anúncio" = quem chegou no WhatsApp pelo botão do anúncio (mensagem pré-preenchida). Pedido do cardápio online
              não dá pra saber se veio do anúncio ou do Instagram, então o custo real por pedido é um pouco menor que o mostrado.
            </p>
            <div className="mt-3 flex gap-2">
              <Input value={spend} onChange={(e) => setSpend(e.target.value)} placeholder="Registrar gasto de hoje (R$)" inputMode="decimal" />
              <Button onClick={addSpend} disabled={saving || parseBrl(spend) <= 0}>
                Registrar
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
