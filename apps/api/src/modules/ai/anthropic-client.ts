import { Anthropic } from "@anthropic-ai/sdk";
import { env } from "../../config/env.js";

/**
 * Client único da Anthropic, compartilhado por toda chamada de IA do projeto
 * (conversa do bot, reconhecimento de intenção, leitura de comprovante Pix) —
 * antes cada arquivo instanciava o seu próprio, com o mesmo código triplicado.
 */
let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.anthropic.apiKey });
  return client;
}

export const AI_MODEL_HAIKU = env.anthropic.modelHaiku;
export const AI_MODEL_SONNET = env.anthropic.modelSonnet;
