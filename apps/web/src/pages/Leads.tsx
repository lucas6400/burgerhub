import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Users } from "lucide-react";
import { api } from "../lib/api";
import { formatPhoneBR, ORDER_STATUS_LABELS, timeAgo } from "../lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "../components/ui";

type Stage = "ORDERED" | "OUT_OF_AREA" | "HUMAN" | "GHOSTED" | "BUILDING" | "ASKING";

interface Lead {
  phone: string;
  name: string;
  stage: Stage;
  lastAt: string;
  lastFrom: "CUSTOMER" | "BOT" | "HUMAN" | "SYSTEM";
  snippet: string;
  items?: string;
  orderNumber?: number;
  orderStatus?: string;
  followUpSent?: boolean;
  declined?: boolean;
}

const STAGES: { key: Stage; label: string; emoji: string; hint: string }[] = [
  { key: "BUILDING", label: "Montando pedido", emoji: "🛒", hint: "Já escolheram itens e ainda não fecharam." },
  { key: "ASKING", label: "Perguntando", emoji: "💬", hint: "Conversando, ainda sem itens no carrinho." },
  { key: "GHOSTED", label: "Sumiu", emoji: "👻", hint: "Parou de responder há mais de 30 min ou disse que desistiu." },
  { key: "ORDERED", label: "Pediu", emoji: "✅", hint: "Já fez pedido nas últimas horas." },
  { key: "HUMAN", label: "Com a equipe", emoji: "🙋", hint: "Você/equipe assumiu — o bot fica calado." },
  { key: "OUT_OF_AREA", label: "Fora da área", emoji: "🚫", hint: "Mandou local que não atendemos." },
];

const HOURS_OPTIONS = [
  { value: 12, label: "12h" },
  { value: 30, label: "30h" },
  { value: 72, label: "3 dias" },
];

const FROM_LABEL: Record<Lead["lastFrom"], string> = {
  CUSTOMER: "Cliente",
  BOT: "Bot",
  HUMAN: "Você",
  SYSTEM: "Sistema",
};

export function LeadsPage() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [tab, setTab] = useState<Stage>("BUILDING");
  const [hours, setHours] = useState(30);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get<Lead[]>(`/conversations/leads?hours=${hours}`)
      .then((d) => {
        setLeads(d);
        setError("");
      })
      .catch(() => setError("Não consegui carregar agora. Tentando de novo..."));
  }, [hours]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const counts = new Map<Stage, number>();
  for (const l of leads ?? []) counts.set(l.stage, (counts.get(l.stage) ?? 0) + 1);
  const current = STAGES.find((s) => s.key === tab)!;
  const visible = (leads ?? []).filter((l) => l.stage === tab);

  return (
    <div className="animate-fade-in">
      <PageHeader title="Leads" subtitle="Quem está pedindo, quem sumiu e quem já pediu — tudo do WhatsApp em um lugar" />

      <div className="mb-3 flex items-center gap-2 text-xs text-surface-500">
        <span>Período:</span>
        {HOURS_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setHours(o.value)}
            className={`rounded-full px-3 py-1 font-medium ${
              hours === o.value ? "bg-brand-500 text-white" : "bg-surface-100 text-surface-500 dark:bg-surface-800"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        {STAGES.map((s) => (
          <button
            key={s.key}
            onClick={() => setTab(s.key)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              tab === s.key ? "bg-brand-500 text-white" : "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300"
            }`}
          >
            {s.emoji} {s.label} <span className="ml-1 opacity-80">{counts.get(s.key) ?? 0}</span>
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs text-surface-400">{current.hint}</p>
      {error && <p className="mb-3 text-xs text-amber-600">{error}</p>}

      {!leads ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={<Users size={24} />} title="Ninguém aqui agora" description="Quando alguém entrar nessa situação, aparece nesta lista." />
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((l) => (
            <Card key={l.phone} className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{l.name}</p>
                  <p className="text-xs text-surface-400">{formatPhoneBR(l.phone.replace(/^55/, ""))}</p>
                </div>
                <span className="shrink-0 text-xs text-surface-400">{timeAgo(l.lastAt)}</span>
              </div>

              {l.items && (
                <p className="mt-2 text-sm">
                  🛒 <span className="font-medium">{l.items}</span>
                </p>
              )}
              {l.orderNumber != null && (
                <p className="mt-2 text-sm">
                  ✅ Pedido #{l.orderNumber}
                  {l.orderStatus ? ` — ${ORDER_STATUS_LABELS[l.orderStatus] ?? l.orderStatus}` : ""}
                </p>
              )}
              <p className="mt-1.5 line-clamp-2 text-xs text-surface-500">
                <b>{FROM_LABEL[l.lastFrom]}:</b> {l.snippet}
              </p>

              <div className="mt-2 flex items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  {l.followUpSent && <Badge color="blue">Retomada enviada</Badge>}
                  {l.declined && <Badge color="red">Desistiu</Badge>}
                  {l.stage === "GHOSTED" && !l.followUpSent && !l.declined && <Badge color="amber">Sem resposta</Badge>}
                </div>
                <a
                  href={`https://wa.me/${l.phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-white"
                >
                  <ExternalLink size={13} /> Abrir no WhatsApp
                </a>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
