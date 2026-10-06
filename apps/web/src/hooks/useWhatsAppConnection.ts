import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

const POLL_INTERVAL_MS = 30_000;
/** Leituras seguidas "fora do ar" antes de avisar — a conexão do WhatsApp oscila por alguns segundos de vez em quando. */
const MISSES_BEFORE_ALERT = 2;
const ORIGINAL_TITLE_KEY = "__burgerhubTitle";

interface WaStatus {
  status: "DISCONNECTED" | "CONNECTING" | "CONNECTED";
}

const connectedFlagKey = (tenantId: string) => `burgerhub.wa.connected.${tenantId}`;

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // sem localStorage (modo privado): segue só com a checagem das conversas
  }
}

/**
 * Detecta WhatsApp desconectado: com a conexão caída o bot NÃO recebe mensagem nenhuma (ninguém é avisado, o cliente
 * fica sem resposta) e um alerta pelo próprio WhatsApp não funciona nessa hora — então o aviso é no painel.
 *
 * Só avisa quem já usou o WhatsApp (já viu "conectado" neste navegador ou tem conversas), pra não incomodar loja que
 * nunca conectou. Falha de rede da própria API não conta como WhatsApp fora do ar.
 */
export function useWhatsAppConnection(enabled: boolean, tenantId: string | undefined): { down: boolean } {
  const [down, setDown] = useState(false);
  const misses = useRef(0);
  const everUsed = useRef<boolean | null>(null);

  useEffect(() => {
    if (!enabled || !tenantId) return;
    let cancelled = false;
    const flagKey = connectedFlagKey(tenantId);
    everUsed.current = readFlag(flagKey) ? true : null;

    async function hasConversations(): Promise<boolean> {
      try {
        const list = await api.get<unknown[]>("/conversations");
        return list.length > 0;
      } catch {
        return false;
      }
    }

    async function check() {
      let status: WaStatus["status"];
      try {
        status = (await api.get<WaStatus>("/whatsapp/status")).status;
      } catch {
        return; // API fora do ar ou sem rede: mantém o último estado conhecido
      }
      if (cancelled) return;
      if (status === "CONNECTED") {
        misses.current = 0;
        everUsed.current = true;
        writeFlag(flagKey);
        setDown(false);
        return;
      }
      misses.current += 1;
      if (misses.current < MISSES_BEFORE_ALERT) return;
      if (everUsed.current === null) everUsed.current = await hasConversations();
      if (!cancelled && everUsed.current) setDown(true);
    }

    check();
    const interval = setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, tenantId]);

  // Título da aba: o aviso aparece mesmo com o painel em segundo plano.
  useEffect(() => {
    const w = window as unknown as Record<string, string | undefined>;
    if (w[ORIGINAL_TITLE_KEY] === undefined) w[ORIGINAL_TITLE_KEY] = document.title;
    const original = w[ORIGINAL_TITLE_KEY] ?? document.title;
    document.title = down ? `⚠️ WhatsApp desconectado — ${original}` : original;
    return () => {
      document.title = original;
    };
  }, [down]);

  return { down };
}
