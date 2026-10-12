import { env } from "../../config/env.js";

/**
 * Transcrição de áudio do WhatsApp via Google Gemini (REST, sem SDK). Devolve o texto falado
 * ou null quando não há chave, o áudio não é compreensível ou a chamada falha — quem chama
 * cai no aviso "só consigo ler texto".
 *
 * O Google tira modelos de circulação e congestiona os novos (2.5-flash saiu das chaves novas com 404; o 3.8-flash
 * ficou em 503 "alta demanda" por horas): por isso, se o modelo principal falhar, tenta outros modelos "flash"
 * descobertos na própria chave, em vez de deixar o cliente sem resposta ao áudio.
 */
const TIMEOUT_MS = 12_000; // por tentativa
const MAX_AUDIO_BASE64_CHARS = 14_000_000; // ~10 MB, limite do envio inline
const API = "https://generativelanguage.googleapis.com/v1beta";
const MAX_FALLBACK_MODELS = 3;
const MODEL_LIST_TTL_MS = 60 * 60_000;
/** Erros temporários do Google (pico de demanda, limite por minuto): vale insistir no mesmo modelo uma vez. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_DELAY_MS = 1_000;

const PROMPT =
  "Transcreva fielmente este áudio de WhatsApp em português do Brasil, exatamente como foi falado (é um cliente de hamburgueria fazendo ou perguntando algo sobre um pedido). Devolva SOMENTE a transcrição, sem aspas, sem comentários. Se o áudio for inaudível, vazio ou só ruído, devolva exatamente: [inaudível]";

export function audioTranscriptionEnabled(): boolean {
  return !!env.gemini.apiKey;
}

type GeminiResponse = { candidates?: { content?: { parts?: { text?: string }[] } }[] };

let cachedFallbacks: { models: string[]; at: number } | null = null;

/** Modelos "flash" de texto/áudio que a chave enxerga, do mais novo pro mais antigo. Nunca lança. */
async function discoverFallbackModels(exclude: string): Promise<string[]> {
  if (cachedFallbacks && Date.now() - cachedFallbacks.at < MODEL_LIST_TTL_MS) return cachedFallbacks.models.filter((m) => m !== exclude);
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { "x-goog-api-key": env.gemini.apiKey }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
      console.error("[gemini] não consegui listar os modelos:", res.status);
      return [];
    }
    const json = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    const models = (json.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/image|tts|live|embed|thinking|exp|latest|audio/i.test(n))
      .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
    cachedFallbacks = { models, at: Date.now() };
    return models.filter((m) => m !== exclude);
  } catch (err) {
    console.error("[gemini] erro ao listar modelos:", err);
    return [];
  }
}

async function generate(model: string, mime: string, base64: string): Promise<Response> {
  // O 2.5 "pensa" antes de responder e isso conta nos tokens de saída: desliga o raciocínio (thinkingBudget só existe nele).
  // Nos modelos novos o limite maior evita transcrição cortada se o modelo pensar um pouco.
  const is25 = model.includes("2.5");
  return fetch(`${API}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": env.gemini.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
      generationConfig: { temperature: 0, maxOutputTokens: is25 ? 600 : 2048, ...(is25 ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Uma resposta ok do modelo, ou null se ele está fora do ar (insiste uma vez em erro temporário). */
async function tryModel(model: string, mime: string, base64: string, maxAttempts: number): Promise<Response | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await generate(model, mime, base64);
    } catch (err) {
      console.error("[gemini] erro de rede/tempo esgotado:", { model, attempt, err });
      continue;
    }
    if (res.ok) return res;
    const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    console.error("[gemini] falha na transcrição:", res.status, { model, attempt, detail });
    if (!RETRYABLE_STATUS.has(res.status)) return null; // 404/400/403: insistir não adianta, passa pro próximo modelo
    if (attempt === 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return null;
}

export async function transcribeAudio(base64: string, mimeType: string): Promise<string | null> {
  if (!env.gemini.apiKey || !base64 || base64.length > MAX_AUDIO_BASE64_CHARS) return null;
  const mime = mimeType.split(";")[0].trim() || "audio/ogg";
  try {
    let res = await tryModel(env.gemini.model, mime, base64, 2);
    if (!res) {
      for (const model of (await discoverFallbackModels(env.gemini.model)).slice(0, MAX_FALLBACK_MODELS)) {
        res = await tryModel(model, mime, base64, 1); // o cliente está esperando: uma tentativa por modelo alternativo
        if (res) {
          console.warn("[gemini] áudio transcrito com modelo alternativo:", model);
          break;
        }
      }
    }
    if (!res) return null;
    const json = (await res.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
    if (!text) console.error("[gemini] resposta sem texto:", JSON.stringify(json).slice(0, 300));
    if (!text || /^\[?inaud[ií]vel\]?$/i.test(text)) return null;
    return text.slice(0, 1000);
  } catch (err) {
    console.error("[gemini] erro ao transcrever áudio:", err);
    return null;
  }
}
