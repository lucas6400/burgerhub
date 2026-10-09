import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { background } from "../../lib/background.js";
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
import { customerJidFromKey } from "./phone.js";
import { describeCatalogOrder } from "./catalog-cart.js";
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

/** Mensagem citada quando o cliente usa "responder" no WhatsApp (contextInfo do protobuf). */
interface QuotedContext {
  participant?: string;
  quotedMessage?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
    audioMessage?: object;
    locationMessage?: object;
  };
}

/**
 * Cliente que "marca" uma mensagem (a dele ou a da loja) e responde com "." ou "isso" pra não escrever de novo: o sentido
 * está na mensagem citada, que o bot nunca via. Devolve uma linha com a citação pra ir junto do texto — "" se não há citação.
 */
export function quotedReplyContext(context: QuotedContext | undefined, customerPhone: string): string {
  const q = context?.quotedMessage;
  if (!q) return "";
  const raw = q.conversation ?? q.extendedTextMessage?.text ?? q.imageMessage?.caption ?? q.videoMessage?.caption ?? (q.imageMessage ? "[imagem]" : q.audioMessage ? "[áudio]" : q.locationMessage ? "[localização]" : "");
  const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  if (!snippet) return "";
  const author = (context?.participant ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");
  const tail = customerPhone.replace(/\D/g, "").slice(-8);
  const whose = !author ? "" : author.endsWith(tail) ? " que ele mesmo escreveu antes" : " da loja";
  return `↩️ Respondeu à mensagem${whose}: "${snippet}"`;
}

/** Números do protobuf chegam como número, texto ou objeto Long ({ low, high }). */
type LongLike = number | string | { low?: number; high?: number } | null;
function longToNumber(value: LongLike | undefined): number {
  if (value == null) return 0;
  if (typeof value === "object") return Number(value.low ?? 0) + Number(value.high ?? 0) * 2 ** 32;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

interface WebhookBody {
  event?: string;
  data?: {
    key?: { id?: string; remoteJid?: string; remoteJidAlt?: string; senderPn?: string; participantPn?: string; fromMe?: boolean };
    pushName?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: { text?: string; contextInfo?: QuotedContext };
      locationMessage?: { degreesLatitude?: number; degreesLongitude?: number; name?: string; address?: string; accuracyInMeters?: number; isLive?: boolean };
      /** Localização em TEMPO REAL: o ponto se move e expira — não serve pro entregador. */
      liveLocationMessage?: { degreesLatitude?: number; degreesLongitude?: number; accuracyInMeters?: number };
      imageMessage?: WaRawImageMessage;
      audioMessage?: { seconds?: number; ptt?: boolean; mimetype?: string };
      /** Carrinho enviado pelo catálogo do WhatsApp Business (só traz contagem e total, não a lista de itens). */
      orderMessage?: { itemCount?: LongLike; orderTitle?: string; message?: string; totalAmount1000?: LongLike };
      /** Produto do catálogo compartilhado pelo cliente. */
      productMessage?: { product?: { title?: string; description?: string; priceAmount1000?: number | string } };
    };
  };
}

/**
 * Carrinho/produto do catálogo do WhatsApp chega sem texto e era ignorado em silêncio. Vira uma linha
 * pro bot responder em cima — o produto vem com título (a IA casa com o cardápio); o carrinho só vem
 * com quantidade e total, então a IA pede pro cliente dizer os itens.
 */
function catalogMessageText(message: NonNullable<NonNullable<WebhookBody["data"]>["message"]> | undefined): string {
  const brl = (thousandths: LongLike | undefined) => {
    const n = longToNumber(thousandths);
    return n > 0 ? ` (R$ ${(n / 1000).toFixed(2).replace(".", ",")})` : "";
  };
  const product = message?.productMessage?.product;
  if (product?.title) return `[Cliente abriu o produto "${product.title}" do catálogo do WhatsApp${brl(product.priceAmount1000)}]`;
  const order = message?.orderMessage;
  if (order) {
    const count = longToNumber(order.itemCount) ? `${longToNumber(order.itemCount)} item(ns)` : "itens";
    return `[Cliente enviou um carrinho do catálogo do WhatsApp com ${count}${brl(order.totalAmount1000)}. A lista dos itens NÃO chegou — peça pra ele dizer quais são e as quantidades.]`;
  }
  return "";
}

/** Espera antes de responder no modo IA, pra juntar mensagens picadas do cliente. */
const BOT_DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS ?? (env.whatsapp.mock ? 0 : 10_000));
const ECHO_WAIT_MS = env.whatsapp.mock ? 0 : 3_000;
/**
 * Depois que um humano fala com o cliente, o bot fica calado por esse tempo (renovado a cada mensagem da equipe).
 * Eram 2h: a equipe mandava um aviso e não conseguia continuar (celular quebrado, entrega) e o cliente ficava sem
 * ninguém por horas. Agora 10 min: se a equipe não continuar a conversa, o bot volta a responder na próxima mensagem do cliente.
 */
