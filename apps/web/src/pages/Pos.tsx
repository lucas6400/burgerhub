import { useEffect, useMemo, useRef, useState } from "react";
import { Gift, Keyboard, Minus, Plus, Printer, ShoppingCart, Trash2, Zap } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatPhoneBR } from "../lib/format";
import { printOrder } from "../lib/print";
import { Badge, Button, Card, Field, Input, PageHeader, Skeleton, Textarea } from "../components/ui";
import { useAuth } from "../stores/auth";
import type { Customer, Order, Product } from "../types";

interface PosItem {
  product: Product;
  quantity: number;
  notes: string;
}

const ORDER_TYPES = [
  { value: "PICKUP", label: "🥡 Balcão" },
  { value: "DINE_IN", label: "🍽️ No local" },
  { value: "DELIVERY", label: "🛵 Entrega" },
] as const;

const PAYMENTS = [
  { value: "CASH", label: "Dinheiro" },
  { value: "PIX", label: "Pix" },
  { value: "CREDIT", label: "Crédito" },
  { value: "DEBIT", label: "Débito" },
  { value: "VR", label: "VR" },
  { value: "VA", label: "VA" },
] as const;

/** Aceita "5", "5*2" ou "5x2" (código × quantidade). */
function parseCodeInput(raw: string): { code: string; qty: number } | null {
  const match = raw.trim().toLowerCase().match(/^(\S+?)\s*[*x]\s*(\d+)$/);
  if (match) return { code: match[1], qty: Math.min(99, parseInt(match[2], 10) || 1) };
  const code = raw.trim().toLowerCase();
  return code ? { code, qty: 1 } : null;
}

