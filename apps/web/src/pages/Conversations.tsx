import { useEffect, useRef, useState } from "react";
import { Bot, Headset, MessageCircle, Send, ShoppingBag } from "lucide-react";
import { api } from "../lib/api";
import { brl, formatDateTime, ORDER_STATUS_LABELS, timeAgo } from "../lib/format";
import { Badge, Card, EmptyState, PageHeader, Skeleton, Toggle, statusBadgeColor } from "../components/ui";

const LIST_POLL_MS = 5_000;
const DETAIL_POLL_MS = 4_000;

interface ConversationListItem {
  phone: string;
  customer: { id: string; name: string; phone: string; tier: string } | null;
  lastMessage: { body: string; direction: string; senderType: string; createdAt: string };
  unreadCount: number;
}

interface Message {
  id: string;
  direction: "IN" | "OUT";
  senderType: "CUSTOMER" | "BOT" | "HUMAN" | "SYSTEM";
  body: string;
  createdAt: string;
}

interface ConversationDetail {
  phone: string;
  customer:
    | {
        id: string;
        name: string;
        phone: string;
        tier: string;
        loyaltyPoints: number;
        orders: { id: string; number: number; status: string; totalCents: number; createdAt: string }[];
      }
    | null;
  messages: Message[];
  botPaused: boolean;
}

const SENDER_LABELS: Record<Message["senderType"], string> = {
  CUSTOMER: "Cliente",
  BOT: "Bot",
  HUMAN: "Você",
  SYSTEM: "Aviso automático",
};

