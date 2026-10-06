import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { quoteDelivery } from "../orders/orders.service.js";
import { reverseGeocode } from "../orders/geocoding.js";
import { getWhatsAppSenderFor } from "./transport.js";

/**
 * Tudo que o bot NÃO pode resolver sozinho e a equipe precisa saber na hora: cliente pede atendente, manda
 * localização nova depois do pedido, pede pagamento dividido, deixa recado pro entregador, manda comprovante
 * ou reclama/pede estorno. Cada caso (1) registra no pedido quando ele existe e (2) avisa o WhatsApp de alerta
 * da loja (TenantSettings.orderAlertPhone). Os detectores são regex puras, testáveis, e rodam por código — não
 * dependem de a IA lembrar de chamar uma ferramenta.
 */

const ACTIVE_STATUSES = ["AWAITING_PAYMENT", "NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"];
const STATUS_LABEL: Record<string, string> = {
  AWAITING_PAYMENT: "aguardando pagamento",
  NEW: "na fila da cozinha",
  PREPARING: "em preparo",
  FINISHING: "finalizando",
  READY: "pronto",
  OUT_FOR_DELIVERY: "saiu pra entrega",
};
const HUMAN_PAUSE_MS = 2 * 60 * 60_000;
const ALERT_DEDUPE_MS = 10 * 60_000;

const phoneTail = (phone: string) => phone.replace(/\D/g, "").slice(-8);
const waLink = (phone: string) => `https://wa.me/${phone.replace(/\D/g, "")}`;

// ── Alerta à equipe ────────────────────────────────────────────────────────────

/** Envia o alerta pro WhatsApp da equipe. Nunca lança; devolve se a mensagem de fato saiu. */
export async function alertTeam(tenantId: string, text: string): Promise<boolean> {
  try {
    const settings = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { orderAlertPhone: true } });
    if (!settings?.orderAlertPhone) return false;
    const sender = await getWhatsAppSenderFor(tenantId);
    if (!sender) return false;
    await sender.sendText(settings.orderAlertPhone, text);
    return true;
  } catch (err) {
    console.error("[escalation] falha ao avisar a equipe:", err);
    return false;
  }
}

const lastAlertAt = new Map<string, number>();
/** Mesmo alerta (mesmo cliente + motivo) no máximo 1x a cada 10 min — cliente que insiste não vira spam pro dono. */
export async function alertTeamOnce(tenantId: string, phone: string, kind: string, text: string): Promise<boolean> {
  const key = `${tenantId}:${phone}:${kind}`;
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? 0) < ALERT_DEDUPE_MS) return false;
  lastAlertAt.set(key, now);
  return alertTeam(tenantId, text);
}

export interface ActiveOrderInfo {
  id: string;
  number: number;
  status: string;
  type: string;
  notes: string | null;
  subtotalCents: number;
  deliveryFeeCents: number;
  paymentMethod: string | null;
  paymentStatus: string;
  addressReference: string | null;
}

/** Pedido do cliente ainda em andamento (últimas 8h), o mais recente. */
export async function findActiveOrder(tenantId: string, phone: string): Promise<ActiveOrderInfo | null> {
  return prisma.order.findFirst({
    where: {
      tenantId,
      customer: { phone: { endsWith: phoneTail(phone) } },
      status: { in: ACTIVE_STATUSES },
      createdAt: { gte: new Date(Date.now() - 8 * 3_600_000) },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, number: true, status: true, type: true, notes: true, subtotalCents: true, deliveryFeeCents: true, paymentMethod: true, paymentStatus: true, addressReference: true },
  });
}

const orderLine = (o: ActiveOrderInfo) => `🧾 Pedido #${o.number} (${o.type === "DELIVERY" ? "entrega" : "retirada"}, ${STATUS_LABEL[o.status] ?? o.status})`;

