import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { printOrder, type PrintTenant } from "../lib/print";
import type { Order } from "../types";

const POLL_INTERVAL_MS = 15_000;

interface WindowWithWebkitAudio extends Window {
  webkitAudioContext?: typeof AudioContext;
}

function getAudioContextClass(): typeof AudioContext | undefined {
  return window.AudioContext ?? (window as WindowWithWebkitAudio).webkitAudioContext;
}

/** Três tons curtos sintetizados (dó-mi-sol) — sem depender de nenhum arquivo de áudio. */
function playBeep(ctx: AudioContext) {
  const now = ctx.currentTime;
  const notes = [
    { offset: 0, freq: 784 }, // Sol5
    { offset: 0.16, freq: 988 }, // Si5
    { offset: 0.32, freq: 1319 }, // Mi6
  ];
  notes.forEach(({ offset, freq }) => {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.type = "sine";
    oscillator.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.3);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.35);
  });
}

function notifyNewOrder(count: number) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!document.hidden) return; // já está com a aba em foco, o beep basta
  new Notification("Novo pedido!", {
    body: count > 1 ? `${count} pedidos novos chegaram` : "Você tem um pedido novo",
  });
}

/**
 * Alerta sonoro/notificação de pedido novo, independente de qual tela do
 * painel o lojista está — antes só quem estava com o KDS aberto percebia.
 * Retorna a quantidade de pedidos com status NEW no momento (pra um badge).
 *
 * Com `autoPrint` ligado nas configurações, também imprime cada pedido
 * recém-chegado automaticamente — dispara em QUALQUER tela do painel que
 * estiver aberta (útil pra deixar rodando no computador ligado à impressora,
 * seja na tela do KDS ou em qualquer outra).
 */
interface TenantForPrint extends PrintTenant {
  settings?: { address?: string | null; autoPrint?: boolean } | null;
}

export function useNewOrderAlert(tenant?: TenantForPrint | null) {
  const [newCount, setNewCount] = useState(0);
  const seenIds = useRef<Set<string> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const tenantRef = useRef(tenant);
  tenantRef.current = tenant;

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    // O navegador só libera áudio depois de um gesto do usuário na página —
    // aproveita o primeiro clique/tecla pra "destravar" o contexto de áudio.
    function unlockAudio() {
      const AudioCtxClass = getAudioContextClass();
      if (!AudioCtxClass) return;
      if (!audioCtxRef.current) audioCtxRef.current = new AudioCtxClass();
      audioCtxRef.current.resume().catch(() => {});
    }
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    let cancelled = false;

    async function poll() {
      try {
        const orders = await api.get<Order[]>("/orders?active=true");
        if (cancelled) return;
        const pendingNew = orders.filter((o) => o.status === "NEW");

        if (seenIds.current === null) {
          // Primeira carga: só registra o que já existia, sem alertar —
          // senão todo pedido pendente ao abrir o painel dispara o beep.
          seenIds.current = new Set(pendingNew.map((o) => o.id));
          setNewCount(pendingNew.length);
          return;
        }

        const arrived = pendingNew.filter((o) => !seenIds.current!.has(o.id));
        if (arrived.length > 0) {
          notifyNewOrder(arrived.length);
          const currentTenant = tenantRef.current;
          if (currentTenant?.settings?.autoPrint) {
            for (const order of arrived) printOrder(order, currentTenant);
          }
        }
        // Repete o som a cada verificação enquanto houver pedido parado em NEW —
        // não só na chegada, pra não passar despercebido se ninguém ouviu de primeira.
        if (pendingNew.length > 0 && audioCtxRef.current) playBeep(audioCtxRef.current);
        seenIds.current = new Set(pendingNew.map((o) => o.id));
        setNewCount(pendingNew.length);
      } catch {
        // falha de rede pontual — mantém o último estado conhecido
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  return newCount;
}
