import { useCallback, useEffect, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { api } from "../lib/api";
import { formatPhoneBR, timeAgo } from "../lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton } from "../components/ui";

type FlagKey = "FREE_CLAIM" | "HUMAN_CORRECTED" | "ORDER_CHANGE" | "LOOP" | "NO_TEXT_REPLY" | "UNANSWERED";

interface ReviewItem {
  phone: string;
  name: string;
  lastAt: string;
  flags: { key: FlagKey; label: string; detail: string }[];
  messages: { senderType: string; body: string; at: string; flagged: boolean }[];
}

const FILTERS: { key: FlagKey | "ALL"; label: string }[] = [
  { key: "ALL", label: "Todas" },
  { key: "FREE_CLAIM", label: "💸 Taxa sem localização" },
  { key: "ORDER_CHANGE", label: "✏️ Alteração / alergia" },
  { key: "HUMAN_CORRECTED", label: "🙋 Você corrigiu" },
  { key: "UNANSWERED", label: "⏳ Sem resposta" },
  { key: "LOOP", label: "🔁 Repetiu frase" },
  { key: "NO_TEXT_REPLY", label: "🖼️ Só texto" },
];

const HOURS_OPTIONS = [
  { value: 12, label: "12h" },
  { value: 30, label: "30h" },
  { value: 72, label: "3 dias" },
];

const SENDER_LABEL: Record<string, string> = { CUSTOMER: "Cliente", BOT: "Bot", HUMAN: "Você", SYSTEM: "Sistema" };

export function BotReviewPage() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [filter, setFilter] = useState<FlagKey | "ALL">("ALL");
  const [hours, setHours] = useState(30);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api
      .get<ReviewItem[]>(`/conversations/review?hours=${hours}`)
      .then((d) => {
        setItems(d);
        setError("");
      })
      .catch(() => setError("Não consegui carregar agora. Tentando de novo..."));
  }, [hours]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const visible = (items ?? []).filter((i) => filter === "ALL" || i.flags.some((f) => f.key === filter));
  const countOf = (k: FlagKey | "ALL") => (items ?? []).filter((i) => k === "ALL" || i.flags.some((f) => f.key === k)).length;

  return (
    <div className="animate-fade-in">
      <PageHeader title="Revisão do bot" subtitle="Conversas em que algo pode ter dado errado — confira aqui em vez de ler tudo" />

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
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              filter === f.key ? "bg-brand-500 text-white" : "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300"
            }`}
          >
            {f.label} <span className="ml-1 opacity-80">{countOf(f.key)}</span>
          </button>
        ))}
      </div>
      {error && <p className="mb-3 text-xs text-amber-600">{error}</p>}

      {!items ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState icon={<ShieldCheck size={24} />} title="Nada suspeito" description="Nenhuma conversa com esse sinal no período." />
        </Card>
      ) : (
        <div className="space-y-2">
          {visible.map((it) => (
            <Card key={it.phone} className="p-3">
              <button className="w-full text-left" onClick={() => setOpen(open === it.phone ? null : it.phone)}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{it.name}</p>
                    <p className="text-xs text-surface-400">{formatPhoneBR(it.phone.replace(/^55/, ""))}</p>
                  </div>
                  <span className="shrink-0 text-xs text-surface-400">{timeAgo(it.lastAt)}</span>
                </div>
                <div className="mt-2 space-y-1">
                  {it.flags.map((f) => (
                    <p key={f.key} className="text-xs">
                      <Badge color="amber">{f.label}</Badge> <span className="text-surface-500">{f.detail}</span>
                    </p>
                  ))}
                </div>
                <p className="mt-2 text-xs font-medium text-brand-600">{open === it.phone ? "Ocultar conversa" : "Ver conversa"}</p>
              </button>

              {open === it.phone && (
                <div className="mt-2 space-y-1.5 rounded-xl bg-surface-50 p-2 dark:bg-surface-900">
                  {it.messages.map((m, idx) => (
                    <div key={idx} className={`rounded-lg px-2 py-1.5 text-xs ${m.flagged ? "bg-amber-100 dark:bg-amber-900/30" : ""}`}>
                      <b>{SENDER_LABEL[m.senderType] ?? m.senderType}:</b> <span className="whitespace-pre-wrap">{m.body}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-2 flex justify-end">
                <a
                  href={`https://wa.me/${it.phone.replace(/\D/g, "")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-3 py-2 text-xs font-semibold text-white"
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
