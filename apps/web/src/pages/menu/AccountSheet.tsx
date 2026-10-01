import { useState, type FormEvent } from "react";
import { Field, Input, Button } from "../../components/ui";
import { formatPhoneBR } from "../../lib/format";
import { ApiError } from "../../lib/api";
import { useCustomerAuth } from "../../stores/customerAuth";
import { Sheet } from "./PublicMenu";

/** Login/criar conta do cliente no cardápio — telefone + senha, sem e-mail. */
export function AccountSheet({
  onClose,
  prefillName,
  prefillPhone,
}: {
  onClose: () => void;
  prefillName?: string;
  prefillPhone?: string;
}) {
  const { login, register } = useCustomerAuth();
  const [mode, setMode] = useState<"login" | "register">(prefillPhone ? "register" : "login");
  const [name, setName] = useState(prefillName ?? "");
  const [phone, setPhone] = useState(prefillPhone ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      if (mode === "login") await login(phone, password);
      else await register(name, phone, password);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível concluir. Tente de novo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet title={mode === "login" ? "Entrar" : "Criar conta"} onClose={onClose}>
      <div className="mb-4 flex rounded-xl bg-surface-100 p-1 text-sm font-medium dark:bg-surface-800">
        <button
          type="button"
          onClick={() => setMode("login")}
          className={`flex-1 rounded-lg py-2 transition-colors ${mode === "login" ? "bg-white shadow-sm dark:bg-surface-700" : "text-surface-500"}`}
        >
          Entrar
        </button>
        <button
          type="button"
          onClick={() => setMode("register")}
          className={`flex-1 rounded-lg py-2 transition-colors ${mode === "register" ? "bg-white shadow-sm dark:bg-surface-700" : "text-surface-500"}`}
        >
          Criar conta
        </button>
      </div>

      <form onSubmit={submit} className="space-y-3">
        {mode === "register" && (
          <Field label="Seu nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </Field>
        )}
        <Field label="Telefone">
          <Input
            value={formatPhoneBR(phone)}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
            placeholder="(11) 91234-5678"
            inputMode="numeric"
            required
          />
        </Field>
        <Field label="Senha">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="mínimo 6 caracteres"
            minLength={6}
            required
          />
        </Field>
        {mode === "register" && (
          <p className="text-xs text-surface-400">
            Já pediu aqui antes com esse telefone? Sua conta já nasce com seus pontos e pedidos anteriores.
          </p>
        )}
        {error && <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? "Aguarde..." : mode === "login" ? "Entrar" : "Criar conta"}
        </Button>
      </form>
    </Sheet>
  );
}
