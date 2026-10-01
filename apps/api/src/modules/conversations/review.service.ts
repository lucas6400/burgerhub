import { prisma } from "../../lib/prisma.js";

/**
 * Revisão das conversas do bot: junta num lugar só as conversas com sinais de que
 * algo pode ter saído errado (taxa/"grátis" dita sem localização, atendente
 * corrigindo o bot, pedido de alteração/alergia, bot repetindo a mesma frase,
 * cliente sem resposta). Tudo calculado na hora a partir das mensagens salvas.
 */

export type ReviewFlagKey = "FREE_CLAIM" | "HUMAN_CORRECTED" | "ORDER_CHANGE" | "LOOP" | "NO_TEXT_REPLY" | "UNANSWERED";

export interface ReviewMessage {
  senderType: string;
  body: string;
  at: string;
  flagged: boolean;
}

export interface ReviewItem {
  phone: string;
  name: string;
  lastAt: string;
  flags: { key: ReviewFlagKey; label: string; detail: string }[];
  messages: ReviewMessage[];
}

const PLACE_TYPED = /\d{2,4}\s*(n|s|norte|sul)\b|quadra|alameda|avenida|condom[ií]nio|\brua\b/i;
const FEE_CLAIM = /(entrega|taxa)[^.\n]{0,40}gr[aá]tis|gr[aá]tis[^.\n]{0,25}entrega|entregamos a[ií] ✅|estimativa/i;
const HUMAN_FIX = /deu erro|n[ãa]o [ée] gr[aá]tis|n[ãa]o era gr[aá]tis|infelizmente|n[ãa]o atend|n[ãa]o entreg|desculp|na verdade|equivoc/i;
const CHANGE_WORDS = /alerg|sem (milho|cebola|tomate|alface|maionese|molho|picles|bacon|ovo|salsicha|calabresa|presunto|catupiry)|tirar|trocar|alterar|acrescent|adicionar|mudar o pedido|esqueci de/i;
const THANKS = /^\s*(ok|okay|blz|beleza|certo|show|top|valeu|obg|obrigad[oa]s?|tá bom|ta bom|👍|🙏|❤️)[\s!.]*$/i;
const FIX_WINDOW_MS = 15 * 60_000;
const UNANSWERED_AFTER_MS = 6 * 60_000;
const LOCATION_MSG = "📍 Localização compartilhada";

export async function computeReview(tenantId: string, hours: number): Promise<ReviewItem[]> {
  const since = new Date(Date.now() - hours * 3_600_000);
  const msgs = await prisma.whatsAppMessage.findMany({
    where: { tenantId, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: { phone: true, senderType: true, body: true, createdAt: true },
  });
  const byPhone = new Map<string, typeof msgs>();
  for (const m of msgs) {
    const list = byPhone.get(m.phone);
    if (list) list.push(m);
    else byPhone.set(m.phone, [m]);
  }

  const items: ReviewItem[] = [];
  for (const [phone, list] of byPhone) {
    if (!list.some((m) => m.senderType === "BOT")) continue; // só conversa em que o bot falou
    const flags: ReviewItem["flags"] = [];
    const flaggedIdx = new Set<number>();

    let seenLocation = false;
    list.forEach((m, i) => {
      if (m.senderType === "CUSTOMER" && m.body === LOCATION_MSG) seenLocation = true;
      if (m.senderType === "BOT" && !seenLocation && FEE_CLAIM.test(m.body)) {
        const prevCustomer = [...list.slice(0, i)].reverse().find((x) => x.senderType === "CUSTOMER");
        if (prevCustomer && PLACE_TYPED.test(prevCustomer.body)) {
          flaggedIdx.add(i);
          if (!flags.some((f) => f.key === "FREE_CLAIM")) {
            flags.push({ key: "FREE_CLAIM", label: "Falou taxa/grátis sem localização", detail: "O bot deu valor de entrega a partir de endereço digitado, sem o cliente ter mandado a localização." });
          }
        }
      }
      if (m.senderType === "HUMAN" && HUMAN_FIX.test(m.body)) {
        const botBefore = list.slice(0, i).some((x) => x.senderType === "BOT" && m.createdAt.getTime() - x.createdAt.getTime() < FIX_WINDOW_MS);
        if (botBefore) {
          flaggedIdx.add(i);
          if (!flags.some((f) => f.key === "HUMAN_CORRECTED")) {
            flags.push({ key: "HUMAN_CORRECTED", label: "Você corrigiu o bot", detail: "Um atendente escreveu algo como 'infelizmente/deu erro' logo depois de uma resposta do bot." });
          }
        }
      }
      if (m.senderType === "CUSTOMER" && CHANGE_WORDS.test(m.body) && m.body !== LOCATION_MSG) {
        flaggedIdx.add(i);
        if (!flags.some((f) => f.key === "ORDER_CHANGE")) {
          flags.push({ key: "ORDER_CHANGE", label: "Pedido de alteração / alergia", detail: "O cliente pediu para tirar/trocar/acrescentar algo — confira se chegou pra você e está na observação do pedido." });
        }
      }
      if (m.senderType === "BOT" && /só consigo ler texto/i.test(m.body)) {
        flaggedIdx.add(i);
        if (!flags.some((f) => f.key === "NO_TEXT_REPLY")) {
          flags.push({ key: "NO_TEXT_REPLY", label: "Resposta 'só consigo ler texto'", detail: "O bot recebeu algo sem texto (foto, áudio) ou perdeu a fala do cliente." });
        }
      }
    });

    const botCounts = new Map<string, number[]>();
    list.forEach((m, i) => {
      if (m.senderType !== "BOT") return;
      const key = m.body.trim();
      botCounts.set(key, [...(botCounts.get(key) ?? []), i]);
    });
    for (const [body, idxs] of botCounts) {
      if (idxs.length >= 3 && body.length < 200) {
        idxs.forEach((i) => flaggedIdx.add(i));
        flags.push({ key: "LOOP", label: "Bot repetiu a mesma frase", detail: `"${body.slice(0, 80)}" ${idxs.length}x na mesma conversa.` });
        break;
      }
    }

    const last = list[list.length - 1];
    if (last.senderType === "CUSTOMER" && !THANKS.test(last.body) && Date.now() - last.createdAt.getTime() > UNANSWERED_AFTER_MS) {
      flaggedIdx.add(list.length - 1);
      flags.push({ key: "UNANSWERED", label: "Cliente sem resposta", detail: "A última mensagem é do cliente e ninguém respondeu." });
    }

    if (flags.length === 0) continue;

    const customer = await prisma.customer.findFirst({
      where: { tenantId, phone: { endsWith: phone.replace(/\D/g, "").slice(-8) } },
      select: { name: true },
    });
    const start = Math.max(0, list.length - 16);
    items.push({
      phone,
      name: customer?.name ?? phone,
      lastAt: last.createdAt.toISOString(),
      flags,
      messages: list.slice(start).map((m, k) => ({
        senderType: m.senderType,
        body: m.body.slice(0, 500),
        at: m.createdAt.toISOString(),
        flagged: flaggedIdx.has(start + k),
      })),
    });
  }
  return items.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