const HUMAN_PAUSE_MS = 10 * 60_000;

/** Mensagens "embrulhadas" (conversa com mensagens temporárias, visualização única, legenda de documento): o conteúdo está dentro. */
function unwrapMessage<T extends object | undefined>(message: T): T {
  let current = message as Record<string, any> | undefined;
  for (let i = 0; i < 3 && current; i++) {
    const inner = current.ephemeralMessage?.message ?? current.viewOnceMessage?.message ?? current.viewOnceMessageV2?.message ?? current.documentWithCaptionMessage?.message ?? current.editedMessage?.message;
    if (!inner) break;
    current = inner;
  }
  return current as T;
}

/**
 * Trecho fixo dos avisos "figurinha/vídeo/documento recebido". Esses registros NÃO podem contar como "a última mensagem
 * de texto do cliente" ao juntar mensagens seguidas: uma figurinha logo depois de "Sim" / "Tem batata frita?" fazia as
 * duas mensagens de texto serem consideradas "já respondidas pela mais nova" — e ninguém respondia nenhuma.
 */
const UNSUPPORTED_MARK = "o bot só lê texto, foto, áudio e localização";

/**
 * Vídeo, figurinha, documento, contato etc.: o bot não lê, mas a mensagem NÃO pode sumir (antes era descartada sem
 * registro nem resposta — o cliente ficava sem retorno e a equipe nem via que ele escreveu). Registra e avisa o cliente.
 */
async function handleUnsupportedMessage(tenantId: string, instance: string, phone: string, kinds: string[], pushName?: string) {
  try {
    const label = kinds.includes("videoMessage") ? "🎬 Vídeo" : kinds.includes("stickerMessage") ? "🙂 Figurinha" : kinds.includes("documentMessage") ? "📄 Documento" : kinds.includes("contactMessage") || kinds.includes("contactsArrayMessage") ? "👤 Contato" : "📎 Mensagem";
    // O tipo técnico entra no registro pra equipe/eu sabermos o que chegou quando é "📎 Mensagem" genérica.
    await recordInboundMessage(tenantId, phone, `${label} recebido [${kinds.slice(0, 3).join(", ")}] (${UNSUPPORTED_MARK})`, pushName);
    const [flags, session, recentOut] = await Promise.all([
      prisma.tenantSettings.findUnique({ where: { tenantId }, select: { botEnabled: true } }),
      prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { botPausedUntil: true } }),
      prisma.whatsAppMessage.findFirst({ where: { tenantId, phone, direction: "OUT", createdAt: { gte: new Date(Date.now() - 5 * 60_000) } }, select: { id: true } }),
    ]);
    if (!flags?.botEnabled || (session?.botPausedUntil && session.botPausedUntil > new Date()) || recentOut) return;
    const reply = "Recebi sua mensagem 😊 Mas por aqui eu só consigo ler texto, foto, áudio e localização. Pode me escrever o que você precisa?";
    await waTransport.sendText(instance, phone, reply);
    await recordOutboundMessage(tenantId, phone, reply, { senderType: "BOT" });
  } catch (err) {
    console.error("Erro ao tratar mensagem não suportada do WhatsApp:", err);
  }
}
const LIVE_LOCATION_REPLY =
  "Recebi sua localização em tempo real 📍, mas ela não serve pra entrega (o ponto se move e expira). Me manda a *localização fixa* da sua casa: toque no 📎 (clipe) → *Localização* → escolha o ponto da casa no mapa e envie — não use a atual nem a em tempo real. 🛵";

/**
 * Localização em TEMPO REAL não serve pro entregador (o ponto se move e some). Registra e pede a FIXA — a menos que a equipe
 * esteja atendendo (bot pausado) ou o bot tenha acabado de mandar esse mesmo pedido.
 */
