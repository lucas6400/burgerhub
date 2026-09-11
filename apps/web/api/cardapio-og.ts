import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * Injeta meta tags Open Graph no HTML do cardápio público antes de servir —
 * necessário porque crawlers de WhatsApp/Instagram/Facebook não executam
 * JavaScript, então trocar o <title> do lado do cliente (SPA) não afeta a
 * prévia de compartilhamento. Serve pra /cardapio/:slug (ver vercel.json).
 */

interface TenantMenu {
  tenant?: {
    name?: string;
    address?: string | null;
    logoUrl?: string | null;
    bannerUrl?: string | null;
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const slug = typeof req.query.slug === "string" ? req.query.slug : "";
  const apiUrl = process.env.API_URL ?? "https://burgerhub-api.vercel.app";
  const webOrigin = `https://${req.headers.host}`;

  const [menu, html] = await Promise.all([
    fetch(`${apiUrl}/api/public/${slug}/menu`)
      .then((r) => (r.ok ? (r.json() as Promise<TenantMenu>) : null))
      .catch(() => null),
    fetch(`${webOrigin}/index.html`).then((r) => r.text()),
  ]);

  let finalHtml = html;
  if (menu?.tenant?.name) {
    const t = menu.tenant;
    const title = `${t.name} — Cardápio Digital`;
    const description = `Peça agora no cardápio digital do ${t.name}${t.address ? ` — ${t.address}` : ""}.`;
    const image = t.bannerUrl || t.logoUrl || "";
    const pageUrl = `${webOrigin}/cardapio/${slug}`;

    const ogTags = `<title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    ${image ? `<meta property="og:image" content="${escapeHtml(image)}" />` : ""}
    <meta property="og:url" content="${escapeHtml(pageUrl)}" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />`;

    finalHtml = html.replace(/<title>.*?<\/title>/, ogTags);
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(finalHtml);
}
