/**
 * Rastreamento de vendas no cardápio digital público — Meta Pixel (automático)
 * e um script personalizado opcional (TikTok, GA4, outro). Só roda em
 * /cardapio/:slug, nunca no painel administrativo.
 */

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void;
    _fbq?: unknown;
  }
}

const MARKER_ATTR = "data-burgerhub-pixel";

// Tenant pro qual os scripts atuais foram injetados — evita que o pixel/script
// de uma loja continue "vivo" se o cliente navegar (sem F5) pra outro cardápio
// na mesma aba, o que vazaria dados de venda de um lojista pro script de outro.
let activeSlug: string | null = null;

/** Injeta o snippet oficial do Meta Pixel. */
function injectMetaPixel(pixelId: string) {
  if (document.querySelector(`script[${MARKER_ATTR}="meta"]`)) {
    // Já carregado nesta aba (ex.: troca de tenant) — o fbevents.js não
    // precisa recarregar, só reassociar o próximo "track" a este Pixel ID.
    window.fbq?.("init", pixelId);
    window.fbq?.("track", "PageView");
    return;
  }

  const script = document.createElement("script");
  script.setAttribute(MARKER_ATTR, "meta");
  script.text = `
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
  `;
  document.head.appendChild(script);
  window.fbq?.("init", pixelId);
  window.fbq?.("track", "PageView");
}

/** Recria como elementos reais de <script> — atribuir HTML direto ao DOM não executa scripts (segurança do navegador). */
function injectCustomHeadScript(rawHtml: string) {
  const container = document.createElement("template");
  container.innerHTML = rawHtml;
  container.content.querySelectorAll("script").forEach((original) => {
    const clone = document.createElement("script");
    clone.setAttribute(MARKER_ATTR, "custom");
    for (const attr of Array.from(original.attributes)) clone.setAttribute(attr.name, attr.value);
    clone.text = original.text;
    document.head.appendChild(clone);
  });
}

/** Remove os scripts/marcadores injetados pro tenant anterior antes de trocar de loja na mesma aba. */
function teardownPreviousTenant() {
  document.querySelectorAll(`[${MARKER_ATTR}="custom"]`).forEach((el) => el.remove());
  // O script base do Meta (fbevents.js) fica — é só a biblioteca, sem dado de
  // nenhum tenant. O próximo `injectMetaPixel` já rechama fbq('init', novoId).
}

/** Chame sempre que os dados do tenant carregarem no cardápio (seguro chamar de novo se o slug mudar). */
export function setupPixels(tenant: { slug: string; metaPixelId?: string | null; customHeadScript?: string | null }) {
  if (activeSlug && activeSlug !== tenant.slug) teardownPreviousTenant();
  activeSlug = tenant.slug;

  if (tenant.metaPixelId) injectMetaPixel(tenant.metaPixelId);
  if (tenant.customHeadScript) injectCustomHeadScript(tenant.customHeadScript);
}

/**
 * Dispara no momento exato em que o pedido é confirmado. Sempre emite o
 * evento customizado (qualquer script personalizado pode escutar isso via
 * `document.addEventListener("burgerhub:order_placed", (e) => ...)`),
 * e complementa com o evento nativo "Purchase" quando o Meta Pixel está ativo.
 */
export function trackPurchase(params: { totalCents: number; orderId: string; orderNumber: number }) {
  const valueBRL = Number((params.totalCents / 100).toFixed(2));

  window.fbq?.("track", "Purchase", { value: valueBRL, currency: "BRL" });

  document.dispatchEvent(
    new CustomEvent("burgerhub:order_placed", {
      detail: { orderId: params.orderId, orderNumber: params.orderNumber, valueBRL, currency: "BRL" },
    }),
  );
}