async function handleLiveLocationMessage(tenantId: string, instance: string, phone: string, pushName?: string) {
  try {
    await recordInboundMessage(tenantId, phone, `📍 Localização em tempo real recebida — não serve pra entrega (${UNSUPPORTED_MARK})`, pushName);
    const [flags, session, asked] = await Promise.all([
      prisma.tenantSettings.findUnique({ where: { tenantId }, select: { botEnabled: true } }),
      prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone } }, select: { botPausedUntil: true } }),
      prisma.whatsAppMessage.findFirst({ where: { tenantId, phone, direction: "OUT", body: { startsWith: "Recebi sua localização em tempo real" }, createdAt: { gte: new Date(Date.now() - 3 * 60_000) } }, select: { id: true } }),
    ]);
    if (!flags?.botEnabled || (session?.botPausedUntil && session.botPausedUntil > new Date()) || asked) return;
    await waTransport.sendText(instance, phone, LIVE_LOCATION_REPLY);
    await recordOutboundMessage(tenantId, phone, LIVE_LOCATION_REPLY, { senderType: "BOT" });
  } catch (err) {
    console.error("Erro ao tratar localização em tempo real do WhatsApp:", err);
  }
}

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
  if (body.data?.message) body.data.message = unwrapMessage(body.data.message);

  const eventName = (body.event ?? "").toLowerCase().replace(/_/g, ".");
  if (eventName && eventName !== "messages.upsert") return;

  const jid = customerJidFromKey(body.data?.key);
  if (!jid) {
    if (body.data?.key?.remoteJid?.endsWith("@lid")) console.error("[whatsapp] mensagem com @lid e sem telefone real (remoteJidAlt/senderPn ausentes) — não dá pra responder:", body.data.key.remoteJid.slice(0, 8) + "…");
    return;
  }
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
  if (body.data?.message?.liveLocationMessage || loc?.isLive === true) {
    await handleLiveLocationMessage(tenantId, instance, phone, body.data?.pushName);
    return;
  }
  const location =
    loc?.degreesLatitude != null && loc?.degreesLongitude != null
      ? { lat: loc.degreesLatitude, lng: loc.degreesLongitude }
      : undefined;
  // Guarda os detalhes de cada localização recebida (nome/endereço do ponto, precisão do GPS): é o que diferencia o ponto
  // FIXO escolhido no mapa da localização "atual" — e hoje não sei como a Evolution entrega cada um.
  if (loc && location) {
    background(audit({ tenantId, action: "WA_LOCATION_META", entity: "WhatsAppLocation", detail: { hasName: !!loc.name, hasAddress: !!loc.address, accuracy: loc.accuracyInMeters ?? null } }));
  }
  const img = body.data?.message?.imageMessage;
  const image = img?.url && img?.mediaKey ? { ...img, messageId: body.data?.key?.id } : undefined;
  // Legenda da foto vira o texto da mensagem (o bot lê a imagem junto com ela).
  let text = body.data?.message?.conversation ?? body.data?.message?.extendedTextMessage?.text ?? (image ? img?.caption ?? "" : "");
  // Mensagem marcada ("responder" do WhatsApp): a citação vai junto — o "." só faz sentido com ela.
  const quotedLine = text.trim() && !image ? quotedReplyContext(body.data?.message?.extendedTextMessage?.contextInfo, phone) : "";
  if (quotedLine) text = `${quotedLine}\n${text}`;
  if (!text.trim() && !location && !image) {
    const order = body.data?.message?.orderMessage;
    if (order) {
      // Carrinho do catálogo: o WhatsApp só manda quantidade + total — os itens são deduzidos pelo cardápio (catalog-cart.ts).
      const cents = Math.round(longToNumber(order.totalAmount1000) / 10);
      const described = await describeCatalogOrder(tenantId, {
        itemCount: longToNumber(order.itemCount) || undefined,
        totalCents: cents > 0 ? cents : undefined,
        title: order.orderTitle,
      }).catch((err) => {
        console.error("[whatsapp] falha ao deduzir o carrinho do catálogo:", err);
        return null;
      });
      text = described?.aiText ?? catalogMessageText(body.data?.message);
    } else {
      text = catalogMessageText(body.data?.message);
    }
  }
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
  if (!text.trim() && !location && !image) {
    // Reação (👍 numa mensagem) e mensagens de sistema não pedem resposta; o resto (vídeo, figurinha, documento...) pede.
    const kinds = Object.keys((body.data?.message ?? {}) as object).filter((k) => !["messageContextInfo", "senderKeyDistributionMessage", "reactionMessage", "protocolMessage"].includes(k));
    if (kinds.length > 0 && !body.data?.key?.fromMe) await handleUnsupportedMessage(tenantId, instance, phone, kinds, body.data?.pushName);
    return;
  }
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
export async function collectPendingText(
  tenantId: string,
  phone: string,
  inbound: { id: string; createdAt: Date },
  ownText: string,
): Promise<string | null> {
  const textOnly = { notIn: MEDIA_PLACEHOLDERS };
  const latest = await prisma.whatsAppMessage.findFirst({
    where: { tenantId, phone, senderType: "CUSTOMER", body: textOnly, NOT: { body: { contains: UNSUPPORTED_MARK } } },
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
    where: { tenantId, phone, senderType: "CUSTOMER", body: textOnly, NOT: { body: { contains: UNSUPPORTED_MARK } }, createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: { body: true },
  });
  // Mensagem que chegou enquanto a resposta anterior ainda era gerada fica ANTES do
  // horário dessa resposta e some do filtro acima — sem o fallback virava texto vazio
  // ("só consigo ler texto") e a fala do cliente se perdia.
  return pending.length > 0 ? pending.map((m) => m.body).join("\n") : ownText;
}