/** Anota no pedido (campo de observações que aparece na cozinha/ticket) e avisa a equipe. */
export async function noteOnOrderAndAlert(tenantId: string, phone: string, order: ActiveOrderInfo, label: string, detail: string, extra?: { reference?: string }): Promise<boolean> {
  await prisma.order.update({
    where: { id: order.id },
    data: {
      notes: [order.notes, `${label}: ${detail}`].filter(Boolean).join("\n"),
      ...(extra?.reference ? { addressReference: [order.addressReference, extra.reference].filter(Boolean).join(" | ") } : {}),
    },
  });
  return alertTeam(tenantId, `⚠️ *${label}*\n📱 ${phone}\n💬 ${waLink(phone)}\n${orderLine(order)}\n✏️ ${detail}`);
}

// ── 3. Cliente pede atendente humano ───────────────────────────────────────────

const HUMAN_VERBS = "falar|fala|conversar|chamar|chama|passa|passar|passe|transfere|transferir|quero|preciso|prefiro|cad[êe]|cade|tem|chame|manda";
const HUMAN_NOUNS = "atendente|atendimento humano|humano|pessoa de verdade|pessoa|gerente|dono|dona|respons[aá]vel|algu[eé]m da (?:loja|equipe)|funcion[aá]rio";
const HUMAN_REQUEST_RE = new RegExp(
  `\\b(?:${HUMAN_VERBS})\\b[^.!?\\n]{0,30}\\b(?:${HUMAN_NOUNS})\\b|^\\s*(?:atendente|humano|atendimento)[\\s!.?]*$|\\b(?:n[aã]o (?:quero|gosto de) falar com (?:rob[oô]|bot|ia|m[aá]quina)|chamem? (?:o |a )?(?:dono|dona|gerente))\\b`,
  "i",
);
export function isHumanRequest(text: string): boolean {
  return HUMAN_REQUEST_RE.test(text.trim());
}

/**
 * Cliente pediu um atendente: avisa a equipe com o contexto, pausa o bot nessa conversa (2h) e responde na hora.
 * Se não houver número de alerta configurado, NÃO pausa (senão o cliente ficaria sem ninguém) e devolve null
 * pra IA seguir atendendo.
 */
export async function handleHumanRequest(tenantId: string, phone: string, pushName: string | undefined, text: string): Promise<string[] | null> {
  const order = await findActiveOrder(tenantId, phone);
  const recent = await prisma.whatsAppMessage.findMany({
    where: { tenantId, phone, direction: "IN" },
    orderBy: { createdAt: "desc" },
    take: 4,
    select: { body: true },
  });
  const context = recent.reverse().map((m) => `"${m.body.replace(/\n/g, " ").slice(0, 120)}"`).join(" → ");
  const sent = await alertTeam(
    tenantId,
    `🙋 *Cliente pediu um ATENDENTE*\n👤 ${pushName || "Cliente"}\n📱 ${phone}\n💬 ${waLink(phone)}\n${order ? orderLine(order) + "\n" : ""}🗨️ ${context || `"${text.slice(0, 160)}"`}\n\n⏸️ O bot ficou calado nessa conversa por 2h — responda direto pelo WhatsApp.`,
  );
  if (!sent) return null;
  const until = new Date(Date.now() + HUMAN_PAUSE_MS);
  await prisma.chatSession.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: { botPausedUntil: until },
    create: { tenantId, phone, state: "AI_CONVO", data: "{}", botPausedUntil: until },
  });
  return ["Claro! 🙏 Já chamei um atendente da equipe pra falar com você por aqui — ele responde assim que puder."];
}

// ── Cliente desistiu do carrinho ───────────────────────────────────────────────

