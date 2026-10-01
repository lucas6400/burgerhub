/**
 * Limite simples por telefone pra chamada de IA do bot — o estado permanece
 * "MAIN" quando a IA não reconhece nada, então sem isso um número mandando
 * mensagens soltas repetidas dispararia a IA a cada mensagem (única
 * superfície de custo variável do bot).
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function allowAiCall(
  tenantId: string,
  phone: string,
  max = 4,
  windowMs = 15 * 60_000,
): boolean {
  const key = `${tenantId}:${phone}`;
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count++;
  return bucket.count <= max;
}
