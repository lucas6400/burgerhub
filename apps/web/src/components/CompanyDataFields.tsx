import { useState } from "react";
import { formatCnpj, formatPhoneBR } from "../lib/format";
import { Field, Input } from "./ui";

export interface CompanyData {
  companyLegalName?: string | null;
  companyCnpj?: string | null;
  companyStateRegistration?: string | null;
  companyMunicipalRegistration?: string | null;
  companyPhone?: string | null;
}

/**
 * Dados da empresa que saem no cupom impresso (razão social, CNPJ, inscrições, telefone) — pra quem precisa de um
 * comprovante com identificação do vendedor. Cada campo salva ao sair dele; o CNPJ é conferido pelo servidor.
 */
export function CompanyDataFields({ values, onSave }: { values: CompanyData; onSave: (patch: CompanyData) => Promise<void> }) {
  const [cnpj, setCnpj] = useState(formatCnpj(values.companyCnpj ?? ""));
  const [phone, setPhone] = useState(formatPhoneBR(values.companyPhone ?? ""));
  const [error, setError] = useState("");

  async function save(patch: CompanyData) {
    setError("");
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui salvar");
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-surface-200 p-4 dark:border-surface-700">
      <div>
        <p className="text-sm font-semibold">Dados da empresa (saem no cupom impresso)</p>
        <p className="text-xs text-surface-500">
          Para quem pede um comprovante com a identificação da empresa. O cupom continua sendo um comprovante do pedido, não uma nota fiscal.
        </p>
      </div>
      <Field label="Razão social">
        <Input
          defaultValue={values.companyLegalName ?? ""}
          onBlur={(e) => save({ companyLegalName: e.target.value.trim() || null })}
          placeholder="Ex.: Fulano de Tal LTDA"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="CNPJ">
          <Input
            value={cnpj}
            onChange={(e) => setCnpj(formatCnpj(e.target.value))}
            onBlur={() => save({ companyCnpj: cnpj.replace(/\D/g, "") ? cnpj : null })}
            placeholder="00.000.000/0000-00"
            inputMode="numeric"
          />
        </Field>
        <Field label="Telefone da loja">
          <Input
            value={phone}
            onChange={(e) => setPhone(formatPhoneBR(e.target.value))}
            onBlur={() => save({ companyPhone: phone.replace(/\D/g, "") ? phone : null })}
            placeholder="(63) 90000-0000"
            inputMode="tel"
          />
        </Field>
        <Field label="Inscrição estadual (opcional)">
          <Input
            defaultValue={values.companyStateRegistration ?? ""}
            onBlur={(e) => save({ companyStateRegistration: e.target.value.trim() || null })}
          />
        </Field>
        <Field label="Inscrição municipal (opcional)">
          <Input
            defaultValue={values.companyMunicipalRegistration ?? ""}
            onBlur={(e) => save({ companyMunicipalRegistration: e.target.value.trim() || null })}
          />
        </Field>
      </div>
      {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