const DECLINE_RE = /^\s*(?:n[aã]o,?\s+obrigad[oa]|(?:quero )?hoje n[aã]o|quero n[aã]o|deixa(?: quieto| pra l[aá])?|deixa pra pr[oó]xima|desisti|n[aã]o quero(?: mais)?|n[aã]o vou querer|amanh[aã] (?:eu )?(?:pe[cç]o|vejo|fa[cç]o)|outra hora|fica pra pr[oó]xima|cancela(?:r)?|obrigad[oa],? (?:mas )?n[aã]o)(?:\s+obrigad[oa])?[\s!.,]*$/i;
const PLEASANTRY_RE = /^\s*(?:obrigad[oa]s?|ok|blz|beleza|valeu|tmj|tudo bem|certo|desculpa|😊|🙏|👍)[\s!.,]*$/i;
/**
 * Recusa explícita ("não obrigado", "hoje não", "deixa quieto", "amanhã eu peço"). O "não" sozinho NÃO conta: responde a
 * "posso seguir?" e pode ser "não, quero mudar". Já aconteceu de o bot insistir no pedido depois de um "hoje não".
 */
export function isDecline(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.some((l) => DECLINE_RE.test(l)) && lines.every((l) => DECLINE_RE.test(l) || PLEASANTRY_RE.test(l));
}

// ── Reclamação / estorno: avisa o dono sem calar o bot ─────────────────────────

const COMPLAINT_RE = /\b(estorno|estornar|reembolso|reembolsar|devolu[cç][aã]o|dinheiro de volta|procon|processar|processo|boletim|den[uú]ncia|golpe|palha[cç]ada|absurdo)\b/i;
export function isComplaint(text: string): boolean {
  return COMPLAINT_RE.test(text);
}

export async function alertComplaint(tenantId: string, phone: string, pushName: string | undefined, text: string): Promise<void> {
  const order = await findActiveOrder(tenantId, phone);
  await alertTeamOnce(
    tenantId,
    phone,
    "complaint",
    `🔴 *Cliente reclamando / pedindo estorno*\n👤 ${pushName || "Cliente"}\n📱 ${phone}\n💬 ${waLink(phone)}\n${order ? orderLine(order) + "\n" : ""}🗨️ "${text.replace(/\n/g, " ").slice(0, 220)}"`,
  );
}

// ── 1. Localização nova depois do pedido feito ─────────────────────────────────

/**
 * Cliente com pedido de ENTREGA em andamento manda uma localização: é a correção do endereço (já aconteceu do pedido
 * sair pro endereço antigo e o bot responder "o que você vai querer pedir?"). Grava o novo ponto no pedido, anota e
 * avisa a equipe com os mapas. Devolve null quando não há pedido de entrega ativo (segue o fluxo normal).
 */
