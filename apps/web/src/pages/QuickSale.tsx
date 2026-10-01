import { useEffect, useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { api } from "../lib/api";
import { brl } from "../lib/format";
import { Button, Card, Input, PageHeader, Skeleton } from "../components/ui";
import type { Product } from "../types";

const PAYMENTS = [
  { key: "PIX", label: "Pix" },
  { key: "CASH", label: "Dinheiro" },
  { key: "DEBIT", label: "Débito" },
  { key: "CREDIT", label: "Crédito" },
] as const;

interface Done {
  id: string;
  number: number;
  totalCents: number;
}

/** Venda da porta em poucos toques, pensada pro celular: toca no item, escolhe o pagamento, lança. Entra como entregue e paga. */
export function QuickSalePage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [payment, setPayment] = useState<(typeof PAYMENTS)[number]["key"]>("PIX");
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.get<Product[]>("/products").then(setProducts).catch(() => setError("Não consegui carregar os produtos."));
  }, []);

  const list = useMemo(
    () =>
      (products ?? [])
        .filter((p) => p.available && (!search || p.name.toLowerCase().includes(search.toLowerCase())))
        .sort((a, b) => b.priceCents - a.priceCents),
    [products, search],
  );
  const chosen = list.length === 0 && !products ? [] : (products ?? []).filter((p) => (qty[p.id] ?? 0) > 0);
  const total = chosen.reduce((s, p) => s + (p.promoPriceCents ?? p.priceCents) * (qty[p.id] ?? 0), 0);

  function change(id: string, delta: number) {
    setQty((q) => ({ ...q, [id]: Math.max(0, (q[id] ?? 0) + delta) }));
  }

  async function submit() {
    if (chosen.length === 0) return;
    setSubmitting(true);
    setError("");
    try {
      const order = await api.post<{ id: string; number: number; totalCents: number }>("/orders", {
        type: "PICKUP",
        source: "POS",
        paymentMethod: payment,
        notes: "Venda da porta (lançamento rápido)",
        items: chosen.map((p) => ({ productId: p.id, quantity: qty[p.id] })),
      });
      await api.patch(`/orders/${order.id}/status`, { status: "DELIVERED" });
      setDone({ id: order.id, number: order.number, totalCents: order.totalCents });
      setQty({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui lançar a venda.");
    } finally {
      setSubmitting(false);
    }
  }

  async function undo() {
    if (!done) return;
    try {
      await api.patch(`/orders/${done.id}/status`, { status: "CANCELED", cancelReason: "Lançamento rápido desfeito" });
      setDone(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui desfazer.");
    }
  }

  return (
    <div className="animate-fade-in pb-32">
      <PageHeader title="Lançar venda da porta" subtitle="Toque nos itens, escolha o pagamento e lance — entra como venda paga" />

      {done && (
        <Card className="mb-3 border-emerald-500 p-4">
          <p className="text-sm font-semibold text-emerald-600">✅ Venda #{done.number} lançada — {brl(done.totalCents)}</p>
          <button onClick={undo} className="mt-1 text-xs font-medium text-red-500 underline">
            Lancei errado — desfazer
          </button>
        </Card>
      )}
      {error && <p className="mb-3 text-xs text-red-500">{error}</p>}

      <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar item..." className="mb-3" />

      {!products ? (
        <Skeleton className="h-40" />
      ) : (
        <div className="space-y-2">
          {list.map((p) => {
            const n = qty[p.id] ?? 0;
            return (
              <Card key={p.id} className={`flex items-center gap-3 p-3 ${n > 0 ? "ring-2 ring-brand-500" : ""}`}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="text-xs text-surface-500">{brl(p.promoPriceCents ?? p.priceCents)}</p>
                </div>
                {n > 0 && (
                  <>
                    <button onClick={() => change(p.id, -1)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-surface-100 dark:bg-surface-800" aria-label="Menos">
                      <Minus size={18} />
                    </button>
                    <span className="w-6 text-center text-base font-bold">{n}</span>
                  </>
                )}
                <button onClick={() => change(p.id, 1)} className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500 text-white" aria-label="Mais">
                  <Plus size={18} />
                </button>
              </Card>
            );
          })}
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-surface-200 bg-white p-3 dark:border-surface-800 dark:bg-surface-950">
        <div className="mx-auto max-w-2xl space-y-2 pr-16">
          <div className="grid grid-cols-4 gap-2">
            {PAYMENTS.map((m) => (
              <button
                key={m.key}
                onClick={() => setPayment(m.key)}
                className={`rounded-xl py-2.5 text-sm font-semibold ${payment === m.key ? "bg-brand-500 text-white" : "bg-surface-100 dark:bg-surface-800"}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Button className="w-full" onClick={submit} disabled={submitting || chosen.length === 0}>
            {submitting ? "Lançando..." : chosen.length === 0 ? "Escolha os itens" : `Lançar venda — ${brl(total)}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
