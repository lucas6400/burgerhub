// Token do CLIENTE no cardápio público — separado do token de staff (lib/api.ts)
// e guardado por loja: o mesmo navegador pode visitar o cardápio de várias
// hamburguerias diferentes, então logar numa não pode parecer logado na outra.
const PREFIX = "burgerhub.customer.token.";

export function getCustomerToken(slug: string) {
  return localStorage.getItem(PREFIX + slug);
}
export function setCustomerToken(slug: string, token: string | null) {
  if (token) localStorage.setItem(PREFIX + slug, token);
  else localStorage.removeItem(PREFIX + slug);
}
