/**
 * Limite por telefone pro modo conversacional (IA conduz a conversa inteira) —
 * diferente do throttle do classificador em `ai-throttle.ts` (poucas chamadas
 * pontuais por pedido): aqui TODA mensagem aciona a IA, então o limite é bem
 * mais generoso (dá pra conversar um pedido inteiro sem esbarrar nele), mas
 * ainda existe pra não deixar um número malicioso/travado gerar custo sem fim.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function allowAiConversationTurn(
  tenantId: string,
  phone: string,
  max = 60,
  windowMs = 30 * 60_000,
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
