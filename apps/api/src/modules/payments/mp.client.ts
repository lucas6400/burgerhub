import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";

/**
 * Cliente Mercado Pago — Checkout API transparente para Pix e cartão.
 * O Access Token é do PRÓPRIO estabelecimento — o repasse é direto para ele.
 * O cartão é tokenizado no navegador do cliente (Payment Brick); aqui só
 * recebemos o token e chamamos POST /v1/payments, igual ao Pix.
 * Com MP_MOCK=true, simula pagamentos (Pix aprova ~12s depois; cartão aprova na hora).
 */

export interface PixPaymentResult {
  mpPaymentId: string;
  pixQrCode: string; // copia e cola
  pixQrBase64?: string; // imagem
}

export interface CardPaymentResult {
  mpPaymentId: string;
  status: MpStatus;
}

export type MpStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELED";

export interface CreatePaymentInput {
  accessToken: string;
  amountCents: number;
  description: string;
  externalReference: string; // orderId
  notificationUrl: string;
  backUrl?: string;
  payerEmail?: string;
  payerName?: string;
  /** Taxa de marketplace da BurgerHub (split) — só válido com accessToken obtido via OAuth. */
  applicationFeeCents?: number;
}

export interface CreateCardPaymentInput extends CreatePaymentInput {
  token: string; // token do cartão gerado pelo Payment Brick no navegador
  installments: number;
  paymentMethodId: string;
  payerDocType?: string;
  payerDocNumber?: string;
}

const MP_BASE = "https://api.mercadopago.com";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function mpFetch(accessToken: string, path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${MP_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Mercado Pago ${res.status} em ${path}:`, JSON.stringify(body).slice(0, 500));
    throw new AppError(502, "Não foi possível iniciar o pagamento. Tente novamente.");
  }
  return body;
}

// ---------------------------------------------------------------- MOCK

const mockPayments = new Map<string, { createdAt: number }>();
const MOCK_APPROVE_AFTER_MS = 12_000;

const mock = {
  async createPix(input: CreatePaymentInput): Promise<PixPaymentResult> {
    const id = `mock_pix_${input.externalReference}`;
    mockPayments.set(id, { createdAt: Date.now() });
    return {
      mpPaymentId: id,
      pixQrCode:
        "00020126580014br.gov.bcb.pix0136demo-burgerhub-pix-copia-e-cola-simulado5204000053039865802BR5909BurgerHub6009Sao Paulo62070503***6304ABCD",
    };
  },
  async createCardPayment(input: CreateCardPaymentInput): Promise<CardPaymentResult> {
    const id = `mock_card_${input.externalReference}`;
    // Cartão aprova na hora (comportamento real da Checkout API), sem precisar do polling
    return { mpPaymentId: id, status: "APPROVED" };
  },
  async getStatus(_accessToken: string, mpPaymentId: string): Promise<MpStatus> {
    const p = mockPayments.get(mpPaymentId);
    if (!p) return "PENDING";
    return Date.now() - p.createdAt > MOCK_APPROVE_AFTER_MS ? "APPROVED" : "PENDING";
  },
  async getPaymentInfo(
    accessToken: string,
    mpPaymentId: string,
  ): Promise<{ status: MpStatus; externalReference: string | null }> {
    return {
      status: await mock.getStatus(accessToken, mpPaymentId),
      externalReference: mpPaymentId.replace(/^mock_(pix|card)_/, "") || null,
    };
  },
};

// ---------------------------------------------------------------- REAL

function mapStatus(status: string): MpStatus {
  if (status === "approved") return "APPROVED";
  if (["rejected", "cancelled"].includes(status)) return status === "rejected" ? "REJECTED" : "CANCELED";
  return "PENDING";
}

const real = {
  async createPix(input: CreatePaymentInput): Promise<PixPaymentResult> {
    const expiration = new Date(Date.now() + 30 * 60_000).toISOString().replace("Z", "-03:00");
    const body = await mpFetch(input.accessToken, "/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": `pix-${input.externalReference}` },
      body: JSON.stringify({
        transaction_amount: Number((input.amountCents / 100).toFixed(2)),
        payment_method_id: "pix",
        description: input.description,
        external_reference: input.externalReference,
        notification_url: input.notificationUrl,
        date_of_expiration: expiration,
        application_fee: input.applicationFeeCents ? Number((input.applicationFeeCents / 100).toFixed(2)) : undefined,
        payer: {
          email: input.payerEmail ?? `cliente.${input.externalReference.slice(-8)}@burgerhub.app`,
          first_name: input.payerName?.split(" ")[0] ?? "Cliente",
        },
      }),
    });
    const tx = body.point_of_interaction?.transaction_data ?? {};
    return {
      mpPaymentId: String(body.id),
      pixQrCode: tx.qr_code ?? "",
      pixQrBase64: tx.qr_code_base64,
    };
  },

  async createCardPayment(input: CreateCardPaymentInput): Promise<CardPaymentResult> {
    const body = await mpFetch(input.accessToken, "/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": `card-${input.externalReference}-${input.token}` },
      body: JSON.stringify({
        transaction_amount: Number((input.amountCents / 100).toFixed(2)),
        token: input.token,
        installments: input.installments,
        payment_method_id: input.paymentMethodId,
        description: input.description,
        external_reference: input.externalReference,
        notification_url: input.notificationUrl,
        statement_descriptor: "PEDIDO LANCHE",
        application_fee: input.applicationFeeCents ? Number((input.applicationFeeCents / 100).toFixed(2)) : undefined,
        payer: {
          email: input.payerEmail ?? `cliente.${input.externalReference.slice(-8)}@burgerhub.app`,
          first_name: input.payerName?.split(" ")[0] ?? "Cliente",
          identification:
            input.payerDocType && input.payerDocNumber
              ? { type: input.payerDocType, number: input.payerDocNumber }
              : undefined,
        },
      }),
    });
    return { mpPaymentId: String(body.id), status: mapStatus(body.status ?? "pending") };
  },

  async getStatus(accessToken: string, mpPaymentId: string): Promise<MpStatus> {
    const body = await mpFetch(accessToken, `/v1/payments/${mpPaymentId}`);
    return mapStatus(body.status ?? "pending");
  },

  /** Status + referência externa (id do pedido) — usado pelo webhook. */
  async getPaymentInfo(
    accessToken: string,
    mpPaymentId: string,
  ): Promise<{ status: MpStatus; externalReference: string | null }> {
    const body = await mpFetch(accessToken, `/v1/payments/${mpPaymentId}`);
    return {
      status: mapStatus(body.status ?? "pending"),
      externalReference: body.external_reference ?? null,
    };
  },
};

export const mpClient = env.mercadoPago.mock ? mock : real;
