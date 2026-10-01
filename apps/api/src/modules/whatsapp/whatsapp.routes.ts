import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { AppError } from "../../middlewares/error.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { audit } from "../../utils/audit.js";
import { env } from "../../config/env.js";
import { waitUntil } from "@vercel/functions";
import { getWhatsAppSenderFor, instanceNameFor, waTransport, type WaRawImageMessage } from "./transport.js";
import { handleIncoming } from "./bot.service.js";
import { recordInboundMessage, recordOutboundMessage } from "./messages.service.js";
import { serializeByKey } from "./request-queue.js";
import { maybeRunFollowUpSweep } from "./followup.service.js";
import { maybeRunLateOrderSweep } from "./late-orders.service.js";
import { audioTranscriptionEnabled, transcribeAudio } from "./gemini.service.js";
import { computeBroadcastRecipients, sendBroadcastMessage } from "./broadcast.service.js";
import { LABEL_STAGES, labelStatus, moveLead, stageFromSessionData, type LabelStage } from "./labels.service.js";

export const whatsappRoutes = Router();

/**
 * Conexão do WhatsApp do estabelecimento.
 * Fluxo do lojista: clicar em "Conectar" → escanear o QR → pronto.
 */

whatsappRoutes.post(
  "/connect",
  requireAuth,
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const instance = instanceNameFor(tenantId);
    const info = await waTransport.connect(instance);

    if (info.status === "CONNECTED") {
      await prisma.tenantSettings.update({
        where: { tenantId },
        data: { waEnabled: true, waInstanceName: instance, waNumber: info.number },
      });
    }
    res.json(info);
  }),
);

whatsappRoutes.get(
  "/status",
  requireAuth,
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const instance = instanceNameFor(tenantId);
    const info = await waTransport.status(instance);

    const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
    const wasConnected = settings?.waEnabled ?? false;
    const isConnected = info.status === "CONNECTED";
    if (isConnected !== wasConnected) {
      await prisma.tenantSettings.update({
        where: { tenantId },
        data: {
          waEnabled: isConnected,
          waInstanceName: isConnected ? instance : settings?.waInstanceName,
          waNumber: isConnected ? info.number : null,
        },
      });
      if (isConnected) {
        await audit({ tenantId, userId: req.auth!.userId, action: "WA_CONNECTED", entity: "TenantSettings" });
      }
    }
    res.json({
      ...info,
      botEnabled: settings?.botEnabled ?? true,
      aiConversationEnabled: settings?.aiConversationEnabled ?? false,
      followUpEnabled: settings?.followUpEnabled ?? false,
      waLabelsEnabled: settings?.waLabelsEnabled ?? false,
      lateOrderAlertEnabled: settings?.lateOrderAlertEnabled ?? false,
      lateOrderNotifyCustomer: settings?.lateOrderNotifyCustomer ?? false,
    });
  }),
);

whatsappRoutes.post(
  "/disconnect",
  requireAuth,
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    await waTransport.disconnect(instanceNameFor(tenantId));
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: { waEnabled: false, waNumber: null },
    });
    await audit({ tenantId, userId: req.auth!.userId, action: "WA_DISCONNECTED", entity: "TenantSettings" });
    res.json({ ok: true });
  }),
);

/** Quais etiquetas do WhatsApp Business o sistema encontrou (diagnóstico da tela). */
whatsappRoutes.get(
  "/labels/status",
  requireAuth,
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    res.json(await labelStatus(tenantId, instanceNameFor(tenantId)));
  }),
);

/** Teste manual: aplica uma etiqueta numa conversa pra o dono conferir no celular. */
whatsappRoutes.post(
  "/labels/test",
  requireAuth,
  requireRole("MANAGER"),
  rateLimit(20, 60_000),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { phone, stage } = z
      .object({ phone: z.string().min(10), stage: z.enum(Object.keys(LABEL_STAGES) as [LabelStage, ...LabelStage[]]) })
      .parse(req.body);
    let detail = "";
    const ok = await moveLead(tenantId, phone, stage, { force: true, onDetail: (d) => (detail = d) });
    res.json({ ok, soft: ok && detail.startsWith("SOFT:"), detail: ok && !detail.startsWith("SOFT:") ? undefined : detail });
  }),
);