export function ConversationsPage() {
  const [conversations, setConversations] = useState<ConversationListItem[] | null>(null);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    function load() {
      api
        .get<ConversationListItem[]>("/conversations")
        .then((list) => !cancelled && setConversations(list))
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, LIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!selectedPhone) return;
    let cancelled = false;
    function load() {
      api
        .get<ConversationDetail>(`/conversations/${selectedPhone}`)
        .then((d) => !cancelled && setDetail(d))
        .catch(() => {});
    }
    setDetail(null);
    load();
    api.patch(`/conversations/${selectedPhone}/read`, {}).catch(() => {});
    const interval = setInterval(load, DETAIL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [selectedPhone]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [detail?.messages.length]);

  async function sendReply() {
    const text = reply.trim();
    if (!text || !selectedPhone || sending) return;
    setSending(true);
    setReply("");
    try {
      await api.post("/whatsapp/send", { phone: selectedPhone, text });
      const updated = await api.get<ConversationDetail>(`/conversations/${selectedPhone}`);
      setDetail(updated);
    } catch {
      setReply(text);
    } finally {
      setSending(false);
    }
  }

  async function toggleBot(paused: boolean) {
    if (!selectedPhone || !detail) return;
    setDetail({ ...detail, botPaused: paused });
    await api.patch(`/conversations/${selectedPhone}/bot`, { paused }).catch(() => {});
  }

  return (
    <div className="animate-fade-in">
      <PageHeader title="Central de Atendimento" subtitle="Todas as conversas do WhatsApp em um só lugar" />

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Lista de conversas */}
        <Card className="max-h-[75vh] overflow-y-auto p-2 lg:max-h-[75vh]">
          {!conversations ? (
            <div className="space-y-2 p-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : conversations.length === 0 ? (
            <EmptyState
              icon={<Headset size={22} />}
              title="Nenhuma conversa ainda"
              description="As mensagens dos seus clientes no WhatsApp aparecem aqui."
            />
          ) : (
            <div className="space-y-1">
              {conversations.map((c) => (
                <button
                  key={c.phone}
                  onClick={() => setSelectedPhone(c.phone)}
                  className={`flex w-full items-start gap-2.5 rounded-xl p-3 text-left transition-colors ${
                    selectedPhone === c.phone
                      ? "bg-brand-500/10"
                      : "hover:bg-surface-100 dark:hover:bg-surface-850"
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-100 text-sm font-semibold text-surface-500 dark:bg-surface-800">
                    {(c.customer?.name ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{c.customer?.name ?? c.phone}</p>
                      <span className="shrink-0 text-[11px] text-surface-400">{timeAgo(c.lastMessage.createdAt)}</span>
                    </div>
                    <p className="truncate text-xs text-surface-500">
                      {c.lastMessage.direction === "OUT" && "Você: "}
                      {c.lastMessage.body}
                    </p>
                  </div>
                  {c.unreadCount > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                      {c.unreadCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Conversa selecionada */}
        <Card className="flex max-h-[75vh] flex-col overflow-hidden p-0">
          {!selectedPhone ? (
            <EmptyState
              icon={<MessageCircle size={24} />}
              title="Selecione uma conversa"
              description="Escolha um cliente na lista pra ver o histórico e responder."
            />
          ) : !detail ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10" />
              <Skeleton className="h-40" />
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-surface-200 p-4 dark:border-surface-800">
                <div>
                  <p className="font-semibold">{detail.customer?.name ?? detail.phone}</p>
                  <p className="text-xs text-surface-400">{detail.phone}</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-surface-500">
                  <Bot size={14} />
                  {detail.botPaused ? "Bot pausado" : "Bot ativo"}
                  <Toggle checked={!detail.botPaused} onChange={(active) => toggleBot(!active)} />
                </div>
              </div>

              <div className="flex flex-1 overflow-hidden">
                <div className="flex-1 space-y-2 overflow-y-auto p-4">
                  {detail.messages.map((m) => (
                    <div key={m.id} className={`flex ${m.direction === "OUT" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                          m.direction === "OUT"
                            ? m.senderType === "SYSTEM"
                              ? "bg-surface-200 text-surface-600 dark:bg-surface-800 dark:text-surface-300"
                              : "bg-brand-500 text-white"
                            : "bg-surface-100 text-surface-700 dark:bg-surface-800 dark:text-surface-200"
                        }`}
                      >
                        {m.direction === "OUT" && (
                          <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-70">
                            {SENDER_LABELS[m.senderType]}
                          </p>
                        )}
                        <p className="whitespace-pre-wrap">{m.body}</p>
                        <p className="mt-1 text-right text-[10px] opacity-60">{formatDateTime(m.createdAt)}</p>
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>

                {detail.customer && (
                  <div className="hidden w-64 shrink-0 space-y-3 overflow-y-auto border-l border-surface-200 p-4 text-sm md:block dark:border-surface-800">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-surface-400">Cliente</p>
                      <Badge color="amber">{detail.customer.tier}</Badge>
                      <p className="mt-1 text-xs text-surface-500">{detail.customer.loyaltyPoints} pontos</p>
                    </div>
                    <div>
                      <p className="mb-1.5 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-surface-400">
                        <ShoppingBag size={12} /> Pedidos recentes
                      </p>
                      {detail.customer.orders.length === 0 ? (
                        <p className="text-xs text-surface-400">Nenhum pedido ainda.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {detail.customer.orders.map((o) => (
                            <div key={o.id} className="rounded-lg bg-surface-50 p-2 text-xs dark:bg-surface-850">
                              <div className="flex items-center justify-between">
                                <span className="font-medium">#{o.number}</span>
                                <Badge color={statusBadgeColor[o.status]}>{ORDER_STATUS_LABELS[o.status]}</Badge>
                              </div>
                              <p className="mt-0.5 text-surface-500">
                                {brl(o.totalCents)} · {formatDateTime(o.createdAt)}
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2 border-t border-surface-200 p-3 dark:border-surface-800">
                <input
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendReply()}
                  placeholder="Escreva uma mensagem..."
                  className="flex-1 rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-surface-700 dark:bg-surface-850"
                />
                <button
                  onClick={sendReply}
                  disabled={sending || !reply.trim()}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-500 text-white disabled:opacity-40"
                >
                  <Send size={15} />
                </button>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
