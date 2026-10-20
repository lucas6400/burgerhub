/** Hosts em que um link de local do Google Maps pode estar (link curto do app, link completo e fichas do Google). */
const MAPS_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co", "g.page", "share.google", "maps.google.com", "www.google.com", "google.com"]);

/**
 * Link de local do Google Maps: https + domínio do Google. Os domínios genéricos (google.com) só valem no caminho /maps —
 * o texto vai direto pro cliente no WhatsApp, então não aceita qualquer URL colada por engano.
 */
export function isGoogleMapsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || !MAPS_HOSTS.has(url.hostname)) return false;
  if (url.hostname.endsWith("google.com")) return url.pathname.startsWith("/maps") || url.hostname === "maps.google.com";
  if (url.hostname === "goo.gl") return url.pathname.startsWith("/maps");
  return true;
}
