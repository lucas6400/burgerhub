import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Input, Field } from "../components/ui";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.post("/auth/forgot-password", { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao solicitar redefinição");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4 dark:bg-surface-950">
      <div className="animate-slide-up w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500 text-2xl shadow-lg shadow-brand-500/30">
            🍔
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Esqueceu sua senha?</h1>
          <p className="mt-1 text-sm text-surface-500">Informe seu e-mail e enviamos um link pra redefinir.</p>
        </div>

        <div className="rounded-2xl border border-surface-200 bg-white p-6 shadow-sm dark:border-surface-800 dark:bg-surface-900">
          {sent ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-surface-600 dark:text-surface-300">
                Se <strong>{email}</strong> estiver cadastrado, você vai receber um e-mail com o link de
                redefinição em instantes. Confira também a caixa de spam.
              </p>
              <Link to="/login" className="inline-block text-sm font-medium text-brand-500 hover:underline">
                Voltar para o login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="E-mail">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="voce@hamburgueria.com"
                  required
                  autoFocus
                />
              </Field>
              {error && (
                <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
              )}
              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? "Enviando..." : "Enviar link de redefinição"}
              </Button>
              <p className="text-center text-xs text-surface-400">
                <Link to="/login" className="font-medium text-brand-500 hover:underline">
                  Voltar para o login
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
