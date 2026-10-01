import { useEffect, useState } from "react";
import { Crown, Gift, MessageCircle, Search, Users } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { brl, formatDate, timeAgo } from "../lib/format";
import { Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Skeleton, Textarea } from "../components/ui";

interface CustomerRow {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  birthDate?: string | null;
  ordersCount: number;
  totalSpentCents: number;
  avgTicketCents: number;
  lastOrderAt?: string | null;
  computedTier: string;
  loyaltyPoints: number;
  cashbackCents: number;
  buyXProgress: number;
  hasAppAccess: boolean;
  addresses: { id: string; label: string; street: string; number: string; neighborhood: string }[];
}

interface CustomerDetail extends Omit<CustomerRow, "ordersCount" | "totalSpentCents" | "avgTicketCents" | "lastOrderAt" | "computedTier"> {
  orders: {
    id: string;
    number: number;
    status: string;
    totalCents: number;
    createdAt: string;
    items: { nameSnapshot: string; quantity: number }[];
  }[];
}

const tierColor: Record<string, "gray" | "amber" | "purple" | "blue"> = {
  BRONZE: "gray",
  PRATA: "blue",
  OURO: "amber",
  VIP: "purple",
};

const TABS = ["Todos", "Fidelidade"] as const;

export function CustomersPage() {
  const { tenant, user } = useAuth();
  const canResetAccess = user?.role === "ADMIN" || user?.role === "MANAGER";
  const [resettingAccess, setResettingAccess] = useState(false);
  const [customers, setCustomers] = useState<CustomerRow[] | null>(null);
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [detailRow, setDetailRow] = useState<CustomerRow | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Todos");
  const [messageTarget, setMessageTarget] = useState<CustomerRow | null>(null);
  const [messageText, setMessageText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [sent, setSent] = useState(false);
  const [program, setProgram] = useState<{ type: string; buyX: number; getY: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .get<CustomerRow[]>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ""}`)
        .then(setCustomers)
        .catch(console.error);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    api.get<{ type: string; buyX: number; getY: string }>("/loyalty/program").then(setProgram).catch(console.error);
  }, []);

  async function redeemBuyXGetY() {
    if (!detail) return;
    setRedeeming(true);
    setRedeemError("");
    try {
      const { buyXProgress } = await api.post<{ ok: true; buyXProgress: number }>(
        `/customers/${detail.id}/redeem-buy-x-get-y`,
      );
      setDetail((prev) => (prev ? { ...prev, buyXProgress } : prev));
      setDetailRow((prev) => (prev ? { ...prev, buyXProgress } : prev));
      setCustomers((prev) => prev?.map((c) => (c.id === detail.id ? { ...c, buyXProgress } : c)) ?? prev);
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : "Erro ao resgatar recompensa");
    } finally {
      setRedeeming(false);
    }
  }

  async function openDetail(row: CustomerRow) {
    setDetailRow(row);
    setRedeemError("");
    setDetail(await api.get<CustomerDetail>(`/customers/${row.id}`));
  }

  async function resetAppAccess() {
    if (!detail) return;
    if (!confirm(`Redefinir o acesso de ${detail.name} ao app? Ele(a) vai precisar criar a conta de novo com o mesmo telefone.`)) return;
    setResettingAccess(true);
    try {
      await api.post(`/customers/${detail.id}/reset-app-access`);
      setDetail((prev) => (prev ? { ...prev, hasAppAccess: false } : prev));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao redefinir acesso");
    } finally {
      setResettingAccess(false);
    }
  }

  function openMessageModal(c: CustomerRow) {
    const name = tenant?.name ?? "nosso estabelecimento";
    const defaultText =
      c.cashbackCents > 0
        ? `Olá, ${c.name}! Você tem ${brl(c.cashbackCents)} de cashback esperando por você no ${name}. Use no seu próximo pedido pelo cardápio digital! 🎉`
        : program?.type === "BUY_X_GET_Y" && c.buyXProgress > 0
          ? c.buyXProgress >= program.buyX
            ? `Olá, ${c.name}! Você já completou seus pedidos no ${name} e tem direito a: ${program.getY}. Aproveite! 🎉`
            : `Olá, ${c.name}! Você já fez ${c.buyXProgress} de ${program.buyX} pedidos no ${name} — faltam só ${program.buyX - c.buyXProgress} pra ganhar: ${program.getY}. 🎉`
          : `Olá, ${c.name}! Você tem ${c.loyaltyPoints} pontos de fidelidade no ${name}. 🎉`;
    setMessageTarget(c);
    setMessageText(defaultText);
    setSendError("");
    setSent(false);
  }

  async function sendMessage() {
    if (!messageTarget || !messageText.trim()) return;
    setSending(true);
    setSendError("");
    try {
      await api.post("/whatsapp/send", { phone: messageTarget.phone, text: messageText.trim() });
      setSent(true);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : "Erro ao enviar mensagem");
    } finally {
      setSending(false);
    }
  }

  const loyaltyCustomers = (customers ?? [])
    .filter((c) => c.loyaltyPoints > 0 || c.cashbackCents > 0 || c.buyXProgress > 0)
    .sort(
      (a, b) =>
        b.cashbackCents + b.loyaltyPoints + b.buyXProgress - (a.cashbackCents + a.loyaltyPoints + a.buyXProgress),
    );
  const visibleCustomers = tab === "Fidelidade" ? loyaltyCustomers : customers;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Clientes" subtitle={`${customers?.length ?? 0} clientes cadastrados`} />

      <div className="mb-4 flex gap-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? "bg-brand-500 text-white"
                : "bg-surface-100 text-surface-500 hover:bg-surface-200 dark:bg-surface-800"
            }`}
          >
            {t === "Fidelidade" && <Gift size={13} className="mr-1 inline" />}
            {t}
          </button>
        ))}
      </div>

      <div className="relative mb-4 max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-surface-400" />
        <Input
          placeholder="Buscar por nome ou telefone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {!visibleCustomers ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : visibleCustomers.length === 0 ? (
        <Card>
          <EmptyState
            icon={tab === "Fidelidade" ? <Gift size={24} /> : <Users size={24} />}
            title={tab === "Fidelidade" ? "Ninguém com saldo ainda" : "Nenhum cliente"}
            description={
              tab === "Fidelidade"
                ? "Assim que um cliente ganhar pontos ou cashback, ele aparece aqui."
                : "Os clientes são criados automaticamente quando fazem o primeiro pedido."
            }
          />
        </Card>
      ) : (
        <Card className="divide-y divide-surface-100 overflow-hidden dark:divide-surface-800">
          {visibleCustomers.map((c) => (
            <div
              key={c.id}
              className="flex w-full items-center gap-4 px-4 py-3 transition-colors hover:bg-surface-50 dark:hover:bg-surface-850"
            >
              <button onClick={() => openDetail(c)} className="flex min-w-0 flex-1 items-center gap-4 text-left">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500/10 font-semibold text-brand-600 dark:text-brand-400">
                  {c.name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {c.name}
                    {c.computedTier === "VIP" && <Crown size={13} className="text-purple-500" />}
                  </p>
                  <p className="text-xs text-surface-400">
                    {c.phone} · {c.ordersCount} pedidos
                    {c.lastOrderAt && ` · último ${timeAgo(c.lastOrderAt)}`}
                  </p>
                </div>
                <Badge color={tierColor[c.computedTier]}>{c.computedTier}</Badge>
                {tab === "Fidelidade" ? (
                  <div className="hidden w-32 text-right sm:block">
                    {c.cashbackCents > 0 && (
                      <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                        {brl(c.cashbackCents)}
                      </p>
                    )}
                    {c.loyaltyPoints > 0 && (
                      <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                        {c.loyaltyPoints} pts
                      </p>
                    )}
                    {c.buyXProgress > 0 && program && (
                      <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                        {c.buyXProgress}/{program.buyX} pedidos
                        {c.buyXProgress >= program.buyX && " 🎁"}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="hidden w-28 text-right sm:block">
                    <p className="text-sm font-semibold">{brl(c.totalSpentCents)}</p>
                    <p className="text-[11px] text-surface-400">ticket {brl(c.avgTicketCents)}</p>
                  </div>
                )}
              </button>
              {tab === "Fidelidade" && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => openMessageModal(c)}
                  className="shrink-0"
                >
                  <MessageCircle size={14} /> Mensagem
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}

      <Modal
        open={!!detailRow}
        onClose={() => {
          setDetailRow(null);
          setDetail(null);
        }}
        title={detailRow?.name ?? ""}
      >
        {detailRow && (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl bg-surface-50 p-3 dark:bg-surface-850">
                <p className="text-lg font-bold">{detailRow.ordersCount}</p>
                <p className="text-[11px] text-surface-400">Pedidos</p>
              </div>
              <div className="rounded-xl bg-surface-50 p-3 dark:bg-surface-850">
                <p className="text-lg font-bold">{brl(detailRow.totalSpentCents)}</p>
                <p className="text-[11px] text-surface-400">Total gasto</p>
              </div>
              <div className="rounded-xl bg-surface-50 p-3 dark:bg-surface-850">
                <p className="text-lg font-bold">{brl(detailRow.avgTicketCents)}</p>
                <p className="text-[11px] text-surface-400">Ticket médio</p>
              </div>
            </div>

            <div className="text-sm">
              <p className="text-surface-500">📱 {detailRow.phone}</p>
              {detailRow.email && <p className="text-surface-500">✉️ {detailRow.email}</p>}
              {detailRow.birthDate && (
                <p className="text-surface-500">🎂 {formatDate(detailRow.birthDate)}</p>
              )}
            </div>

            {program?.type === "BUY_X_GET_Y" && detail && (
              <div className="rounded-xl bg-amber-500/10 p-3">
                <p className="text-sm font-medium">
                  🎁 {detail.buyXProgress}/{program.buyX} pedidos — {program.getY}
                </p>
                {detail.buyXProgress >= program.buyX ? (
                  canResetAccess ? (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        className="mt-2"
                        onClick={redeemBuyXGetY}
                        disabled={redeeming}
                      >
                        {redeeming ? "Resgatando..." : "Marcar recompensa como entregue"}
                      </Button>
                      {redeemError && <p className="mt-1 text-xs text-red-500">{redeemError}</p>}
                    </>
                  ) : (
                    <p className="mt-1 text-xs text-surface-500">
                      Já pode resgatar — peça pra um gerente confirmar a entrega.
                    </p>
                  )
                ) : (
                  <p className="mt-1 text-xs text-surface-500">
                    Faltam {program.buyX - detail.buyXProgress} pedido(s) pra completar.
                  </p>
                )}
              </div>
            )}

            {canResetAccess && detail?.hasAppAccess && (
              <Button type="button" variant="secondary" size="sm" onClick={resetAppAccess} disabled={resettingAccess}>
                {resettingAccess ? "Redefinindo..." : "Redefinir acesso ao app"}
              </Button>
            )}

            {detail?.addresses && detail.addresses.length > 0 && (
              <div>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                  Endereços
                </h4>
                {detail.addresses.map((a) => (
                  <p key={a.id} className="text-sm text-surface-500">
                    <span className="font-medium text-surface-700 dark:text-surface-200">{a.label}:</span>{" "}
                    {a.street}, {a.number} — {a.neighborhood}
                  </p>
                ))}
              </div>
            )}

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-surface-400">
                Últimos pedidos
              </h4>
              {!detail ? (
                <Skeleton className="h-24" />
              ) : (
                <div className="max-h-56 space-y-2 overflow-y-auto">
                  {detail.orders.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center justify-between rounded-xl bg-surface-50 px-3 py-2 text-sm dark:bg-surface-850"
                    >
                      <div>
                        <p className="font-medium">
                          #{o.number} · {formatDate(o.createdAt)}
                        </p>
                        <p className="line-clamp-1 text-xs text-surface-400">
                          {o.items.map((i) => `${i.quantity}× ${i.nameSnapshot}`).join(", ")}
                        </p>
                      </div>
                      <span className="shrink-0 font-semibold">{brl(o.totalCents)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={!!messageTarget}
        onClose={() => setMessageTarget(null)}
        title={`Mensagem para ${messageTarget?.name ?? ""}`}
      >
        {messageTarget && (
          <div className="space-y-3">
            <p className="text-xs text-surface-400">📱 {messageTarget.phone}</p>
            <Textarea
              rows={4}
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              disabled={sending || sent}
            />
            {sendError && <p className="text-sm text-red-500">{sendError}</p>}
            {sent ? (
              <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600">
                ✓ Mensagem enviada!
              </p>
            ) : (
              <Button type="button" onClick={sendMessage} disabled={sending || !messageText.trim()}>
                <MessageCircle size={14} /> {sending ? "Enviando..." : "Enviar pelo WhatsApp"}
              </Button>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
