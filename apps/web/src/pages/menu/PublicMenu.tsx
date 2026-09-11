import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  Clock,
  Crosshair,
  ImageOff,
  MapPinned,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { initMercadoPago, Payment } from "@mercadopago/sdk-react";
import { api } from "../../lib/api";
import { brl, formatCep, formatPhoneBR } from "../../lib/format";
import type { Product } from "../../types";

// ---------- Tipos do cardápio público ----------

interface MenuTenant {
  name: string;
  slug: string;
  phone?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  address?: string | null;
  storeLat?: number | null;
  storeLng?: number | null;
  minOrderCents: number;
  freeDeliveryAbove?: number | null;
  paymentMethods: string[];
  onlinePayments: boolean;
  mpPublicKey: string | null;
  cardCheckoutAvailable: boolean;
  acceptsDelivery: boolean;
  acceptsPickup: boolean;
  prepMinutes: number;
  isOpen: boolean;
  closedMessage?: string | null;
}

/** Com lat/lng, aponta o pino exato; só cai pro texto (menos preciso — o Google recalcula sozinho) quando não há coordenada salva. */
function storeMapUrl(address?: string | null, lat?: number | null, lng?: number | null) {
  if (lat != null && lng != null) return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}

interface MenuCategory {
  id: string;
  name: string;
  icon?: string | null;
  products: Product[];
}

interface MenuData {
  tenant: MenuTenant;
  categories: MenuCategory[];
  featuredProducts?: Product[];
}

interface DeliveryQuote {
  feeCents: number;
  distanceKm: number;
  etaMinutes: number;
}

