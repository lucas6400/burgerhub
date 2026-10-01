import { useRef, useState } from "react";
import { api } from "../lib/api";
import { Button, Card } from "../components/ui";

interface Recipient {
  phone: string;
  name: string;
  wrote: string;
  refusedAt: string;
  lastItems?: string;
}

type Audience = "refused" | "buyers";
const DEFAULT_TEXTS: Record<Audience, string> = {
  refused:
    "Oi! Boa notícia: a Casa 63 Hamburgueria agora já entrega na sua região! 🛵🍔 Se quiser pedir, é só responder aqui com o que você quer que eu monto seu pedido.",
  buyers:
    "Oi! Aqui é da Casa 63 Hamburgueria 🍔 Sentimos sua falta! Bora repetir o seu *{ultimo_pedido}*? É só responder aqui que eu já separo pra você! 🍔",
};
const MIN_GAP_S = 25;
const MAX_GAP_S = 55;

const randomGapMs = () => (MIN_GAP_S + Math.random() * (MAX_GAP_S - MIN_GAP_S)) * 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function BroadcastCard() {
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [audience, setAudience] = useState<Audience>("buyers");
  const [text, setText] = useState(DEFAULT_TEXTS.buyers);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const stopRef = useRef(false);

  async function load() {
    setError("");
    setLoading(true);
    try {
      const list = await api.get<Recipient[]>(`/whatsapp/broadcast/recipients?audience=${audience}`);
      setRecipients(list);
      setSelected(new Set(list.map((r) => r.phone)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui carregar a lista.");
    } finally {
      setLoading(false);
    }
  }

  function pickAudience(next: Audience) {
    setAudience(next);
    setText(DEFAULT_TEXTS[next]);
    setRecipients(null);
    setLog([]);
  }

  function toggle(phone: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  }

  async function start() {
    const queue = (recipients ?? []).filter((r) => selected.has(r.phone));
    if (queue.length === 0 || text.trim().length < 5) return;
    if (!window.confirm(`Enviar para ${queue.length} pessoa(s), uma a cada ${MIN_GAP_S}–${MAX_GAP_S} segundos? Mantenha esta tela aberta até terminar.`)) return;
    stopRef.current = false;
    setRunning(true);
    setLog([]);
    for (let i = 0; i < queue.length; i++) {
      if (stopRef.current) {
        setLog((l) => [...l, "⏹️ Parado por você."]);
        break;
      }
      const r = queue[i];
      const label = r.name || r.phone;
      try {
        const res = await api.post<{ status: string; reason?: string }>("/whatsapp/broadcast/send-one", { phone: r.phone, text: text.trim(), audience });
        setLog((l) => [...l, res.status === "sent" ? `✅ ${label}` : `⏭️ ${label} — ${res.reason ?? "pulado"}`]);
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(r.phone);
          return next;
        });
      } catch (err) {
        setLog((l) => [...l, `❌ ${label} — ${err instanceof Error ? err.message : "erro"}`]);
      }
      if (i < queue.length - 1 && !stopRef.current) await sleep(randomGapMs());
    }
    setRunning(false);
  }

  return (
    <Card className="p-5">
      <h3 className="mb-2 text-sm font-semibold">Disparo em massa (com intervalo)</h3>
      <div className="mb-3 flex gap-2">
        {([["buyers", "Clientes antigos (recompra)"], ["refused", "Recusados por área"]] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            disabled={running}
            onClick={() => pickAudience(k)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${audience === k ? "bg-brand-500 text-white" : "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300"}`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mb-3 text-xs leading-relaxed text-surface-500">
        {audience === "buyers"
          ? "Lista quem já comprou e não pede há 3 dias ou mais (o pedido mais recente de cada cliente)."
          : "Lista quem o bot recusou por estar fora da área e nunca comprou (já sem Taquaralto, Aureny e região além da ponte)."}{" "}
        Envia uma mensagem por vez, com intervalo aleatório de {MIN_GAP_S} a {MAX_GAP_S}s pra não arriscar bloqueio do número. Confira a
        lista e desmarque quem não deve receber.
      </p>

      {!recipients ? (
        <Button variant="secondary" size="sm" onClick={load} disabled={loading}>
          {loading ? "Carregando..." : "Carregar lista"}
        </Button>
      ) : (
        <div className="space-y-3">
          <textarea
            className="w-full rounded-xl border border-surface-200 p-3 text-sm"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={running}
          />
          {audience === "buyers" && (
            <p className="text-xs text-surface-500">
              Use <code>{"{ultimo_pedido}"}</code> e <code>{"{nome}"}</code> no texto — cada cliente recebe com os próprios dados no lugar, em vez do mesmo texto pra todo mundo.
            </p>
          )}
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border border-surface-200 p-2">
            {recipients.length === 0 && <p className="p-2 text-xs text-surface-500">Ninguém na lista.</p>}
            {recipients.map((r) => (
              <label key={r.phone} className="flex items-start gap-2 rounded-lg p-2 text-xs hover:bg-surface-50">
                <input type="checkbox" className="mt-0.5" checked={selected.has(r.phone)} onChange={() => toggle(r.phone)} disabled={running} />
                <span>
                  <strong>{r.name || r.phone}</strong> <span className="text-surface-500">({r.phone})</span>
                  <br />
                  <span className="text-surface-500">{r.wrote}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={start} disabled={running || selected.size === 0}>
              {running ? "Enviando..." : `Enviar para ${selected.size}`}
            </Button>
            {running && (
              <Button variant="secondary" size="sm" onClick={() => (stopRef.current = true)}>
                Parar
              </Button>
            )}
          </div>
          {log.length > 0 && <pre className="whitespace-pre-wrap rounded-xl bg-surface-50 p-3 text-xs">{log.join("\n")}</pre>}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
    </Card>
  );
}
