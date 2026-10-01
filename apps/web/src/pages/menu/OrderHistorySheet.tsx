import { useEffect, useState } from "react";
import { MapPinned, ShoppingBag } from "lucide-react";
import { EmptyState, Skeleton } from "../../components/ui";
import { api } from "../../lib/api";
import { brl, formatDateTime, ORDER_STATUS_LABELS, ORDER_TYPE_LABELS } from "../../lib/format";
import { useCustomerAuth } from "../../stores/customerAuth";
import { Sheet } from "./PublicMenu";

interface HistoryOrder {
  id: string;
  number: number;
  status: string;
  type: string;
  totalCents: number;
  createdAt: string;
}

/** Lista os pedidos do cliente logado — resolve a reclamação de perder o link de acompanhamento. */
export function OrderHistorySheet({
  slug,
  onClose,
  onOpenAddresses,
}: {
  slug: string;
  onClose: () => void;
  onOpenAddresses: () => void;
}) {
  const { customer, logout } = useCustomerAuth();
  const [orders, setOrders] = useState<HistoryOrder[] | null>(null);

  useEffect(() => {
    api
      .get<HistoryOrder[]>(`/public/${slug}/account/orders`)
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [slug]);

  return (
    <Sheet title="Meus pedidos" onClose={onClose}>
      {customer && (
        <div className="mb-4 flex items-center justify-between rounded-xl bg-surface-100 px-3 py-2.5 text-sm dark:bg-surface-800">
          <div>
            <p className="font-semibold">{customer.name}</p>
            <p className="text-xs text-surface-400">
              {customer.loyaltyPoints > 0 && `${customer.loyaltyPoints} pontos`}
              {customer.loyaltyPoints > 0 && customer.cashbackCents > 0 && " · "}
              {customer.cashbackCents > 0 && `${brl(customer.cashbackCents)} de cashback`}
            </p>
          </div>
          <button onClick={logout} className="text-xs font-medium text-surface-400 hover:text-red-500">
            Sair
          </button>
        </div>
      )}

      <button
        onClick={onOpenAddresses}
        className="mb-4 flex w-full items-center gap-2 rounded-xl border border-surface-200 px-3 py-2.5 text-sm font-medium text-surface-600 dark:border-surface-700 dark:text-surface-300"
      >
        <MapPinned size={15} /> Meus endereços
      </button>

      {!orders ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <EmptyState icon={<ShoppingBag size={22} />} title="Nenhum pedido ainda" description="Seus pedidos aparecem aqui." />
      ) : (
        <div className="space-y-2">
          {orders.map((o) => (
            <a
              key={o.id}
              href={`/cardapio/${slug}/pedido/${o.id}`}
              className="block rounded-xl border border-surface-200 p-3 transition-colors hover:border-brand-400 dark:border-surface-700"
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="text-sm font-semibold">Pedido #{o.number}</span>
                <span className="text-sm font-semibold text-brand-600 dark:text-brand-400">{brl(o.totalCents)}</span>
              </div>
              <p className="text-xs text-surface-400">
                {ORDER_TYPE_LABELS[o.type] ?? o.type} · {ORDER_STATUS_LABELS[o.status] ?? o.status} · {formatDateTime(o.createdAt)}
              </p>
            </a>
          ))}
        </div>
      )}
    </Sheet>
  );
}
