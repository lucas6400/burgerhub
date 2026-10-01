import { prisma } from "../../lib/prisma.js";
import { normalizeBrazilPhone } from "./phone.js";
import { waTransport, instanceNameFor, type WaLabel } from "./transport.js";

/**
 * Etiquetas do WhatsApp Business por etapa do lead — o dono filtra a lista
 * direto no celular ("Pediu", "Sumiu"...). As etiquetas são criadas por ele no
 * app (a API não cria), com estes nomes; nome que não existir é simplesmente
 * ignorado. Nunca lança erro: etiqueta é conveniência e não pode derrubar o bot.
 */

export const LABEL_STAGES = {
  ASKING: "Perguntando",
  BUILDING: "Montando pedido",
  ORDERED: "Pediu",
  GHOSTED: "Sumiu",
  OUT_OF_AREA: "Fora da área",
} as const;
export type LabelStage = keyof typeof LABEL_STAGES;

const ORDERED_STICKY_MS = 12 * 3_600_000; // depois de pedir, não volta pra "Perguntando" na mesma noite

// Tolerante a acento, maiúscula, emoji, espaço duplo/estranho (NBSP) e pontuação.
const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Se o nome não bate exato, aceita variações que contenham as palavras-chave da etapa.
// Cada etapa aceita várias grafias (cada uma é uma lista de palavras que precisam estar todas no nome).
const STAGE_KEYWORDS: Record<LabelStage, string[][]> = {
  ASKING: [["perguntando"]],
  BUILDING: [["montando"]],
  ORDERED: [["pediu"]],
  GHOSTED: [["sumiu"]],
  // "Fora da rea": o acento às vezes se perde ao criar a etiqueta no WhatsApp — a palavra "fora" já basta.
  OUT_OF_AREA: [["fora", "area"], ["fora", "rea"], ["fora"]],
};

// Se o servidor recusar aplicar etiqueta (ex.: banco da Evolution sem migração), para de
// insistir por um tempo em vez de gerar duas chamadas falhas a cada mensagem.
const BACKOFF_MS = 30 * 60_000;
const backoffUntil = new Map<string, number>();

const cache = new Map<string, { at: number; labels: WaLabel[] }>();
async function getLabels(instance: string, force = false): Promise<WaLabel[]> {
  const hit = cache.get(instance);
  if (!force && hit && Date.now() - hit.at < 5 * 60_000) return hit.labels;
  const labels = await waTransport.listLabels(instance);
  cache.set(instance, { at: Date.now(), labels });
  return labels;
}

function idFor(labels: WaLabel[], stage: LabelStage): string | undefined {
  const wanted = norm(LABEL_STAGES[stage]);
  const exact = labels.find((l) => norm(l.name) === wanted);
  if (exact) return exact.id;
  return labels.find((l) => {
    const words = norm(l.name).split(" ");
    return STAGE_KEYWORDS[stage].some((alt) => alt.every((k) => words.includes(k)));
  })?.id;
}

/** Quais das 5 etiquetas existem no WhatsApp — usado na tela de diagnóstico. */
export async function labelStatus(tenantId: string, instance: string) {
  const labels = await getLabels(instance, true);
  return {
    total: labels.length,
    names: labels.map((l) => l.name),
    stages: (Object.keys(LABEL_STAGES) as LabelStage[]).map((stage) => ({
      stage,
      name: LABEL_STAGES[stage],
      found: idFor(labels, stage) != null,
    })),
  };
}

/** Coloca o lead na etiqueta da etapa (e tira da anterior). Devolve se a Evolution confirmou. */
export async function moveLead(tenantId: string, phone: string, stage: LabelStage, opts: { force?: boolean; onDetail?: (detail: string) => void } = {}): Promise<boolean> {
  try {
    const settings = await prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { waLabelsEnabled: true, waEnabled: true, waProvider: true },
    });
    if (!opts.force && !settings?.waLabelsEnabled) return false;
    if (!opts.force && (backoffUntil.get(tenantId) ?? 0) > Date.now()) return false;
    if (!settings?.waEnabled || settings.waProvider !== "EVOLUTION") return false;

    const key = normalizeBrazilPhone(phone);
    const session = await prisma.chatSession.findUnique({ where: { tenantId_phone: { tenantId, phone: key } } });
    const current = session?.labelStage as LabelStage | null | undefined;
    if (!opts.force) {
      if (current === stage) return true;
      const recentlyOrdered =
        current === "ORDERED" && session?.labelStageAt && Date.now() - session.labelStageAt.getTime() < ORDERED_STICKY_MS;
      if (recentlyOrdered && stage !== "ORDERED") return true;
    }

    const instance = instanceNameFor(tenantId);
    const labels = await getLabels(instance);
    const targetId = idFor(labels, stage);
    if (!targetId) {
      opts.onDetail?.(`Etiqueta "${LABEL_STAGES[stage]}" não encontrada no WhatsApp (nomes vistos: ${labels.map((l) => l.name).join(", ") || "nenhum"})`);
      return false;
    }

    if (current && current !== stage) {
      const prevId = idFor(labels, current);
      if (prevId && prevId !== targetId) await waTransport.setLabel(instance, key, prevId, "remove");
    }
    const ok = await waTransport.setLabel(instance, key, targetId, "add", opts.onDetail);
    if (!ok && !opts.force) backoffUntil.set(tenantId, Date.now() + BACKOFF_MS);
    if (ok) backoffUntil.delete(tenantId);
    if (ok) {
      await prisma.chatSession.upsert({
        where: { tenantId_phone: { tenantId, phone: key } },
        update: { labelStage: stage, labelStageAt: new Date() },
        create: { tenantId, phone: key, data: "{}", labelStage: stage, labelStageAt: new Date() },
      });
    }
    return ok;
  } catch (err) {
    console.error("Erro ao atualizar etiqueta do WhatsApp:", err);
    return false;
  }
}

interface CartLine {
  quantity: number;
}

/** Etapa pelo estado atual da conversa: carrinho com itens = montando; senão perguntando. */
export function stageFromSessionData(sessionData: string): LabelStage | null {
  try {
    const d = JSON.parse(sessionData) as { cart?: CartLine[]; draft?: { cart?: CartLine[]; finalizedOrderId?: string } };
    // Pedido acabou de ser fechado: a etiqueta "Pediu" é aplicada pela criação do pedido.
    if (d.draft?.finalizedOrderId) return null;
    const cart = d.draft?.cart ?? d.cart ?? [];
    return cart.length > 0 ? "BUILDING" : "ASKING";
  } catch {
    return "ASKING";
  }
}
