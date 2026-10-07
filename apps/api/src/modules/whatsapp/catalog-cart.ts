import { prisma } from "../../lib/prisma.js";

/**
 * Carrinho do catálogo do WhatsApp Business: a mensagem traz só a QUANTIDADE de itens e o TOTAL — a lista dos itens
 * só existiria numa chamada que a Evolution API não expõe (ela só lista o catálogo, não os pedidos recebidos). Antes o
 * bot pedia "me diz quais são" e o cliente tinha que repetir tudo. Aqui os itens são DEDUZIDOS: procura no cardápio a
 * combinação de produtos com exatamente essa quantidade de unidades e esse total. R$ 65 com 1 item só pode ser o combo
 * de 3 X-Tudo; R$ 100 com 2 itens é 2x o combo de R$ 50 antes de qualquer outra soma.
 */

export interface CatalogProduct {
  id: string;
  name: string;
  priceCents: number;
}

export interface CartSolution {
  lines: { product: CatalogProduct; quantity: number }[];
}

const MAX_UNITS = 12;
const MAX_STEPS = 300_000;
const MAX_SOLUTIONS = 40;

const normalize = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Todas as combinações de exatamente `units` unidades de produtos que somam `totalCents` (com limite de busca). */
export function findCartSolutions(products: CatalogProduct[], units: number, totalCents: number): CartSolution[] {
  if (units < 1 || units > MAX_UNITS || totalCents <= 0) return [];
  const sorted = [...products].filter((p) => p.priceCents > 0).sort((a, b) => b.priceCents - a.priceCents);
  if (sorted.length === 0) return [];
  const minPrice = sorted[sorted.length - 1].priceCents;
  const solutions: CartSolution[] = [];
  let steps = 0;

  function walk(index: number, unitsLeft: number, totalLeft: number, picked: { product: CatalogProduct; quantity: number }[]) {
    if (steps++ > MAX_STEPS || solutions.length >= MAX_SOLUTIONS) return;
    if (unitsLeft === 0) {
      if (totalLeft === 0) solutions.push({ lines: picked.map((l) => ({ ...l })) });
      return;
    }
    if (index >= sorted.length) return;
    // poda: o que sobra tem que caber entre o mais barato e o mais caro restante
    if (totalLeft < unitsLeft * minPrice || totalLeft > unitsLeft * sorted[index].priceCents) return;
    const product = sorted[index];
    const maxQty = Math.min(unitsLeft, Math.floor(totalLeft / product.priceCents));
    for (let qty = maxQty; qty >= 0; qty--) {
      if (qty > 0) picked.push({ product, quantity: qty });
      walk(index + 1, unitsLeft - qty, totalLeft - qty * product.priceCents, picked);
      if (qty > 0) picked.pop();
    }
  }
  walk(0, units, totalCents, []);
  return solutions;
}

export type CartGuess =
  | { kind: "single"; solution: CartSolution }
  | { kind: "candidates"; solutions: CartSolution[] }
  | { kind: "none" };

/**
 * Escolhe entre as combinações possíveis: as que repetem o MESMO produto vêm primeiro (cliente que leva 2 itens quase
 * sempre leva 2 do mesmo combo), depois as com menos produtos distintos. Se o melhor grupo tem uma só combinação, é
 * "single"; se tem 2 ou 3, o bot pergunta entre elas; mais que isso, não chuta.
 * `titleHint`: título do carrinho (se o WhatsApp mandar o nome do 1º item) desempata a favor do produto citado.
 */
