import { useState } from "react";
import { Field, Input } from "./ui";

/**
 * Link da ficha da loja no Google Maps. O bot manda este link (com nome e endereço) quando o cliente pergunta onde a
 * loja fica — abre o local marcado, com fotos e rota. O servidor confere que é mesmo um link do Google Maps.
 */
export function GoogleMapsLinkField({ value, onSave }: { value: string; onSave: (url: string | null) => Promise<void> }) {
  const [url, setUrl] = useState(value);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  async function save() {
    setError("");
    setSaved(false);
    try {
      await onSave(url.trim() || null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui salvar");
    }
  }

  return (
    <Field label="Link da loja no Google Maps">
      <Input value={url} onChange={(e) => setUrl(e.target.value)} onBlur={save} placeholder="https://maps.app.goo.gl/…" inputMode="url" />
      <p className="mt-0.5 text-xs text-surface-500">
        No Google Maps, abra a ficha da loja → Compartilhar → Copiar link. É o que o bot manda quando o cliente pergunta onde fica.
        {saved && <span className="ml-1 font-medium text-emerald-600">Salvo ✓</span>}
      </p>
      {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
    </Field>
  );
}
