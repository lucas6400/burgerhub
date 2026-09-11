import { useState, useEffect, useRef, type MouseEvent } from "react";
import {
  Store,
  QrCode,
  PackageCheck,
  Flame,
  Bike,
  TrendingUp,
  Gift,
  Printer,
  CheckCircle2,
  Check,
  Info,
  XCircle,
  ArrowRight,
  Sun,
  Moon,
  Menu,
  X,
  ChefHat,
  Sparkles,
  ChevronRight,
  ShieldCheck,
  RotateCw,
} from "lucide-react";

// Hook de animação de entrada com IntersectionObserver (respeitando prefers-reduced-motion)
function useInView(options = { threshold: 0.15 }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [isInView, setIsInView] = useState(false);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsInView(true);
        observer.disconnect(); // Anima apenas uma vez
      }
    }, options);

    if (ref.current) {
      observer.observe(ref.current);
    }

    return () => observer.disconnect();
  }, [options]);

  return { ref, isInView };
}

// Contador animado usando requestAnimationFrame (executado 1x ao entrar na viewport)
interface CounterProps {
  end: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  startAnimation: boolean;
}

function AnimatedCounter({ end, prefix = "", suffix = "", decimals = 0, duration = 1200, startAnimation }: CounterProps) {
  const [value, setValue] = useState(0);
  const animatedRef = useRef(false);

  useEffect(() => {
    if (!startAnimation || animatedRef.current) return;
    animatedRef.current = true;

    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setValue(end);
      return;
    }

    let startTime: number | null = null;

    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);

      // Easing out quad
      const easedProgress = 1 - (1 - progress) * (1 - progress);
      const currentVal = easedProgress * end;

      setValue(currentVal);

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        setValue(end);
      }
    };

    requestAnimationFrame(step);
  }, [startAnimation, end, duration]);

  const formatted =
    decimals > 0
      ? value.toLocaleString("pt-BR", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : Math.floor(value).toLocaleString("pt-BR");

  return (
    <span>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}

const REGISTER_URL = "/cadastro";
const LOGIN_URL = "/login";

export function LandingPage() {
  // Tema (claro/escuro) — mesma chave de localStorage usada no painel (AppShell),
  // pra quem alterna o tema aqui já entrar com a preferência certa depois do login.
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => {
    const savedTheme = localStorage.getItem("burgerhub.theme");
    if (savedTheme) return savedTheme === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [isAnnual, setIsAnnual] = useState(false);
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});

  const toggleFlip = (index: number, e?: MouseEvent) => {
    if (e) e.stopPropagation();
    setFlippedCards((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  useEffect(() => {
    const root = document.documentElement;
    if (isDarkMode) {
      root.classList.add("dark");
      localStorage.setItem("burgerhub.theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("burgerhub.theme", "light");
    }
  }, [isDarkMode]);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const toggleDarkMode = () => setIsDarkMode((prev) => !prev);

  // Intersection Observers para cada seção
  const heroMockup = useInView({ threshold: 0.1 });
  const painSection = useInView({ threshold: 0.1 });
  const featuresSection = useInView({ threshold: 0.05 });
  const stepsSection = useInView({ threshold: 0.1 });
  const pricingSection = useInView({ threshold: 0.05 });
  const ctaSection = useInView({ threshold: 0.1 });

  // 8 Recursos com detalhes ricos para o flip 3D
  const features = [
    {
      icon: Store,
      title: "PDV — Balcão",
      description: "Lance pedidos por código em segundos, com comanda aberta para consumo no local — cobra só na entrega.",
      tag: "Balcão & Mesas",
      details: [
        "Venda express por código rápido ou leitor",
        "Comandas abertas por mesa ou nome do cliente",
        "Divisão fácil da conta em múltiplos pagamentos (Pix + Cartão + Dinheiro)",
        "Lançamento de adicionais (bacon extra, dobro de queijo) em 1 clique",
      ],
    },
    {
      icon: QrCode,
      title: "Cardápio digital com pagamento",
      description: "Seu cliente pede e paga online (Pix ou cartão) direto pelo link do cardápio, sem app nenhum pra baixar.",
      tag: "Pix e Cartão Direto",
      details: [
        "Link próprio com a logo e cores da sua hamburgueria",
        "QR Code de mesa para o cliente pedir sem chamar o garçom",
        "Pix com baixa instantânea na tela e confirmação automática",
        "Pagamento no cartão de crédito direto pelo navegador do cliente",
      ],
    },
    {
      icon: PackageCheck,
      title: "Estoque e ficha técnica",
      description: "Baixa automática de pães, blends, queijos e embalagens a cada venda. Saiba o custo e o lucro real de cada hambúrguer.",
      tag: "Controle de insumos",
      details: [
        "Baixa proporcional por receita (carne, pão, queijo e molhos)",
        "Alerta visual automático quando o estoque de algum item estiver baixo",
        "Cálculo automático de Food Cost e Custo de Mercadoria (CMV)",
        "Evite que falte hambúrguer no meio da noite de sexta e sábado",
      ],
    },
    {
      icon: Flame,
      title: "Cozinha organizada (KDS)",
      description: "Tela dedicada pra cozinha acompanhar o preparo por status, sem papel e sem perder pedido.",
      tag: "Zero papel",
      details: [
        "Separação visual por cores de tempo de espera (verde, amarelo e vermelho)",
        "Filtro por estação de preparo (Chapa, Fritadeira e Montagem)",
        "Alerta sonoro customizável a cada novo pedido que entra",
        "Elimina perda de comandas de papel engorduradas ou molhadas",
      ],
    },
    {
      icon: Bike,
      title: "Central de Despacho",
      description: "Mapa ao vivo dos entregadores, sugestão de quem despachar, agrupamento de rotas e app próprio pro motoboy.",
      tag: "Rotas inteligentes",
      details: [
        "Rastreamento e status de entrega dos motoboys em tempo real",
        "Agrupamento inteligente de múltiplos pedidos na mesma região",
        "App exclusivo do entregador integrado ao Google Maps e Waze",
        "Relatório automático de taxas e diárias a pagar aos motoboys",
      ],
    },
    {
      icon: TrendingUp,
      title: "Financeiro e relatórios",
      description: "Fluxo de caixa, ticket médio, produtos mais vendidos e horários de pico — tudo calculado sozinho.",
      tag: "Métricas em tempo real",
      details: [
        "Gráfico de horários de pico pra planejar equipe e chapa",
        "Ranking dos hambúrgueres e combos mais vendidos e mais lucrativos",
        "Fechamento de caixa diário por operador e canal de venda",
        "Exportação de relatórios completos em PDF ou Excel",
      ],
    },
    {
      icon: Gift,
      title: "Cupons e fidelidade",
      description: "Cashback, pontos e cupons de desconto pra fazer o cliente voltar, sem precisar de outra ferramenta.",
      tag: "Fidelização",
      details: [
        "Criação de cupons de desconto por valor fixo ou porcentagem",
        "Programa de fidelidade: a cada X compras ganha um burger ou combo",
        "Cashback automático vinculado ao número de telefone do cliente",
        "Aumente a taxa de recompra sem depender de promoções de terceiros",
      ],
    },
    {
      icon: Printer,
      title: "App desktop com impressão",
      description: "Instala no computador da loja e imprime o pedido sozinho na térmica assim que ele chega.",
      tag: "Impressão térmica",
      details: [
        "Compatível com impressoras térmicas de 58mm e 80mm (USB, Rede e Serial)",
        "Impressão automática com corte de guilhotina na chegada do pedido",
        "Vias separadas: Via da Cozinha (sem preço) e Via do Cliente/Entrega",
        "Roda em segundo plano no Windows e Mac sem travar o computador",
      ],
    },
  ];

  const painPoints = [
    "Anota pedido no papel e erra o endereço da entrega",
    "Fica trocando entre caderno, maquininha e iFood sem saber o lucro real",
    "Não sabe quanto pagou de motoboy no mês",
    "Perde cliente porque o cardápio não abre direito no celular",
  ];

  const steps = [
    {
      number: "01",
      title: "Crie sua conta",
      description: "Cadastre sua hamburgueria em menos de 2 minutos, sem cartão de crédito e sem burocracia.",
    },
    {
      number: "02",
      title: "Monte seu cardápio",
      description: "Adicione produtos, fotos e preços — seu link de pedidos já sai pronto pra compartilhar.",
    },
    {
      number: "03",
      title: "Comece a vender",
      description: "Receba pedidos pelo cardápio digital, balcão ou delivery, tudo caindo no mesmo painel.",
    },
  ];

  return (
    <div className="min-h-screen bg-white dark:bg-surface-950 text-surface-900 dark:text-surface-100 transition-colors duration-200">
      {/* =========================================================================
          1. HEADER FIXO (STICKY)
      ========================================================================== */}
      <header
        className={`sticky top-0 z-50 w-full transition-all duration-200 ${
          scrolled
            ? "bg-white/85 dark:bg-surface-950/85 backdrop-blur-md border-b border-surface-200/80 dark:border-surface-800/80 shadow-sm"
            : "bg-white/50 dark:bg-surface-950/50 backdrop-blur-sm border-b border-transparent"
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <a href="#" className="flex items-center gap-3 group focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded-xl">
            <div className="w-10 h-10 rounded-2xl bg-brand-500 flex items-center justify-center text-xl shadow-md group-hover:scale-105 transition-transform duration-200">
              🍔
            </div>
            <div className="flex flex-col">
              <span className="text-xl font-bold tracking-tight text-surface-900 dark:text-white">
                Burger<span className="text-brand-500">Hub</span>
              </span>
              <span className="text-[10px] uppercase font-semibold tracking-wider text-surface-400 -mt-1">
                Gestão de Hamburguerias
              </span>
            </div>
          </a>

          <nav className="hidden md:flex items-center gap-8 text-sm font-medium text-surface-600 dark:text-surface-300">
            <a href="#dores" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
              Por que o BurgerHub?
            </a>
            <a href="#recursos" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
              Recursos
            </a>
            <a href="#como-funciona" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
              Como Funciona
            </a>
            <a href="#planos" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
              Planos
            </a>
          </nav>

          <div className="hidden sm:flex items-center gap-3">
            <button
              onClick={toggleDarkMode}
              className="p-2.5 rounded-2xl text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={isDarkMode ? "Mudar para modo claro" : "Mudar para modo escuro"}
              title={isDarkMode ? "Mudar para modo claro" : "Mudar para modo escuro"}
            >
              {isDarkMode ? <Sun className="w-5 h-5 text-brand-400" /> : <Moon className="w-5 h-5" />}
            </button>

            <a
              href={LOGIN_URL}
              className="px-4 py-2.5 text-sm font-semibold rounded-2xl text-surface-700 dark:text-surface-200 hover:text-surface-900 dark:hover:text-white hover:bg-surface-100 dark:hover:bg-surface-800 transition-all active:scale-[0.98] focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Entrar
            </a>

            <a
              href={REGISTER_URL}
              className="px-5 py-2.5 text-sm font-bold rounded-2xl bg-brand-500 hover:bg-brand-600 text-white shadow-brand transition-all duration-150 active:scale-[0.98] hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
            >
              Criar conta grátis
            </a>
          </div>

          <div className="flex items-center gap-2 sm:hidden">
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-xl text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
              aria-label="Alternar tema"
            >
              {isDarkMode ? <Sun className="w-5 h-5 text-brand-400" /> : <Moon className="w-5 h-5" />}
            </button>
            <button
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              className="p-2 rounded-xl text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800 focus:outline-none"
              aria-label="Menu de navegação"
            >
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
          </div>
        </div>

        {mobileMenuOpen && (
          <div className="sm:hidden border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950 px-4 pt-2 pb-6 space-y-4 shadow-lg animate-in slide-in-from-top-2 duration-150">
            <nav className="flex flex-col space-y-3 text-base font-medium text-surface-700 dark:text-surface-200">
              <a href="#dores" onClick={() => setMobileMenuOpen(false)} className="px-3 py-2 rounded-xl hover:bg-surface-100 dark:hover:bg-surface-850 transition-colors">
                Por que o BurgerHub?
              </a>
              <a href="#recursos" onClick={() => setMobileMenuOpen(false)} className="px-3 py-2 rounded-xl hover:bg-surface-100 dark:hover:bg-surface-850 transition-colors">
                Recursos
              </a>
              <a href="#como-funciona" onClick={() => setMobileMenuOpen(false)} className="px-3 py-2 rounded-xl hover:bg-surface-100 dark:hover:bg-surface-850 transition-colors">
                Como Funciona
              </a>
              <a href="#planos" onClick={() => setMobileMenuOpen(false)} className="px-3 py-2 rounded-xl hover:bg-surface-100 dark:hover:bg-surface-850 transition-colors">
                Planos
              </a>
            </nav>
            <div className="pt-2 border-t border-surface-200 dark:border-surface-800 flex flex-col gap-2.5">
              <a href={LOGIN_URL} className="w-full text-center py-2.5 text-sm font-semibold rounded-2xl border border-surface-300 dark:border-surface-700 text-surface-800 dark:text-surface-100 hover:bg-surface-100 dark:hover:bg-surface-800">
                Já tenho conta (Entrar)
              </a>
              <a href={REGISTER_URL} className="w-full text-center py-3 text-sm font-bold rounded-2xl bg-brand-500 hover:bg-brand-600 text-white shadow-brand">
                Criar minha conta grátis
              </a>
            </div>
          </div>
        )}
      </header>

      {/* =========================================================================
          2. HERO SECTION
      ========================================================================== */}
      <section className="relative pt-12 pb-20 md:pt-20 md:pb-28 overflow-hidden">
        <div className="absolute top-10 left-1/2 -translate-x-1/2 w-[600px] h-[350px] bg-brand-500/10 dark:bg-brand-500/5 blur-3xl -z-10 pointer-events-none rounded-full" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-4xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center">
              <span className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-xs sm:text-sm font-bold bg-brand-50 text-brand-800 border border-brand-200 dark:bg-surface-850 dark:text-brand-300 dark:border-brand-500/50 shadow-sm animate-pulse-glow">
                <span>🔥</span>
                <span>Feito pra hamburgueria, do balcão à entrega</span>
              </span>
            </div>

            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight text-surface-900 dark:text-white leading-[1.15]">
              Do primeiro pedido até a entrega,
              <br className="hidden sm:inline" />
              <span className="bg-gradient-to-r from-brand-500 via-brand-600 to-brand-700 dark:from-brand-300 dark:via-brand-400 dark:to-amber-300 bg-clip-text text-transparent">
                sua hamburgueria no piloto automático.
              </span>
            </h1>

            <p className="text-base sm:text-lg lg:text-xl text-surface-600 dark:text-surface-200 max-w-2xl mx-auto leading-relaxed">
              Receba pedidos pelo cardápio digital e balcão, organize a fila da cozinha sem papel e despache os motoboys sem estresse.
            </p>

            <div className="pt-2 flex flex-col sm:flex-row items-center justify-center gap-3.5 sm:gap-4">
              <a
                href={REGISTER_URL}
                className="w-full sm:w-auto px-8 py-4 text-base font-bold rounded-2xl bg-brand-500 hover:bg-brand-600 text-white shadow-brand hover:shadow-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2.5 group focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
              >
                <span>Criar minha conta grátis</span>
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </a>

              <a
                href="#como-funciona"
                className="w-full sm:w-auto px-7 py-4 text-base font-semibold rounded-2xl border border-surface-300 dark:border-surface-700 text-surface-700 dark:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-850 transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                <span>Ver como funciona</span>
                <ChevronRight className="w-4 h-4 text-surface-400" />
              </a>
            </div>

            <div className="pt-2 flex items-center justify-center gap-2 text-xs sm:text-sm text-surface-600 dark:text-surface-300 font-medium">
              <ShieldCheck className="w-4 h-4 text-brand-500 shrink-0" />
              <span>Construído para donos de hamburgueria que cansaram de controlar tudo no caderno</span>
            </div>
          </div>

          {/* MOCKUP ESTILIZADO DO PAINEL COM MÉTRICAS ANIMADAS */}
          <div
            ref={heroMockup.ref}
            className={`mt-14 max-w-5xl mx-auto transition-all duration-700 transform ${
              heroMockup.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
            }`}
          >
            <div className="bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-800 rounded-2xl sm:rounded-3xl shadow-2xl overflow-hidden">
              <div className="bg-surface-100 dark:bg-surface-850 px-4 py-3 border-b border-surface-200 dark:border-surface-800 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-400/80" />
                  <div className="w-3 h-3 rounded-full bg-amber-400/80" />
                  <div className="w-3 h-3 rounded-full bg-emerald-400/80" />
                </div>

                <div className="bg-white dark:bg-surface-900 text-surface-500 dark:text-surface-400 text-xs px-4 py-1.5 rounded-lg border border-surface-200 dark:border-surface-800 font-mono flex items-center gap-2 shadow-xs">
                  <span className="text-emerald-500 text-[10px]">🔒</span>
                  <span>app.burgerhub.com.br/painel</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    Loja Aberta
                  </span>
                </div>
              </div>

              <div className="p-4 sm:p-6 lg:p-8 bg-surface-50/50 dark:bg-surface-900/50 space-y-6">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <div className="bg-white dark:bg-surface-850 p-4 sm:p-5 rounded-2xl border border-surface-200/80 dark:border-surface-800 shadow-xs hover:border-brand-300 dark:hover:border-brand-500/40 transition-colors">
                    <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-200 font-semibold">
                      <span>Pedidos hoje</span>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/80 dark:text-emerald-200 dark:border dark:border-emerald-700/60">+12%</span>
                    </div>
                    <div className="text-2xl sm:text-3xl font-black text-surface-900 dark:text-white mt-2">
                      <AnimatedCounter end={48} startAnimation={heroMockup.isInView} />
                    </div>
                    <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">32 entregues · 10 balcão</div>
                  </div>

                  <div className="bg-white dark:bg-surface-850 p-4 sm:p-5 rounded-2xl border border-surface-200/80 dark:border-surface-800 shadow-xs hover:border-brand-300 dark:hover:border-brand-500/40 transition-colors">
                    <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-200 font-semibold">
                      <span>Receita hoje</span>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-brand-100 text-brand-800 dark:bg-brand-900/80 dark:text-brand-200 dark:border dark:border-brand-700/60">Pix & Cartão</span>
                    </div>
                    <div className="text-2xl sm:text-3xl font-black text-brand-600 dark:text-brand-300 mt-2">
                      <AnimatedCounter end={1842} prefix="R$ " startAnimation={heroMockup.isInView} />
                    </div>
                    <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">100% conciliado</div>
                  </div>

                  <div className="bg-white dark:bg-surface-850 p-4 sm:p-5 rounded-2xl border border-surface-200/80 dark:border-surface-800 shadow-xs hover:border-brand-300 dark:hover:border-brand-500/40 transition-colors">
                    <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-200 font-semibold">
                      <span>Em preparo</span>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/80 dark:text-amber-200 dark:border dark:border-amber-700/60">KDS Cozinha</span>
                    </div>
                    <div className="text-2xl sm:text-3xl font-black text-amber-600 dark:text-amber-300 mt-2">
                      <AnimatedCounter end={6} startAnimation={heroMockup.isInView} />
                    </div>
                    <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">Tempo médio: 14 min</div>
                  </div>

                  <div className="bg-white dark:bg-surface-850 p-4 sm:p-5 rounded-2xl border border-surface-200/80 dark:border-surface-800 shadow-xs hover:border-brand-300 dark:hover:border-brand-500/40 transition-colors">
                    <div className="flex items-center justify-between text-xs text-surface-600 dark:text-surface-200 font-semibold">
                      <span>Ticket médio</span>
                      <span className="text-[11px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/80 dark:text-blue-200 dark:border dark:border-blue-700/60">Combo + Refri</span>
                    </div>
                    <div className="text-2xl sm:text-3xl font-black text-surface-900 dark:text-white mt-2">
                      <AnimatedCounter end={38.4} prefix="R$ " decimals={2} startAnimation={heroMockup.isInView} />
                    </div>
                    <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">+ R$ 4,20 vs média</div>
                  </div>
                </div>

                <div className="bg-white dark:bg-surface-850 rounded-2xl border border-surface-200/80 dark:border-surface-800 p-4 sm:p-5 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-surface-100 dark:border-surface-800">
                    <span className="text-xs font-bold uppercase tracking-wider text-surface-700 dark:text-surface-200">
                      Pedidos em Andamento (Tempo Real)
                    </span>
                    <span className="text-xs text-brand-600 dark:text-brand-300 font-bold flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-brand-500 animate-ping" />
                      Atualizado agora
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-surface-50 dark:bg-surface-900 border border-surface-200/60 dark:border-surface-800 gap-2">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 flex items-center justify-center font-black text-xs">
                          #142
                        </div>
                        <div>
                          <div className="text-sm font-bold text-surface-900 dark:text-surface-100">
                            2x Smash Burger Bacon Duplo + Fritas Rústicas
                          </div>
                          <div className="text-xs text-surface-600 dark:text-surface-300 flex items-center gap-2">
                            <span className="font-semibold text-surface-700 dark:text-surface-200">Cardápio Digital</span> • <span>Cliente: Rafael S.</span> •{" "}
                            <span className="font-bold text-emerald-600 dark:text-emerald-400">Pago via Pix</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-brand-100 text-brand-800 dark:bg-brand-900/90 dark:text-brand-100 dark:border dark:border-brand-700 flex items-center gap-1">
                          <Bike className="w-3.5 h-3.5" />
                          Despachando (Motoboy 02)
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between p-3 rounded-xl bg-surface-50 dark:bg-surface-900 border border-surface-200/60 dark:border-surface-800 gap-2">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 flex items-center justify-center font-black text-xs">
                          #143
                        </div>
                        <div>
                          <div className="text-sm font-bold text-surface-900 dark:text-surface-100">
                            1x Burger Clássico Artesanal (Ponto da carne: Ao ponto)
                          </div>
                          <div className="text-xs text-surface-600 dark:text-surface-300 flex items-center gap-2">
                            <span className="font-semibold text-surface-700 dark:text-surface-200">Cardápio Digital</span> • <span>Mesa 04 (Comanda aberta)</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-center">
                        <span className="px-2.5 py-1 rounded-lg text-xs font-bold bg-amber-100 text-amber-800 dark:bg-amber-900/90 dark:text-amber-100 dark:border dark:border-amber-700 flex items-center gap-1">
                          <ChefHat className="w-3.5 h-3.5" />
                          Na Chapa (KDS)
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* =========================================================================
          3. SEÇÃO DE DORES
      ========================================================================== */}
      <section
        id="dores"
        ref={painSection.ref}
        className="py-16 sm:py-24 bg-surface-50 dark:bg-surface-900/60 border-y border-surface-200/70 dark:border-surface-800/70 transition-colors"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center space-y-4">
            <span className="text-xs sm:text-sm font-bold uppercase tracking-wider text-red-600 dark:text-red-300">
              Chega de dor de cabeça na operação
            </span>
            <h2 className="text-2xl sm:text-4xl font-extrabold text-surface-900 dark:text-white tracking-tight">
              Reconhece algum desses problemas?
            </h2>
            <p className="text-base sm:text-lg text-surface-600 dark:text-surface-200">
              A rotina de uma hamburgueria já é corrida o suficiente. A desorganização não pode ser o motivo de você perder vendas.
            </p>
          </div>

          <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
            {painPoints.map((pain, index) => (
              <div
                key={index}
                className={`bg-white dark:bg-surface-850 rounded-2xl p-6 border border-surface-200 dark:border-surface-800 shadow-card hover:border-red-300 dark:hover:border-red-800/80 transition-all duration-300 flex flex-col justify-between ${
                  painSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
                }`}
                style={{ transitionDelay: `${index * 80}ms` }}
              >
                <div className="space-y-4">
                  <div className="w-10 h-10 rounded-xl bg-red-100 dark:bg-red-950/80 text-red-600 dark:text-red-300 flex items-center justify-center">
                    <XCircle className="w-6 h-6" />
                  </div>
                  <p className="text-sm sm:text-base font-bold text-surface-900 dark:text-surface-100 leading-snug">"{pain}"</p>
                </div>
                <div className="mt-4 pt-3 border-t border-surface-100 dark:border-surface-800 text-[11px] text-red-600 dark:text-red-300 font-bold">
                  Gera erro e prejuízo
                </div>
              </div>
            ))}
          </div>

          <div
            className={`mt-12 max-w-2xl mx-auto text-center p-6 rounded-2xl bg-brand-50 dark:bg-surface-900 border border-brand-200 dark:border-brand-600/50 shadow-xs transition-all duration-500 ${
              painSection.isInView ? "opacity-100 scale-100" : "opacity-0 scale-95"
            }`}
          >
            <div className="inline-flex items-center gap-2 text-brand-700 dark:text-brand-300 font-extrabold text-base sm:text-lg">
              <CheckCircle2 className="w-5 h-5 text-emerald-500 shrink-0" />
              <span>O BurgerHub resolve tudo isso num único lugar.</span>
            </div>
            <p className="mt-1 text-xs sm:text-sm text-surface-600 dark:text-surface-200">
              Sem precisar contratar vários sistemas ou pagar mensalidades acumuladas.
            </p>
          </div>
        </div>
      </section>

      {/* =========================================================================
          4. GRID DE RECURSOS (8 CARDS, FLIP 3D)
      ========================================================================== */}
      <section id="recursos" ref={featuresSection.ref} className="py-16 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center space-y-4">
          <span className="text-xs sm:text-sm font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">
            Tudo em uma única ferramenta
          </span>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-surface-900 dark:text-white tracking-tight">
            Cada detalhe pensado pro dia a dia da chapa
          </h2>
          <p className="text-base sm:text-lg text-surface-600 dark:text-surface-200">
            Sem telas complicadas ou funções inúteis. O BurgerHub entrega exatamente o que sua hamburgueria precisa pra faturar mais.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 sm:gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            const isFlipped = !!flippedCards[index];

            return (
              <div
                key={index}
                className={`perspective-1000 min-h-[350px] transition-all duration-300 ${
                  featuresSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
                }`}
                style={{ transitionDelay: `${index * 60}ms` }}
              >
                <div className={`relative w-full h-full transform-style-3d transition-transform duration-500 rounded-2xl ${isFlipped ? "rotate-y-180" : ""}`}>
                  <div
                    onClick={() => toggleFlip(index)}
                    className="absolute inset-0 backface-hidden bg-white dark:bg-surface-850 rounded-2xl p-6 border border-surface-200 dark:border-surface-800 shadow-xs hover:shadow-card-hover hover:border-brand-400 dark:hover:border-brand-500/50 transition-colors flex flex-col justify-between cursor-pointer group"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-4">
                        <div className="w-12 h-12 rounded-2xl bg-brand-50 dark:bg-brand-950/80 text-brand-600 dark:text-brand-300 dark:border dark:border-brand-700/60 flex items-center justify-center group-hover:bg-brand-500 group-hover:text-white transition-colors duration-200">
                          <Icon className="w-6 h-6" />
                        </div>
                        <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-md bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 dark:border dark:border-surface-700/80">
                          {feature.tag}
                        </span>
                      </div>

                      <h3 className="text-base sm:text-lg font-bold text-surface-900 dark:text-white mb-2 group-hover:text-brand-600 dark:group-hover:text-brand-400 transition-colors">
                        {feature.title}
                      </h3>

                      <p className="text-xs sm:text-sm text-surface-600 dark:text-surface-200 leading-relaxed">{feature.description}</p>
                    </div>

                    <div className="mt-5 pt-3 border-t border-surface-100 dark:border-surface-800 flex items-center justify-between text-xs font-bold text-brand-600 dark:text-brand-300">
                      <span className="flex items-center gap-1.5 group-hover:translate-x-1 transition-transform">
                        <span>Ver em detalhes</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </span>
                      <span className="p-1 rounded-lg bg-surface-100 dark:bg-surface-800 text-surface-500 dark:text-surface-400 group-hover:text-brand-500 group-hover:rotate-180 transition-all duration-300">
                        <RotateCw className="w-3.5 h-3.5" />
                      </span>
                    </div>
                  </div>

                  <div
                    onClick={() => toggleFlip(index)}
                    className="absolute inset-0 backface-hidden rotate-y-180 bg-white dark:bg-surface-850 rounded-2xl p-6 border-2 border-brand-500/80 dark:border-brand-500 shadow-card-hover flex flex-col justify-between cursor-pointer"
                  >
                    <div className="space-y-3">
                      <div className="flex items-center justify-between pb-2 border-b border-surface-100 dark:border-surface-800">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-lg bg-brand-100 dark:bg-brand-950 text-brand-600 dark:text-brand-300 flex items-center justify-center">
                            <Icon className="w-4 h-4" />
                          </div>
                          <span className="text-[11px] font-bold uppercase tracking-wider text-brand-600 dark:text-brand-300">O que está incluso:</span>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => toggleFlip(index, e)}
                          className="p-1 rounded-lg text-surface-400 hover:text-surface-700 dark:hover:text-white hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors"
                          title="Voltar ao card"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <h4 className="text-sm sm:text-base font-bold text-surface-900 dark:text-white leading-tight">{feature.title}</h4>

                      <ul className="space-y-2 text-xs text-surface-700 dark:text-surface-200">
                        {feature.details.map((detail, dIdx) => (
                          <li key={dIdx} className="flex items-start gap-2">
                            <Check className="w-3.5 h-3.5 text-brand-500 shrink-0 mt-0.5" />
                            <span className="leading-snug">{detail}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => toggleFlip(index, e)}
                      className="mt-3 w-full py-2 px-3 rounded-xl bg-brand-50 dark:bg-surface-900 border border-brand-200 dark:border-brand-700/60 text-xs font-bold text-brand-700 dark:text-brand-300 hover:bg-brand-100 dark:hover:bg-brand-950 transition-colors flex items-center justify-center gap-1.5"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      <span>Voltar ao card frontal</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* =========================================================================
          5. COMO FUNCIONA (3 PASSOS)
      ========================================================================== */}
      <section
        id="como-funciona"
        ref={stepsSection.ref}
        className="py-16 sm:py-24 bg-surface-50 dark:bg-surface-900/60 border-t border-surface-200/70 dark:border-surface-800/70 transition-colors"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center space-y-4">
            <span className="text-xs sm:text-sm font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">
              Simples e sem burocracia
            </span>
            <h2 className="text-2xl sm:text-4xl font-extrabold text-surface-900 dark:text-white tracking-tight">Como funciona o BurgerHub</h2>
            <p className="text-base sm:text-lg text-surface-600 dark:text-surface-200">
              Você não precisa ser especialista em computador. Em minutos sua loja já está pronta pra receber pedidos.
            </p>
          </div>

          <div className="mt-14 grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
            {steps.map((step, index) => (
              <div
                key={index}
                className={`relative bg-white dark:bg-surface-850 rounded-2xl p-7 border border-surface-200 dark:border-surface-800 shadow-card hover:border-brand-300 dark:hover:border-brand-500/50 transition-all duration-300 ${
                  stepsSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
                }`}
                style={{ transitionDelay: `${index * 100}ms` }}
              >
                <div className="text-4xl sm:text-5xl font-black text-brand-500/40 dark:text-brand-400/40 mb-2 font-mono">{step.number}</div>
                <h3 className="text-lg sm:text-xl font-bold text-surface-900 dark:text-white mb-2">{step.title}</h3>
                <p className="text-sm text-surface-600 dark:text-surface-200 leading-relaxed">{step.description}</p>

                {index < 2 && (
                  <div className="hidden lg:block absolute -right-4 top-1/2 -translate-y-1/2 z-10 text-surface-300 dark:text-surface-700">
                    <ChevronRight className="w-8 h-8" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* =========================================================================
          6. PLANOS E PREÇOS
      ========================================================================== */}
      <section id="planos" ref={pricingSection.ref} className="py-16 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 transition-colors">
        <div className="max-w-3xl mx-auto text-center space-y-4">
          <span className="text-xs sm:text-sm font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">Transparência total</span>
          <h2 className="text-2xl sm:text-4xl font-extrabold text-surface-900 dark:text-white tracking-tight">
            Planos simples que cabem no bolso da sua hamburgueria
          </h2>
          <p className="text-base sm:text-lg text-surface-600 dark:text-surface-200">
            Sem pegadinhas, sem taxas abusivas e com <span className="font-bold text-surface-900 dark:text-white">pedidos ilimitados</span> em todos os planos.
          </p>

          <div className="pt-4 flex items-center justify-center">
            <div className="inline-flex items-center bg-surface-100 dark:bg-surface-850 p-1.5 rounded-2xl border border-surface-200 dark:border-surface-800">
              <button
                type="button"
                onClick={() => setIsAnnual(false)}
                className={`px-5 py-2 text-xs sm:text-sm font-bold rounded-xl transition-all duration-150 ${
                  !isAnnual
                    ? "bg-white dark:bg-surface-900 text-surface-900 dark:text-white shadow-xs"
                    : "text-surface-600 dark:text-surface-300 hover:text-surface-900 dark:hover:text-white"
                }`}
              >
                Mensal
              </button>
              <button
                type="button"
                onClick={() => setIsAnnual(true)}
                className={`px-5 py-2 text-xs sm:text-sm font-bold rounded-xl transition-all duration-150 flex items-center gap-1.5 ${
                  isAnnual ? "bg-brand-500 text-white shadow-xs" : "text-surface-600 dark:text-surface-300 hover:text-surface-900 dark:hover:text-white"
                }`}
              >
                <span>Anual</span>
                <span
                  className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                    isAnnual ? "bg-white/25 text-white" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 dark:border dark:border-emerald-800"
                  }`}
                >
                  2 meses grátis
                </span>
              </button>
            </div>
          </div>
        </div>

        <div className="mt-14 grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">
          {/* Plano Start */}
          <div
            className={`bg-white dark:bg-surface-850 rounded-3xl p-7 sm:p-8 border border-surface-200 dark:border-surface-800 shadow-card hover:border-surface-300 dark:hover:border-surface-700 transition-all duration-300 flex flex-col justify-between ${
              pricingSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
            }`}
          >
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-surface-900 dark:text-white">Start</h3>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 dark:border dark:border-surface-700">
                  Iniciante
                </span>
              </div>
              <p className="text-xs sm:text-sm text-surface-600 dark:text-surface-300 mt-2">Para quem quer começar a vender online e organizar o balcão.</p>

              <div className="mt-6 pb-6 border-b border-surface-100 dark:border-surface-800">
                <div className="flex items-baseline gap-1">
                  <span className="text-sm font-semibold text-surface-500 dark:text-surface-400">R$</span>
                  <span className="text-4xl sm:text-5xl font-black text-surface-900 dark:text-white">{isAnnual ? "55" : "69"}</span>
                  <span className="text-sm font-medium text-surface-500 dark:text-surface-400">/mês</span>
                </div>
                <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">
                  {isAnnual ? "R$ 660 cobrados anualmente" : "Faturamento mensal sem fidelidade"}
                </div>
              </div>

              <ul className="mt-6 space-y-3.5 text-xs sm:text-sm text-surface-800 dark:text-surface-100 font-medium">
                <li className="flex items-center gap-2.5 font-bold text-surface-900 dark:text-white">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Pedidos Ilimitados</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>PDV Balcão (vendas rápidas)</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Cardápio Digital (Pix e Cartão)</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Taxa de 1,5% no cardápio online</span>
                </li>
                <li className="flex items-center gap-2.5 font-bold text-emerald-600 dark:text-emerald-400">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>0% de taxa nas vendas de balcão</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Relatórios básicos de faturamento</span>
                </li>
              </ul>
            </div>

            <div className="mt-8 pt-4">
              <a
                href={REGISTER_URL}
                className="w-full py-3.5 px-4 text-sm font-bold rounded-2xl border border-surface-300 dark:border-surface-700 text-surface-800 dark:text-surface-100 hover:bg-surface-100 dark:hover:bg-surface-800 transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 text-center"
              >
                <span>Começar no Start</span>
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Plano Pro (Destaque) */}
          <div
            className={`relative bg-white dark:bg-surface-850 rounded-3xl p-7 sm:p-8 border-2 border-brand-500 shadow-2xl transition-all duration-300 flex flex-col justify-between lg:-translate-y-2 ${
              pricingSection.isInView ? "opacity-100 translate-y-0 lg:-translate-y-2" : "opacity-0 translate-y-6"
            }`}
            style={{ transitionDelay: "100ms" }}
          >
            <div className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-brand-500 text-white text-[11px] font-black uppercase tracking-wider px-4 py-1 rounded-full shadow-md">
              🔥 Mais Escolhido
            </div>

            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-surface-900 dark:text-white">Pro</h3>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-brand-100 text-brand-800 dark:bg-brand-900/80 dark:text-brand-200 dark:border dark:border-brand-700">
                  Chapa Quente
                </span>
              </div>
              <p className="text-xs sm:text-sm text-surface-600 dark:text-surface-300 mt-2">Para quem precisa de velocidade na cozinha e na rota dos motoboys.</p>

              <div className="mt-6 pb-6 border-b border-surface-100 dark:border-surface-800">
                <div className="flex items-baseline gap-1">
                  <span className="text-sm font-semibold text-surface-500 dark:text-surface-400">R$</span>
                  <span className="text-4xl sm:text-5xl font-black text-brand-600 dark:text-brand-300">{isAnnual ? "99" : "129"}</span>
                  <span className="text-sm font-medium text-surface-500 dark:text-surface-400">/mês</span>
                </div>
                <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">
                  {isAnnual ? "R$ 1.188 cobrados anualmente" : "Faturamento mensal sem fidelidade"}
                </div>
              </div>

              <ul className="mt-6 space-y-3.5 text-xs sm:text-sm text-surface-800 dark:text-surface-100 font-medium">
                <li className="flex items-center gap-2.5 font-bold text-brand-600 dark:text-brand-300">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Tudo do plano Start</span>
                </li>
                <li className="flex items-center gap-2.5 font-bold text-surface-900 dark:text-white">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Pedidos Ilimitados</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Tela KDS de Cozinha (sem papel)</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Central de Despacho & App do Motoboy</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>App Desktop com Impressão Térmica</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Relatórios avançados (pico e ticket médio)</span>
                </li>
              </ul>
            </div>

            <div className="mt-8 pt-4">
              <a
                href={REGISTER_URL}
                className="w-full py-4 px-4 text-sm font-bold rounded-2xl bg-brand-500 hover:bg-brand-600 text-white shadow-brand hover:shadow-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 text-center"
              >
                <span>Criar conta no Plano Pro</span>
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>

          {/* Plano Prime */}
          <div
            className={`bg-white dark:bg-surface-850 rounded-3xl p-7 sm:p-8 border border-surface-200 dark:border-surface-800 shadow-card hover:border-surface-300 dark:hover:border-surface-700 transition-all duration-300 flex flex-col justify-between ${
              pricingSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
            }`}
            style={{ transitionDelay: "200ms" }}
          >
            <div>
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-surface-900 dark:text-white">Prime</h3>
                <span className="text-xs font-bold px-2.5 py-1 rounded-full bg-surface-100 dark:bg-surface-800 text-surface-700 dark:text-surface-200 dark:border dark:border-surface-700">
                  Completo
                </span>
              </div>
              <p className="text-xs sm:text-sm text-surface-600 dark:text-surface-300 mt-2">Para quem busca controle cirúrgico de custos e fidelização.</p>

              <div className="mt-6 pb-6 border-b border-surface-100 dark:border-surface-800">
                <div className="flex items-baseline gap-1">
                  <span className="text-sm font-semibold text-surface-500 dark:text-surface-400">R$</span>
                  <span className="text-4xl sm:text-5xl font-black text-surface-900 dark:text-white">{isAnnual ? "159" : "199"}</span>
                  <span className="text-sm font-medium text-surface-500 dark:text-surface-400">/mês</span>
                </div>
                <div className="text-[11px] text-surface-500 dark:text-surface-300 font-medium mt-1">
                  {isAnnual ? "R$ 1.908 cobrados anualmente" : "Faturamento mensal sem fidelidade"}
                </div>
              </div>

              <ul className="mt-6 space-y-3.5 text-xs sm:text-sm text-surface-800 dark:text-surface-100 font-medium">
                <li className="flex items-center gap-2.5 font-bold text-brand-600 dark:text-brand-300">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Tudo do plano Pro</span>
                </li>
                <li className="flex items-center gap-2.5 font-bold text-surface-900 dark:text-white">
                  <Check className="w-4 h-4 text-emerald-500 shrink-0" />
                  <span>Pedidos Ilimitados</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Controle de Estoque & Ficha Técnica</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Cupons, Cashback e Fidelidade</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Múltiplos operadores e caixas</span>
                </li>
                <li className="flex items-center gap-2.5">
                  <Check className="w-4 h-4 text-brand-500 shrink-0" />
                  <span>Suporte prioritário</span>
                </li>
              </ul>
            </div>

            <div className="mt-8 pt-4">
              <a
                href={REGISTER_URL}
                className="w-full py-3.5 px-4 text-sm font-bold rounded-2xl border border-surface-300 dark:border-surface-700 text-surface-800 dark:text-surface-100 hover:bg-surface-100 dark:hover:bg-surface-800 transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 text-center"
              >
                <span>Começar no Prime</span>
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </div>
        </div>

        <div
          className={`mt-12 max-w-4xl mx-auto p-6 sm:p-7 rounded-2xl bg-surface-50 dark:bg-surface-900 border border-surface-200 dark:border-surface-800 shadow-xs flex flex-col sm:flex-row items-start sm:items-center gap-4 transition-all duration-500 ${
            pricingSection.isInView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          }`}
        >
          <div className="w-10 h-10 rounded-xl bg-brand-100 dark:bg-brand-950 text-brand-600 dark:text-brand-300 dark:border dark:border-brand-700 flex items-center justify-center shrink-0">
            <Info className="w-5 h-5" />
          </div>
          <div className="space-y-1 text-xs sm:text-sm">
            <p className="font-bold text-surface-900 dark:text-white">Como funciona a taxa de 1,5%?</p>
            <p className="text-surface-600 dark:text-surface-200 leading-relaxed">
              A taxa de 1,5% incide <span className="font-bold text-surface-900 dark:text-white">apenas sobre os pedidos concluídos pelo Cardápio Digital online</span> para
              custear a plataforma e transações (contra os 27% dos grandes apps). Suas vendas físicas de{" "}
              <span className="font-bold text-emerald-600 dark:text-emerald-400">Balcão e Mesas no PDV têm ZERO (0%) de taxa</span>.
            </p>
          </div>
        </div>
      </section>

      {/* =========================================================================
          7. CTA FINAL
      ========================================================================== */}
      <section ref={ctaSection.ref} className="py-16 sm:py-24 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div
          className={`relative rounded-3xl bg-gradient-to-br from-brand-500 via-brand-600 to-brand-700 text-white p-8 sm:p-12 lg:p-16 shadow-2xl overflow-hidden transition-all duration-700 ${
            ctaSection.isInView ? "opacity-100 scale-100" : "opacity-0 scale-95"
          }`}
        >
          <div className="absolute top-0 right-0 -mt-12 -mr-12 w-64 h-64 bg-white/10 rounded-full blur-2xl pointer-events-none" />
          <div className="absolute bottom-0 left-0 -mb-12 -ml-12 w-64 h-64 bg-brand-900/20 rounded-full blur-2xl pointer-events-none" />

          <div className="relative z-10 max-w-3xl mx-auto text-center space-y-6">
            <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-white/20 text-white text-xs sm:text-sm font-bold backdrop-blur-sm">
              <Sparkles className="w-4 h-4" />
              <span>Experimente grátis na sua hamburgueria</span>
            </div>

            <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white leading-tight">
              Pronto para colocar ordem na sua operação e vender mais?
            </h2>

            <p className="text-base sm:text-lg text-brand-50 max-w-xl mx-auto">
              Crie sua conta agora mesmo. Chega de sofrer com anotações manuais e pedidos perdidos.
            </p>

            <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 pt-2 text-xs sm:text-sm font-semibold text-white/95">
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-brand-200" />
                <span>Cadastro em minutos</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-brand-200" />
                <span>Sem fidelidade</span>
              </div>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-brand-200" />
                <span>Suporte pra tirar dúvidas</span>
              </div>
            </div>

            <div className="pt-4 flex flex-col sm:flex-row items-center justify-center gap-4">
              <a
                href={REGISTER_URL}
                className="w-full sm:w-auto px-8 py-4 text-base sm:text-lg font-bold rounded-2xl bg-white text-brand-700 hover:bg-brand-50 shadow-xl transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2 group"
              >
                <span>Criar minha conta grátis</span>
                <ArrowRight className="w-5 h-5 text-brand-600 group-hover:translate-x-1 transition-transform" />
              </a>

              <a href={LOGIN_URL} className="text-sm font-semibold text-brand-100 hover:text-white underline underline-offset-4 transition-colors">
                Já tenho conta → Entrar
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* =========================================================================
          8. FOOTER
      ========================================================================== */}
      <footer className="border-t border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-950 py-12 transition-colors">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6 pb-8 border-b border-surface-200 dark:border-surface-800">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-brand-500 flex items-center justify-center text-base shadow-sm">🍔</div>
              <span className="text-lg font-bold text-surface-900 dark:text-white">
                Burger<span className="text-brand-500">Hub</span>
              </span>
              <span className="hidden sm:inline text-surface-400 text-sm">|</span>
              <span className="hidden sm:inline text-xs text-surface-600 dark:text-surface-300 font-medium">
                O SaaS de gestão feito sob medida para hamburguerias
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-center gap-6 text-xs sm:text-sm font-semibold text-surface-600 dark:text-surface-300">
              <a href="#dores" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                Dores
              </a>
              <a href="#recursos" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                Recursos
              </a>
              <a href="#como-funciona" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                Como Funciona
              </a>
              <a href="#planos" className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                Planos
              </a>
              <a href={LOGIN_URL} className="hover:text-brand-600 dark:hover:text-brand-400 transition-colors">
                Entrar
              </a>
              <a href={REGISTER_URL} className="text-brand-600 dark:text-brand-400 font-bold hover:underline">
                Criar Conta
              </a>
            </div>
          </div>

          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between text-xs text-surface-500 dark:text-surface-400 gap-3">
            <p>© {new Date().getFullYear()} BurgerHub. Todos os direitos reservados.</p>
            <p>Construído com foco em velocidade, estabilidade e usabilidade para donos de hamburgueria.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
