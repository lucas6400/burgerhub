import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Minus, Plus, Printer, QrCode, Table2, Trash2, Users } from "lucide-react";
import { api } from "../lib/api";
import { brl } from "../lib/format";
import { printTableBill } from "../lib/print";
import { useAuth } from "../stores/auth";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
} from "../components/ui";
import type { Order, Product, Table } from "../types";

interface CartItem {
  product: Product;
  quantity: number;
}

const PAYMENTS = [
  { value: "CASH", label: "Dinheiro" },
  { value: "PIX", label: "Pix" },
  { value: "CREDIT", label: "Crédito" },
  { value: "DEBIT", label: "Débito" },
  { value: "VR", label: "VR" },
  { value: "VA", label: "VA" },
] as const;

const STATUS_STYLE: Record<string, string> = {
  FREE: "border-surface-200 bg-white dark:border-surface-800 dark:bg-surface-900",
  OPEN: "border-emerald-400 bg-emerald-500/5 dark:border-emerald-500/60",
};

function parseCodeInput(raw: string): { code: string; qty: number } | null {
  const match = raw.trim().toLowerCase().match(/^(\S+?)\s*[*x]\s*(\d+)$/);
  if (match) return { code: match[1], qty: Math.min(99, parseInt(match[2], 10) || 1) };
  const code = raw.trim().toLowerCase();
  return code ? { code, qty: 1 } : null;
}

