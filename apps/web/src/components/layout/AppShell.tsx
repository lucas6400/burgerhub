import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  Activity,
  BarChart3,
  Bike,
  ChefHat,
  ExternalLink,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Moon,
  Package,
  Settings,
  ShoppingBag,
  Store,
  Sun,
  Table2,
  Tag,
  Truck,
  Users,
  UtensilsCrossed,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "../../stores/auth";
import { useNewOrderAlert } from "../../hooks/useNewOrderAlert";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/pdv", label: "PDV — Balcão", icon: Store },
  { to: "/mesas", label: "Mesas", icon: Table2 },
  { to: "/pedidos", label: "Pedidos", icon: ShoppingBag },
  { to: "/entregas", label: "Entregas", icon: Truck, hideForRoles: ["KITCHEN", "COURIER"] },
  { to: "/entregas-metricas", label: "Métricas de Entrega", icon: Activity, hideForRoles: ["KITCHEN", "COURIER"] },
  { to: "/entregadores", label: "Entregadores", icon: Bike, hideForRoles: ["KITCHEN", "COURIER"] },
  { to: "/kds", label: "Cozinha (KDS)", icon: ChefHat },
  { to: "/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { to: "/produtos", label: "Produtos", icon: UtensilsCrossed },
  { to: "/clientes", label: "Clientes", icon: Users },
  { to: "/cupons", label: "Cupons", icon: Tag },
  { to: "/estoque", label: "Estoque", icon: Package },
  { to: "/financeiro", label: "Financeiro", icon: Wallet },
  { to: "/relatorios", label: "Relatórios", icon: BarChart3 },
  { to: "/configuracoes", label: "Configurações", icon: Settings },
];

function useDarkMode() {
  const [dark, setDark] = useState(
    () =>
      localStorage.getItem("burgerhub.theme") === "dark" ||
      (!localStorage.getItem("burgerhub.theme") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches),
  );
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("burgerhub.theme", dark ? "dark" : "light");
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function AppShell() {
  const { user, tenant, loading, logout } = useAuth();
  const { dark, toggle } = useDarkMode();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const newOrderCount = useNewOrderAlert(tenant);
  const navigate = useNavigate();
  const kdsEnabled = tenant?.settings?.kdsEnabled ?? true;

  useEffect(() => {
    if (loading) return;
    if (!user) navigate("/login");
    else if (user.role === "COURIER") navigate("/motoboy"); // entregador tem área própria, sem o painel administrativo
  }, [loading, user, navigate]);

  if (loading || !user) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  const nav = (
    <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
      {NAV_ITEMS.filter((item) => !item.hideForRoles?.includes(user.role)).map(({ to, label, icon: Icon, end }) => {
        const kdsDisabled = to === "/kds" && !kdsEnabled;
        if (kdsDisabled) {
          return (
            <span
              key={to}
              title="Ative o KDS em Configurações → Geral para usar a cozinha"
              className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-surface-300 dark:text-surface-700"
            >
              <Icon size={18} strokeWidth={2} />
              {label}
            </span>
          );
        }
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={() => setSidebarOpen(false)}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-brand-500/10 text-brand-600 dark:text-brand-400"
                  : "text-surface-500 hover:bg-surface-100 hover:text-surface-800 dark:text-surface-400 dark:hover:bg-surface-800/60 dark:hover:text-surface-100"
              }`
            }
          >
            <Icon size={18} strokeWidth={2} />
            {label}
            {to === "/pedidos" && newOrderCount > 0 && (
              <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white">
                {newOrderCount}
              </span>
            )}
          </NavLink>
        );
      })}
      <a
        href={`/cardapio/${tenant?.slug}`}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-surface-500 transition-colors hover:bg-surface-100 hover:text-surface-800 dark:text-surface-400 dark:hover:bg-surface-800/60"
      >
        <ExternalLink size={18} />
        Cardápio Digital
      </a>
    </nav>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Menu em drawer — aberto pelo botão flutuante, desliza da direita em qualquer tamanho de tela */}
      <div
        className={`fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          sidebarOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={() => setSidebarOpen(false)}
      />
      <aside
        className={`fixed inset-y-0 right-0 z-40 flex w-64 flex-col bg-white py-5 shadow-2xl transition-transform duration-300 ease-in-out dark:bg-surface-900 ${
          sidebarOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="mb-6 flex items-center justify-between px-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 text-lg">🍔</span>
            <p className="text-sm font-semibold">{tenant?.name}</p>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="p-1 text-surface-400">
            <X size={20} />
          </button>
        </div>
        {nav}
        <div className="border-t border-surface-200 px-3 pt-3 dark:border-surface-800">
          <button
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-surface-500 transition-colors hover:bg-red-500/10 hover:text-red-500"
          >
            <LogOut size={18} />
            Sair
          </button>
        </div>
      </aside>

      {/* Botão flutuante — único jeito de abrir o menu, em qualquer tela (estilo ggCheckout) */}
      <button
        onClick={() => setSidebarOpen(true)}
        className={`fixed bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-brand-500 text-white shadow-lg shadow-brand-500/30 transition-all duration-300 hover:scale-105 active:scale-95 ${
          sidebarOpen ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100"
        }`}
        title="Abrir menu"
      >
        <Menu size={22} />
      </button>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-surface-200 bg-white/80 px-4 backdrop-blur-md sm:px-6 dark:border-surface-800 dark:bg-surface-900/80">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-base shadow-sm shadow-brand-500/30">
              🍔
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{tenant?.name}</p>
              <p className="text-[11px] leading-tight text-surface-400">BurgerHub</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggle}
              className="rounded-xl p-2 text-surface-500 transition-colors hover:bg-surface-100 dark:hover:bg-surface-800"
              title={dark ? "Modo claro" : "Modo escuro"}
            >
              {dark ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <div className="flex items-center gap-2.5 rounded-xl px-2 py-1">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-500/15 text-sm font-semibold text-brand-600 dark:text-brand-400">
                {user.name.charAt(0).toUpperCase()}
              </span>
              <div className="hidden sm:block">
                <p className="text-sm font-medium leading-tight">{user.name}</p>
                <p className="text-[11px] leading-tight text-surface-400">{user.role}</p>
              </div>
            </div>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