/** Disparo "agora entregamos aí": lista de destinatários e envio de UMA mensagem por chamada (o painel espaça as chamadas). */
whatsappRoutes.get(
  "/broadcast/recipients",
  requireAuth,
  requireRole("MANAGER"),
  h(async (req, res) => {
    const audience = (req.query as Record<string, string | undefined>).audience === "buyers" ? "buyers" : "refused";
    res.json(await computeBroadcastRecipients(tenantOf(req), audience));
  }),
);

whatsappRoutes.post(
  "/broadcast/send-one",
  requireAuth,
  requireRole("MANAGER"),
  rateLimit(30, 60_000),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { phone, text, audience } = z
      .object({ phone: z.string().min(10), text: z.string().trim().min(5).max(1000), audience: z.enum(["refused", "buyers"]).default("refused") })
      .parse(req.body);
    const result = await sendBroadcastMessage(tenantId, phone, text, audience);
    if (result.status === "sent") {
      await audit({ tenantId, userId: req.auth!.userId, action: "WA_BROADCAST_SEND", entity: "Customer", detail: { phone } });
    }
    res.json(result);
  }),
);

/** Mensagem manual pra um cliente específico (ex.: avisar sobre saldo de fidelidade). */
whatsappRoutes.post(
  "/send",
  requireAuth,
  rateLimit(30, 60_000),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { phone, text } = z
      .object({ phone: z.string().min(10), text: z.string().trim().min(1).max(1000) })
      .parse(req.body);

    const sender = await getWhatsAppSenderFor(tenantId);
    if (!sender) {
      throw new AppError(409, "Conecte o WhatsApp em Configurações antes de enviar mensagens.");
    }

    await sender.sendText(phone, text);
    await recordOutboundMessage(tenantId, phone, text, { senderType: "HUMAN", byUserId: req.auth!.userId });
    // Atendente respondeu manualmente — o bot fica de fora dessa conversa por um tempo
    // pra não atropelar o humano no meio do atendimento.
    await prisma.chatSession.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      update: { botPausedUntil: new Date(Date.now() + HUMAN_PAUSE_MS) },
      create: { tenantId, phone, botPausedUntil: new Date(Date.now() + HUMAN_PAUSE_MS) },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "WA_SEND_MANUAL",
      entity: "Customer",
      detail: { phone },
    });
    res.json({ ok: true });
  }),
);

/**
 * Webhook público: recebe mensagens dos clientes e aciona o bot.
 * A instância identifica o tenant (bh_<tenantId>).
 */
whatsappRoutes.post(
  "/webhook/:instance",
  rateLimit(600, 60_000),
  h(async (req, res) => {
    res.json({ ok: true }); // responde já; processamento segue async

    const instance = req.params.instance;
    const body = req.body as WebhookBody;

    // Registrada via waitUntil: numa função serverless a Vercel pode congelar a
    // instância assim que a resposta HTTP é enviada — sem isso, processamento
    // assíncrono mais longo (ex.: a chamada de IA do bot) corria risco de ser
    // cortado no meio antes de terminar.
    waitUntil(processWebhookMessage(instance, body));
  }),
);

interface WebhookBody {
  event?: string;
  data?: {
    key?: { id?: string; remoteJid?: string; fromMe?: boolean };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string };
      locationMessage?: { degreesLatitude?: number; degreesLongitude?: number };
      imageMessage?: WaRawImageMessage;
      audioMessage?: { seconds?: number; ptt?: boolean; mimetype?: string };
    };
  };
}

