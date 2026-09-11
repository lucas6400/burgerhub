import { useEffect, useState, type FormEvent } from "react";
import { ArrowDownCircle, ArrowUpCircle, Plus, Wallet } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatDate, parseBrl } from "../lib/format";
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

interface Summary {
  monthIncomeCents: number;
  monthExpenseCents: number;
  monthProfitCents: number;
  receivableCents: number;
  payableCents: number;
}

interface Entry {
  id: string;
  type: "INCOME" | "EXPENSE";
  category: string;
  description: string;
  amountCents: number;
  dueDate?: string | null;
  paidAt?: string | null;
  createdAt: string;
}

const EXPENSE_CATEGORIES = ["Insumos", "Aluguel", "Salários", "Marketing", "Taxas", "Outros"];

export function FinancePage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    type: "EXPENSE" as Entry["type"],
    category: "Insumos",
    description: "",
    amount: "",
    dueDate: "",
    paid: true,
  });

  function load() {
    api.get<Summary>("/finance/summary").then(setSummary).catch(console.error);
    api.get<Entry[]>("/finance/entries").then(setEntries).catch(console.error);
  }
  useEffect(load, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    await api.post("/finance/entries", {
      type: form.type,
      category: form.type === "INCOME" ? "Vendas" : form.category,
      description: form.description,
      amountCents: parseBrl(form.amount),
      dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
      paidAt: form.paid ? new Date().toISOString() : null,
    });
    setCreating(false);
    setForm({ ...form, description: "", amount: "", dueDate: "" });
    load();
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Financeiro"
        subtitle="Fluxo de caixa do mês"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> Novo lançamento
          </Button>
        }
      />

      {!summary ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <Card className="p-4">
            <p className="text-xs text-surface-500">Entradas (mês)</p>
            <p className="mt-1 text-xl font-semibold text-emerald-600">{brl(summary.monthIncomeCents)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-surface-500">Saídas (mês)</p>
            <p className="mt-1 text-xl font-semibold text-red-500">{brl(summary.monthExpenseCents)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-surface-500">Lucro (mês)</p>
            <p
              className={`mt-1 text-xl font-semibold ${summary.monthProfitCents >= 0 ? "text-emerald-600" : "text-red-500"}`}
            >
              {brl(summary.monthProfitCents)}
            </p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-surface-500">A receber</p>
            <p className="mt-1 text-xl font-semibold">{brl(summary.receivableCents)}</p>
          </Card>
          <Card className="p-4">
            <p className="text-xs text-surface-500">A pagar</p>
            <p className="mt-1 text-xl font-semibold">{brl(summary.payableCents)}</p>
          </Card>
        </div>
      )}

      <h3 className="mb-3 mt-8 text-sm font-semibold">Lançamentos</h3>
      {!entries ? (
        <Skeleton className="h-64" />
      ) : entries.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Wallet size={24} />}
            title="Nenhum lançamento"
            description="Vendas entregues são lançadas automaticamente como entradas."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
          {entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              {entry.type === "INCOME" ? (
                <ArrowUpCircle size={20} className="shrink-0 text-emerald-500" />
              ) : (
                <ArrowDownCircle size={20} className="shrink-0 text-red-500" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{entry.description}</p>
                <p className="text-xs text-surface-400">
                  {entry.category} · {formatDate(entry.createdAt)}
                </p>
              </div>
              {!entry.paidAt && (
                <div className="flex items-center gap-2">
                  <Badge color="amber">
                    {entry.dueDate ? `vence ${formatDate(entry.dueDate)}` : "pendente"}
                  </Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await api.patch(`/finance/entries/${entry.id}/pay`);
                      load();
                    }}
                  >
                    Baixar
                  </Button>
                </div>
              )}
              <span
                className={`w-28 shrink-0 text-right font-semibold ${
                  entry.type === "INCOME" ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {entry.type === "INCOME" ? "+" : "−"}
                {brl(entry.amountCents)}
              </span>
            </div>
          ))}
        </Card>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="Novo lançamento">
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Tipo">
              <Select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as Entry["type"] })}
              >
                <option value="EXPENSE">Saída (despesa)</option>
                <option value="INCOME">Entrada (receita)</option>
              </Select>
            </Field>
            {form.type === "EXPENSE" && (
              <Field label="Categoria">
                <Select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  {EXPENSE_CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label="Descrição *">
            <Input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Valor (R$) *">
              <Input
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: e.target.value })}
                placeholder="150,00"
                required
              />
            </Field>
            <Field label="Vencimento">
              <Input
                type="date"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.paid}
              onChange={(e) => setForm({ ...form, paid: e.target.checked })}
              className="h-4 w-4 rounded accent-amber-500"
            />
            Já foi pago/recebido
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
              Cancelar
            </Button>
            <Button type="submit">Lançar</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
