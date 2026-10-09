import { prisma } from "../../lib/prisma.js";
import { quoteDelivery } from "../orders/orders.service.js";
import { AppError } from "../../middlewares/error.js";

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Monta a resposta real sobre entrega naquele local — nunca a partir do texto
 * da IA, sempre do cálculo de verdade (`quoteDelivery`, que já enviesa a busca
 * pela localização da própria loja — essencial pra bairros com nomes comuns em
 * várias cidades do Brasil, como "Bela Vista", quando o cliente não cita a
 * cidade).
 */
export async function answerDeliveryAreaQuery(
  tenantId: string,
  neighborhood: string,
  city: string | null,
): Promise<string> {
  // Quadra (ex.: "405 sul", "508 norte", "ARNO 41") não é reconhecida pelo mapa —
  // o resultado seria um chute no centro do bairro. Só a localização confirma.
  if (/\b\d{2,4}\s*(n|norte|s|sul|o|oeste|l|leste)\b|\b(arno|arne|arso|arse|asr|acsu)\b/i.test(neighborhood)) {
    const confirmLine = "O valor exato e a confirmação saem pela sua 📍 localização (toque no 📎 → Localização → escolha o ponto da casa no mapa — localização FIXA, não a atual nem a em tempo real) — o pedido de entrega só fecha depois dela.";
    // Texto de quadra vira um chute no mapa (já deu "grátis, 3 km" pra uma quadra a 11 km):
    // NUNCA calcula por ele — só informa a faixa cadastrada da região citada.
    const lower = neighborhood.toLowerCase();
    const isSul = /\b\d{2,4}\s*(s|sul)\b|\b(arso|arse|asr|acsu)\b/.test(lower);
    const isNorte = /\b\d{2,4}\s*(n|norte)\b|\b(arno|arne)\b/.test(lower);
    const region = isSul ? "sul" : isNorte ? "norte" : null;
    const zones = await prisma.deliveryZone.findMany({ where: { tenantId, active: true }, select: { name: true, feeCents: true } });
    const fees = region ? zones.filter((z) => z.name.toLowerCase().includes(region)).map((z) => z.feeCents) : [];
    if (region && fees.length > 0) {
      const min = Math.min(...fees);
      const max = Math.max(...fees);
      const range = max === 0 ? "grátis" : min === max ? brl(min) : min === 0 ? `de grátis a ${brl(max)}` : `de ${brl(min)} a ${brl(max)}`;
      return `Entregamos na região ${region === "sul" ? "Sul" : "Norte"}! A taxa varia por quadra, ${range}, conforme a distância — não cite um valor único pra essa quadra. ${confirmLine}`;
    }
    return `Pra quadra eu não consigo dizer a taxa só pelo nome — depende da distância. ${confirmLine}`;
  }
  try {
    const quote = await quoteDelivery(tenantId, { street: "", number: "", neighborhood, city: city ?? "" }, 0);
    return `Entregamos sim! 🛵 Taxa de ${brl(quote.feeCents)} (~${quote.distanceKm} km, ${quote.etaMinutes} min).`;
  } catch (err) {
    const msg = err instanceof AppError ? err.message : "Não consegui confirmar essa área agora.";
    return `😕 ${msg}\nSe quiser, me manda sua 📍 localização (📎 → Localização) que eu confirmo certinho, ou podemos seguir com retirada no balcão.`;
  }
}

/**
 * Resposta pra pergunta genérica sobre entrega ("é grátis?", "quanto custa o
 * frete?") sem bairro citado — usa os dados reais de configuração (faixas de
 * taxa, valor mínimo pra frete grátis), nunca um número inventado. Sem bairro
 * não dá pra calcular a taxa exata, então convida o cliente a mandar o endereço.
 */
export async function answerGeneralDeliveryQuestion(tenantId: string): Promise<string> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  const [tiers, zones] = await Promise.all([
    prisma.deliveryRadiusTier.findMany({ where: { tenantId, active: true }, orderBy: { feeCents: "asc" } }),
    prisma.deliveryZone.findMany({ where: { tenantId, active: true }, orderBy: { feeCents: "asc" } }),
  ]);
  if (settings?.storeLat == null || settings?.storeLng == null || (tiers.length === 0 && zones.length === 0)) {
    return "A entrega ainda não está configurada por aqui. Me manda seu endereço que eu confirmo certinho, ou podemos seguir com retirada no balcão. 😉";
  }
  const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  // "A partir de" precisa considerar a zona mais barata também — sem isso, uma
  // zona grátis desenhada no mapa faria o bot anunciar um valor mínimo errado.
  const candidateFees = [...tiers.map((t) => t.feeCents), ...zones.map((z) => z.feeCents)];
  const minFee = Math.min(...candidateFees);
  const minPaidFee = candidateFees.filter((f) => f > 0).sort((a, b) => a - b)[0];
  const freeZoneNames = zones.filter((z) => z.feeCents === 0).map((z) => z.name);
  const freeTierKm = Math.max(0, ...tiers.filter((t) => t.feeCents === 0).map((t) => t.maxKm));
  const freeParts = [
    freeZoneNames.length > 0 ? `nas regiões ${freeZoneNames.join(", ")}` : "",
    freeTierKm > 0 ? `até ${freeTierKm} km da loja` : "",
  ].filter(Boolean);
  const areas = settings.deliveryAreasDescription?.trim();
  const freeLine =
    settings.freeDeliveryAbove != null
      ? ` Grátis em pedidos acima de ${brl(settings.freeDeliveryAbove)}!`
      : "";
  // Nunca dizer "não temos entrega grátis" nem "a partir de R$ 0,00" quando
  // existe área grátis: explica onde é grátis e onde a taxa varia.
  const feeLine = areas
    ? `Entregamos ${areas}.${minFee === 0 ? " Em parte dessas regiões a entrega é grátis!" : ""}${minPaidFee ? ` Onde tem taxa, ela começa em ${brl(minPaidFee)}.` : ""}`
    : freeParts.length > 0
      ? `Temos entrega GRÁTIS ${freeParts.join(" e ")}! 🎉${minPaidFee ? ` Fora dessas áreas a taxa varia (a partir de ${brl(minPaidFee)}).` : ""}`
      : `A taxa de entrega varia pela distância até você, a partir de ${brl(minFee)}.`;
  const notServed = settings.deliveryNotServedText?.trim();
  const notServedLine = notServed ? ` Não atendemos ${notServed}.` : "";
  return `${feeLine}${notServedLine}${freeLine}\nMe manda sua 📍 localização (📎 → Localização) que eu confirmo certinho pra você! 🛵`;
}

/** Resposta sobre onde fica A LOJA (não o endereço do cliente) — usa o endereço real cadastrado, nunca inventado. */
export async function answerStoreAddressQuestion(tenantId: string): Promise<string> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.address) {
    return "Ainda não tenho nosso endereço cadastrado aqui no sistema — dá uma olhada no nosso perfil do WhatsApp, ou me chama que confirmo com a equipe. 🙏";
  }
  return `Estamos em: ${settings.address} 📍 Te esperamos!`;
}