/** Espera antes de responder no modo IA, pra juntar mensagens picadas do cliente. */
const BOT_DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS ?? (env.whatsapp.mock ? 0 : 10_000));
const ECHO_WAIT_MS = env.whatsapp.mock ? 0 : 3_000;
/** Depois que um humano fala com o cliente, o bot fica calado por esse tempo. */
const HUMAN_PAUSE_MS = 2 * 60 * 60_000;
const MEDIA_PLACEHOLDERS = ["📍 Localização compartilhada", "🖼️ Imagem recebida", "🎤 Áudio recebido"];
const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Áudio: o bot não escuta — registra na conversa (a equipe vê que chegou um áudio) e pede pro
 * cliente escrever, sem chamar a IA. Se um atendente está na conversa, fica calado.
 */
async function handleAudioMessage(tenantId: string, instance: string, phone: string, pushName?: string) {
  try {
    await recordInboundMessage(tenantId, phone, "🎤 Áudio recebido", pushName);
    const [flags, session] = await Promise.all([
      prisma.tenantSettings.findUnique({ where: { tenantId }, select: { botEnabled: true } }),
      prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { botPausedUntil: true } }),
    ]);
    if (!flags?.botEnabled || (session?.botPausedUntil && session.botPausedUntil > new Date())) return;
    const reply = "Recebi seu áudio 🎤, mas por aqui eu só consigo ler texto. Pode me escrever o que você precisa? 😊";
    await waTransport.sendText(instance, phone, reply);
    await recordOutboundMessage(tenantId, phone, reply, { senderType: "BOT" });
  } catch (err) {
    console.error("Erro ao tratar áudio do WhatsApp:", err);
  }
}

