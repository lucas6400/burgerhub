import { useEffect, useState } from "react";
import { api } from "../lib/api";

const POLL_INTERVAL_MS = 8_000;

interface ConversationSummary {
  unreadCount: number;
}

/** Total de mensagens não lidas na Central de Atendimento, pra badge na sidebar. */
export function useUnreadConversations() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const conversations = await api.get<ConversationSummary[]>("/conversations");
        if (cancelled) return;
        setUnreadCount(conversations.reduce((sum, c) => sum + c.unreadCount, 0));
      } catch {
        // falha de rede pontual — mantém o último estado conhecido
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return unreadCount;
}
