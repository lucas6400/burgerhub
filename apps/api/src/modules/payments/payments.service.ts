import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";
import { mpClient, type MpStatus } from "./mp.client.js";

/**
 * Orquestra pagamentos online do cardápio digital (Pix e cartão).
 * O pedido nasce com paymentMethod ONLINE + paymentStatus PENDING;
 * quando o Mercado Pago aprova (webhook ou polling), vira PAID.
 */

/**
 * Taxa da BurgerHub (split via application_fee do Mercado Pago) — incide só
 * sobre pagamentos online do cardápio digital, nunca balcão/PDV/WhatsApp
 * (esta função só é chamada a partir do cardápio público).
 */
const PLATFORM_FEE_RATE = 0.015;

/**
 * `application_fee` só é aceito pelo Mercado Pago quando o Access Token veio
 * do fluxo OAuth (conexão marketplace de verdade) — token colado manualmente
 * não tem esse vínculo. `mpRefreshToken`/`mpUserId` só existem em contas
 * conectadas via OAuth (exigir os dois reduz o risco de um campo desatualizado
 * liberar a taxa indevidamente — ver settings.routes.ts, que zera os dois
 * sempre que o Access Token é trocado manualmente).
 *
 * `mpSplitEnabled` é o interruptor de negócio de verdade: mesmo conectado via
 * OAuth, um tenant só é cobrado se isso for ligado manualmente (nunca pelo
 * próprio lojista) — necessário pra nunca cobrar taxa dos estabelecimentos que
 * são do próprio dono da BurgerHub, só de clientes pagantes reais.
 */
function calcApplicationFeeCents(
  totalCents: number,
  settings: { mpRefreshToken: string | null; mpUserId: string | null; mpSplitEnabled: boolean } | null,
) {
  if (!settings?.mpSplitEnabled || !settings?.mpRefreshToken || !settings?.mpUserId) return undefined;
  const fee = Math.round(totalCents * PLATFORM_FEE_RATE);
  return fee > 0 ? fee : undefined;
}

function requireMpConfig(settings: { mpEnabled: boolean; mpAccessToken: string | null } | null) {
  const token = env.mercadoPago.mock ? "mock" : settings?.mpAccessToken;
  if (!settings?.mpEnabled || !token) {
    throw new AppError(409, "Pagamento online não está disponível neste estabelecimento.");
  }
  return token;
}

export function onlinePaymentsAvailable(settings: { mpEnabled: boolean; mpAccessToken: string | null } | null) {
  if (!settings?.mpEnabled) return false;
  return env.mercadoPago.mock || !!settings.mpAccessToken;
}

/**
 * Cartão embutido (Payment Brick) exige a Public Key do estabelecimento.
 * Diferente do Access Token, ela é usada pelo SDK real da MP direto no navegador
 * do cliente — MP_MOCK não dispensa essa exigência, pois não existe "brick mockado".
 */
export function cardCheckoutAvailable(
  settings: { mpEnabled: boolean; mpAccessToken: string | null; mpPublicKey: string | null } | null,
) {
  if (!onlinePaymentsAvailable(settings)) return false;
  return !!settings?.mpPublicKey;
}

export interface CardPaymentInput {
  token: string;
  installments: number;
  paymentMethodId: string;
  payerDocType?: string;
  payerDocNumber?: string;
}

export async function startPayment(params: {
  tenantId: string;
  tenantSlug: string;
  orderId: string;
  method: "PIX" | "CARD";
  card?: CardPaymentInput;
}) {
  const { tenantId, orderId, method, card } = params;

  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: { customer: true, payment: true },
  });
  if (!order) throw new AppError(404, "Pedido não encontrado");
  if (order.paymentStatus === "PAID") throw new AppError(409, "Este pedido já está pago");

  // Idempotente: reaproveita o pagamento existente do mesmo método
  if (order.payment && order.payment.method === method && order.payment.status === "PENDING") {
    return order.payment;
  }
  if (order.payment) {
    await prisma.payment.delete({ where: { id: order.payment.id } });
  }

  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  const accessToken = requireMpConfig(settings);
  const applicationFeeCents = env.mercadoPago.mock ? undefined : calcApplicationFeeCents(order.totalCents, settings);

  const common = {
    accessToken,
    amountCents: order.totalCents,
    description: `Pedido #${order.number}`,
    externalReference: order.id,
    notificationUrl: `${env.whatsapp.publicApiUrl}/api/payments/webhook/${tenantId}`,
    backUrl: `${env.publicWebUrl}/cardapio/${params.tenantSlug}?pedido=${order.id}`,
    payerEmail: order.customer?.email ?? undefined,
    payerName: order.customer?.name,
    applicationFeeCents,
  };

  if (method === "PIX") {
    const pix = await mpClient.createPix(common);
    return prisma.payment.create({
      data: {
        tenantId,
        orderId: order.id,
        method: "PIX",
        amountCents: order.totalCents,
        mpPaymentId: pix.mpPaymentId,
        pixQrCode: pix.pixQrCode,
        pixQrBase64: pix.pixQrBase64,
        platformFeeCents: applicationFeeCents,
      },
    });
  }

  if (!card) throw new AppError(400, "Dados do cartão ausentes");
  const result = await mpClient.createCardPayment({ ...common, ...card });
  // Nasce PENDING (default do schema) para que approvePayment() seja quem
  // efetivamente dispara a transação que marca o pedido como PAID.
  const payment = await prisma.payment.create({
    data: {
      tenantId,
      orderId: order.id,
      method: "CARD",
      amountCents: order.totalCents,
      mpPaymentId: result.mpPaymentId,
      platformFeeCents: applicationFeeCents,
    },
  });
  if (result.status === "APPROVED") {
    await approvePayment(payment.id);
  } else if (result.status === "REJECTED" || result.status === "CANCELED") {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: result.status } });
  }
  return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