async function processWebhookMessage(instance: string, body: WebhookBody) {
  if (!instance.startsWith("bh_")) return;
  const tenantId = instance.slice(3);

  const eventName = (body.event ?? "").toLowerCase().replace(/_/g, ".");
  if (eventName && eventName !== "messages.upsert") return;

  const jid = body.data?.key?.remoteJid ?? "";
  if (!jid) return;
  if (jid.endsWith("@g.us")) return; // ignora grupos
  // Alguns contatos chegam com sufixo de aparelho ("5577999999999:86@s.whatsapp.net") — sem tirar,
  // o bot respondia pra um número errado e o cliente ficava sem resposta.
  const phone = jid.split("@")[0].split(":")[0];

  // Mensagem enviada pelo próprio número conectado — dono/atendente respondendo
  // direto pelo celular, fora do painel (o botão "Mensagem" da Central de
  // Atendimento já pausa o bot; isso cobre quem responde direto no WhatsApp).
  // Sem isso, o bot continuava mandando mensagem por cima da conversa humana.
  if (body.data?.key?.fromMe) {
    const humanMsg = body.data?.message;
    let humanText = humanMsg?.conversation ?? humanMsg?.extendedTextMessage?.text ?? "";
    // Áudio/foto/localização mandados à mão também são a equipe assumindo a conversa —
    // sem isso o bot continuava respondendo por cima de um áudio do atendente.
    let isMedia = false;
    if (!humanText.trim()) {
      if (humanMsg?.audioMessage) humanText = "🎤 Áudio enviado pela equipe";
      else if (humanMsg?.imageMessage) humanText = "🖼️ Imagem enviada pela equipe";
      else if (humanMsg?.locationMessage) humanText = "📍 Localização enviada pela equipe";
      isMedia = !!humanText;
    }
    if (!humanText.trim()) return;
    try {
      // O servidor de WhatsApp também devolve como "fromMe" as mensagens que o
      // PRÓPRIO sistema enviou (bot, avisos, botão Mensagem do painel) — essas já
      // ficam registradas em recordOutboundMessage logo após o envio, então
      // espera um instante e ignora o eco; só sobra o que foi digitado à mão.
      await sleep(ECHO_WAIT_MS);
      const echo = await prisma.whatsAppMessage.findFirst({
        where: {
          tenantId,
          phone,
          direction: "OUT",
          createdAt: { gte: new Date(Date.now() - 2 * 60_000) },
          // A foto e o pino da loja que o PRÓPRIO bot manda também voltam como "fromMe" — não são a equipe.
          OR: [{ body: humanText }, ...(isMedia ? [{ body: { startsWith: "🖼️ Foto enviada" } }, { body: { startsWith: "📍 Localização da loja" } }] : [])],
        },
        select: { id: true },
      });
      if (echo) return;
      // Ticket de pedido novo mandado pro próprio dono também não é conversa com cliente.
      const alertSettings = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { orderAlertPhone: true } });
      const alertDigits = alertSettings?.orderAlertPhone?.replace(/\D/g, "").slice(-10);
      if (alertDigits && phone.replace(/\D/g, "").endsWith(alertDigits)) return;

      const pausedUntil = new Date(Date.now() + HUMAN_PAUSE_MS);
      await prisma.chatSession.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        update: { botPausedUntil: pausedUntil },
        create: { tenantId, phone, botPausedUntil: pausedUntil },
      });
      // Áudio da equipe: o bot já está pausado; transcreve pra a conversa ficar legível
      // (e pro bot saber o que foi combinado quando voltar a atender).
      const staffAudioId = body.data?.key?.id;
      if (humanMsg?.audioMessage && staffAudioId && audioTranscriptionEnabled()) {
        const b64 = await waTransport.downloadAudio(instance, staffAudioId);
        const transcript = b64 ? await transcribeAudio(b64, humanMsg.audioMessage.mimetype ?? "audio/ogg") : null;
        if (transcript) humanText = `🎤 (áudio da equipe) ${transcript}`;
      }
      await recordOutboundMessage(tenantId, phone, humanText, { senderType: "HUMAN" });
    } catch (err) {
      console.error("Erro ao registrar mensagem humana do WhatsApp:", err);
    }
    return;
  }
  const loc = body.data?.message?.locationMessage;
  const location =
    loc?.degreesLatitude != null && loc?.degreesLongitude != null
      ? { lat: loc.degreesLatitude, lng: loc.degreesLongitude }
      : undefined;
  const img = body.data?.message?.imageMessage;
  const image = img?.url && img?.mediaKey ? { ...img, messageId: body.data?.key?.id } : undefined;
  // Legenda da foto vira o texto da mensagem (o bot lê a imagem junto com ela).
  let text = body.data?.message?.conversation ?? body.data?.message?.extendedTextMessage?.text ?? (image ? img?.caption ?? "" : "");
  // Áudio: com GEMINI_API_KEY transcreve e segue o fluxo normal como se o cliente tivesse escrito;
  // sem chave (ou se falhar) só registra e pede pra escrever.
  let audioTranscript: string | null = null;
  const audioMsg = body.data?.message?.audioMessage;
  if (!text.trim() && !location && !image && audioMsg) {
    const messageId = body.data?.key?.id;
    if (audioTranscriptionEnabled() && messageId) {
      const b64 = await waTransport.downloadAudio(instance, messageId);
      audioTranscript = b64 ? await transcribeAudio(b64, audioMsg.mimetype ?? "audio/ogg") : null;
    }
    if (!audioTranscript) {
      await handleAudioMessage(tenantId, instance, phone, body.data?.pushName);
      return;
    }
    text = audioTranscript;
  }
  if (!text.trim() && !location && !image) return;
  const recordedText = audioTranscript ? `🎤 (áudio) ${audioTranscript}` : location ? "📍 Localização compartilhada" : image ? (text.trim() ? `🖼️ Imagem recebida — ${text}` : "🖼️ Imagem recebida") : text;

  let inbound: { id: string; createdAt: Date };
  try {
    inbound = await recordInboundMessage(tenantId, phone, recordedText, body.data?.pushName);
  } catch (err) {
    console.error("Erro ao registrar mensagem recebida do WhatsApp:", err);
    return;
  }

  // Modo IA: cliente costuma mandar a ideia picada em várias mensagens curtas
  // ("oi" / "boa noite" / "quero um x-bacon"). Espera alguns segundos; só a
  // ÚLTIMA mensagem do bloco processa, já com todas juntas — uma resposta só,
  // em vez de uma por fragmento poluindo a conversa. Localização/comprovante
  // são ação deliberada, respondem na hora. No menu numerado cada mensagem é
  // um comando isolado ("2", "ok"), então não se junta nada por lá.
  let textToProcess = text;
  if (!location && !image && BOT_DEBOUNCE_MS > 0) {
    try {
      const flags = await prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { botEnabled: true, aiConversationEnabled: true },
      });
      if (flags?.botEnabled && flags.aiConversationEnabled) {
        await sleep(BOT_DEBOUNCE_MS);
        const combined = await collectPendingText(tenantId, phone, inbound, text);
        if (combined === null) return; // chegou mensagem mais nova — ela responde por todas
        textToProcess = combined;
      }
    } catch (err) {
      console.error("Erro ao agrupar mensagens do WhatsApp:", err);
    }
  }

  // Serializado por tenant+telefone: se o cliente mandar mensagens em
  // sequência rápida, a segunda só começa a processar depois que a primeira
  // já salvou o ChatSession — evita ler estado desatualizado e pisar na etapa
  // anterior (ver request-queue.ts).
  await serializeByKey(`${tenantId}:${phone}`, async () => {
    try {
      const replies = await handleIncoming(tenantId, phone, textToProcess, body.data?.pushName, location, image);
      for (const reply of replies) {
        await waTransport.sendText(instance, phone, reply);
        await recordOutboundMessage(tenantId, phone, reply, { senderType: "BOT" });
      }
    } catch (err) {
      console.error("Erro no bot de WhatsApp:", err);
    }
  });

  // Etiqueta do WhatsApp Business conforme a etapa do lead (ver labels.service.ts).
  try {
    const session = await prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { data: true } });
    const stage = stageFromSessionData(session?.data ?? "{}");
    if (stage) await moveLead(tenantId, phone, stage);
  } catch (err) {
    console.error("Erro ao etiquetar lead:", err);
  }

  // Aproveita a função já ativa pra retomar leads que sumiram (ver followup.service.ts).
  await maybeRunFollowUpSweep(tenantId, instance);
  await maybeRunLateOrderSweep(tenantId);
}

