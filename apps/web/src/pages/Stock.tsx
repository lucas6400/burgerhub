import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Package, Plus } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatDateTime } from "../lib/format";
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
} from "../components/ui";

interface Ingredient {
  id: string;
  name: string;
  unit: string;
  stockQty: number;
  minStockQty: number;
  costCentsPerUnit: number;
  lowStock: boolean;
}

interface Movement {
  id: string;
  type: string;
  quantity: number;
  reason?: string | null;
  createdAt: string;
  ingredient: { name: string; unit: string };
}

export function StockPage() {
  const [ingredients, setIngredients] = useState<Ingredient[] | null>(null);
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [tab, setTab] = useState<"items" | "movements">("items");
  const [adjusting, setAdjusting] = useState<Ingredient | null>(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", unit: "un", stockQty: "0", minStockQty: "0" });

  function load() {
    api.get<Ingredient[]>("/stock/ingredients").then(setIngredients).catch(console.error);
    api.get<Movement[]>("/stock/movements").then(setMovements).catch(console.error);
  }
  useEffect(load, []);

  const lowCount = ingredients?.filter((i) => i.lowStock).length ?? 0;

  async function handleAdjust(e: FormEvent) {
    e.preventDefault();
    if (!adjusting) return;
    await api.post(`/stock/ingredients/${adjusting.id}/adjust`, {
      quantity: parseFloat(adjustQty.replace(",", ".")) || 0,
    });
    setAdjusting(null);
    setAdjustQty("");
    load();
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    await api.post("/stock/ingredients", {
      name: form.name,
      unit: form.unit,
      stockQty: parseFloat(form.stockQty.replace(",", ".")) || 0,
      minStockQty: parseFloat(form.minStockQty.replace(",", ".")) || 0,
    });
    setCreating(false);
    setForm({ name: "", unit: "un", stockQty: "0", minStockQty: "0" });
    load();
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Estoque"
        subtitle="Baixa automática a cada pedido"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Novo ingrediente
          </Button>
        }
      />

      {lowCount > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle size={16} />
          <span>
            <strong>{lowCount}</strong> {lowCount === 1 ? "ingrediente está" : "ingredientes estão"} com
            estoque baixo.
          </span>
        </div>
      )}

      <div className="mb-4 flex gap-2">
        {(["items", "movements"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? "bg-brand-500 text-white"
                : "bg-surface-100 text-surface-500 hover:bg-surface-200 dark:bg-surface-800"
            }`}
          >
            {t === "items" ? "Ingredientes" : "Movimentações"}
          </button>
        ))}
      </div>

      {tab === "items" ? (
        !ingredients ? (
          <Skeleton className="h-64" />
        ) : ingredients.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Package size={24} />}
              title="Nenhum ingrediente"
              description="Cadastre ingredientes e vincule aos produtos para controle automático."
            />
          </Card>
        ) : (
          <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
            {ingredients.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{i.name}</p>
                  <p className="text-xs text-surface-400">
                    custo {brl(i.costCentsPerUnit)}/{i.unit} · mínimo {i.minStockQty} {i.unit}
                  </p>
                </div>
                {i.lowStock && <Badge color="red">Estoque baixo</Badge>}
                <span
                  className={`w-24 text-right text-sm font-semibold ${i.lowStock ? "text-red-500" : ""}`}
                >
                  {Number(i.stockQty.toFixed(2))} {i.unit}
                </span>
                <Button size="sm" variant="secondary" onClick={() => setAdjusting(i)}>
                  Ajustar
                </Button>
              </div>
            ))}
          </Card>
        )
      ) : !movements ? (
        <Skeleton className="h-64" />
      ) : (
        <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
          {movements.map((m) => (
            <div key={m.id} className="flex items-center gap-4 px-4 py-2.5 text-sm">
              <Badge color={m.quantity > 0 ? "green" : m.type === "ADJUST" ? "blue" : "red"}>
                {m.type === "IN" ? "Entrada" : m.type === "OUT" ? "Saída" : "Ajuste"}
              </Badge>
              <span className="min-w-0 flex-1 truncate">
                {m.ingredient.name}
                {m.reason && <span className="text-surface-400"> · {m.reason}</span>}
              </span>
              <span className={`font-medium ${m.quantity > 0 ? "text-emerald-600" : "text-red-500"}`}>
                {m.quantity > 0 ? "+" : ""}
                {Number(m.quantity.toFixed(2))} {m.ingredient.unit}
              </span>
              <span className="hidden w-28 text-right text-xs text-surface-400 sm:block">
                {formatDateTime(m.createdAt)}
              </span>
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={!!adjusting}
        onClose={() => setAdjusting(null)}
        title={`Ajustar — ${adjusting?.name ?? ""}`}
      >
        <form onSubmit={handleAdjust} className="space-y-4">
          <p className="text-sm text-surface-500">
            Estoque atual: <strong>{adjusting?.stockQty} {adjusting?.unit}</strong>. Use valores
            negativos para dar baixa.
          </p>
          <Field label={`Quantidade (${adjusting?.unit})`}>
            <Input
              value={adjustQty}
              onChange={(e) => setAdjustQty(e.target.value)}
              placeholder="Ex.: 50 ou -10"
              autoFocus
              required
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setAdjusting(null)}>
              Cancelar
            </Button>
            <Button type="submit">Confirmar ajuste</Button>
          </div>
        </form>
      </Modal>

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo ingrediente">
        <form onSubmit={handleCreate} className="space-y-4">
          <Field label="Nome *">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              autoFocus
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Unidade">
              <Select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                <option value="un">unidade</option>
                <option value="g">gramas</option>
                <option value="kg">kg</option>
                <option value="ml">ml</option>
                <option value="l">litros</option>
              </Select>
            </Field>
            <Field label="Estoque inicial">
              <Input value={form.stockQty} onChange={(e) => setForm({ ...form, stockQty: e.target.value })} />
            </Field>
            <Field label="Estoque mínimo">
              <Input
                value={form.minStockQty}
                onChange={(e) => setForm({ ...form, minStockQty: e.target.value })}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="submit">Criar</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
