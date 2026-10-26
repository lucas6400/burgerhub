import { useState } from "react";
import { Download, Printer } from "lucide-react";
import { canOfferDesktopDownload, DESKTOP_APP_DOWNLOAD_URL, getPaperWidthMm, isAutoPrintDevice, isDesktopApp, printTestReceipt, setAutoPrintDevice, setPaperWidthMm, type PaperWidthMm, type PrintTenant } from "../lib/print";
import { Button, Field, Select, Toggle } from "./ui";

/**
 * Impressão DESTE aparelho (cada computador tem a própria impressora e papel; o celular não imprime sozinho):
 * largura do papel, se este aparelho imprime os pedidos novos sozinho e um cupom de teste pra conferir o tamanho.
 */
export function PrintDeviceSettings({ tenant }: { tenant: PrintTenant | null }) {
  const [width, setWidth] = useState<PaperWidthMm>(getPaperWidthMm);
  const [autoDevice, setAutoDevice] = useState(isAutoPrintDevice);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState("");

  async function test() {
    if (!tenant) return;
    setTesting(true);
    setResult("");
    const ok = await printTestReceipt(tenant).catch(() => false);
    setResult(ok ? (isDesktopApp() ? "✓ Enviado para a impressora." : "✓ Enviado — confirme na caixa de impressão do navegador.") : "✗ Não consegui imprimir. Confira se a impressora está ligada, com papel e escolhida acima.");
    setTesting(false);
  }

  return (
    <div className="space-y-3 rounded-xl border border-surface-200 p-3 dark:border-surface-700">
      <p className="text-xs font-semibold uppercase tracking-wide text-surface-400">Impressão neste aparelho</p>
      <Toggle
        checked={autoDevice}
        onChange={(v) => {
          setAutoDevice(v);
          setAutoPrintDevice(v);
        }}
        label="Este aparelho imprime os pedidos novos sozinho"
      />
      <p className="pl-0.5 text-xs text-surface-400">
        Ligue só no computador que tem a impressora. No celular e em outros computadores deixe desligado — senão eles tentam imprimir também.
        {!isDesktopApp() && " No navegador comum ainda aparece a caixa de impressão pra confirmar; o app BurgerHub pra Windows imprime direto, sem confirmar."}
      </p>
      {canOfferDesktopDownload() && (
        <a href={DESKTOP_APP_DOWNLOAD_URL} className="inline-flex items-center gap-2 rounded-xl bg-brand-500 px-3 py-2 text-xs font-semibold text-white">
          <Download size={14} /> Baixar o app BurgerHub para Windows
        </a>
      )}
      <Field label="Largura do papel da impressora">
        <Select
          value={String(width)}
          onChange={(e) => {
            const next: PaperWidthMm = e.target.value === "58" ? 58 : 80;
            setWidth(next);
            setPaperWidthMm(next);
          }}
          className="max-w-[14rem]"
        >
          <option value="80">80 mm (bobina larga)</option>
          <option value="58">58 mm (bobina estreita)</option>
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={test} disabled={testing || !tenant}>
          <Printer size={14} /> {testing ? "Imprimindo..." : "Imprimir cupom de teste"}
        </Button>
        {result && <span className="text-xs">{result}</span>}
      </div>
    </div>
  );
}
