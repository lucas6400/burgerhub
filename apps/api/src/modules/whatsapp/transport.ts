import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";
import { prisma } from "../../lib/prisma.js";

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
};

// ---------------------------------------------------------------- REAL

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
      body: JSON.stringify({ number: phone.replace(/\D/g, ""), text }),
    });
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