export async function applyLocationToActiveOrder(tenantId: string, phone: string, location: { lat: number; lng: number }): Promise<string[] | null> {
  const order = await findActiveOrder(tenantId, phone);
  if (!order || order.type !== "DELIVERY") return null;
  const maps = `🗺️ Waze: https://waze.com/ul?ll=${location.lat},${location.lng}&navigate=yes\n🗺️ Maps: https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`;

  let feeNote = "";
  let feeForCustomer = "";
  let outsideArea = false;
  try {
    const quote = await quoteDelivery(tenantId, { street: "", number: "", neighborhood: "", city: "", ...location }, order.subtotalCents);
    const feeText = quote.feeCents === 0 ? "grátis 🎉" : `R$ ${(quote.feeCents / 100).toFixed(2).replace(".", ",")}`;
    // Quem manda localização costuma querer saber o valor da entrega ("quanto fica?"): responde junto, sem prometer mudar o pedido.
    feeForCustomer = ` Taxa de entrega nesse endereço: ${feeText}${quote.feeCents !== order.deliveryFeeCents ? " (a equipe confirma o valor do seu pedido)" : ""}.`;
    if (quote.feeCents !== order.deliveryFeeCents) feeNote = `\n💲 Taxa do pedido: R$ ${(order.deliveryFeeCents / 100).toFixed(2)} — pela nova localização seria R$ ${(quote.feeCents / 100).toFixed(2)}.`;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 409) outsideArea = true;
  }

  if (outsideArea) {
    await alertTeam(tenantId, `📍 *Cliente mandou localização FORA da área* depois do pedido\n📱 ${phone}\n💬 ${waLink(phone)}\n${orderLine(order)}\n${maps}\nO endereço do pedido NÃO foi alterado.`);
    return [`Recebi sua localização, mas ela fica fora da nossa área de entrega 😕 Já avisei a equipe do seu pedido #${order.number} pra falar com você.`];
  }

  const reverse = await reverseGeocode(location).catch(() => null);
  await prisma.order.update({
    where: { id: order.id },
    data: {
      deliveryLat: location.lat,
      deliveryLng: location.lng,
      deliveryLocationPrecise: true,
      ...(reverse?.street ? { addressStreet: reverse.street, addressNumber: reverse.number || null } : {}),
      notes: [order.notes, "📍 LOCALIZAÇÃO ATUALIZADA pelo cliente depois do pedido — use o pino novo."].filter(Boolean).join("\n"),
    },
  });
  await alertTeam(tenantId, `📍 *Cliente mandou NOVA localização* — o endereço do pedido foi atualizado\n📱 ${phone}\n💬 ${waLink(phone)}\n${orderLine(order)}\n${maps}${feeNote}`);
  return [`Recebi sua nova localização! ✅ Atualizei o endereço do pedido #${order.number} e avisei a equipe.${feeForCustomer} Se não era pra mudar o endereço, me avisa!`];
}

// ── 2. Pagamento dividido ──────────────────────────────────────────────────────

const METHOD_WORDS: [string, RegExp][] = [
  ["PIX", /\bpix\b/i],
  ["CASH", /\bdinheiro\b|\bem esp[eé]cie\b/i],
  ["CREDIT", /\bcr[eé]dito\b/i],
  ["DEBIT", /\bd[eé]bito\b/i],
  ["CARD", /\bcart[aã]o\b/i],
];
const SPLIT_JOINER_RE = /\b(e|mais|resto|restante|metade|parte|outro|outra|o outro|a outra)\b|\+|\d/i;

/** "20 no dinheiro e o resto no pix", "metade pix metade cartão", "pix e dinheiro": 2+ formas numa frase que não é pergunta. */
export function detectSplitPayment(text: string): { main: string; note: string } | null {
  // Mensagens seguidas chegam juntas (uma por linha): a nota leva só as linhas que falam de pagamento — a forma e os
  // valores ("PIX e dinheiro" / "4 no Pix" / "E 46 no dinheiro") — e não o endereço que veio ao lado.
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  for (const line of lines) {
    const found = detectSplitInLine(line);
    if (!found) continue;
    const related = lines.filter((l) => l.length > 0 && l.length <= 160 && !l.includes("?") && METHOD_WORDS.some(([, re]) => re.test(l)));
    return { main: found.main, note: related.join(" | ").slice(0, 240) };
  }
  return null;
}

/** Valores do pagamento dividido em mensagem separada, depois do aviso ("4 no Pix", "E 46 no dinheiro"). */
export function extractSplitAmounts(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && l.length <= 80 && !l.includes("?") && /\d/.test(l) && METHOD_WORDS.some(([, re]) => re.test(l)));
  return lines.length > 0 ? lines.join(" | ") : null;
}

function detectSplitInLine(line: string): { main: string; note: string } | null {
  const t = line.replace(/\s+/g, " ").trim();
  if (t.length === 0 || t.length > 160 || t.includes("?")) return null;
  const found = METHOD_WORDS.map(([method, re]) => ({ method, at: t.search(re) }))
    .filter((f) => f.at >= 0)
    .sort((a, b) => a.at - b.at);
  const family = (m: string) => (m === "CREDIT" || m === "DEBIT" || m === "CARD" ? "CARD" : m);
  if (new Set(found.map((f) => family(f.method))).size < 2) return null;
  if (!SPLIT_JOINER_RE.test(t)) return null;
  const first = found[0].method;
  return { main: first === "CARD" ? "CREDIT" : first, note: t };
}

