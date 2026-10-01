/**
 * Preço por milhão de tokens, em CENTAVOS de dólar — conferir a tabela oficial
 * (anthropic.com/pricing) antes de editar quando o valor mudar. O custo de cada
 * chamada é calculado e gravado no momento em que ela acontece (ver usage-log.ts),
 * nunca recalculado depois — mudar aqui só afeta chamadas futuras.
 *
 * Casado por substring do nome do modelo (não por string exata) pra sobreviver
 * a troca de versão (ex.: "claude-haiku-4-5" → "claude-haiku-5") sem precisar
 * editar esta tabela toda vez — só quando o PREÇO mudar de verdade.
 */
interface ModelPricing {
  inputPerMTokCents: number;
  outputPerMTokCents: number;
  cachedInputPerMTokCents: number;
}

const PRICING_TABLE: { match: (model: string) => boolean; pricing: ModelPricing }[] = [
  { match: (m) => m.includes("haiku"), pricing: { inputPerMTokCents: 100, outputPerMTokCents: 500, cachedInputPerMTokCents: 10 } },
  { match: (m) => m.includes("sonnet"), pricing: { inputPerMTokCents: 300, outputPerMTokCents: 1500, cachedInputPerMTokCents: 30 } },
  { match: (m) => m.includes("opus"), pricing: { inputPerMTokCents: 1500, outputPerMTokCents: 7500, cachedInputPerMTokCents: 150 } },
];

function pricingFor(model: string): ModelPricing | null {
  return PRICING_TABLE.find((p) => p.match(model))?.pricing ?? null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Custo estimado em centavos de dólar. `inputTokens` já vem SEM os tokens de
 * cache (a API devolve os três separados — ver doc do SDK); escrita de cache
 * custa ~25% a mais que input normal, leitura de cache custa a fração reduzida
 * da tabela. Devolve null (e loga um aviso) se o modelo não está na tabela —
 * melhor não gravar um custo inventado do que gravar um número errado.
 */
export function estimateCostCents(model: string, usage: TokenUsage): number | null {
  const pricing = pricingFor(model);
  if (!pricing) {
    console.warn(`[ai/pricing] modelo desconhecido na tabela de preço, custo não calculado: ${model}`);
    return null;
  }
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cost =
    (usage.inputTokens / 1_000_000) * pricing.inputPerMTokCents +
    (cacheCreation / 1_000_000) * pricing.inputPerMTokCents * 1.25 +
    (cacheRead / 1_000_000) * pricing.cachedInputPerMTokCents +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMTokCents;
  return Math.round(cost);
}
