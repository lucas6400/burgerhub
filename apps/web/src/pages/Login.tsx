import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Input, Field } from "../components/ui";
import { useAuth } from "../stores/auth";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user = await login(email, password);
      navigate(user.role === "COURIER" ? "/motoboy" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao entrar");
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
          <h1 className="text-2xl font-bold tracking-tight">BurgerHub</h1>
          <p className="mt-1 text-sm text-surface-500">Gestão completa para sua hamburgueria</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-surface-200 bg-white p-6 shadow-sm dark:border-surface-800 dark:bg-surface-900"
        >
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
          <Field label="Senha">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </Field>
          <p className="text-right text-xs">
            <Link to="/esqueci-senha" className="font-medium text-brand-500 hover:underline">
              Esqueci minha senha
            </Link>
          </p>
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={loading}>
            {loading ? "Entrando..." : "Entrar"}
          </Button>
          <p className="text-center text-xs text-surface-400">
            Ainda não tem conta?{" "}
            <Link to="/cadastro" className="font-medium text-brand-500 hover:underline">
              Criar cadastro
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