/** Marca pagamento aprovado e atualiza o pedido (idempotente). */
async function approvePayment(paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status === "APPROVED") return;
  await prisma.$transaction([
    prisma.payment.update({
      where: { id: payment.id },
      data: { status: "APPROVED", paidAt: new Date() },
    }),
    prisma.order.update({
      where: { id: payment.orderId },
      data: { paymentStatus: "PAID" },
    }),
  ]);
}

/** Consulta e sincroniza o status (usado pelo polling do cardápio). */
export async function refreshPaymentStatus(tenantId: string, orderId: string) {
  const payment = await prisma.payment.findFirst({
    where: { orderId, tenantId },
  });
  if (!payment) throw new AppError(404, "Pagamento não encontrado");
  if (payment.status !== "PENDING") return payment;

  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  const accessToken = env.mercadoPago.mock ? "mock" : settings?.mpAccessToken;
  if (!accessToken) return payment;

  let status: MpStatus = "PENDING";
  if (payment.mpPaymentId) {
    status = await mpClient.getStatus(accessToken, payment.mpPaymentId).catch(() => "PENDING" as MpStatus);
  }

  if (status === "APPROVED") {
    await approvePayment(payment.id);
  } else if (status === "REJECTED" || status === "CANCELED") {
    await prisma.payment.update({ where: { id: payment.id }, data: { status } });
  }
  return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

/**
 * Troca o "code" do fluxo OAuth ("Conectar com Mercado Pago") pelos tokens
 * da conta do lojista — substitui colar o Access Token manualmente. Guarda
 * também o refresh_token (usado por calcApplicationFeeCents pra saber se a
 * conta é elegível ao split) e o user_id (collector_id do vendedor na MP).
 */
export async function connectMercadoPagoOAuth(tenantId: string, code: string, codeVerifier: string) {
  const res = await fetch("https://api.mercadopago.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.mercadoPago.oauthClientId,
      client_secret: env.mercadoPago.oauthClientSecret,
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier, // PKCE — obrigatório pois a aplicação está configurada com "Utiliza fluxo com PKCE = Sim"
      redirect_uri: `${env.publicApiUrl}/api/payments/mercadopago/oauth/callback`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    public_key?: string;
    user_id?: number;
    error?: string;
    message?: string;
  };
  if (!res.ok || !body.access_token) {
    console.error("Falha ao trocar code por token no Mercado Pago:", JSON.stringify(body).slice(0, 400));
    throw new AppError(502, "Não foi possível concluir a conexão com o Mercado Pago. Tente novamente.");
  }

  await prisma.tenantSettings.upsert({
    where: { tenantId },
    update: {
      mpAccessToken: body.access_token,
      mpRefreshToken: body.refresh_token,
      mpPublicKey: body.public_key,
      mpUserId: body.user_id ? String(body.user_id) : undefined,
      mpEnabled: true,
    },
    create: {
      tenantId,
      mpAccessToken: body.access_token,
      mpRefreshToken: body.refresh_token,
      mpPublicKey: body.public_key,
      mpUserId: body.user_id ? String(body.user_id) : undefined,
      mpEnabled: true,
    },
  });
}

/** Webhook do Mercado Pago: notificação de pagamento criado/atualizado. */
export async function handleWebhook(tenantId: string, mpPaymentId: string) {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  const accessToken = env.mercadoPago.mock ? "mock" : settings?.mpAccessToken;
  if (!accessToken) return;

  const info = await mpClient.getPaymentInfo(accessToken, mpPaymentId).catch(() => null);
  if (!info) return;

  // Casa pelo mpPaymentId (Pix) ou pelo external_reference = orderId (cartão)
  let payment = await prisma.payment.findFirst({ where: { tenantId, mpPaymentId } });
  if (!payment && info.externalReference) {
    payment = await prisma.payment.findFirst({
      where: { tenantId, orderId: info.externalReference },
    });
    if (payment && !payment.mpPaymentId) {
      await prisma.payment.update({ where: { id: payment.id }, data: { mpPaymentId } });
    }
  }
  if (!payment) return;

  if (info.status === "APPROVED") await approvePayment(payment.id);
  else if (info.status === "REJECTED" || info.status === "CANCELED") {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: info.status } });
  }
}
