import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { isAutoPrintDevice, printOrder, type PrintTenant } from "../lib/print";

/** Pedidos mais velhos que isso não são impressos sozinhos (ex.: ligar a impressão automática não pode cuspir o dia inteiro). */
const AUTO_PRINT_MAX_AGE_MS = 6 * 3_600_000;
const AUTO_PRINT_MAX_ATTEMPTS = 3;
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
  const [printError, setPrintError] = useState("");
  const printing = useRef(false);
  const printAttempts = useRef<Map<string, number>>(new Map());
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

    /**
     * Impressão automática pelo que o SERVIDOR sabe (printedAt), não pelo que esta tela viu chegar: pedido que entrou com o
     * painel fechado, ou durante um recarregamento, também sai. O primeiro aparelho a "reservar" o pedido imprime; se a
     * impressão falhar, devolve a reserva e tenta de novo na próxima verificação (até 3 vezes), avisando na tela.
     */
    async function printPending(orders: Order[]) {
      const currentTenant = tenantRef.current;
      if (printing.current || !currentTenant?.settings?.autoPrint || !isAutoPrintDevice()) return;
      const oldest = Date.now() - AUTO_PRINT_MAX_AGE_MS;
      const todo = orders
        .filter((o) => !o.printedAt && o.source !== "POS" && o.type !== "DINE_IN" && new Date(o.createdAt).getTime() > oldest)
        .filter((o) => (printAttempts.current.get(o.id) ?? 0) < AUTO_PRINT_MAX_ATTEMPTS)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (todo.length === 0) return;
      printing.current = true;
      try {
        for (const order of todo) {
          const claim = await api.post<{ claimed: boolean }>(`/orders/${order.id}/print-claim`, {}).catch(() => null);
          if (!claim?.claimed) continue; // outro aparelho já imprimiu (ou falhou a rede: tenta na próxima)
          const ok = await printOrder(order, currentTenant).catch(() => false);
          if (ok) {
            setPrintError("");
          } else {
            printAttempts.current.set(order.id, (printAttempts.current.get(order.id) ?? 0) + 1);
            await api.post(`/orders/${order.id}/print-release`, {}).catch(() => {});
            setPrintError(`Não consegui imprimir o pedido #${order.number}. Confira a impressora (ligada, com papel e escolhida em Configurações).`);
          }
        }
      } finally {
        printing.current = false;
      }
    }

    async function poll() {
      try {
        const orders = await api.get<Order[]>("/orders?active=true");
        if (cancelled) return;
        const pendingNew = orders.filter((o) => o.status === "NEW");
        void printPending(orders);

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

  function retryPrint() {
    printAttempts.current.clear();
    setPrintError("");
  }

  return { newCount, printError, retryPrint };
}
