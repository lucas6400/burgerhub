import { useEffect, useState } from "react";
import { Store } from "lucide-react";
import { api } from "../lib/api";
import { Card } from "./ui";

interface StatusInfo {
  isOpenOverride: boolean | null;
  openNow: boolean;
}

const OPTIONS: { value: boolean | null; label: string }[] = [
  { value: null, label: "Horário normal" },
  { value: true, label: "Forçar aberta" },
  { value: false, label: "Forçar fechada" },
];

/**
 * Controle rápido de "a loja está aberta agora" — o botão que faltava.
 * Antes só existia "forçar aberta"; fechar fora do horário programado (loja
 * fechou mais cedo, imprevisto etc.) exigia editar a grade de horários da
 * semana inteira. Isso já causou o bot dizer "estamos abertos" com a loja
 * fechada de verdade. Fica em destaque no Dashboard por ser algo que muda
 * no meio do expediente, não só em Configurações.
 */
export function StoreStatusControl() {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    api.get<StatusInfo>("/settings/store-status").then(setStatus).catch(() => {});
  }
  useEffect(load, []);

  async function setOverride(value: boolean | null) {
    if (!status || saving) return;
    setSaving(true);
    setStatus({ ...status, isOpenOverride: value });
    try {
      const next = await api.put<StatusInfo>("/settings", { isOpenOverride: value }).then(load);
      void next;
    } finally {
      setSaving(false);
    }
  }

  if (!status) return null;

  return (
    <Card className={`p-4 ${status.openNow ? "" : "border-red-300 dark:border-red-800"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Store size={18} className={status.openNow ? "text-emerald-500" : "text-red-500"} />
          <div>
            <p className="text-sm font-semibold">
              Loja está {status.openNow ? "ABERTA" : "FECHADA"} agora
              {status.isOpenOverride != null && <span className="ml-1 font-normal text-surface-400">(forçado)</span>}
            </p>
            <p className="text-xs text-surface-500">O bot do WhatsApp usa isso pra saber se pode receber pedido.</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          {OPTIONS.map((o) => (
            <button
              key={String(o.value)}
              onClick={() => setOverride(o.value)}
              disabled={saving}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60 ${
                status.isOpenOverride === o.value
                  ? "bg-brand-500 text-white"
                  : "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {status.isOpenOverride != null && (
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
          {status.isOpenOverride
            ? "Forçado ABERTA — ignora o horário cadastrado até você voltar pra \"Horário normal\"."
            : "Forçado FECHADA — ignora o horário cadastrado até você voltar pra \"Horário normal\". Lembre de voltar quando reabrir!"}
        </p>
      )}
    </Card>
  );
}
