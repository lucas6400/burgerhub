import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";
import { prisma } from "../../lib/prisma.js";
import { normalizeBrazilPhone } from "./phone.js";

/**
 * Transporte de WhatsApp da plataforma.
 * Encapsula o servidor de mensagens (Evolution API) — nenhum detalhe
 * técnico vaza para o tenant: ele só escaneia um QR Code.
 *
 * Com WA_MOCK=true, simula todo o fluxo (QR → conectado) para demonstração.
 */

export type ConnectionStatus = "DISCONNECTED" | "CONNECTING" | "CONNECTED";

export interface ConnectionInfo {
  status: ConnectionStatus;
  /** src pronto para <img> (data URL ou URL) com o QR Code, quando CONNECTING */
  qrImage?: string;
  /** número conectado, quando CONNECTED */
  number?: string;
}

export function instanceNameFor(tenantId: string) {
  return `bh_${tenantId}`;
}

/** Campos crus de uma imagem recebida no webhook (formato Baileys/Evolution) — usados pra baixar o arquivo depois. */
export interface WaRawImageMessage {
  url?: string;
  mediaKey?: string;
  mimetype?: string;
  fileSha256?: string;
  fileEncSha256?: string;
  fileLength?: string;
  directPath?: string;
  caption?: string;
  /** ID da mensagem no WhatsApp — o endpoint documentado da Evolution baixa a mídia por ele. */
  messageId?: string;
}

export interface WaLabel {
  id: string;
  name: string;
}

const UNAVAILABLE = new AppError(
  503,
  "Serviço de WhatsApp temporariamente indisponível. Tente novamente em instantes.",
);

// ---------------------------------------------------------------- MOCK
// Simula o ciclo de conexão: QR por ~8s, depois "conectado".
const mockSessions = new Map<string, { startedAt: number; connected: boolean }>();

const mock = {
  async connect(instance: string): Promise<ConnectionInfo> {
    const existing = mockSessions.get(instance);
    if (existing?.connected) {
      return { status: "CONNECTED", number: "+55 11 99999-0000" };
    }
    mockSessions.set(instance, { startedAt: Date.now(), connected: false });
    return {
      status: "CONNECTING",
      qrImage: `https://api.qrserver.com/v1/create-qr-code/?size=260x260&data=${encodeURIComponent(
        `burgerhub-demo-${instance}-${Date.now()}`,
      )}`,
    };
  },
  async status(instance: string): Promise<ConnectionInfo> {
    const s = mockSessions.get(instance);
    if (!s) return { status: "DISCONNECTED" };
    if (s.connected || Date.now() - s.startedAt > 8000) {
      s.connected = true;
      return { status: "CONNECTED", number: "+55 11 99999-0000" };
    }
    return { status: "CONNECTING" };
  },
  async disconnect(instance: string) {
    mockSessions.delete(instance);
  },
  async sendText(instance: string, phone: string, text: string) {
    console.log(`📱 [WA demo] ${instance} → ${phone}:\n${text}\n`);
  },
  async sendLocation(instance: string, phone: string, place: { name: string; address: string; lat: number; lng: number }) {
    console.log(`📍 [WA demo] ${instance} → ${phone}: ${place.name} (${place.lat},${place.lng})`);
  },
  async sendImage(instance: string, phone: string, imageUrl: string, caption: string) {
    console.log(`🖼️ [WA demo] ${instance} → ${phone}: ${imageUrl}\n${caption}\n`);
  },
  async downloadImage(_instance: string, _media: WaRawImageMessage): Promise<string | null> {
    return null; // modo demo nunca recebe mídia real do WhatsApp
  },
  async downloadAudio(_instance: string, _messageId: string): Promise<string | null> {
    return null;
  },
  async listLabels(_instance: string): Promise<WaLabel[]> {
    return ["Perguntando", "Montando pedido", "Pediu", "Sumiu", "Fora da área"].map((name, i) => ({ id: String(i + 1), name }));
  },
  async setLabel(instance: string, phone: string, labelId: string, action: "add" | "remove", _onDetail?: (detail: string) => void): Promise<boolean> {
    console.log(`🏷️ [WA demo] ${instance} → ${phone}: ${action} etiqueta ${labelId}`);
    return true;
  },
};

// ---------------------------------------------------------------- REAL

const AUDIO_DOWNLOAD_ATTEMPTS = 3;
const AUDIO_DOWNLOAD_RETRY_MS = 1_500;

