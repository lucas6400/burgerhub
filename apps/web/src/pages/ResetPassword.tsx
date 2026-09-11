import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Input, Field } from "../components/ui";
import { useAuth } from "../stores/auth";

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("As senhas não coincidem.");
      return;
    }
    setLoading(true);
    try {
      const data = await api.post<Parameters<typeof setSession>[0]>("/auth/reset-password", {
        token,
        password,
      });
      setSession(data);
      navigate(data.user.role === "COURIER" ? "/motoboy" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao redefinir senha");
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4 dark:bg-surface-950">
        <div className="w-full max-w-sm rounded-2xl border border-surface-200 bg-white p-6 text-center shadow-sm dark:border-surface-800 dark:bg-surface-900">
          <p className="text-sm text-surface-600 dark:text-surface-300">
            Link inválido. Peça uma nova redefinição de senha.
          </p>
          <Link to="/esqueci-senha" className="mt-4 inline-block text-sm font-medium text-brand-500 hover:underline">
            Esqueci minha senha
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-50 p-4 dark:bg-surface-950">
      <div className="animate-slide-up w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-500 text-2xl shadow-lg shadow-brand-500/30">
            🍔
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Nova senha</h1>
          <p className="mt-1 text-sm text-surface-500">Escolha uma nova senha pra sua conta.</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-surface-200 bg-white p-6 shadow-sm dark:border-surface-800 dark:bg-surface-900"
        >
          <Field label="Nova senha">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              minLength={6}
              required
              autoFocus
            />
          </Field>
          <Field label="Confirmar senha">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              minLength={6}
              required
            />
          </Field>
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={loading}>
            {loading ? "Salvando..." : "Redefinir senha"}
          </Button>
        </form>
      </div>
    </div>
  );
}
