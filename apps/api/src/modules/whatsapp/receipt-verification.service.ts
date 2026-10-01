import { prisma } from "../../lib/prisma.js";
import { updateOrderStatus } from "../orders/orders.service.js";
import { instanceNameFor, waTransport, type WaRawImageMessage } from "./transport.js";
import { extractReceiptData } from "./receipt-vision.service.js";

/**
 * Fallback de confirmação de pagamento: quando o Mercado Pago automático não
 * confirma sozinho (não conectado, ou webhook ainda não chegou), o cliente
 * manda a foto do comprovante Pix e a gente confere. A IA só EXTRAI o que tá
 * escrito (receipt-vision.service.ts) — a comparação de verdade é sempre em
 * código puro aqui, nunca no "julgamento" da IA.
 */

const MAX_ATTEMPTS = 3;
const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function normalizeText(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distância de Levenshtein simples (sem dependência nova) — usada só pra tolerar diferença de OCR/grafia. */
function levenshteinDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarityRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

/** Contém um o outro (em qualquer direção) ou é parecido o bastante — tolera OCR/variação de grafia. */
function fuzzyMatches(extracted: string, expected: string, threshold: number): boolean {
  const a = normalizeText(extracted);
  const b = normalizeText(expected);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  return similarityRatio(a, b) >= threshold;
}

interface PendingOrder {
  id: string;
  number: number;
  totalCents: number;
  pixReceiptAttempts: number;
  paymentReviewRequired: boolean;
}

/** Ponto de entrada único, chamado pelo bot assim que detecta uma imagem com um pedido AWAITING_PAYMENT pendente. */
export async function handleReceiptImage(
  tenantId: string,
  order: PendingOrder,
  image: WaRawImageMessage,
): Promise<string[]> {
  if (order.paymentReviewRequired) {
    return ["Já recebemos seu comprovante, nossa equipe está conferindo. Só aguardar por aqui. 🙏"];
  }

  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });

  const instance = instanceNameFor(tenantId);
  const imageBase64 = await waTransport.downloadImage(instance, image);
  const extracted = imageBase64 ? await extractReceiptData(tenantId, imageBase64, image.mimetype ?? "image/jpeg") : null;

  const mismatchReasons: string[] = [];
  if (!extracted || !extracted.legible) {
    mismatchReasons.push("não consegui ler a imagem direito");
  } else {
    if (extracted.amountCents == null || extracted.amountCents !== order.totalCents) {
      mismatchReasons.push("o valor não bateu com o total do pedido");
    }
    if (settings?.pixReceiptExpectedName && !fuzzyMatches(extracted.receiverName ?? "", settings.pixReceiptExpectedName, 0.82)) {
      mismatchReasons.push("o nome do recebedor não bateu");
    }
    if (settings?.pixReceiptExpectedBank && !fuzzyMatches(extracted.bankName ?? "", settings.pixReceiptExpectedBank, 0.75)) {
      mismatchReasons.push("o banco não bateu");
    }
  }

  if (mismatchReasons.length === 0) {
    await updateOrderStatus({ tenantId, orderId: order.id, toStatus: "NEW" });
    const prepMinutes = settings?.defaultPrepMinutes ?? 30;
    return [
      `✅ Comprovante confirmado! Pedido #${order.number} liberado pra cozinha. 🍔\nTempo estimado: ${prepMinutes}–${prepMinutes + 20} min a partir de agora.`,
    ];
  }

  const attempts = order.pixReceiptAttempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.order.update({
      where: { id: order.id },
      data: { pixReceiptAttempts: attempts, paymentReviewRequired: true },
    });
    return [
      "Recebemos seu comprovante e nossa equipe vai confirmar manualmente — pode levar alguns minutinhos. Assim que confirmarmos, seu pedido já entra na produção. 🙏",
    ];
  }

  await prisma.order.update({ where: { id: order.id }, data: { pixReceiptAttempts: attempts } });
  return [
    `😕 Esse comprovante não bateu certinho (${mismatchReasons.join(", ")}). Confere se é o comprovante certo (pedido #${order.number}, ${brl(order.totalCents)}) e manda de novo, por favor.`,
  ];
}
