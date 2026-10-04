import { Anthropic } from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";

/**
 * Client único da Anthropic, compartilhado por toda chamada de IA do projeto
 * (conversa do bot, reconhecimento de intenção, leitura de comprovante Pix) —
 * antes cada arquivo instanciava o seu próprio, com o mesmo código triplicado.
 */
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  // O padrão do SDK espera até 10 min por resposta e tenta 2x sozinho — numa queda da API o cliente
  // ficava minutos sem resposta. Chamadas que precisam de outro limite passam o próprio por requisição.
  if (!client) client = new Anthropic({ apiKey: env.anthropic.apiKey, maxRetries: 1, timeout: 45_000 });
  return client;
}

export const AI_MODEL_HAIKU = env.anthropic.modelHaiku;
export const AI_MODEL_SONNET = env.anthropic.modelSonnet;
export const AI_MODEL_EXECUTOR = env.anthropic.modelExecutor;
