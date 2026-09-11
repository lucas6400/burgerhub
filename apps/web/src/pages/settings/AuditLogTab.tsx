import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";
import { Badge, Button, Card, EmptyState, Skeleton } from "../../components/ui";

interface AuditLogItem {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  detail: string | null;
  createdAt: string;
  userName: string;
}

interface AuditLogResponse {
  items: AuditLogItem[];
  nextCursor: string | null;
}

const ACTION_COLOR: Record<string, "green" | "blue" | "red" | "gray" | "amber"> = {
  CREATE: "green",
  STATUS_CHANGE: "green",
  SETTLE_TABLE: "green",
  UPDATE: "blue",
  UPDATE_PAYMENT_SETTINGS: "blue",
  DELETE: "red",
  LOGIN: "gray",
  REGISTER: "gray",
  WA_CONNECTED: "amber",
  WA_DISCONNECTED: "gray",
};

const ACTION_LABELS: Record<string, string> = {
  CREATE: "Criou",
  UPDATE: "Editou",
  DELETE: "Excluiu",
  STATUS_CHANGE: "Mudou status",
  SETTLE_TABLE: "Fechou mesa",
  UPDATE_PAYMENT_SETTINGS: "Alterou pagamento",
  LOGIN: "Login",
  REGISTER: "Cadastro",
  WA_CONNECTED: "WhatsApp conectado",
  WA_DISCONNECTED: "WhatsApp desconectado",
};

function formatDetail(detail: string | null): string | null {
  if (!detail) return null;
  try {
    const parsed = JSON.parse(detail);
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
  } catch {
    return detail;
  }
}

export function AuditLogTab() {
  const [items, setItems] = useState<AuditLogItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  function load() {
    api
      .get<AuditLogResponse>("/settings/audit-log")
      .then((res) => {
        setItems(res.items);
        setNextCursor(res.nextCursor);
      })
      .catch(() => setItems([]));
  }
  useEffect(load, []);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<AuditLogResponse>(`/settings/audit-log?cursor=${nextCursor}`);
      setItems((prev) => [...(prev ?? []), ...res.items]);
      setNextCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  if (!items) return <Skeleton className="h-64" />;

  return (
    <Card className="max-w-2xl p-5">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck size={15} /> Log de auditoria
      </h3>
      <p className="mb-4 text-xs text-surface-500">
        Ações sensíveis registradas automaticamente: pedidos, cupons, equipe, pagamentos e entrega.
      </p>

      {items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={24} />}
          title="Nenhum registro ainda"
          description="As próximas ações sensíveis vão aparecer aqui."
        />
      ) : (
        <>
          <div className="divide-y divide-surface-100 dark:divide-surface-800">
            {items.map((item) => (
              <div key={item.id} className="py-2.5 text-sm">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <Badge color={ACTION_COLOR[item.action] ?? "gray"}>
                      {ACTION_LABELS[item.action] ?? item.action}
                    </Badge>
                    <span className="font-medium">{item.entity}</span>
                  </span>
                  <span className="shrink-0 text-xs text-surface-400">{formatDateTime(item.createdAt)}</span>
                </div>
                <p className="text-xs text-surface-400">
                  {item.userName}
                  {formatDetail(item.detail) && ` · ${formatDetail(item.detail)}`}
                </p>
              </div>
            ))}
          </div>
          {nextCursor && (
            <Button variant="secondary" size="sm" className="mt-4 w-full" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Carregando..." : "Carregar mais"}
            </Button>
          )}
        </>
      )}
    </Card>
  );
}
