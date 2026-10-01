import { prisma } from "../../lib/prisma.js";
import { estimateCostCents, type TokenUsage } from "./pricing.js";

export type AiUsagePurpose = "conversation_executor" | "conversation_redator" | "intent" | "receipt_vision";

/**
 * Grava o consumo real de uma chamada à Anthropic — é o que faltava pra medir
 * custo de verdade em vez de estimar. Nunca lança: é observabilidade, uma
 * falha aqui não pode derrubar a resposta já dada ao cliente (sempre chamado
 * via `background()` nos pontos de chamada).
 */
export async function logAiUsage(tenantId: string, purpose: AiUsagePurpose, model: string, usage: TokenUsage): Promise<void> {
  try {
    await prisma.aiUsageLog.create({
      data: {
        tenantId,
        purpose,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
        estimatedCostCents: estimateCostCents(model, usage) ?? 0,
      },
    });
  } catch (err) {
    console.error("[ai/usage-log] falha ao gravar consumo de IA:", err);
  }
}