async function evoFetch(path: string, options: RequestInit = {}) {
  if (!env.whatsapp.serverUrl) throw UNAVAILABLE;
  const res = await fetch(`${env.whatsapp.serverUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      apikey: env.whatsapp.apiKey,
      ...options.headers,
    },
  });
  if (!res.ok && res.status !== 404) {
    console.error(`Servidor WhatsApp respondeu ${res.status} em ${path}`);
    throw UNAVAILABLE;
  }
  return res;
}

/**
 * (Re)aplica o webhook da instância apontando pra esta API. A Evolution v2 aceita o corpo embrulhado em `webhook`;
 * versões/variações mais antigas aceitam o corpo "solto" — tenta um e depois o outro. Nunca lança: falhar aqui não pode
 * impedir a conexão (só fica no log).
 */
async function ensureWebhook(instance: string): Promise<boolean> {
  const url = `${env.whatsapp.publicApiUrl}/api/whatsapp/webhook/${instance}`;
  const events = ["MESSAGES_UPSERT"];
  const bodies = [
    { webhook: { enabled: true, url, webhookByEvents: false, webhookBase64: false, events } },
    { enabled: true, url, webhookByEvents: false, webhookBase64: false, events },
  ];
  for (const body of bodies) {
    try {
      const res = await fetch(`${env.whatsapp.serverUrl}/webhook/set/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: env.whatsapp.apiKey },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      console.error(`[whatsapp] webhook/set respondeu ${res.status} (${instance}) — tentando outro formato`);
    } catch (err) {
      console.error("[whatsapp] falha ao reaplicar o webhook:", err);
    }
  }
  return false;
}

