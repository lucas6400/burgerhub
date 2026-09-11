import { useEffect, useState } from "react";
import { Gift } from "lucide-react";
import { api } from "../../lib/api";
import { Badge, Card, Field, Input, Select, Toggle } from "../../components/ui";
import type { LoyaltyProgram } from "../../types";

const TYPE_LABELS: Record<string, string> = {
  POINTS: "Pontos",
  CASHBACK: "Cashback",
  BUY_X_GET_Y: "Compre X, leve Y",
};

export function LoyaltyTab() {
  const [program, setProgram] = useState<LoyaltyProgram | null>(null);
  const [saved, setSaved] = useState(false);

  function load() {
    api.get<LoyaltyProgram>("/loyalty/program").then(setProgram).catch(console.error);
  }
  useEffect(load, []);

  async function save(patch: Partial<LoyaltyProgram>) {
    if (!program) return;
    const updated = { ...program, ...patch };
    setProgram(updated);
    await api.put("/loyalty/program", patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!program) return <Card className="max-w-2xl p-5">Carregando...</Card>;

  return (
    <Card className="max-w-2xl space-y-4 p-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Gift size={15} /> Programa de fidelidade
        </h3>
        {saved && <Badge color="green">✓ Salvo</Badge>}
      </div>
      <p className="text-xs text-surface-500">
        Recompense clientes recorrentes com pontos ou cashback aplicados automaticamente no cardápio digital.
      </p>

      <Toggle checked={program.active} onChange={(v) => save({ active: v })} label="Programa ativo" />

      <Field label="Tipo de recompensa">
        <Select value={program.type} onChange={(e) => save({ type: e.target.value })}>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </Field>

      {program.type === "POINTS" && (
        <Field label="Pontos por real gasto">
          <Input
            type="number"
            min={1}
            defaultValue={program.pointsPerReal}
            onBlur={(e) => save({ pointsPerReal: parseInt(e.target.value) || 1 })}
          />
        </Field>
      )}

      {program.type === "CASHBACK" && (
        <Field label="Cashback (% do subtotal)">
          <Input
            type="number"
            min={0}
            max={100}
            step="0.1"
            defaultValue={program.cashbackPct}
            onBlur={(e) => save({ cashbackPct: parseFloat(e.target.value) || 0 })}
          />
        </Field>
      )}

      {program.type === "BUY_X_GET_Y" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Compre X pedidos">
            <Input
              type="number"
              min={1}
              defaultValue={program.buyX}
              onBlur={(e) => save({ buyX: parseInt(e.target.value) || 1 })}
            />
          </Field>
          <Field label="Ganha (descrição)">
            <Input
              defaultValue={program.getY}
              onBlur={(e) => save({ getY: e.target.value })}
            />
          </Field>
        </div>
      )}

      <Field label="Validade dos pontos/cashback (dias)">
        <Input
          type="number"
          min={1}
          defaultValue={program.validityDays}
          onBlur={(e) => save({ validityDays: parseInt(e.target.value) || 90 })}
        />
      </Field>

      {program.type === "CASHBACK" && (
        <p className="text-xs text-surface-400">
          O cliente acumula cashback a cada pedido e pode usar o saldo como desconto num pedido futuro pelo
          cardápio digital (não combina com cupom no mesmo pedido).
        </p>
      )}
      {program.type === "POINTS" && (
        <p className="text-xs text-surface-400">
          Pontos são creditados e ficam visíveis pro cliente — o resgate de pontos por desconto ainda não tem
          botão no cardápio (só o cashback tem resgate ativo por enquanto).
        </p>
      )}
      {program.type === "BUY_X_GET_Y" && (
        <p className="text-xs text-surface-400">
          Este tipo ainda é só um contador de referência — a recompensa é aplicada manualmente pela equipe, sem
          resgate automático no checkout.
        </p>
      )}
    </Card>
  );
}