interface CartAddon {
  addonId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

interface CartItem {
  key: string;
  product: Product;
  quantity: number;
  addons: CartAddon[];
  removals: { id: string; name: string }[];
  notes: string;
}

function itemUnitPrice(item: CartItem) {
  const base = item.product.promoPriceCents ?? item.product.priceCents;
  return base + item.addons.reduce((s, a) => s + a.priceCents * a.quantity, 0);
}

const PAYMENT_OPTIONS: Record<string, string> = {
  PIX: "Pix",
  CASH: "Dinheiro",
  CREDIT: "Cartão de crédito",
  DEBIT: "Cartão de débito",
  VR: "Vale Refeição",
  VA: "Vale Alimentação",
};

interface PayingState {
  orderId: string;
  number?: number;
  totalCents: number;
  method: "PIX" | "CARD";
  pixQrCode?: string;
  pixQrImage?: string;
  earnedPoints?: number;
  earnedCashbackCents?: number;
  type?: "DELIVERY" | "PICKUP" | "DINE_IN";
}

// ==================================================================

/** Chave de sessão do carrinho — some sozinha quando a aba é fechada (sessionStorage). */
function cartStorageKey(slug: string | undefined) {
  return `bh_cart_${slug ?? ""}`;
}

export function PublicMenuPage() {
  const { slug } = useParams<{ slug: string }>();
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("");
  const [customizing, setCustomizing] = useState<Product | null>(null);
  const [cart, setCart] = useState<CartItem[]>(() => {
    try {
      const raw = sessionStorage.getItem(cartStorageKey(slug));
      return raw ? (JSON.parse(raw) as CartItem[]) : [];
    } catch {
      return [];
    }
  });
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [upsellFor, setUpsellFor] = useState<Product | null>(null);
  const [placedOrder, setPlacedOrder] = useState<{
    number: number;
    totalCents: number;
    orderId: string;
    paid?: boolean;
    earnedPoints?: number;
    earnedCashbackCents?: number;
    type?: "DELIVERY" | "PICKUP" | "DINE_IN";
  } | null>(null);
  const [paying, setPaying] = useState<PayingState | null>(null);

  // Cache curto do carrinho — sobrevive a um F5, some quando a aba é fechada.
  useEffect(() => {
    try {
      sessionStorage.setItem(cartStorageKey(slug), JSON.stringify(cart));
    } catch {
      // sessionStorage indisponível (aba anônima etc.) — segue sem cache
    }
  }, [cart, slug]);

  // Pedido feito via QR Code de mesa (?mesa=N) — exige que o garçom já tenha
  // aberto a mesa; a UI de entrega/retirada some e o pedido cai direto nela.
  const tableParam = new URLSearchParams(window.location.search).get("mesa");
  const [tableInfo, setTableInfo] = useState<{ number: number; status: string } | null>(null);
  const [tableChecked, setTableChecked] = useState(!tableParam);

  useEffect(() => {
    api
      .get<MenuData>(`/public/${slug}/menu`)
      .then((data) => {
        setMenu(data);
        setActiveCategory(data.categories[0]?.id ?? "");
        if (data.tenant.mpPublicKey) {
          initMercadoPago(data.tenant.mpPublicKey, { locale: "pt-BR" });
        }
      })
      .catch(() => setNotFound(true));
  }, [slug]);

  useEffect(() => {
    if (!tableParam || !slug) return;
    api
      .get<{ number: number; status: string }>(`/public/${slug}/tables/${tableParam}`)
      .then(setTableInfo)
      .catch(() => setTableInfo(null))
      .finally(() => setTableChecked(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Retorno do checkout de cartão (?pedido=<id>)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get("pedido");
    if (!orderId || !slug) return;
    window.history.replaceState({}, "", window.location.pathname);
    api
      .get<{ id: string; number: number; totalCents: number; paymentStatus: string }>(
        `/public/${slug}/orders/${orderId}`,
      )
      .then((o) => {
        if (o.paymentStatus === "PAID") {
          setPlacedOrder({ orderId: o.id, number: o.number, totalCents: o.totalCents, paid: true });
        } else {
          setPaying({ orderId: o.id, number: o.number, totalCents: o.totalCents, method: "CARD" });
        }
      })
      .catch(() => {});
  }, [slug]);

  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);
  const subtotal = cart.reduce((s, i) => s + itemUnitPrice(i) * i.quantity, 0);

  // Categorias "de acompanhamento" — nunca disparam nem aparecem no upsell.
  const SIDE_CATEGORY_RE = /porç|sobremesa|milk|bebida|molho/i;

  const categoryNameByProductId = useMemo(() => {
    const map = new Map<string, string>();
    if (!menu) return map;
    for (const c of menu.categories) for (const p of c.products) map.set(p.id, c.name);
    return map;
  }, [menu]);

  const upsellProducts = useMemo(() => {
    if (!menu) return [];
    const inCart = new Set(cart.map((c) => c.product.id));
    return menu.categories
      .filter((c) => SIDE_CATEGORY_RE.test(c.name))
      .flatMap((c) => c.products)
      .filter((p) => p.available && !inCart.has(p.id))
      .slice(0, 4);
  }, [menu, cart]);

  function addToCart(item: CartItem) {
    setCart((prev) => [...prev, item]);
    setCustomizing(null);
    // Só oferece upsell ao adicionar lanches/combos — bebidas, sobremesas etc.
    // não disparam o popup (não faz sentido sugerir bebida ao adicionar bebida).
    const categoryName = categoryNameByProductId.get(item.product.id) ?? "";
    const isMainDish = !SIDE_CATEGORY_RE.test(categoryName);
    if (isMainDish && upsellProducts.length > 0) setUpsellFor(item.product);
  }

  function quickAdd(p: Product) {
    addToCart({
      key: `${p.id}-${Date.now()}`,
      product: p,
      quantity: 1,
      addons: [],
      removals: [],
      notes: "",
    });
  }

  function openProduct(p: Product) {
    if (p.addonGroups?.length || p.ingredients?.some((i) => i.removable)) setCustomizing(p);
    else quickAdd(p);
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2 p-6 text-center">
        <span className="text-5xl">🍔</span>
        <h1 className="text-xl font-bold">Estabelecimento não encontrado</h1>
        <p className="text-sm text-surface-500">Confira o link e tente novamente.</p>
      </div>
    );
  }

  if (!menu) {
    return (
      <div className="mx-auto max-w-lg space-y-4 p-4">
        <div className="h-40 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl bg-surface-200 dark:bg-surface-800" />
        ))}
      </div>
    );
  }

  const { tenant } = menu;

  if (tableParam && tableChecked && (!tableInfo || tableInfo.status !== "OPEN")) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <span className="text-5xl">🍽️</span>
        <h1 className="text-xl font-bold">Mesa {tableParam} fechada</h1>
        <p className="max-w-sm text-sm text-surface-500">
          Peça para o garçom abrir a mesa antes de fazer o pedido pelo celular.
        </p>
      </div>
    );
  }

  const filteredCategories = menu.categories
    .map((c) => ({
      ...c,
      products: c.products.filter(
        (p) =>
          p.available &&
          (!search ||
            p.name.toLowerCase().includes(search.toLowerCase()) ||
            p.description?.toLowerCase().includes(search.toLowerCase())),
      ),
    }))
    .filter((c) => c.products.length > 0);

  // ---------- Pedido confirmado ----------
  if (placedOrder) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <span className="flex h-20 w-20 animate-slide-up items-center justify-center rounded-full bg-emerald-500/15 text-4xl">
          ✅
        </span>
        <h1 className="text-2xl font-bold">Pedido #{placedOrder.number} confirmado!</h1>
        {placedOrder.paid && (
          <p className="rounded-full bg-emerald-500/10 px-4 py-1 text-sm font-semibold text-emerald-600">
            💚 Pagamento aprovado
          </p>
        )}
        <p className="max-w-sm text-surface-500">
          Recebemos seu pedido de <strong>{brl(placedOrder.totalCents)}</strong>. Tempo estimado:{" "}
          {tenant.prepMinutes}–{tenant.prepMinutes + 20} min.
        </p>
        {placedOrder.type === "PICKUP" && (
          <div className="max-w-sm rounded-2xl border border-brand-300 bg-brand-500/5 px-4 py-3 text-sm dark:border-brand-700">
            <p className="mb-1 flex items-center justify-center gap-1.5 font-semibold text-brand-700 dark:text-brand-400">
              <MapPinned size={14} /> Retire em:
            </p>
            {tenant.address ? (
              <>
                <p className="text-surface-600 dark:text-surface-300">{tenant.address}</p>
                <a
                  href={storeMapUrl(tenant.address, tenant.storeLat, tenant.storeLng) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-xs font-semibold text-brand-600 underline dark:text-brand-400"
                >
                  Ver rota no mapa
                </a>
              </>
            ) : (
              <p className="text-surface-500">Endereço não informado pela loja — confirme por telefone.</p>
            )}
          </div>
        )}
        {!!placedOrder.earnedCashbackCents && (
          <p className="max-w-sm rounded-2xl bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            🎁 Você ganhou {brl(placedOrder.earnedCashbackCents)} de cashback! Use no seu próximo
            pedido aqui pelo cardápio.
          </p>
        )}
        {!!placedOrder.earnedPoints && (
          <p className="max-w-sm rounded-2xl bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            ⭐ Você ganhou {placedOrder.earnedPoints} pontos de fidelidade!
          </p>
        )}
        <a
          href={`/cardapio/${slug}/pedido/${placedOrder.orderId}`}
          className="rounded-xl bg-brand-500 px-6 py-3 font-medium text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-95"
        >
          Acompanhar pedido
        </a>
        <button
          onClick={() => {
            setPlacedOrder(null);
            setCart([]);
          }}
          className="text-sm font-medium text-surface-500 underline"
        >
          Fazer novo pedido
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-50 pb-24 dark:bg-surface-950">
      {/* Header / banner */}
      <div className="relative h-40 bg-gradient-to-br from-brand-500 to-brand-700 sm:h-52">
        {tenant.bannerUrl && (
          <img src={tenant.bannerUrl} alt="" className="h-full w-full object-cover opacity-70" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
      </div>
      <div className="mx-auto max-w-lg px-4 lg:max-w-4xl">
        <div className="relative -mt-10 mb-4 rounded-2xl border border-surface-200 bg-white p-4 shadow-lg dark:border-surface-800 dark:bg-surface-900">
          <div className="flex items-center gap-3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-brand-500 text-2xl shadow-md">
              {tenant.logoUrl ? <img src={tenant.logoUrl} alt="" className="h-full w-full object-cover" /> : "🍔"}
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-bold">{tenant.name}</h1>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-surface-500">
                <span className={`flex items-center gap-1 font-semibold ${tenant.isOpen ? "text-emerald-600" : "text-red-500"}`}>
                  ● {tenant.isOpen ? "Aberto" : "Fechado"}
                </span>
                <span className="flex items-center gap-1">
                  <Clock size={11} /> {tenant.prepMinutes}–{tenant.prepMinutes + 20} min
                </span>
                {tenant.freeDeliveryAbove && (
                  <span className="text-emerald-600">Entrega grátis &gt; {brl(tenant.freeDeliveryAbove)}</span>
                )}
              </div>
              {tenant.address && (
                <a
                  href={storeMapUrl(tenant.address, tenant.storeLat, tenant.storeLng) ?? undefined}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 flex items-center gap-1 truncate text-xs text-surface-400 hover:text-brand-600 hover:underline dark:hover:text-brand-400"
                >
                  <MapPinned size={11} className="shrink-0" /> <span className="truncate">{tenant.address}</span>
                </a>
              )}
            </div>
          </div>
          {!tenant.isOpen && (
            <p className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              {tenant.closedMessage}
            </p>
          )}
        </div>

        {/* Busca */}
        <div className="relative mb-3">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-surface-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar no cardápio..."
            className="w-full rounded-xl border border-surface-200 bg-white py-2.5 pl-10 pr-4 text-sm outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-surface-700 dark:bg-surface-900"
          />
        </div>

        {/* Mais pedidos */}
        {!search && menu.featuredProducts && menu.featuredProducts.length > 0 && (
          <div className="mb-5">
            <h2 className="mb-2.5 flex items-center gap-1.5 text-sm font-bold">
              🔥 Mais pedidos
            </h2>
            <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
              {menu.featuredProducts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => openProduct(p)}
                  disabled={!tenant.isOpen}
                  className={`relative w-36 shrink-0 snap-start overflow-hidden rounded-2xl border bg-white text-left shadow-sm transition-all active:scale-[0.98] disabled:opacity-60 dark:bg-surface-900 ${
                    p.favorite
                      ? "border-amber-400 ring-1 ring-amber-400/50"
                      : "border-surface-200 dark:border-surface-800"
                  }`}
                >
                  <div className="relative h-24 w-full bg-surface-100 dark:bg-surface-800">
                    {p.imageUrl ? (
                      <img src={p.imageUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-surface-300">
                        <ImageOff size={20} />
                      </div>
                    )}
                    {p.favorite && (
                      <span className="absolute left-1.5 top-1.5 flex items-center gap-0.5 rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm">
                        <Star size={9} fill="white" /> Favorito
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-1 text-xs font-semibold">{p.name}</p>
                    <p className="mt-1 text-sm font-bold text-brand-600 dark:text-brand-400">
                      {brl(p.promoPriceCents ?? p.priceCents)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Categorias */}
        <div className="sticky top-0 z-10 -mx-4 mb-4 flex gap-2 overflow-x-auto bg-surface-50/90 px-4 py-2 backdrop-blur-md dark:bg-surface-950/90">
          {filteredCategories.map((c) => (
            <a
              key={c.id}
              href={`#cat-${c.id}`}
              onClick={() => setActiveCategory(c.id)}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                activeCategory === c.id
                  ? "bg-brand-500 text-white shadow-sm shadow-brand-500/30"
                  : "bg-white text-surface-500 dark:bg-surface-900"
              }`}
            >
              {c.icon} {c.name}
            </a>
          ))}
        </div>

        {/* Produtos */}
        <div className="space-y-8">
          {filteredCategories.map((category) => (
            <section key={category.id} id={`cat-${category.id}`}>
              <h2 className="mb-3 text-base font-bold">
                {category.icon} {category.name}
              </h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {category.products.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => openProduct(p)}
                    disabled={!tenant.isOpen}
                    className="flex gap-3 rounded-2xl border border-surface-200 bg-white p-3 text-left shadow-sm transition-all hover:shadow-md active:scale-[0.99] disabled:opacity-60 dark:border-surface-800 dark:bg-surface-900"
                  >
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold">{p.name}</h3>
                      <p className="mt-0.5 line-clamp-2 text-xs text-surface-500">{p.description}</p>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="font-bold text-brand-600 dark:text-brand-400">
                          {brl(p.promoPriceCents ?? p.priceCents)}
                        </span>
                        {p.promoPriceCents && (
                          <span className="text-xs text-surface-400 line-through">{brl(p.priceCents)}</span>
                        )}
                      </div>
                    </div>
                    {p.imageUrl ? (
                      <img
                        src={p.imageUrl}
                        alt={p.name}
                        loading="lazy"
                        className="h-24 w-24 shrink-0 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-xl bg-surface-100 text-surface-300 dark:bg-surface-800">
                        <ImageOff size={22} />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {filteredCategories.length === 0 && (
            <p className="py-16 text-center text-sm text-surface-400">Nada encontrado para “{search}”.</p>
          )}
        </div>

        {/* Rodapé */}
        <footer className="mt-10 pb-4 text-center">
          <p className="flex items-center justify-center gap-1.5 text-xs font-medium text-surface-400">
            <ShieldCheck size={13} className="text-emerald-500" />
            Pagamento 100% seguro
          </p>
          <p className="mt-2 text-xs text-surface-400">
            Cardápio digital por{" "}
            <span className="font-semibold text-surface-500 dark:text-surface-300">BurgerHub</span>
          </p>
          <p className="mt-0.5 text-[11px] text-surface-300 dark:text-surface-600">
            © {new Date().getFullYear()} BurgerHub. Todos os direitos reservados.
          </p>
        </footer>
      </div>

      {/* Botão flutuante do carrinho */}
      {cartCount > 0 && !cartOpen && (
        <button
          onClick={() => setCartOpen(true)}
          className="fixed bottom-4 left-1/2 z-30 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 animate-slide-up items-center justify-between rounded-2xl bg-brand-500 px-5 py-3.5 font-medium text-white shadow-xl shadow-brand-500/40 transition-transform active:scale-[0.98]"
        >
          <span className="flex items-center gap-2">
            <ShoppingBag size={18} />
            Ver carrinho ({cartCount})
          </span>
          <span className="font-bold">{brl(subtotal)}</span>
        </button>
      )}

      {/* Modais */}
      {customizing && (
        <ProductSheet
          product={customizing}
          onClose={() => setCustomizing(null)}
          onAdd={addToCart}
        />
      )}
      {upsellFor && upsellProducts.length > 0 && (
        <UpsellSheet
          products={upsellProducts}
          onAddMany={(products) => {
            products.forEach(quickAdd);
            setUpsellFor(null);
          }}
          onClose={() => setUpsellFor(null)}
        />
      )}
      {cartOpen && (
        <CartSheet
          cart={cart}
          setCart={setCart}
          subtotal={subtotal}
          onClose={() => setCartOpen(false)}
          onCheckout={() => {
            setCartOpen(false);
            setCheckoutOpen(true);
          }}
        />
      )}
      {checkoutOpen && (
        <CheckoutSheet
          menu={menu}
          cart={cart}
          subtotal={subtotal}
          table={tableInfo?.status === "OPEN" ? tableInfo : null}
          onBack={() => {
            setCheckoutOpen(false);
            setCartOpen(true);
          }}
          onClose={() => setCheckoutOpen(false)}
          onSuccess={(o) => {
            setCheckoutOpen(false);
            setCart([]);
            setPlacedOrder(o);
          }}
          onPixPayment={(p) => {
            setCheckoutOpen(false);
            setPaying(p);
          }}
        />
      )}
      {paying && (
        <PaymentSheet
          slug={tenant.slug}
          paying={paying}
          onPaid={() => {
            setPaying(null);
            setCart([]);
            setPlacedOrder({
              orderId: paying.orderId,
              number: paying.number ?? 0,
              totalCents: paying.totalCents,
              paid: true,
              earnedPoints: paying.earnedPoints,
              earnedCashbackCents: paying.earnedCashbackCents,
              type: paying.type,
            });
          }}
          onClose={() => setPaying(null)}
        />
      )}
    </div>
  );
}

// ---------- Bottom sheet base ----------

function Sheet({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className="animate-slide-up max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white sm:max-w-lg sm:rounded-3xl dark:bg-surface-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-surface-100 bg-white/90 px-5 py-4 backdrop-blur-md dark:border-surface-800 dark:bg-surface-900/90">
          <h2 className="text-base font-bold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-surface-400 hover:bg-surface-100 dark:hover:bg-surface-800">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

// ---------- Personalização do produto ----------

function ProductSheet({
  product,
  onClose,
  onAdd,
}: {
  product: Product;
  onClose: () => void;
  onAdd: (item: CartItem) => void;
}) {
  const [quantity, setQuantity] = useState(1);
  const [addons, setAddons] = useState<Map<string, CartAddon>>(new Map());
  const [removals, setRemovals] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState("");

  const removableIngredients = product.ingredients?.filter((i) => i.removable) ?? [];
  const basePrice = product.promoPriceCents ?? product.priceCents;
  const addonsTotal = [...addons.values()].reduce((s, a) => s + a.priceCents * a.quantity, 0);
  const total = (basePrice + addonsTotal) * quantity;

  function changeAddon(addonId: string, name: string, priceCents: number, maxQty: number, delta: number) {
    setAddons((prev) => {
      const next = new Map(prev);
      const current = next.get(addonId);
      const qty = Math.min(Math.max(0, (current?.quantity ?? 0) + delta), maxQty);
      if (qty === 0) next.delete(addonId);
      else next.set(addonId, { addonId, name, priceCents, quantity: qty });
      return next;
    });
  }

  return (
    <Sheet onClose={onClose} title={product.name}>
      {product.imageUrl && (
        <img src={product.imageUrl} alt="" className="mb-4 h-44 w-full rounded-2xl object-cover" />
      )}
      <p className="mb-4 text-sm text-surface-500">{product.description}</p>

      {product.addonGroups?.map(({ group }) => (
        <div key={group.id} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold">
            {group.name}{" "}
            <span className="font-normal text-surface-400">(até {group.maxSelect})</span>
          </h3>
          <div className="space-y-2">
            {group.addons.map((addon) => {
              const qty = addons.get(addon.id)?.quantity ?? 0;
              return (
                <div
                  key={addon.id}
                  className="flex items-center justify-between rounded-xl border border-surface-200 px-3 py-2.5 dark:border-surface-700"
                >
                  <div>
                    <p className="text-sm font-medium">{addon.name}</p>
                    <p className="text-xs text-brand-600 dark:text-brand-400">+ {brl(addon.priceCents)}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {qty > 0 && (
                      <>
                        <button
                          onClick={() => changeAddon(addon.id, addon.name, addon.priceCents, addon.maxQty, -1)}
                          className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-100 dark:bg-surface-800"
                        >
                          <Minus size={14} />
                        </button>
                        <span className="w-5 text-center text-sm font-semibold">{qty}</span>
                      </>
                    )}
                    <button
                      onClick={() => changeAddon(addon.id, addon.name, addon.priceCents, addon.maxQty, 1)}
                      className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500/10 text-brand-600 dark:text-brand-400"
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {removableIngredients.length > 0 && (
        <div className="mb-5">
          <h3 className="mb-2 text-sm font-semibold">Remover ingredientes</h3>
          <div className="flex flex-wrap gap-2">
            {removableIngredients.map((pi) => {
              const removed = removals.has(pi.id);
              return (
                <button
                  key={pi.id}
                  onClick={() =>
                    setRemovals((prev) => {
                      const next = new Set(prev);
                      if (next.has(pi.id)) next.delete(pi.id);
                      else next.add(pi.id);
                      return next;
                    })
                  }
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors ${
                    removed
                      ? "border-red-400 bg-red-500/10 text-red-600 line-through dark:text-red-400"
                      : "border-surface-200 text-surface-600 dark:border-surface-700 dark:text-surface-300"
                  }`}
                >
                  {removed && <X size={12} />}
                  {pi.ingredient.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="mb-5">
        <h3 className="mb-2 text-sm font-semibold">Observações</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Ex.: capricha no molho 🙏"
          rows={2}
          className="w-full rounded-xl border border-surface-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500 dark:border-surface-700 dark:bg-surface-850"
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-3 rounded-xl border border-surface-200 px-3 py-2 dark:border-surface-700">
          <button onClick={() => setQuantity((q) => Math.max(1, q - 1))}>
            <Minus size={16} />
          </button>
          <span className="w-5 text-center font-semibold">{quantity}</span>
          <button onClick={() => setQuantity((q) => q + 1)}>
            <Plus size={16} />
          </button>
        </div>
        <button
          onClick={() =>
            onAdd({
              key: `${product.id}-${Date.now()}`,
              product,
              quantity,
              addons: [...addons.values()],
              removals: removableIngredients
                .filter((pi) => removals.has(pi.id))
                .map((pi) => ({ id: pi.id, name: pi.ingredient.name })),
              notes,
            })
          }
          className="flex-1 rounded-xl bg-brand-500 py-3 font-semibold text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-[0.98]"
        >
          Adicionar · {brl(total)}
        </button>
      </div>
    </Sheet>
  );
}

// ---------- Upsell ----------

function UpsellSheet({
  products,
  onAddMany,
  onClose,
}: {
  products: Product[];
  onAddMany: (products: Product[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedProducts = products.filter((p) => selected.has(p.id));
  const total = selectedProducts.reduce((s, p) => s + (p.promoPriceCents ?? p.priceCents), 0);

  return (
    <Sheet onClose={onClose} title="Você também pode gostar 😋">
      <div className="grid grid-cols-2 gap-3">
        {products.map((p) => {
          const isSelected = selected.has(p.id);
          return (
            <button
              key={p.id}
              onClick={() => toggle(p.id)}
              className={`relative rounded-2xl border p-3 text-left transition-all active:scale-[0.98] ${
                isSelected
                  ? "border-brand-500 ring-2 ring-brand-500/30"
                  : "border-surface-200 hover:border-brand-300 dark:border-surface-700"
              }`}
            >
              {isSelected && (
                <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-white shadow-sm">
                  <Check size={12} />
                </span>
              )}
              {p.imageUrl && (
                <img src={p.imageUrl} alt="" className="mb-2 h-20 w-full rounded-xl object-cover" />
              )}
              <p className="line-clamp-1 text-sm font-medium">{p.name}</p>
              <p className="text-sm font-bold text-brand-600 dark:text-brand-400">
                {brl(p.promoPriceCents ?? p.priceCents)}
              </p>
            </button>
          );
        })}
      </div>
      <div className="mt-4 flex gap-2">
        <button
          onClick={onClose}
          className="flex-1 rounded-xl py-2.5 text-sm font-medium text-surface-400 transition-colors hover:bg-surface-100 dark:hover:bg-surface-800"
        >
          {selectedProducts.length > 0 ? "Agora não" : "Não, obrigado"}
        </button>
        {selectedProducts.length > 0 && (
          <button
            onClick={() => onAddMany(selectedProducts)}
            className="flex-[2] rounded-xl bg-brand-500 py-2.5 text-sm font-semibold text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-[0.98]"
          >
            Adicionar {selectedProducts.length} · {brl(total)}
          </button>
        )}
      </div>
    </Sheet>
  );
}

// ---------- Carrinho ----------

function CartSheet({
  cart,
  setCart,
  subtotal,
  onClose,
  onCheckout,
}: {
  cart: CartItem[];
  setCart: React.Dispatch<React.SetStateAction<CartItem[]>>;
  subtotal: number;
  onClose: () => void;
  onCheckout: () => void;
}) {
  function updateQty(key: string, delta: number) {
    setCart((prev) =>
      prev
        .map((i) => (i.key === key ? { ...i, quantity: i.quantity + delta } : i))
        .filter((i) => i.quantity > 0),
    );
  }

  return (
    <Sheet onClose={onClose} title="Seu carrinho">
      {cart.length === 0 ? (
        <p className="py-10 text-center text-sm text-surface-400">Carrinho vazio.</p>
      ) : (
        <>
          <div className="space-y-4">
            {cart.map((item) => (
              <div key={item.key} className="flex gap-3">
                {item.product.imageUrl && (
                  <img src={item.product.imageUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{item.product.name}</p>
                  {item.addons.map((a) => (
                    <p key={a.addonId} className="text-xs text-emerald-600 dark:text-emerald-400">
                      + {a.quantity}× {a.name}
                    </p>
                  ))}
                  {item.removals.map((r) => (
                    <p key={r.id} className="text-xs text-red-500">− sem {r.name}</p>
                  ))}
                  {item.notes && <p className="text-xs italic text-surface-400">“{item.notes}”</p>}
                  <p className="mt-1 text-sm font-bold text-brand-600 dark:text-brand-400">
                    {brl(itemUnitPrice(item) * item.quantity)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end justify-between">
                  <button
                    onClick={() => setCart((prev) => prev.filter((i) => i.key !== item.key))}
                    className="p-1 text-surface-300 hover:text-red-500"
                  >
                    <Trash2 size={14} />
                  </button>
                  <div className="flex items-center gap-2 rounded-lg border border-surface-200 px-2 py-1 dark:border-surface-700">
                    <button onClick={() => updateQty(item.key, -1)}>
                      <Minus size={13} />
                    </button>
                    <span className="w-4 text-center text-sm font-semibold">{item.quantity}</span>
                    <button onClick={() => updateQty(item.key, 1)}>
                      <Plus size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-between border-t border-surface-100 pt-4 text-sm dark:border-surface-800">
            <span className="text-surface-500">Subtotal</span>
            <span className="font-bold">{brl(subtotal)}</span>
          </div>
          <button
            onClick={onCheckout}
            className="mt-4 w-full rounded-xl bg-brand-500 py-3.5 font-semibold text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-[0.98]"
          >
            Continuar
          </button>
        </>
      )}
    </Sheet>
  );
}

// ---------- Checkout ----------

function CheckoutSheet({
  menu,
  cart,
  subtotal,
  table,
  onBack,
  onClose,
  onSuccess,
  onPixPayment,
}: {
  menu: MenuData;
  cart: CartItem[];
  subtotal: number;
  table?: { number: number } | null;
  onBack: () => void;
  onClose: () => void;
  onSuccess: (o: {
    number: number;
    totalCents: number;
    orderId: string;
    earnedPoints?: number;
    earnedCashbackCents?: number;
    type?: "DELIVERY" | "PICKUP" | "DINE_IN";
  }) => void;
  onPixPayment: (p: PayingState) => void;
}) {
  const { tenant } = menu;
  const [type, setType] = useState<"DELIVERY" | "PICKUP" | "DINE_IN">(
    table ? "DINE_IN" : tenant.acceptsDelivery ? "DELIVERY" : "PICKUP",
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [street, setStreet] = useState("");
  const [number, setNumber] = useState("");
  const [neighborhood, setNeighborhood] = useState("");
  const [city, setCity] = useState("");
  const [complement, setComplement] = useState("");
  const [payment, setPayment] = useState(tenant.paymentMethods[0] ?? "PIX");
  const [changeFor, setChangeFor] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponApplied, setCouponApplied] = useState<{ code: string; type: string; valueCents: number; valuePct: number } | null>(null);
  const [couponError, setCouponError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // ---- Fidelidade: saldo de cashback do cliente, identificado pelo telefone
  const [loyaltyBalance, setLoyaltyBalance] = useState<{ active: boolean; cashbackCents: number } | null>(null);
  const [useCashback, setUseCashback] = useState(false);

  useEffect(() => {
    if (phone.length < 10) {
      setLoyaltyBalance(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ active: boolean; cashbackCents: number }>(`/public/${tenant.slug}/loyalty/${phone}`)
        .then(setLoyaltyBalance)
        .catch(() => setLoyaltyBalance(null));
    }, 500);
    return () => clearTimeout(timer);
  }, [phone, tenant.slug]);

  // ---- Frete calculado automaticamente pela distância (o cliente não escolhe)
  const [deliveryQuote, setDeliveryQuote] = useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const quoteSeq = useRef(0);

  // ---- Busca automática de endereço pelo CEP — só falta o número/lote
  const [cep, setCep] = useState("");
  const [cepLoading, setCepLoading] = useState(false);
  const [cepError, setCepError] = useState("");
  const numberInputRef = useRef<HTMLInputElement>(null);

  async function lookupCep(rawCep: string) {
    const digits = rawCep.replace(/\D/g, "");
    if (digits.length !== 8) return;
    setCepError("");
    setCepLoading(true);
    try {
      const res = await fetch(`https://viacep.com.br/ws/${digits}/json/`);
      const found = await res.json();
      if (found.erro) {
        setCepError("CEP não encontrado. Digite o endereço manualmente.");
        return;
      }
      setStreet(found.logradouro ?? "");
      setNeighborhood(found.bairro ?? "");
      setCity(found.localidade ?? "");
      setCoords(null);
      numberInputRef.current?.focus();
    } catch {
      setCepError("Não foi possível buscar esse CEP agora. Digite o endereço manualmente.");
    } finally {
      setCepLoading(false);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setQuoteError("Seu navegador não suporta localização automática. Digite o endereço.");
      return;
    }
    setLocating(true);
    setQuoteError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setQuoteError("Não conseguimos acessar sua localização. Digite o endereço manualmente.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const hasAddressText = street.trim() && number.trim() && neighborhood.trim() && city.trim();

  useEffect(() => {
    if (type !== "DELIVERY" || (!coords && !hasAddressText)) {
      setDeliveryQuote(null);
      setQuoteError("");
      setQuoting(false);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    setQuoteError("");
    const timer = setTimeout(
      async () => {
        try {
          const quote = await api.post<DeliveryQuote & { suggestedAddress?: { street: string; number: string; neighborhood: string; city: string } }>(
            `/public/${tenant.slug}/quote-delivery`,
            coords
              ? { lat: coords.lat, lng: coords.lng, subtotalCents: subtotal }
              : { street, number, neighborhood, city, subtotalCents: subtotal },
          );
          if (quoteSeq.current !== seq) return;
          setDeliveryQuote(quote);
          setQuoting(false);
          // Preenche os campos de endereço (editáveis) a partir da localização — só na primeira vez
          if (quote.suggestedAddress && !street.trim()) {
            setStreet(quote.suggestedAddress.street);
            setNumber(quote.suggestedAddress.number);
            setNeighborhood(quote.suggestedAddress.neighborhood);
            setCity(quote.suggestedAddress.city);
          }
        } catch (err) {
          if (quoteSeq.current !== seq) return;
          setDeliveryQuote(null);
          setQuoteError(err instanceof Error ? err.message : "Não foi possível calcular o frete.");
          setQuoting(false);
        }
      },
      coords ? 0 : 700,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, street, number, neighborhood, city, coords, tenant.slug, subtotal]);

  let deliveryFee = type === "DELIVERY" ? (deliveryQuote?.feeCents ?? 0) : 0;
  if (couponApplied?.type === "FREE_SHIPPING") deliveryFee = 0;

  let discount = 0;
  if (couponApplied?.type === "PERCENT") discount = Math.round((subtotal * couponApplied.valuePct) / 100);
  if (couponApplied?.type === "FIXED") discount = Math.min(couponApplied.valueCents, subtotal);

  const redeemCashbackCents =
    useCashback && !couponApplied && loyaltyBalance ? Math.min(loyaltyBalance.cashbackCents, subtotal) : 0;
  if (redeemCashbackCents > 0) discount = redeemCashbackCents;

  const total = subtotal - discount + deliveryFee;

  async function applyCoupon() {
    setCouponError("");
    try {
      const c = await api.post<{ code: string; type: string; valueCents: number; valuePct: number }>(
        `/public/${tenant.slug}/validate-coupon`,
        { code: couponCode, subtotalCents: subtotal },
      );
      setCouponApplied(c);
    } catch (err) {
      setCouponApplied(null);
      setCouponError(err instanceof Error ? err.message : "Cupom inválido");
    }
  }

  async function submit() {
    setError("");
    if (!name.trim() || phone.length < 10) {
      setError("Informe seu nome e um telefone válido.");
      return;
    }
    if (type === "DELIVERY") {
      if (!street.trim() || !number.trim() || !neighborhood.trim() || !city.trim()) {
        setError("Preencha o endereço de entrega.");
        return;
      }
      if (quoting) {
        setError("Aguarde o cálculo do frete...");
        return;
      }
      if (!deliveryQuote) {
        setError(quoteError || "Não foi possível calcular o frete para este endereço.");
        return;
      }
    }
    setSubmitting(true);
    const isOnline = payment.startsWith("ONLINE_");
    try {
      const order = await api.post<{
        orderId: string;
        number: number;
        totalCents: number;
        earnedPoints?: number;
        earnedCashbackCents?: number;
      }>(
        `/public/${tenant.slug}/orders`,
        {
          type,
          tableNumber: table?.number,
          paymentMethod: isOnline ? "ONLINE" : payment,
          changeForCents: payment === "CASH" && changeFor ? Math.round(parseFloat(changeFor.replace(",", ".")) * 100) : undefined,
          couponCode: couponApplied?.code,
          redeemCashbackCents: redeemCashbackCents > 0 ? redeemCashbackCents : undefined,
          customer: { name: name.trim(), phone },
          address:
            type === "DELIVERY"
              ? {
                  street,
                  number,
                  neighborhood,
                  city,
                  complement: complement || undefined,
                  lat: coords?.lat,
                  lng: coords?.lng,
                }
              : undefined,
          items: cart.map((i) => ({
            productId: i.product.id,
            quantity: i.quantity,
            notes: i.notes || undefined,
            addonIds: i.addons.map((a) => ({ addonId: a.addonId, quantity: a.quantity })),
            removedIngredientIds: i.removals.map((r) => r.id),
          })),
        },
      );

      if (isOnline && payment === "ONLINE_CARD") {
        // O cartão é coletado dentro do PaymentSheet (Payment Brick embutido) —
        // o POST .../pay só acontece depois que o Brick devolve o token tokenizado.
        onPixPayment({
          orderId: order.orderId,
          number: order.number,
          totalCents: order.totalCents,
          method: "CARD",
          earnedPoints: order.earnedPoints,
          earnedCashbackCents: order.earnedCashbackCents,
          type,
        });
        return;
      }

      if (isOnline) {
        const pay = await api.post<{
          method: string;
          pixQrCode?: string;
          pixQrBase64?: string;
        }>(`/public/${tenant.slug}/orders/${order.orderId}/pay`, { method: "PIX" });

        onPixPayment({
          orderId: order.orderId,
          number: order.number,
          totalCents: order.totalCents,
          method: "PIX",
          earnedPoints: order.earnedPoints,
          earnedCashbackCents: order.earnedCashbackCents,
          pixQrCode: pay.pixQrCode,
          pixQrImage: pay.pixQrBase64
            ? `data:image/png;base64,${pay.pixQrBase64}`
            : `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(pay.pixQrCode ?? "")}`,
          type,
        });
        return;
      }
      onSuccess({ ...order, type });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao enviar pedido");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-xl border border-surface-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-surface-700 dark:bg-surface-850";

  return (
    <Sheet onClose={onClose} title="Finalizar pedido">
      <button onClick={onBack} className="mb-4 flex items-center gap-1 text-sm text-surface-400">
        <ArrowLeft size={14} /> Voltar ao carrinho
      </button>

      {/* Tipo */}
      {table ? (
        <div className="mb-4 rounded-xl border border-brand-300 bg-brand-500/5 px-3 py-2.5 text-sm font-medium text-brand-600 dark:border-brand-700 dark:text-brand-400">
          🍽️ Mesa {table.number} — a conta é fechada com o garçom
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-2 gap-2">
          {tenant.acceptsDelivery && (
            <button
              onClick={() => setType("DELIVERY")}
              className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                type === "DELIVERY"
                  ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                  : "border-surface-200 text-surface-500 dark:border-surface-700"
              }`}
            >
              🛵 Entrega
            </button>
          )}
          {tenant.acceptsPickup && (
            <button
              onClick={() => setType("PICKUP")}
              className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                type === "PICKUP"
                  ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                  : "border-surface-200 text-surface-500 dark:border-surface-700"
              }`}
            >
              🏃 Retirada
            </button>
          )}
        </div>
      )}

      {!table && type === "PICKUP" && (
        <div className="mb-4 rounded-xl border border-brand-300 bg-brand-500/5 px-3 py-2.5 text-sm dark:border-brand-700">
          <p className="mb-1 flex items-center gap-1.5 font-medium text-brand-700 dark:text-brand-400">
            <MapPinned size={14} /> Retire em:
          </p>
          {tenant.address ? (
            <>
              <p className="text-surface-600 dark:text-surface-300">{tenant.address}</p>
              <a
                href={storeMapUrl(tenant.address, tenant.storeLat, tenant.storeLng) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-xs font-semibold text-brand-600 underline dark:text-brand-400"
              >
                Ver rota no mapa
              </a>
            </>
          ) : (
            <p className="text-surface-500">
              Endereço não cadastrado — a loja ainda precisa preencher em Configurações → Geral.
            </p>
          )}
        </div>
      )}

      {/* Dados */}
      <div className="mb-4 space-y-3">
        <input className={inputClass} placeholder="Seu nome *" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className={inputClass}
          placeholder="(11) 91234-5678"
          inputMode="tel"
          value={formatPhoneBR(phone)}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 11))}
        />
      </div>

      {type === "DELIVERY" && (
        <div className="mb-4 space-y-3">
          <button
            type="button"
            onClick={useMyLocation}
            disabled={locating}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-brand-300 bg-brand-500/5 py-2.5 text-sm font-medium text-brand-600 transition-colors hover:bg-brand-500/10 disabled:opacity-60 dark:border-brand-700 dark:text-brand-400"
          >
            <Crosshair size={15} />
            {locating ? "Localizando..." : "Usar minha localização atual"}
          </button>
          <p className="text-center text-xs text-surface-400">ou informe seu CEP</p>
          <div className="flex items-center gap-2">
            <input
              className={inputClass}
              placeholder="CEP"
              inputMode="numeric"
              value={formatCep(cep)}
              onChange={(e) => {
                const formatted = formatCep(e.target.value);
                setCep(formatted);
                setCepError("");
                if (formatted.replace(/\D/g, "").length === 8) lookupCep(formatted);
              }}
            />
            {cepLoading && <span className="shrink-0 text-xs text-surface-400">Buscando...</span>}
          </div>
          {cepError && <p className="text-xs text-red-500">{cepError}</p>}
          <p className="text-center text-xs text-surface-400">
            ou preencha o endereço manualmente
          </p>
          <div className="grid grid-cols-3 gap-3">
            <input
              className={`${inputClass} col-span-2`}
              placeholder="Rua *"
              value={street}
              onChange={(e) => {
                setStreet(e.target.value);
                setCoords(null);
              }}
            />
            <input
              ref={numberInputRef}
              className={inputClass}
              placeholder="Nº *"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <input
              className={inputClass}
              placeholder="Bairro *"
              value={neighborhood}
              onChange={(e) => {
                setNeighborhood(e.target.value);
                setCoords(null);
              }}
            />
            <input
              className={inputClass}
              placeholder="Cidade *"
              value={city}
              onChange={(e) => {
                setCity(e.target.value);
                setCoords(null);
              }}
            />
          </div>
          <input
            className={inputClass}
            placeholder="Complemento"
            value={complement}
            onChange={(e) => setComplement(e.target.value)}
          />

          {/* Status do frete — calculado automaticamente, o cliente não escolhe */}
          {quoting && (
            <p className="flex items-center gap-2 text-xs text-surface-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Calculando frete...
            </p>
          )}
          {!quoting && quoteError && (
            <p className="flex items-center gap-1.5 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
              <MapPinned size={13} /> {quoteError}
            </p>
          )}
          {!quoting && deliveryQuote && (
            <p className="flex items-center gap-1.5 rounded-xl bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <MapPinned size={13} />
              {deliveryQuote.feeCents === 0 ? "Entrega grátis" : `Entrega ${brl(deliveryQuote.feeCents)}`} ·{" "}
              {deliveryQuote.distanceKm} km · ~{deliveryQuote.etaMinutes} min
            </p>
          )}
        </div>
      )}

      {/* Pagamento */}
      <h3 className="mb-2 text-sm font-semibold">Pagamento</h3>
      {tenant.onlinePayments && (
        <>
          <p className="mb-1.5 text-xs font-medium text-surface-400">Pagar agora (online)</p>
          <div className="mb-3 grid grid-cols-2 gap-2">
            {[
              { value: "ONLINE_PIX", label: "💠 Pix", hint: "aprovação na hora" },
              ...(tenant.cardCheckoutAvailable
                ? [{ value: "ONLINE_CARD", label: "💳 Cartão", hint: "" }]
                : []),
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPayment(opt.value)}
                className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  payment === opt.value
                    ? "border-brand-500 bg-brand-500/10"
                    : "border-surface-200 dark:border-surface-700"
                }`}
              >
                <p className={`text-sm font-semibold ${payment === opt.value ? "text-brand-600 dark:text-brand-400" : ""}`}>
                  {opt.label}
                </p>
                {opt.hint && <p className="text-[11px] text-surface-400">{opt.hint}</p>}
              </button>
            ))}
          </div>
          <p className="mb-1.5 text-xs font-medium text-surface-400">
            Pagar na {type === "DELIVERY" ? "entrega" : type === "DINE_IN" ? "mesa" : "retirada"}
          </p>
        </>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {tenant.paymentMethods
          .filter((m) => PAYMENT_OPTIONS[m])
          .map((m) => (
            <button
              key={m}
              onClick={() => setPayment(m)}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
                payment === m
                  ? "border-brand-500 bg-brand-500/10 text-brand-600 dark:text-brand-400"
                  : "border-surface-200 text-surface-500 dark:border-surface-700"
              }`}
            >
              {PAYMENT_OPTIONS[m]}
            </button>
          ))}
      </div>
      {payment === "CASH" && (
        <input
          className={`${inputClass} mb-4`}
          placeholder="Troco para quanto? (ex.: 100,00)"
          value={changeFor}
          onChange={(e) => setChangeFor(e.target.value)}
        />
      )}

      {/* Cashback de fidelidade */}
      {loyaltyBalance?.active && loyaltyBalance.cashbackCents > 0 && (
        <label
          className={`mb-3 flex items-center justify-between rounded-xl border px-3.5 py-2.5 text-sm ${
            couponApplied
              ? "border-surface-200 opacity-50 dark:border-surface-700"
              : "border-emerald-300 bg-emerald-500/5 dark:border-emerald-700"
          }`}
        >
          <span>
            Você tem <strong>{brl(loyaltyBalance.cashbackCents)}</strong> de cashback
          </span>
          <input
            type="checkbox"
            checked={useCashback}
            disabled={!!couponApplied}
            onChange={(e) => setUseCashback(e.target.checked)}
            className="h-4 w-4 accent-brand-500"
          />
        </label>
      )}

      {/* Cupom */}
      <div className="mb-4 flex gap-2">
        <input
          className={inputClass}
          placeholder="Cupom de desconto"
          value={couponCode}
          disabled={useCashback}
          onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
        />
        <button
          onClick={applyCoupon}
          disabled={!couponCode || useCashback}
          className="shrink-0 rounded-xl bg-surface-100 px-4 text-sm font-medium text-surface-600 disabled:opacity-50 dark:bg-surface-800 dark:text-surface-300"
        >
          Aplicar
        </button>
      </div>
      {couponApplied && (
        <p className="mb-3 flex items-center gap-1 text-sm text-emerald-600">
          <Check size={14} /> Cupom {couponApplied.code} aplicado!
        </p>
      )}
      {couponError && <p className="mb-3 text-sm text-red-500">{couponError}</p>}

      {/* Resumo */}
      <div className="mb-4 space-y-1.5 rounded-2xl bg-surface-50 p-4 text-sm dark:bg-surface-850">
        <div className="flex justify-between text-surface-500">
          <span>Subtotal</span>
          <span>{brl(subtotal)}</span>
        </div>
        {discount > 0 && (
          <div className="flex justify-between text-emerald-600">
            <span>Desconto</span>
            <span>−{brl(discount)}</span>
          </div>
        )}
        {type === "DELIVERY" && (
          <div className="flex justify-between text-surface-500">
            <span>Entrega</span>
            <span>{deliveryFee === 0 ? <span className="font-medium text-emerald-600">Grátis</span> : brl(deliveryFee)}</span>
          </div>
        )}
        <div className="flex justify-between border-t border-surface-200 pt-2 text-base font-bold dark:border-surface-700">
          <span>Total</span>
          <span>{brl(total)}</span>
        </div>
      </div>

      {error && (
        <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}

      <button
        onClick={submit}
        disabled={submitting || cart.length === 0 || (type === "DELIVERY" && (quoting || !deliveryQuote))}
        className="w-full rounded-xl bg-brand-500 py-3.5 font-semibold text-white shadow-lg shadow-brand-500/30 transition-transform active:scale-[0.98] disabled:opacity-60"
      >
        {submitting
          ? "Enviando..."
          : payment.startsWith("ONLINE_")
            ? `Pagar agora · ${brl(total)}`
            : `Confirmar pedido · ${brl(total)}`}
      </button>
    </Sheet>
  );
}

// ---------- Pagamento online (Pix / retorno do cartão) ----------

function PaymentSheet({
  slug,
  paying,
  onPaid,
  onClose,
}: {
  slug: string;
  paying: PayingState;
  onPaid: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  // Cartão: só existe um Payment pra consultar depois que o Brick devolve o token.
  const [cardProcessing, setCardProcessing] = useState(paying.method !== "CARD");
  const [cardError, setCardError] = useState("");
  const cardProcessingRef = useRef(cardProcessing);
  cardProcessingRef.current = cardProcessing;

  useEffect(() => {
    const interval = setInterval(async () => {
      if (!cardProcessingRef.current) return; // Brick ainda coletando o cartão
      try {
        const p = await api.get<{ status: string }>(`/public/${slug}/orders/${paying.orderId}/payment`);
        if (p.status === "APPROVED") {
          clearInterval(interval);
          onPaid();
        } else if (p.status === "REJECTED" || p.status === "CANCELED") {
          clearInterval(interval);
          setFailed(true);
        }
      } catch {
        // segue tentando
      }
    }, 4000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, paying.orderId]);

  function copyPix() {
    if (!paying.pixQrCode) return;
    navigator.clipboard.writeText(paying.pixQrCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  async function submitCard(formData: {
    token: string;
    installments: number;
    payment_method_id: string;
    payer?: { identification?: { type: string; number: string } };
  }) {
    setCardError("");
    try {
      const res = await api.post<{ status: string }>(`/public/${slug}/orders/${paying.orderId}/pay`, {
        method: "CARD",
        token: formData.token,
        installments: formData.installments,
        paymentMethodId: formData.payment_method_id,
        payerDocType: formData.payer?.identification?.type,
        payerDocNumber: formData.payer?.identification?.number,
      });
      if (res.status === "APPROVED") {
        onPaid();
      } else if (res.status === "REJECTED" || res.status === "CANCELED") {
        setFailed(true);
      } else {
        setCardProcessing(true);
      }
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "Não foi possível processar o cartão. Tente novamente.");
      throw err; // o Brick reabilita o formulário quando o onSubmit rejeita
    }
  }

  return (
    <Sheet
      onClose={onClose}
      title={
        paying.method === "PIX"
          ? "Pague com Pix"
          : cardProcessing
            ? "Confirmando pagamento"
            : "Pagar com cartão"
      }
    >
      <div className="flex flex-col items-center gap-4 text-center">
        <p className="text-sm text-surface-500">
          Pedido {paying.number ? `#${paying.number}` : ""} ·{" "}
          <strong className="text-surface-900 dark:text-surface-100">{brl(paying.totalCents)}</strong>
        </p>

        {failed ? (
          <p className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400">
            O pagamento não foi aprovado. 😕 Feche e tente novamente.
          </p>
        ) : paying.method === "PIX" ? (
          <>
            {paying.pixQrImage && (
              <img
                src={paying.pixQrImage}
                alt="QR Code Pix"
                className="h-56 w-56 rounded-2xl border border-surface-200 bg-white p-2 dark:border-surface-700"
              />
            )}
            <p className="text-xs text-surface-400">
              Abra o app do seu banco, escolha <strong>Pix → Ler QR Code</strong>
              <br />
              ou use o copia e cola:
            </p>
            {paying.pixQrCode && (
              <button
                onClick={copyPix}
                className="w-full rounded-xl border border-dashed border-surface-300 bg-surface-50 px-3 py-2.5 font-mono text-[10px] text-surface-500 transition-colors hover:border-brand-400 dark:border-surface-600 dark:bg-surface-850"
              >
                <span className="line-clamp-2 break-all">{paying.pixQrCode}</span>
                <span className="mt-1 block text-xs font-sans font-semibold text-brand-600 dark:text-brand-400">
                  {copied ? "✓ Copiado!" : "Tocar para copiar"}
                </span>
              </button>
            )}
          </>
        ) : cardProcessing ? (
          <p className="text-sm text-surface-500">
            Estamos confirmando seu pagamento com a operadora do cartão...
          </p>
        ) : (
          <div className="w-full text-left">
            {cardError && (
              <p className="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                {cardError}
              </p>
            )}
            <Payment
              initialization={{ amount: paying.totalCents / 100 }}
              customization={{ paymentMethods: { creditCard: "all", debitCard: "all" } }}
              onSubmit={async ({ formData }) => {
                await submitCard(formData);
              }}
              onError={() => setCardError("Não foi possível carregar o formulário de cartão. Tente novamente.")}
            />
          </div>
        )}

        {!failed && (paying.method === "PIX" || cardProcessing) && (
          <p className="flex items-center gap-2 text-xs text-surface-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            Aguardando confirmação — esta tela atualiza sozinha
          </p>
        )}
      </div>
    </Sheet>
  );
}
