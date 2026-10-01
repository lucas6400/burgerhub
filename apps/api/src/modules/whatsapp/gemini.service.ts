import { env } from "../../config/env.js";

/**
 * Transcrição de áudio do WhatsApp via Google Gemini (REST, sem SDK). Devolve o texto falado
 * ou null quando não há chave, o áudio não é compreensível ou a chamada falha — quem chama
 * cai no aviso "só consigo ler texto".
 */
const TIMEOUT_MS = 25_000;
const MAX_AUDIO_BASE64_CHARS = 14_000_000; // ~10 MB, limite do envio inline

const PROMPT =
  "Transcreva fielmente este áudio de WhatsApp em português do Brasil, exatamente como foi falado (é um cliente de hamburgueria fazendo ou perguntando algo sobre um pedido). Devolva SOMENTE a transcrição, sem aspas, sem comentários. Se o áudio for inaudível, vazio ou só ruído, devolva exatamente: [inaudível]";

export function audioTranscriptionEnabled(): boolean {
  return !!env.gemini.apiKey;
}

export async function transcribeAudio(base64: string, mimeType: string): Promise<string | null> {
  if (!env.gemini.apiKey || !base64 || base64.length > MAX_AUDIO_BASE64_CHARS) return null;
  const mime = mimeType.split(";")[0].trim() || "audio/ogg";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.gemini.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.gemini.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
        // 2.5 "pensa" antes de responder e isso conta nos tokens de saída — desliga pra a transcrição não vir cortada.
        generationConfig: { temperature: 0, maxOutputTokens: 600, ...(env.gemini.model.includes("2.5") ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("[gemini] falha na transcrição:", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim() ?? "";
    if (!text || /^\[?inaud[ií]vel\]?$/i.test(text)) return null;
    return text.slice(0, 1000);
  } catch (err) {
    console.error("[gemini] erro ao transcrever áudio:", err);
    return null;
  }
}