export function TablesPage() {
  const { user, tenant } = useAuth();
  const canManage = user?.role === "ADMIN" || user?.role === "MANAGER";

  const [tables, setTables] = useState<Table[] | null>(null);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [newTableModal, setNewTableModal] = useState(false);
  const [newTable, setNewTable] = useState({ number: "", seats: "4" });
  const [newTableError, setNewTableError] = useState("");

  const [selected, setSelected] = useState<Table | null>(null);
  const [detailOrders, setDetailOrders] = useState<Order[] | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [launching, setLaunching] = useState(false);

  const [closeModal, setCloseModal] = useState(false);
  const [closePayment, setClosePayment] = useState("CASH");
  const [splitCount, setSplitCount] = useState("1");
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState("");

  const [qrModal, setQrModal] = useState<Table | null>(null);

  function loadTables() {
    api.get<Table[]>("/tables").then(setTables).catch(console.error);
  }
  useEffect(loadTables, []);
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

  async function openTableDetail(table: Table) {
    setSelected(table);
    setCart([]);
    setCodeInput("");
    setCodeError("");
    setCloseError("");
    setSplitCount("1");
    const detail = await api.get<{ orders: Order[] }>(`/tables/${table.id}`);
    setDetailOrders(detail.orders);
  }

  async function refreshDetail(table: Table) {
    const detail = await api.get<{ orders: Order[] }>(`/tables/${table.id}`);
    setDetailOrders(detail.orders);
    loadTables();
  }

  async function createTable(e: FormEvent) {
    e.preventDefault();
    setNewTableError("");
    try {
      await api.post("/tables", { number: Number(newTable.number), seats: Number(newTable.seats) });
      setNewTableModal(false);
      setNewTable({ number: "", seats: "4" });
      loadTables();
    } catch (err) {
      setNewTableError(err instanceof Error ? err.message : "Erro ao criar mesa");
    }
  }

  async function openTable(table: Table) {
    await api.post(`/tables/${table.id}/open`, {});
    const updated = { ...table, status: "OPEN" };
    setSelected(updated);
    loadTables();
    refreshDetail(updated);
  }

  function addToCart(product: Product, qty = 1) {
    setCodeError("");
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id ? { ...i, quantity: Math.min(99, i.quantity + qty) } : i,
        );
      }
      return [...prev, { product, quantity: qty }];
    });
  }

  function handleCodeSubmit() {
    const parsed = parseCodeInput(codeInput);
    if (!parsed) return;
    const product = byCode.get(parsed.code);
    if (!product) {
      setCodeError(`Código "${parsed.code}" não encontrado`);
      return;
    }
    addToCart(product, parsed.qty);
    setCodeInput("");
  }

  function updateCartQty(productId: string, delta: number) {
    setCart((prev) =>
      prev
        .map((i) => (i.product.id === productId ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0),
    );
  }

  async function launchOrder() {
    if (!selected || cart.length === 0) return;
    setLaunching(true);
    try {
      await api.post(`/tables/${selected.id}/orders`, {
        items: cart.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
      });
      setCart([]);
      refreshDetail(selected);
    } catch (err) {
      setCodeError(err instanceof Error ? err.message : "Erro ao lançar pedido");
    } finally {
      setLaunching(false);
    }
  }

  async function handleClose() {
    if (!selected) return;
    setClosing(true);
    setCloseError("");
    try {
      await api.post(`/tables/${selected.id}/close`, { paymentMethod: closePayment });
      if (detailOrders && tenant) {
        printTableBill(detailOrders, selected.number, tenant, Number(splitCount) || undefined);
      }
      setCloseModal(false);
      setSelected(null);
      setDetailOrders(null);
      loadTables();
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Erro ao fechar mesa");
    } finally {
      setClosing(false);
    }
  }

  async function deleteTable(table: Table) {
    if (!confirm(`Excluir a mesa ${table.number}?`)) return;
    try {
      await api.delete(`/tables/${table.id}`);
      loadTables();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao excluir mesa");
    }
  }

  const cartTotal = cart.reduce(
    (s, i) => s + (i.product.promoPriceCents ?? i.product.priceCents) * i.quantity,
    0,
  );
  const detailTotal = (detailOrders ?? []).reduce((s, o) => s + o.totalCents, 0);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Mesas"
        subtitle="Abra, lance pedidos e feche a conta de cada mesa"
        actions={
          canManage && (
            <Button onClick={() => setNewTableModal(true)}>
              <Plus size={16} /> Nova mesa
            </Button>
          )
        }
      />

      {!tables ? (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : tables.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Table2 size={24} />}
            title="Nenhuma mesa cadastrada"
            description="Cadastre as mesas do salão para começar a operar."
            action={
              canManage && (
                <Button onClick={() => setNewTableModal(true)}>
                  <Plus size={16} /> Nova mesa
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {tables.map((t) => (
            <button
              key={t.id}
              onClick={() => openTableDetail(t)}
              className={`rounded-2xl border p-4 text-left shadow-sm transition-all hover:shadow-md ${STATUS_STYLE[t.status] ?? STATUS_STYLE.FREE}`}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-lg font-bold">Mesa {t.number}</span>
                <Badge color={t.status === "OPEN" ? "green" : "gray"}>
                  {t.status === "OPEN" ? "Aberta" : "Livre"}
                </Badge>
              </div>
              <p className="flex items-center gap-1 text-xs text-surface-400">
                <Users size={12} /> {t.seats} lugares
              </p>
              {t.status === "OPEN" && (
                <p className="mt-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                  {brl(t.runningTotalCents ?? 0)}
                </p>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ---------- Modal nova mesa ---------- */}
      <Modal open={newTableModal} onClose={() => setNewTableModal(false)} title="Nova mesa">
        <form onSubmit={createTable} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Número *">
              <Input
                type="number"
                value={newTable.number}
                onChange={(e) => setNewTable({ ...newTable, number: e.target.value })}
                required
                autoFocus
              />
            </Field>
            <Field label="Lugares">
              <Input
                type="number"
                value={newTable.seats}
                onChange={(e) => setNewTable({ ...newTable, seats: e.target.value })}
              />
            </Field>
          </div>
          {newTableError && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {newTableError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setNewTableModal(false)}>
              Cancelar
            </Button>
            <Button type="submit">Criar mesa</Button>
          </div>
        </form>
      </Modal>

      {/* ---------- Modal detalhe da mesa ---------- */}
      <Modal
        open={!!selected}
        onClose={() => {
          setSelected(null);
          setDetailOrders(null);
        }}
        title={selected ? `Mesa ${selected.number}` : ""}
        wide
      >
        {selected && (
          <div className="space-y-4">
            {selected.status === "FREE" ? (
              <div className="py-6 text-center">
                <p className="mb-4 text-sm text-surface-500">Esta mesa está livre.</p>
                <Button onClick={() => openTable(selected)}>Abrir mesa</Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <Badge color="green">Aberta</Badge>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setQrModal(selected)}>
                      <QrCode size={14} /> QR da mesa
                    </Button>
                    {canManage && (
                      <Button size="sm" variant="ghost" onClick={() => deleteTable(selected)}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Pedidos já lançados */}
                {!detailOrders ? (
                  <Skeleton className="h-24" />
                ) : detailOrders.length === 0 ? (
                  <p className="text-sm text-surface-400">Nenhum pedido lançado ainda.</p>
                ) : (
                  <div className="space-y-2 rounded-xl border border-surface-100 p-3 dark:border-surface-800">
                    {detailOrders.map((o) => (
                      <div key={o.id} className="text-sm">
                        <p className="font-medium">
                          Pedido #{o.number} — {brl(o.totalCents)}
                        </p>
                        <p className="text-xs text-surface-400">
                          {o.items.map((i) => `${i.quantity}x ${i.nameSnapshot}`).join(", ")}
                        </p>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-surface-100 pt-2 text-sm font-semibold dark:border-surface-800">
                      <span>Total da mesa</span>
                      <span>{brl(detailTotal)}</span>
                    </div>
                  </div>
                )}

                {/* Lançar novo pedido */}
                <div>
                  <h4 className="mb-2 text-sm font-semibold">Lançar pedido</h4>
                  <div className="mb-2 flex gap-2">
                    <Input
                      value={codeInput}
                      onChange={(e) => {
                        setCodeInput(e.target.value);
                        setCodeError("");
                      }}
                      onKeyDown={(e) => e.key === "Enter" && handleCodeSubmit()}
                      placeholder="Código do produto — ex.: 1 ou 1*2"
                    />
                    <Button type="button" onClick={handleCodeSubmit} disabled={!codeInput.trim()}>
                      Adicionar
                    </Button>
                  </div>
                  {codeError && <p className="mb-2 text-xs text-red-500">{codeError}</p>}

                  {cart.length > 0 && (
                    <div className="mb-3 space-y-2">
                      {cart.map((item) => (
                        <div key={item.product.id} className="flex items-center gap-2 text-sm">
                          <span className="min-w-0 flex-1 truncate">{item.product.name}</span>
                          <div className="flex items-center gap-1.5 rounded-lg border border-surface-200 px-1.5 py-0.5 dark:border-surface-700">
                            <button onClick={() => updateCartQty(item.product.id, -1)} className="p-0.5">
                              <Minus size={12} />
                            </button>
                            <span className="w-5 text-center text-xs font-semibold">{item.quantity}</span>
                            <button onClick={() => updateCartQty(item.product.id, 1)} className="p-0.5">
                              <Plus size={12} />
                            </button>
                          </div>
                          <span className="w-16 shrink-0 text-right text-xs text-surface-400">
                            {brl((item.product.promoPriceCents ?? item.product.priceCents) * item.quantity)}
                          </span>
                        </div>
                      ))}
                      <div className="flex justify-between text-sm font-semibold">
                        <span>Subtotal</span>
                        <span>{brl(cartTotal)}</span>
                      </div>
                      <Button
                        className="w-full"
                        onClick={launchOrder}
                        disabled={launching}
                      >
                        {launching ? "Lançando..." : "Lançar na mesa"}
                      </Button>
                    </div>
                  )}
                </div>

                {closeError && (
                  <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                    {closeError}
                  </p>
                )}
                <Button
                  variant="secondary"
                  className="w-full"
                  disabled={!detailOrders?.length}
                  onClick={() => setCloseModal(true)}
                >
                  Fechar conta
                </Button>
              </>
            )}
          </div>
        )}
      </Modal>

      {/* ---------- Modal fechar conta ---------- */}
      <Modal open={closeModal} onClose={() => setCloseModal(false)} title="Fechar conta">
        <div className="space-y-4">
          <div className="rounded-xl bg-surface-50 p-4 text-center dark:bg-surface-850">
            <p className="text-xs text-surface-400">Total da mesa</p>
            <p className="text-2xl font-bold">{brl(detailTotal)}</p>
          </div>
          <Field label="Forma de pagamento">
            <div className="flex flex-wrap gap-1.5">
              {PAYMENTS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setClosePayment(p.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    closePayment === p.value
                      ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                      : "border-surface-200 text-surface-500 dark:border-surface-700"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Dividir por (pessoas) — só para o cupom">
            <Input
              type="number"
              min={1}
              value={splitCount}
              onChange={(e) => setSplitCount(e.target.value)}
            />
          </Field>
          {splitCount && Number(splitCount) > 1 && (
            <p className="text-sm text-surface-500">
              {Number(splitCount)}x {brl(Math.ceil(detailTotal / Number(splitCount)))} por pessoa
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setCloseModal(false)}>
              Cancelar
            </Button>
            <Button onClick={handleClose} disabled={closing}>
              <Printer size={14} /> {closing ? "Fechando..." : "Fechar e imprimir"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------- Modal QR da mesa ---------- */}
      <Modal open={!!qrModal} onClose={() => setQrModal(null)} title={qrModal ? `QR — Mesa ${qrModal.number}` : ""}>
        {qrModal && (
          <div className="text-center">
            <img
              src={`https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(
                `${window.location.origin}/cardapio/${tenant?.slug}?mesa=${qrModal.number}`,
              )}`}
              alt={`QR Code da mesa ${qrModal.number}`}
              className="mx-auto mb-3 rounded-2xl border border-surface-200 p-2 dark:border-surface-700 dark:bg-white"
            />
            <p className="text-xs text-surface-400">
              O cliente escaneia, entra no cardápio e pede direto pela mesa (só funciona com a mesa aberta).
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
