import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { h } from "../../lib/http.js";
import { prisma } from "../../lib/prisma.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";
import { env } from "../../config/env.js";
import { connectMercadoPagoOAuth, handleWebhook } from "./payments.service.js";

export const paymentsRoutes = Router();

interface MpOAuthState {
  tenantId: string;
  codeVerifier: string;
  purpose: "mp_oauth";
}

/** Gera a URL de autorização do Mercado Pago — front redireciona o navegador pra ela. */
paymentsRoutes.get(
  "/mercadopago/connect",
  requireAuth,
  requireRole("MANAGER"),
  h(async (req, res) => {
    if (!env.mercadoPago.oauthClientId) {
      throw new AppError(503, "Conexão automática com o Mercado Pago ainda não está configurada nesta plataforma.");
    }
    // PKCE — a aplicação BurgerHub no Mercado Pago exige code_verifier/code_challenge.
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

    const state: MpOAuthState = { tenantId: tenantOf(req), codeVerifier, purpose: "mp_oauth" };
    const signedState = jwt.sign(state, env.jwtSecret, { expiresIn: "10m" });

    const redirectUri = `${env.publicApiUrl}/api/payments/mercadopago/oauth/callback`;
    const url = new URL("https://auth.mercadopago.com/authorization");
    url.searchParams.set("client_id", env.mercadoPago.oauthClientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("platform_id", "mp");
    url.searchParams.set("state", signedState);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    res.json({ url: url.toString() });
  }),
);

/** Desconecta a conta Mercado Pago do tenant (limpa tokens e desativa pagamento online). */
paymentsRoutes.post(
  "/mercadopago/disconnect",
  requireAuth,
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: {
        mpAccessToken: null,
        mpRefreshToken: null,
        mpPublicKey: null,
        mpUserId: null,
        mpEnabled: false,
      },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE_PAYMENT_SETTINGS",
      entity: "TenantSettings",
      detail: { mpDisconnected: true },
    });
    res.json({ ok: true });
  }),
);

/**
 * Callback público — o Mercado Pago redireciona o navegador do lojista pra
 * cá depois de autorizar. Sem header de autenticação (é um redirect puro do
 * navegador), por isso o tenant vem do `state` assinado, não de um JWT nosso.
 */
paymentsRoutes.get(
  "/mercadopago/oauth/callback",
  h(async (req, res) => {
    const { code, state, error } = req.query as { code?: string; state?: string; error?: string };
    const failUrl = `${env.publicWebUrl}/configuracoes?tab=Pagamentos&mp=error`;

    if (error || !code || !state) {
      return res.redirect(failUrl);
    }

    let payload: MpOAuthState;
    try {
      payload = jwt.verify(state, env.jwtSecret) as MpOAuthState;
      if (payload.purpose !== "mp_oauth") throw new Error("state inválido");
    } catch {
      return res.redirect(failUrl);
    }

    try {
      await connectMercadoPagoOAuth(payload.tenantId, code, payload.codeVerifier);
    } catch (err) {
      console.error("Erro ao conectar Mercado Pago via OAuth:", err);
      return res.redirect(failUrl);
    }

    res.redirect(`${env.publicWebUrl}/configuracoes?tab=Pagamentos&mp=connected`);
  }),
);

/**
 * Webhook do Mercado Pago (público).
 * Chega como { type: "payment", data: { id } } no corpo e/ou
 * ?type=payment&data.id=... na query (formatos variam por produto MP).
 */
paymentsRoutes.post(
  "/webhook/:tenantId",
  rateLimit(600, 60_000),
  h(async (req, res) => {
    res.json({ ok: true }); // MP exige 200 rápido; processa em seguida

    const body = req.body as { type?: string; action?: string; data?: { id?: string | number } };
    const query = req.query as Record<string, string | undefined>;

    const type = body.type ?? query.type ?? query.topic ?? "";
    if (type && !type.includes("payment")) return;

    const paymentId = String(body.data?.id ?? query["data.id"] ?? query.id ?? "");
    if (!paymentId) return;

    try {
      await handleWebhook(req.params.tenantId, paymentId);
    } catch (err) {
      console.error("Erro no webhook de pagamento:", err);
    }
  }),
);
