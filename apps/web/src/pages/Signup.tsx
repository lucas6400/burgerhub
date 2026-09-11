import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, Input, Field } from "../components/ui";
import { useAuth } from "../stores/auth";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function SignupPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [restaurantName, setRestaurantName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function handleRestaurantNameChange(value: string) {
    setRestaurantName(value);
    if (!slugTouched) setSlug(slugify(value));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("As senhas não coincidem");
      return;
    }

    setLoading(true);
    try {
      await register({
        restaurantName,
        slug,
        name,
        email,
        password,
        phone: phone || undefined,
      });
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao criar cadastro");
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
          <p className="mt-1 text-sm text-surface-500">Crie a conta da sua hamburgueria</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-surface-200 bg-white p-6 shadow-sm dark:border-surface-800 dark:bg-surface-900"
        >
          <Field label="Nome da hamburgueria">
            <Input
              value={restaurantName}
              onChange={(e) => handleRestaurantNameChange(e.target.value)}
              placeholder="Burger do Lu"
              required
              autoFocus
            />
          </Field>
          <Field label="Endereço do cardápio">
            <div className="flex items-center rounded-xl border border-surface-200 bg-white pl-3.5 text-sm focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 dark:border-surface-700 dark:bg-surface-850">
              <span className="shrink-0 text-surface-400">/cardapio/</span>
              <input
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(slugify(e.target.value));
                }}
                placeholder="burger-do-lu"
                required
                className="w-full bg-transparent py-2.5 pr-3.5 text-surface-900 outline-none dark:text-surface-100"
              />
            </div>
            <p className="mt-1 text-xs text-surface-400">Só letras minúsculas, números e hífens</p>
          </Field>
          <Field label="Seu nome">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome completo"
              required
            />
          </Field>
          <Field label="E-mail">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@hamburgueria.com"
              required
            />
          </Field>
          <Field label="Telefone (opcional)">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(11) 99999-9999"
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              minLength={6}
              required
            />
          </Field>
          <Field label="Confirmar senha">
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </Field>
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={loading}>
            {loading ? "Criando conta..." : "Criar conta"}
          </Button>
          <p className="text-center text-xs text-surface-400">
            Já tem conta?{" "}
            <Link to="/login" className="font-medium text-brand-500 hover:underline">
              Entrar
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
