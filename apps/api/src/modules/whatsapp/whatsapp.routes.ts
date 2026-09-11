import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { AppError } from "../../middlewares/error.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { audit } from "../../utils/audit.js";
import { getWhatsAppSenderFor, instanceNameFor, waTransport } from "./transport.js";
import { handleIncoming } from "./bot.service.js";

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
    res.json({ ...info, botEnabled: settings?.botEnabled ?? true });
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
    if (!instance.startsWith("bh_")) return;
    const tenantId = instance.slice(3);

    const body = req.body as {
      event?: string;
      data?: {
        key?: { remoteJid?: string; fromMe?: boolean };
        pushName?: string;
        message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      };
    };

    const eventName = (body.event ?? "").toLowerCase().replace(/_/g, ".");
    if (eventName && eventName !== "messages.upsert") return;

    const jid = body.data?.key?.remoteJid ?? "";
    if (!jid || body.data?.key?.fromMe) return;
    if (jid.endsWith("@g.us")) return; // ignora grupos

    const phone = jid.split("@")[0];
    const text =
      body.data?.message?.conversation ?? body.data?.message?.extendedTextMessage?.text ?? "";
    if (!text.trim()) return;

    try {
      const replies = await handleIncoming(tenantId, phone, text, body.data?.pushName);
      for (const reply of replies) {
        await waTransport.sendText(instance, phone, reply);
      }
    } catch (err) {
      console.error("Erro no bot de WhatsApp:", err);
    }
  }),
);