export function PosPage() {
  const { tenant } = useAuth();
  const [products, setProducts] = useState<Product[] | null>(null);
  const [items, setItems] = useState<PosItem[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<string>("PICKUP");
  const [payment, setPayment] = useState<string>("CASH");
  const [changeFor, setChangeFor] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [address, setAddress] = useState({ street: "", number: "", neighborhood: "", city: "" });
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [customerBalance, setCustomerBalance] = useState<Customer | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const digits = customerPhone.replace(/\D/g, "");
    if (digits.length < 10) {
      setCustomerBalance(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<Customer[]>(`/customers?search=${digits}`)
        .then((list) => setCustomerBalance(list.find((c) => c.phone === digits) ?? null))
        .catch(() => setCustomerBalance(null));
    }, 500);
    return () => clearTimeout(timer);
  }, [customerPhone]);

  useEffect(() => {
    api.get<Product[]>("/products").then(setProducts).catch(console.error);
  }, []);

  const byCode = useMemo(() => {
    const map = new Map<string, Product>();
    for (const p of products ?? []) {
      if (p.internalCode) map.set(p.internalCode.toLowerCase(), p);
      if (p.sku) map.set(p.sku.toLowerCase(), p);
    }
    return map;
  }, [products]);

  const total = items.reduce(
    (s, i) => s + (i.product.promoPriceCents ?? i.product.priceCents) * i.quantity,
    0,
  );

  function addProduct(product: Product, qty = 1) {
    if (!product.available) {
      setCodeError(`"${product.name}" está esgotado`);
      return;
    }
    setCodeError("");
    setLastOrder(null);
    setItems((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: Math.min(99, i.quantity + qty) } : i,
        );
      }
      return [...prev, { product, quantity: qty, notes: "" }];
    });
  }

  function updateNotes(productId: string, notes: string) {
    setItems((prev) => prev.map((i) => (i.product.id === productId ? { ...i, notes } : i)));
  }

  function handleCodeSubmit() {
    const parsed = parseCodeInput(codeInput);
    if (!parsed) return;
    const product = byCode.get(parsed.code);
    if (!product) {
      setCodeError(`Código "${parsed.code}" não encontrado`);
      return;
    }
    addProduct(product, parsed.qty);
    setCodeInput("");
    codeRef.current?.focus();
  }

  function updateQty(productId: string, delta: number) {
    setItems((prev) =>
      prev
        .map((i) => (i.product.id === productId ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0),
    );
  }

  async function submit() {
    setError("");
    if (items.length === 0) return;
    if (type === "DELIVERY" && (!address.street || !address.number || !address.neighborhood)) {
      setError("Preencha o endereço de entrega.");
      return;
    }
    const hasCustomer = customerName.trim() && customerPhone.replace(/\D/g, "").length >= 8;
    setSubmitting(true);
    try {
      const isTab = type === "DINE_IN"; // comanda aberta — cobra só quando o pedido ficar pronto
      const order = await api.post<Order>("/orders", {
        type,
        source: "POS",
        paymentMethod: isTab ? undefined : payment,
        changeForCents:
          !isTab && payment === "CASH" && changeFor
            ? Math.round(parseFloat(changeFor.replace(",", ".")) * 100)
            : undefined,
        notes: notes || undefined,
        customer: hasCustomer
          ? { name: customerName.trim(), phone: customerPhone.trim() }
          : undefined,
        address:
          type === "DELIVERY"
            ? { ...address, city: address.city || address.neighborhood }
            : undefined,
        items: items.map((i) => ({ productId: i.product.id, quantity: i.quantity, notes: i.notes || undefined })),
      });
      setLastOrder(order);
      setItems([]);
      setNotes("");
      setChangeFor("");
      setCustomerName("");
      setCustomerPhone("");
      setAddress({ street: "", number: "", neighborhood: "", city: "" });
      codeRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao lançar pedido");
    } finally {
      setSubmitting(false);
    }
  }

  const filteredProducts = (products ?? []).filter(
    (p) =>
      !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.internalCode?.toLowerCase() === search.toLowerCase(),
  );

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="PDV — Balcão"
        subtitle="Digite o código do lanche e pressione Enter"
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        {/* ---------- Coluna esquerda: código + grade ---------- */}
        <div>
          <Card className="mb-4 p-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-500/10 text-brand-500">
                <Zap size={20} />
              </span>
              <div className="flex-1">
                <Input
                  ref={codeRef}
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value);
                    setCodeError("");
                  }}
                  onKeyDown={(e) => e.key === "Enter" && handleCodeSubmit()}
                  placeholder="Código do produto — ex.: 1 ou 1*2 (código × qtd)"
                  className="text-base font-medium"
                  autoFocus
                />
              </div>
              <Button onClick={handleCodeSubmit} disabled={!codeInput.trim()}>
                <Plus size={16} /> Lançar
              </Button>
            </div>
            {codeError && (
              <p className="mt-2 rounded-xl bg-red-500/10 px-3 py-1.5 text-sm text-red-600 dark:text-red-400">
                {codeError}
              </p>
            )}
            <p className="mt-2 flex items-center gap-1.5 text-xs text-surface-400">
              <Keyboard size={12} /> Dica: “2*3” lança 3 unidades do código 2.
            </p>
          </Card>

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar produto..."
            className="mb-3"
          />

          {!products ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {filteredProducts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => addProduct(p)}
                  disabled={!p.available}
                  className="relative rounded-2xl border border-surface-200 bg-white p-3 text-left shadow-sm transition-all hover:border-brand-400 hover:shadow-md active:scale-[0.97] disabled:opacity-40 dark:border-surface-800 dark:bg-surface-900"
                >
                  <span className="absolute right-2 top-2 rounded-lg bg-surface-900 px-2 py-0.5 font-mono text-xs font-bold text-white dark:bg-surface-100 dark:text-surface-900">
                    {p.internalCode ?? "—"}
                  </span>
                  <p className="line-clamp-2 pr-8 text-sm font-semibold">{p.name}</p>
                  <p className="mt-1.5 text-sm font-bold text-brand-600 dark:text-brand-400">
                    {brl(p.promoPriceCents ?? p.priceCents)}
                  </p>
                  {!p.available && <Badge color="red">Esgotado</Badge>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* ---------- Coluna direita: comanda ---------- */}
        <Card className="flex h-fit flex-col p-4 lg:sticky lg:top-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <ShoppingCart size={16} /> Comanda
            {items.length > 0 && <Badge color="amber">{items.reduce((s, i) => s + i.quantity, 0)} itens</Badge>}
          </h3>

          {lastOrder && (
            <div className="mb-3 flex items-center justify-between rounded-xl bg-emerald-500/10 px-3 py-2.5 text-sm">
              <span className="font-medium text-emerald-700 dark:text-emerald-400">
                ✅ Pedido #{lastOrder.number} lançado!
              </span>
              <Button size="sm" variant="secondary" onClick={() => tenant && printOrder(lastOrder, tenant)}>
                <Printer size={14} /> Cupom
              </Button>
            </div>
          )}

          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-surface-400">
              Digite um código ou clique num produto.
            </p>
          ) : (
            <div className="mb-3 space-y-2.5">
              {items.map((item) => (
                <div key={item.product.id}>
                  <div className="flex items-center gap-2">
                    <span className="w-8 shrink-0 rounded-md bg-surface-100 px-1.5 py-0.5 text-center font-mono text-xs font-bold dark:bg-surface-800">
                      {item.product.internalCode}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.product.name}</p>
                      <p className="text-xs text-surface-400">
                        {brl((item.product.promoPriceCents ?? item.product.priceCents) * item.quantity)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 px-1.5 py-0.5 dark:border-surface-700">
                      <button onClick={() => updateQty(item.product.id, -1)} className="p-0.5">
                        <Minus size={13} />
                      </button>
                      <span className="w-5 text-center text-sm font-semibold">{item.quantity}</span>
                      <button onClick={() => updateQty(item.product.id, 1)} className="p-0.5">
                        <Plus size={13} />
                      </button>
                    </div>
                    <button
                      onClick={() => setItems((prev) => prev.filter((i) => i.product.id !== item.product.id))}
                      className="p-1 text-surface-300 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <Input
                    value={item.notes}
                    onChange={(e) => updateNotes(item.product.id, e.target.value)}
                    placeholder="Observação (ex.: sem cebola, ponto da carne...)"
                    className="mt-1 py-1.5 pl-9 text-xs"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Tipo */}
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {ORDER_TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={`rounded-xl border px-2 py-2 text-xs font-medium transition-colors ${
                  type === t.value
                    ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                    : "border-surface-200 text-surface-500 dark:border-surface-700"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {type === "DELIVERY" && (
            <div className="mb-3 space-y-2">
              <div className="grid grid-cols-[1fr_80px] gap-2">
                <Input
                  placeholder="Rua *"
                  value={address.street}
                  onChange={(e) => setAddress({ ...address, street: e.target.value })}
                />
                <Input
                  placeholder="Nº *"
                  value={address.number}
                  onChange={(e) => setAddress({ ...address, number: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Bairro *"
                  value={address.neighborhood}
                  onChange={(e) => setAddress({ ...address, neighborhood: e.target.value })}
                />
                <Input
                  placeholder="Cidade"
                  value={address.city}
                  onChange={(e) => setAddress({ ...address, city: e.target.value })}
                />
              </div>
            </div>
          )}

          {/* Cliente opcional */}
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Input
              placeholder="Cliente (opcional)"
              value={customerName}
              onChange={(e) => setCustomerName(e.target.value)}
            />
            <Input
              placeholder="(11) 91234-5678"
              inputMode="tel"
              value={formatPhoneBR(customerPhone)}
              onChange={(e) => setCustomerPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            />
          </div>

          {customerBalance && (customerBalance.cashbackCents || customerBalance.loyaltyPoints) ? (
            <p className="mb-3 flex items-center gap-1.5 text-xs text-surface-500">
              <Gift size={12} />
              {customerBalance.cashbackCents ? `${brl(customerBalance.cashbackCents)} de cashback` : null}
              {customerBalance.cashbackCents && customerBalance.loyaltyPoints ? " · " : null}
              {customerBalance.loyaltyPoints ? `${customerBalance.loyaltyPoints} pontos` : null}
            </p>
          ) : null}

          {/* Pagamento — pedido "No local" vira comanda aberta, sem cobrar agora */}
          {type === "DINE_IN" ? (
            <p className="mb-3 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              🧾 Comanda aberta — a forma de pagamento é escolhida em Pedidos quando o pedido ficar pronto pra cobrar do cliente.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {PAYMENTS.map((p) => (
                  <button
                    key={p.value}
                    onClick={() => setPayment(p.value)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                      payment === p.value
                        ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                        : "border-surface-200 text-surface-500 dark:border-surface-700"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {payment === "CASH" && (
                <div className="mb-3">
                  <Field label="Troco para (R$)">
                    <Input
                      value={changeFor}
                      onChange={(e) => setChangeFor(e.target.value)}
                      placeholder="100,00"
                    />
                  </Field>
                </div>
              )}
            </>
          )}

          <Textarea
            rows={2}
            placeholder="Observações do pedido..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="mb-3"
          />

          {error && (
            <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          <div className="mb-3 flex items-center justify-between border-t border-surface-100 pt-3 dark:border-surface-800">
            <span className="text-sm text-surface-500">Total</span>
            <span className="text-2xl font-bold tracking-tight">{brl(total)}</span>
          </div>
          <Button size="lg" onClick={submit} disabled={submitting || items.length === 0}>
            {submitting ? "Lançando..." : type === "DINE_IN" ? "Abrir comanda" : "Finalizar pedido"}
          </Button>
        </Card>
      </div>
    </div>
  );
}