export function guessCart(solutions: CartSolution[], titleHint?: string): CartGuess {
  if (solutions.length === 0) return { kind: "none" };
  const hint = titleHint ? normalize(titleHint) : "";
  const mentions = (s: CartSolution) => (hint ? s.lines.some((l) => hint.includes(normalize(l.product.name)) || normalize(l.product.name).includes(hint)) : false);
  const hinted = hint ? solutions.filter(mentions) : [];
  const pool = hinted.length > 0 ? hinted : solutions;
  const minDistinct = Math.min(...pool.map((s) => s.lines.length));
  const best = pool.filter((s) => s.lines.length === minDistinct);
  if (best.length === 1) return { kind: "single", solution: best[0] };
  if (best.length <= 3) return { kind: "candidates", solutions: best };
  return { kind: "none" };
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const describeSolution = (s: CartSolution) => s.lines.map((l) => `${l.quantity}x ${l.product.name} (${brl(l.product.priceCents)} cada)`).join(" + ");

export interface CatalogOrderInfo {
  itemCount?: number;
  totalCents?: number;
  title?: string;
  note?: string;
}

/**
 * Texto pra IA (instrução embutida entre colchetes, igual ao que o bot já recebia) e texto legível pra equipe no painel.
 * `aiText` manda ADICIONAR ao carrinho o que foi deduzido e pedir confirmação em uma frase — o cliente já escolheu lá.
 */
export async function describeCatalogOrder(tenantId: string, order: CatalogOrderInfo): Promise<{ aiText: string; recordedText: string }> {
  const count = order.itemCount && order.itemCount > 0 ? order.itemCount : undefined;
  const header = `${count ? `${count} item(ns)` : "itens"}${order.totalCents ? ` (${brl(order.totalCents)})` : ""}`;
  const recordedBase = `🛒 Carrinho do catálogo do WhatsApp: ${header}`;
  const noList = {
    aiText: `[Cliente enviou um carrinho do catálogo do WhatsApp com ${header}. A lista dos itens NÃO chegou e não foi possível deduzir pelo valor — peça pra ele dizer quais são e as quantidades.]`,
    recordedText: `${recordedBase} — itens não identificados`,
  };
  if (!count || !order.totalCents) return noList;

  // O carrinho do catálogo só pode ter produtos que ESTÃO no catálogo do WhatsApp da loja (botCatalogProductIds): procurar
  // no cardápio inteiro dava palpite errado (R$ 88 virava "X-Tudo ou X Bacon Especial", mas só o X-Tudo está no catálogo).
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { botCatalogProductIds: true } });
  const catalogIds = Array.isArray(settings?.botCatalogProductIds) ? (settings.botCatalogProductIds as unknown[]).filter((v): v is string => typeof v === "string") : [];
  const rows = await prisma.product.findMany({
    where: { tenantId, available: true, ...(catalogIds.length > 0 ? { id: { in: catalogIds } } : {}) },
    select: { id: true, name: true, priceCents: true, promoPriceCents: true },
  });
  const products: CatalogProduct[] = rows.map((p) => ({ id: p.id, name: p.name, priceCents: p.promoPriceCents ?? p.priceCents }));
  const guess = guessCart(findCartSolutions(products, count, order.totalCents), order.title);

  if (guess.kind === "single") {
    const text = describeSolution(guess.solution);
    return {
      aiText: `[Cliente escolheu um carrinho no CATÁLOGO do WhatsApp com ${header}. Pelo valor e pelo cardápio, o carrinho é: ${text}. ADICIONE esses itens ao pedido agora (update_cart_item) e confirme em UMA frase o que entendeu ("Vi que você escolheu ... — é isso?"), sem pedir que ele repita a lista. Se ele corrigir, ajuste.]`,
      recordedText: `${recordedBase} — provável: ${guess.solution.lines.map((l) => `${l.quantity}x ${l.product.name}`).join(" + ")}`,
    };
  }
  if (guess.kind === "candidates") {
    const options = guess.solutions.map((s, i) => `${i + 1}) ${describeSolution(s)}`).join(" | ");
    return {
      aiText: `[Cliente enviou um carrinho do catálogo do WhatsApp com ${header}. Pelo valor, pode ser: ${options}. NÃO adicione ainda: pergunte em UMA frase qual dessas opções é a dele (cite os itens e preços), e só depois use update_cart_item.]`,
      recordedText: `${recordedBase} — pode ser: ${guess.solutions.map((s) => s.lines.map((l) => `${l.quantity}x ${l.product.name}`).join(" + ")).join(" ou ")}`,
    };
  }
  return noList;
}