/**
 * Junta as mensagens de texto do cliente ainda sem resposta. Devolve null se
 * existe uma mensagem de texto mais nova (ela vai cuidar de tudo). Só considera
 * mensagens recentes (3 min) pra não ressuscitar conversa antiga que o bot
 * ignorou enquanto estava pausado.
 */
async function collectPendingText(
  tenantId: string,
  phone: string,
  inbound: { id: string; createdAt: Date },
  ownText: string,
): Promise<string | null> {
  const textOnly = { notIn: MEDIA_PLACEHOLDERS };
  const latest = await prisma.whatsAppMessage.findFirst({
    where: { tenantId, phone, senderType: "CUSTOMER", body: textOnly },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (latest?.id !== inbound.id) return null;

  const lastReply = await prisma.whatsAppMessage.findFirst({
    where: { tenantId, phone, senderType: { not: "CUSTOMER" } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const since = new Date(Math.max(lastReply?.createdAt.getTime() ?? 0, inbound.createdAt.getTime() - 3 * 60_000));
  const pending = await prisma.whatsAppMessage.findMany({
    where: { tenantId, phone, senderType: "CUSTOMER", body: textOnly, createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { body: true },
  });
  // Mensagem que chegou enquanto a resposta anterior ainda era gerada fica ANTES do
  // horário dessa resposta e some do filtro acima — sem o fallback virava texto vazio
  // ("só consigo ler texto") e a fala do cliente se perdia.
  return pending.length > 0 ? pending.map((m) => m.body).join("\n") : ownText;
}