const real = {
  /** Garante a instância do tenant e retorna o QR (ou status conectado). */
  async connect(instance: string): Promise<ConnectionInfo> {
    // Cria a instância se não existir (idempotente) já apontando o webhook
    await evoFetch("/instance/create", {
      method: "POST",
      body: JSON.stringify({
        instanceName: instance,
        qrcode: true,
        integration: "WHATSAPP-BAILEYS",
        webhook: {
          url: `${env.whatsapp.publicApiUrl}/api/whatsapp/webhook/${instance}`,
          events: ["MESSAGES_UPSERT"],
        },
      }),
    }).catch(() => undefined); // já existe → segue para connect

    // Instância que já existia responde 403 acima e o webhook NÃO é recriado — depois de reinício/recriação do servidor
    // ele pode ter se perdido e o bot fica "conectado" mas sem receber nenhuma mensagem de cliente. Reaplica sempre.
    await ensureWebhook(instance);

    const res = await evoFetch(`/instance/connect/${instance}`);
    const body = (await res.json().catch(() => ({}))) as { base64?: string; code?: string };
    if (body.base64) {
      const src = body.base64.startsWith("data:") ? body.base64 : `data:image/png;base64,${body.base64}`;
      return { status: "CONNECTING", qrImage: src };
    }
    return this.status(instance);
  },

  async status(instance: string): Promise<ConnectionInfo> {
    const res = await evoFetch(`/instance/connectionState/${instance}`);
    if (res.status === 404) return { status: "DISCONNECTED" };
    const body = (await res.json().catch(() => ({}))) as {
      instance?: { state?: string; ownerJid?: string };
    };
    const state = body.instance?.state;
    if (state === "open") {
      return {
        status: "CONNECTED",
        number: body.instance?.ownerJid?.split("@")[0],
      };
    }
    if (state === "connecting") return { status: "CONNECTING" };
    return { status: "DISCONNECTED" };
  },

  async disconnect(instance: string) {
    await evoFetch(`/instance/logout/${instance}`, { method: "DELETE" }).catch(() => undefined);
  },

  async sendText(instance: string, phone: string, text: string) {
    await evoFetch(`/message/sendText/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number: normalizeBrazilPhone(phone), text }),
    });
  },

  async sendLocation(instance: string, phone: string, place: { name: string; address: string; lat: number; lng: number }) {
    await evoFetch(`/message/sendLocation/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number: normalizeBrazilPhone(phone), name: place.name, address: place.address, latitude: place.lat, longitude: place.lng }),
    });
  },

  async sendImage(instance: string, phone: string, imageUrl: string, caption: string) {
    await evoFetch(`/message/sendMedia/${instance}`, {
      method: "POST",
      body: JSON.stringify({ number: normalizeBrazilPhone(phone), mediatype: "image", mimetype: "image/jpeg", media: imageUrl, fileName: "foto.jpg", caption }),
    });
  },

  /**
   * Baixa (em base64) a imagem de uma mensagem recebida — pra ler comprovante
   * de Pix. Nunca lança: o endpoint da Evolution tem instabilidade conhecida
   * (docs de terceiros citam erro 429/500 intermitente), então qualquer falha
   * vira `null` e quem chama trata como "não consegui ler a imagem" em vez de
   * derrubar o processamento do webhook.
   */
  async downloadImage(instance: string, media: WaRawImageMessage): Promise<string | null> {
    // Caminho documentado da Evolution: baixa a mídia pelo ID da mensagem.
    if (media.messageId) {
      try {
        const res = await evoFetch(`/chat/getBase64FromMediaMessage/${instance}`, {
          method: "POST",
          body: JSON.stringify({ message: { key: { id: media.messageId } } }),
        });
        const body = (await res.json().catch(() => ({}))) as { base64?: string };
        if (body.base64) return body.base64.replace(/^data:[^;]+;base64,/, "");
      } catch (err) {
        console.error("Falha em getBase64FromMediaMessage, tentando endpoint alternativo:", err);
      }
    }
    try {
      const res = await evoFetch(`/message/downloadimage/${instance}`, {
        method: "POST",
        body: JSON.stringify(media),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; image?: string };
      return body.success && body.image ? body.image : null;
    } catch (err) {
      console.error("Falha ao baixar imagem do WhatsApp:", err);
      return null;
    }
  },

  /** Baixa (base64) o áudio de uma mensagem recebida, pelo ID. Nunca lança — falha vira null. */
  async downloadAudio(instance: string, messageId: string): Promise<string | null> {
    // O webhook pode chegar antes de a Evolution gravar a mensagem (404 / sem base64): tenta de novo antes de desistir.
    for (let attempt = 1; attempt <= AUDIO_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        const res = await evoFetch(`/chat/getBase64FromMediaMessage/${instance}`, {
          method: "POST",
          body: JSON.stringify({ message: { key: { id: messageId } } }),
        });
        const body = (await res.json().catch(() => ({}))) as { base64?: string };
        if (body.base64) return body.base64.replace(/^data:[^;]+;base64,/, "");
        console.error("[whatsapp] áudio: Evolution respondeu sem base64.", { attempt, status: res.status, body: JSON.stringify(body).slice(0, 200) });
      } catch (err) {
        console.error("[whatsapp] áudio: falha ao baixar da Evolution.", { attempt, err });
      }
      if (attempt < AUDIO_DOWNLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, AUDIO_DOWNLOAD_RETRY_MS));
    }
    return null;
  },

  async listLabels(instance: string): Promise<WaLabel[]> {
  try {
    const res = await evoFetch(`/label/findLabels/${instance}`);
    const body = (await res.json().catch(() => [])) as { id?: string | number; name?: string }[];
    return Array.isArray(body) ? body.filter((l) => l.id != null && l.name).map((l) => ({ id: String(l.id), name: String(l.name) })) : [];
  } catch (err) {
    console.error("Falha ao listar etiquetas do WhatsApp:", err);
    return [];
  }
  },
  async setLabel(
    instance: string,
    phone: string,
    labelId: string,
    action: "add" | "remove",
    onDetail?: (detail: string) => void,
  ): Promise<boolean> {
    // Tenta o número puro e, se o servidor recusar, o formato JID — a Evolution
    // aceita os dois, mas em algumas versões só um funciona (bug conhecido de JID/LID).
    const digits = normalizeBrazilPhone(phone);
    const attempts = [digits, `${digits}@s.whatsapp.net`];
    const errors: string[] = [];
    for (const number of attempts) {
      try {
        const res = await fetch(`${env.whatsapp.serverUrl}/label/handleLabel/${instance}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: env.whatsapp.apiKey },
          body: JSON.stringify({ number, labelId, action }),
        });
        const text = await res.text().catch(() => "");
        if (res.ok) {
          let success = true;
          try {
            success = (JSON.parse(text) as { success?: boolean }).success !== false;
          } catch {
            /* corpo não-JSON: confia no status */
          }
          if (success) return true;
        }
        // A Evolution aplica a etiqueta no WhatsApp e SÓ DEPOIS grava um registro no banco dela.
        // Quando o banco dela não tem o índice único (erro 42P10 / ON CONFLICT), ela devolve 400
        // mesmo com a etiqueta já aplicada. Trata esse erro específico como "enviado".
        if (/Unable to (add|remove) label/i.test(text) && /42P10|ON CONFLICT|no unique or exclusion constraint/i.test(text)) {
          onDetail?.("SOFT: o WhatsApp recebeu o comando; a Evolution só falhou ao gravar o registro interno dela.");
          return true;
        }
        errors.push(`HTTP ${res.status} (${number.includes("@") ? "jid" : "número"}): ${text.slice(0, 250)}`);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "erro de rede");
      }
    }
    console.error("Falha ao aplicar etiqueta no WhatsApp:", errors.join(" | "));
    onDetail?.(errors.join(" | "));
    return false;
  },
};

export const waTransport = env.whatsapp.mock ? mock : real;

export interface WhatsAppSender {
  sendText(phone: string, text: string): Promise<void>;
}

/**
 * Resolve por qual canal ESTE tenant envia mensagens — Evolution/QR (padrão
 * hoje, todo mundo) ou Cloud API oficial da Meta (quando o tenant concluir o
 * Embedded Signup, ainda não implementado). Retorna null se o tenant não tem
 * WhatsApp conectado por nenhum dos dois caminhos — chamador decide se isso
 * é um no-op silencioso ou um erro.
 */
export async function getWhatsAppSenderFor(tenantId: string): Promise<WhatsAppSender | null> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings) return null;

  if (settings.waProvider === "CLOUD_API") {
    if (!settings.waCloudPhoneNumberId || !settings.waCloudAccessToken) return null;
    const phoneNumberId = settings.waCloudPhoneNumberId;
    const accessToken = settings.waCloudAccessToken;
    const { cloudApiSendText } = await import("./cloud-api-transport.js");
    return { sendText: (phone, text) => cloudApiSendText(phoneNumberId, accessToken, phone, text) };
  }

  if (!settings.waEnabled || !settings.waInstanceName) return null;
  const instance = settings.waInstanceName;
  return { sendText: (phone, text) => waTransport.sendText(instance, phone, text) };
}
