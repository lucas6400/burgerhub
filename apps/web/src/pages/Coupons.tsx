import { useEffect, useState, type FormEvent } from "react";
import { Plus, Tag, Trash2 } from "lucide-react";
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
  Toggle,
} from "../components/ui";

interface Coupon {
  id: string;
  code: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  valueCents: number;
  valuePct: number;
  minOrderCents: number;
  maxUses?: number | null;
  usedCount: number;
  firstPurchaseOnly: boolean;
  birthdayOnly: boolean;
  active: boolean;
  expiresAt?: string | null;
}

function couponValue(c: Coupon) {
  if (c.type === "PERCENT") return `${c.valuePct}% OFF`;
  if (c.type === "FIXED") return `${brl(c.valueCents)} OFF`;
  return "Frete grátis";
}

export function CouponsPage() {
  const [coupons, setCoupons] = useState<Coupon[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    code: "",
    type: "PERCENT" as Coupon["type"],
    value: "10",
    minOrder: "",
    maxUses: "",
    firstPurchaseOnly: false,
    birthdayOnly: false,
    expiresAt: "",
  });

  function load() {
    api.get<Coupon[]>("/coupons").then(setCoupons).catch(console.error);
  }
  useEffect(load, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.post("/coupons", {
        code: form.code,
        type: form.type,
        valuePct: form.type === "PERCENT" ? parseFloat(form.value) || 0 : 0,
        valueCents: form.type === "FIXED" ? parseBrl(form.value) : 0,
        minOrderCents: form.minOrder ? parseBrl(form.minOrder) : 0,
        maxUses: form.maxUses ? parseInt(form.maxUses) : null,
        firstPurchaseOnly: form.firstPurchaseOnly,
        birthdayOnly: form.birthdayOnly,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      });
      setModalOpen(false);
      setForm({ ...form, code: "", value: "10", minOrder: "", maxUses: "", expiresAt: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(c: Coupon, active: boolean) {
    setCoupons((prev) => prev?.map((x) => (x.id === c.id ? { ...x, active } : x)) ?? null);
    try {
      await api.put(`/coupons/${c.id}`, { active });
    } catch {
      load();
    }
  }

  async function remove(c: Coupon) {
    await api.delete(`/coupons/${c.id}`);
    load();
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Cupons"
        subtitle="Descontos e promoções"
        actions={
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={16} /> Novo cupom
          </Button>
        }
      />

      {!coupons ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : coupons.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Tag size={24} />}
            title="Nenhum cupom"
            description="Crie cupons de desconto para atrair e fidelizar clientes."
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {coupons.map((c) => (
            <Card key={c.id} className={`p-4 ${!c.active ? "opacity-60" : ""}`}>
              <div className="mb-2 flex items-start justify-between">
                <div>
                  <p className="font-mono text-base font-bold tracking-wider">{c.code}</p>
                  <p className="text-sm font-medium text-brand-600 dark:text-brand-400">
                    {couponValue(c)}
                  </p>
                </div>
                <button
                  onClick={() => remove(c)}
                  className="rounded-lg p-1.5 text-surface-300 transition-colors hover:bg-red-500/10 hover:text-red-500"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {c.firstPurchaseOnly && <Badge color="blue">1ª compra</Badge>}
                {c.birthdayOnly && <Badge color="purple">Aniversário</Badge>}
                {c.minOrderCents > 0 && <Badge>mín. {brl(c.minOrderCents)}</Badge>}
                {c.expiresAt && <Badge color="amber">até {formatDate(c.expiresAt)}</Badge>}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-surface-400">
                  {c.usedCount}
                  {c.maxUses ? `/${c.maxUses}` : ""} usos
                </span>
                <Toggle checked={c.active} onChange={(v) => toggleActive(c, v)} />
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Novo cupom">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Código *">
              <Input
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                placeholder="BEMVINDO10"
                required
              />
            </Field>
            <Field label="Tipo *">
              <Select
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as Coupon["type"] })}
              >
                <option value="PERCENT">Porcentagem</option>
                <option value="FIXED">Valor fixo</option>
                <option value="FREE_SHIPPING">Frete grátis</option>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {form.type !== "FREE_SHIPPING" && (
              <Field label={form.type === "PERCENT" ? "% de desconto" : "Valor (R$)"}>
                <Input value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              </Field>
            )}
            <Field label="Pedido mínimo (R$)">
              <Input
                value={form.minOrder}
                onChange={(e) => setForm({ ...form, minOrder: e.target.value })}
                placeholder="50,00"
              />
            </Field>
            <Field label="Limite de usos">
              <Input
                type="number"
                value={form.maxUses}
                onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
                placeholder="∞"
              />
            </Field>
          </div>
          <Field label="Validade">
            <Input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
          <div className="flex flex-wrap gap-6">
            <Toggle
              checked={form.firstPurchaseOnly}
              onChange={(v) => setForm({ ...form, firstPurchaseOnly: v })}
              label="Somente 1ª compra"
            />
            <Toggle
              checked={form.birthdayOnly}
              onChange={(v) => setForm({ ...form, birthdayOnly: v })}
              label="Somente aniversário"
            />
          </div>
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setModalOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Salvando..." : "Criar cupom"}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