// ── 7. Recado / referência de endereço ─────────────────────────────────────────

const REFERENCE_RE = /\b(port[aã]o|refer[eê]ncia|ao lado|em frente|pr[oó]ximo (?:a|ao|da|do|à)|perto (?:do|da|dos|das)|apto|apartamento|bloco|campainha|interfone|fundos|esquina|muro|placa|cer[aâ]mica|condom[ií]nio|pr[eé]dio|edif[ií]cio|torre|lote|lt|qd)\b|\b(?:liga|ligar|chama|manda mensagem|avisa)\b[^.!?\n]{0,12}\b(?:quando|ao|pra)\b/i;

/** Linhas da mensagem que parecem referência de endereço ou recado pro entregador (sem perguntas). */
export function extractDeliveryReference(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0 && l.length <= 200 && !l.includes("?") && REFERENCE_RE.test(l));
  return lines.length > 0 ? lines.join(" | ") : null;
}

// ── 8. Comprovante / confirmação de pagamento ──────────────────────────────────

/** O bot não confere pagamento: "Pix recebido" depois de uma imagem qualquer já enganou cliente (pediu estorno). */
export const PAYMENT_CONFIRMED_CLAIM_RE = /\b(pix|pagamento|comprovante)\b[^.!?\n]{0,25}\b(recebid[oa]|confirmad[oa]|aprovad[oa]|identificad[oa]|caiu)\b|\brecebi (?:o|seu|sua) (?:pix|pagamento)\b|\bcaiu\b[^.!?\n]{0,15}\bpix\b/i;
export const PROOF_SAFE_REPLY = "Recebi o comprovante, obrigado! 🙏 A equipe confere o pagamento e, se precisar de algo, te chama por aqui.";

export async function alertProofReceived(tenantId: string, phone: string, order: ActiveOrderInfo): Promise<void> {
  if (order.paymentStatus === "PAID") return;
  await alertTeamOnce(tenantId, phone, "proof", `📎 *Cliente enviou uma imagem (provável comprovante)*\n📱 ${phone}\n💬 ${waLink(phone)}\n${orderLine(order)}\n💳 Pagamento: ${order.paymentMethod ?? "não definido"} — confira no banco antes de dar como pago.`);
}

// ── 4. IA promete "vou confirmar com a equipe" ─────────────────────────────────

/** A IA prometeu ao cliente que a equipe vai confirmar/retornar: se ninguém foi avisado, a promessa fica vazia. */
export const TEAM_PROMISE_RE = /\b(?:vou|irei|vamos|j[aá] vou)\s+(?:confirmar|verificar|checar|consultar|ver|perguntar|falar|repassar|alinhar)\b[^.!?\n]{0,40}\b(?:equipe|cozinha|pessoal|loja|atendente)\b|\b(?:equipe|cozinha)\b[^.!?\n]{0,30}\b(?:confirma|retorna|entra em contato|vai (?:te )?chamar)\b/i;

export async function alertTeamPromise(tenantId: string, phone: string, pushName: string | undefined, customerText: string, botReply: string): Promise<void> {
  const order = await findActiveOrder(tenantId, phone);
  await alertTeamOnce(
    tenantId,
    phone,
    "promise",
    `❓ *O bot prometeu ao cliente que a equipe ia confirmar*\n👤 ${pushName || "Cliente"}\n📱 ${phone}\n💬 ${waLink(phone)}\n${order ? orderLine(order) + "\n" : ""}🗨️ Cliente: "${customerText.replace(/\n/g, " ").slice(0, 200)}"\n🤖 Bot: "${botReply.replace(/\n/g, " ").slice(0, 200)}"`,
  );
}
