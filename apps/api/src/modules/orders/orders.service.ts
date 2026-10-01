import { prisma } from "../../lib/prisma.js";
import { background } from "../../lib/background.js";
import { AppError } from "../../middlewares/error.js";
import { distanceKm, geocodeAddress, pointInPolygon } from "./geocoding.js";
import { env } from "../../config/env.js";
import { audit } from "../../utils/audit.js";
import { computeEarn, validateRedeem } from "../loyalty/loyalty.service.js";
import { createDeliveryForOrder } from "../delivery/delivery.service.js";
import { sendNewOrderPush } from "../push/push.service.js";
import { getDeliveryProviderFor } from "../delivery/delivery-provider.js";
import { brazilCellphoneLink } from "../whatsapp/phone.js";
import { findOrCreateCustomerByPhone } from "../customers/customers.service.js";

export const ORDER_STATUSES = [
  "AWAITING_PAYMENT",
  "NEW",
  "PREPARING",
  "FINISHING",
  "READY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "SETTLED",
  "CANCELED",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
  notes?: string;
  addonIds?: { addonId: string; quantity: number }[];
  removedIngredientIds?: string[]; // ProductIngredient.id
}

export interface DeliveryAddressInput {
  label?: string;
  street: string;
  number: string;
  neighborhood: string;
  city: string;
  complement?: string;
  reference?: string;
  /** Coordenadas capturadas no mapa/GPS — quando presentes, a distância usa
   *  esse ponto diretamente e pula a geocodificação por texto (mais confiável). */
  lat?: number;
  lng?: number;
}

export interface CreateOrderInput {
  tenantId: string;
  source: string; // MENU | WHATSAPP | POS | TABLE
  type: string; // DELIVERY | PICKUP | DINE_IN
  items: CreateOrderItemInput[];
  paymentMethod?: string; // ausente só é válido pra type DINE_IN (comanda aberta, cobrada depois)
  changeForCents?: number;
  notes?: string;
  couponCode?: string;
  redeemCashbackCents?: number;
  customer?: { name: string; phone: string; email?: string };
  customerId?: string;
  tableId?: string;
  address?: DeliveryAddressInput;
}

export interface DeliveryQuote {
  feeCents: number;
  distanceKm: number;
  etaMinutes: number;
  /** Ponto usado no cálculo — persistido no pedido pra alimentar o mapa de entregas. */
  point: { lat: number; lng: number };
  /**
   * false quando o ponto veio só do geocodificador caindo pro nível de bairro
   * (endereçamento por quadra, ex.: Palmas/Brasília, que o serviço gratuito não
   * acha por rua) — o pino pode cair a centenas de metros do endereço real.
   * O entregador precisa ver isso antes de confiar cegamente no mapa.
   */
  precise: boolean;
  /** Nome da zona desenhada no mapa que casou com o endereço, se houver. */
  zoneName?: string;
}

/**
 * Calcula a taxa de entrega automaticamente pelo endereço até o estabelecimento.
 * O cliente nunca escolhe a taxa — ela é sempre derivada da localização real.
 *
 * Primeiro testa as zonas desenhadas no mapa (polígono — mais preciso pra
 * contornos irregulares, ex.: "grátis só nessa região, mesmo que outro bairro
 * fique mais perto em linha reta"). Endereço fora de toda zona cai nas faixas
 * por distância de sempre, sem quebrar quem nunca desenhou nenhuma zona.
 */
export async function quoteDelivery(
  tenantId: string,
  address: Pick<DeliveryAddressInput, "street" | "number" | "neighborhood" | "city" | "lat" | "lng">,
  subtotalCents = 0,
): Promise<DeliveryQuote> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (settings?.storeLat == null || settings?.storeLng == null) {
    throw new AppError(
      409,
      "A entrega ainda não está configurada. Entre em contato com o estabelecimento.",
    );
  }

  // Coordenadas vindas do mapa/GPS são mais confiáveis do que geocodificar o
  // texto — evita depender do serviço gratuito conseguir achar o endereço.
  let point =
    address.lat != null && address.lng != null ? { lat: address.lat, lng: address.lng } : null;
  let precise = point != null;
  const storePoint = { lat: settings.storeLat, lng: settings.storeLng };
  if (!point) {
    const query = `${address.street}, ${address.number}, ${address.neighborhood}, ${address.city}, Brasil`;
    const geo = await geocodeAddress(query, storePoint);
    point = geo?.point ?? null;
    // Nominatim pode "achar" o endereço mas só até o nível de bairro (sem rua/
    // número reconhecidos) — precise vem do que ele realmente encontrou, não
    // só de a busca ter retornado algo.
    precise = geo?.precise ?? false;
  }
  // Cidades com endereçamento por quadra (Palmas, Brasília etc.) não têm nome
  // de rua reconhecível pelo geocodificador gratuito — cai pro nível de bairro,
  // suficiente pra faixa de frete (calculada em km), mas impreciso demais pro
  // entregador confiar cegamente no pino — sinalizamos como não-preciso.
  if (!point && address.neighborhood && address.city) {
    const geo = await geocodeAddress(`${address.neighborhood}, ${address.city}, Brasil`, storePoint);
    point = geo?.point ?? null;
    precise = false;
  }
  if (!point) {
    throw new AppError(400, "Não conseguimos localizar esse endereço. Confira e tente novamente.");
  }

  const distance = distanceKm(storePoint, point);

  const zones = await prisma.deliveryZone.findMany({
    where: { tenantId, active: true },
    orderBy: { createdAt: "asc" },
  });
  // Zonas podem se sobrepor (pra enxergar os limites no mapa): dentro da sobreposição vale a
  // de MENOR área — a mais específica (ex.: "Centro" dentro de "Sul") vence a mais ampla.
  const matchedZone = zones
    .filter((z) => pointInPolygon(point!, z.polygon as { lat: number; lng: number }[]))
    .sort((a, b) => polygonArea(a.polygon as { lat: number; lng: number }[]) - polygonArea(b.polygon as { lat: number; lng: number }[]))[0];
  if (matchedZone) {
    let feeCents = matchedZone.feeCents;
    if (settings.freeDeliveryAbove != null && subtotalCents >= settings.freeDeliveryAbove) {
      feeCents = 0;
    }
    return {
      feeCents,
      distanceKm: Math.round(distance * 10) / 10,
      etaMinutes: matchedZone.etaMinutes,
      point,
      precise,
      zoneName: matchedZone.name,
    };
  }

  const tiers = await prisma.deliveryRadiusTier.findMany({
    where: { tenantId, active: true },
    orderBy: { maxKm: "asc" },
  });
  if (tiers.length === 0) {
    // Só zonas desenhadas (sem faixas por km): fora de todas elas é "fora da área",
    // não "entrega não configurada".
    throw new AppError(
      409,
      zones.length > 0
        ? "Esse endereço está fora das nossas áreas de entrega."
        : "A entrega ainda não está configurada. Entre em contato com o estabelecimento.",
    );
  }

  const maxRadius = settings.maxDeliveryRadiusKm;
  if (distance > maxRadius) {
    throw new AppError(
      409,
      `Esse endereço está fora da nossa área de entrega (raio de ${maxRadius} km).`,
    );
  }

  const tier = tiers.find((t) => distance <= t.maxKm) ?? tiers[tiers.length - 1];
  let feeCents = tier.feeCents;
  if (settings.freeDeliveryAbove != null && subtotalCents >= settings.freeDeliveryAbove) {
    feeCents = 0;
  }

  return { feeCents, distanceKm: Math.round(distance * 10) / 10, etaMinutes: tier.etaMinutes, point, precise };
}

function polygonArea(poly: { lat: number; lng: number }[]): number {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) sum += poly[j].lng * poly[i].lat - poly[i].lng * poly[j].lat;
  return Math.abs(sum) / 2;
}

export async function createOrder(input: CreateOrderInput) {
  const { tenantId } = input;
  if (!input.items.length) throw new AppError(400, "Pedido sem itens");

  // ---- Carrega produtos com adicionais e ingredientes (sempre escopado ao tenant)
  const productIds = input.items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, tenantId },
    include: {
      ingredients: { include: { ingredient: true } },
      addonGroups: { include: { group: { include: { addons: true } } } },
    },
  });
  const productMap = new Map(products.map((p) => [p.id, p]));

  // ---- Monta itens com preços do SERVIDOR (nunca confiar no cliente)
  let subtotalCents = 0;
  const itemsData = input.items.map((item) => {
    const product = productMap.get(item.productId);
    if (!product) throw new AppError(400, "Produto inválido no pedido");
    if (!product.available) throw new AppError(409, `"${product.name}" está indisponível`);

    const unitPrice = product.promoPriceCents ?? product.priceCents;
    const validAddons = new Map(
      product.addonGroups.flatMap((pg) => pg.group.addons.map((a) => [a.id, a] as const)),
    );

    const addonsData = (item.addonIds ?? []).map(({ addonId, quantity }) => {
      const addon = validAddons.get(addonId);
      if (!addon || !addon.available) throw new AppError(400, "Adicional inválido");
      const qty = Math.min(Math.max(1, quantity), addon.maxQty);
      return {
        addonId: addon.id,
        nameSnapshot: addon.name,
        unitPriceCents: addon.priceCents,
        quantity: qty,
      };
    });

    const validRemovals = new Map(
      product.ingredients.filter((pi) => pi.removable).map((pi) => [pi.id, pi] as const),
    );
    const removalsData = (item.removedIngredientIds ?? []).map((id) => {
      const pi = validRemovals.get(id);
      if (!pi) throw new AppError(400, "Ingrediente não pode ser removido");
      return { productIngredientId: pi.id, nameSnapshot: pi.ingredient.name };
    });

    const addonsTotal = addonsData.reduce((sum, a) => sum + a.unitPriceCents * a.quantity, 0);
    subtotalCents += (unitPrice + addonsTotal) * item.quantity;

    return {
      productId: product.id,
      nameSnapshot: product.name,
      unitPriceCents: unitPrice,
      quantity: item.quantity,
      notes: item.notes,
      showInKds: product.showInKds,
      addons: { create: addonsData },
      removals: { create: removalsData },
    };
  });

  // ---- Pedido mínimo
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (settings && subtotalCents < settings.minOrderCents) {
    throw new AppError(400, `Pedido mínimo de R$ ${(settings.minOrderCents / 100).toFixed(2)}`);
  }

  // ---- Taxa de entrega: calculada automaticamente pela distância até o estabelecimento
  let deliveryFeeCents = 0;
  let deliveryDistanceKm: number | null = null;
  let deliveryLat: number | null = null;
  let deliveryLng: number | null = null;
  let deliveryLocationPrecise = true;
  if (input.type === "DELIVERY") {
    if (!input.address) throw new AppError(400, "Endereço obrigatório para entrega");
    const quote = await quoteDelivery(tenantId, input.address, subtotalCents);
    deliveryFeeCents = quote.feeCents;
    deliveryDistanceKm = quote.distanceKm;
    deliveryLat = quote.point.lat;
    deliveryLng = quote.point.lng;
    deliveryLocationPrecise = quote.precise;
  }

  // ---- Cliente (encontra ou cria pelo telefone)
  let customerId = input.customerId ?? null;
  if (!customerId && input.customer) {
    const customer = await findOrCreateCustomerByPhone(tenantId, input.customer, { overwriteName: true });
    customerId = customer.id;
  }

  // ---- Cupom
  let discountCents = 0;
  let couponId: string | null = null;
  let couponCode: string | null = null;
  if (input.couponCode) {
    const coupon = await validateCoupon(tenantId, input.couponCode, subtotalCents, customerId);
    couponCode = coupon.code;
    couponId = coupon.id;
    if (coupon.type === "PERCENT") discountCents = Math.round((subtotalCents * coupon.valuePct) / 100);
    else if (coupon.type === "FIXED") discountCents = Math.min(coupon.valueCents, subtotalCents);
    else if (coupon.type === "FREE_SHIPPING") {
      discountCents = 0;
      deliveryFeeCents = 0;
    }
  }

  // ---- Fidelidade: resgate de cashback (mutuamente exclusivo com cupom) + cálculo do que será ganho
  if (input.couponCode && input.redeemCashbackCents) {
    throw new AppError(400, "Cupom e fidelidade não podem ser combinados");
  }
  let redeemedCashbackCents = 0;
  let earnedPoints = 0;
  let earnedCashbackCents = 0;
  // Programa "compre X, leve Y" não credita pontos/cashback (computeEarn devolve
  // zero pra esse tipo) — é só um contador de pedidos por cliente, 1 por pedido.
  let earnedBuyXPunch = 0;
  const loyaltyProgram = await prisma.loyaltyProgram.findUnique({ where: { tenantId } });
  if (customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (input.redeemCashbackCents) {
      if (!customer || !loyaltyProgram) {
        throw new AppError(400, "Não foi possível aplicar o resgate de cashback");
      }
      redeemedCashbackCents = validateRedeem(
        loyaltyProgram,
        customer.cashbackCents,
        input.redeemCashbackCents,
        subtotalCents,
      );
    }
    if (customer && loyaltyProgram?.active) {
      const earn = computeEarn(loyaltyProgram, subtotalCents);
      earnedPoints = earn.points;
      earnedCashbackCents = earn.cashbackCents;
      if (loyaltyProgram.type === "BUY_X_GET_Y") earnedBuyXPunch = 1;
    }
  } else if (input.redeemCashbackCents) {
    throw new AppError(400, "Identifique-se para resgatar cashback");
  }
  discountCents += redeemedCashbackCents;

  const totalCents = subtotalCents - discountCents + deliveryFeeCents;

  // Entrega paga no Pix (automático via Mercado Pago já vira "ONLINE" antes
  // de chegar aqui, ou manual com chave fixa) fica presa até confirmar
  // pagamento — só pra pedido vindo do WhatsApp, nunca cardápio web/mesa/PDV.
  // Em standby por padrão: só liga se o estabelecimento ativar
  // TenantSettings.pixGateEnabled (Configurações → Pagamentos).
  const gateCandidate =
    input.source === "WHATSAPP" &&
    input.type === "DELIVERY" &&
    (input.paymentMethod === "PIX" || input.paymentMethod === "ONLINE");
  const requiresPaymentGate = gateCandidate
    ? !!(await prisma.tenantSettings.findUnique({ where: { tenantId }, select: { pixGateEnabled: true } }))?.pixGateEnabled
    : false;
  const initialStatus: OrderStatus = requiresPaymentGate ? "AWAITING_PAYMENT" : "NEW";

  // ---- Transação: número sequencial + pedido + baixa de estoque + uso do cupom
  const order = await prisma.$transaction(async (tx) => {
    const last = await tx.order.findFirst({
      where: { tenantId },
      orderBy: { number: "desc" },
      select: { number: true },
    });
    const number = (last?.number ?? 0) + 1;

    const created = await tx.order.create({
      data: {
        tenantId,
        number,
        customerId,
        tableId: input.tableId,
        type: input.type,
        source: input.source,
        status: initialStatus,
        subtotalCents,
        discountCents,
        deliveryFeeCents,
        deliveryDistanceKm,
        totalCents,
        paymentMethod: input.paymentMethod,
        changeForCents: input.changeForCents,
        couponId,
        couponCode,
        notes: input.notes,
        addressLabel: input.address?.label,
        addressStreet: input.address?.street,
        addressNumber: input.address?.number,
        addressNeighborhood: input.address?.neighborhood,
        addressCity: input.address?.city,
        addressComplement: input.address?.complement,
        addressReference: input.address?.reference,
        deliveryLat,
        deliveryLng,
        deliveryLocationPrecise,
        items: { create: itemsData },
        statusEvents: { create: { toStatus: initialStatus } },
      },
      include: {
        items: { include: { addons: true, removals: true } },
        customer: true,
      },
    });

    if (couponId) {
      await tx.coupon.update({
        where: { id: couponId },
        data: { usedCount: { increment: 1 } },
      });
    }

    // ---- Fidelidade: debita o resgate e credita o que foi ganho neste pedido
    if (redeemedCashbackCents > 0 && customerId) {
      await tx.customer.update({
        where: { id: customerId },
        data: { cashbackCents: { decrement: redeemedCashbackCents } },
      });
      await tx.loyaltyTransaction.create({
        data: { customerId, type: "REDEEM", cashCents: redeemedCashbackCents, orderId: created.id },
      });
    }
    if ((earnedPoints > 0 || earnedCashbackCents > 0 || earnedBuyXPunch > 0) && customerId) {
      await tx.customer.update({
        where: { id: customerId },
        data: {
          loyaltyPoints: { increment: earnedPoints },
          cashbackCents: { increment: earnedCashbackCents },
          buyXProgress: { increment: earnedBuyXPunch },
        },
      });
      await tx.loyaltyTransaction.create({
        data: {
          customerId,
          type: "EARN",
          // Campo genérico reaproveitado: pontos do programa POINTS, ou 1 "carimbo"
          // do compre-X-leve-Y (nunca os dois — só um tipo de programa ativo por vez).
          points: earnedPoints || earnedBuyXPunch,
          cashCents: earnedCashbackCents,
          orderId: created.id,
          expiresAt: loyaltyProgram
            ? new Date(Date.now() + loyaltyProgram.validityDays * 86_400_000)
            : undefined,
        },
      });
    }

    // ---- Baixa automática de estoque (receita do produto − ingredientes removidos)
    for (const item of created.items) {
      if (!item.productId) continue;
      const product = productMap.get(item.productId);
      if (!product) continue;
      const removedPiIds = new Set(item.removals.map((r) => r.productIngredientId));
      for (const pi of product.ingredients) {
        if (removedPiIds.has(pi.id)) continue;
        const qty = pi.quantity * item.quantity;
        await tx.ingredient.update({
          where: { id: pi.ingredientId },
          data: { stockQty: { decrement: qty } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId,
            ingredientId: pi.ingredientId,
            type: "OUT",
            quantity: -qty,
            reason: `Pedido #${number}`,
            refOrderId: created.id,
          },
        });
      }
    }

    return created;
  }, { timeout: 15_000 });

  // Avisa o staff no celular mesmo com o painel fechado — só pra pedido que
  // chegou sozinho (cardápio/WhatsApp/mesa), não quando o próprio staff digita
  // no balcão (ele já está com a tela na frente). Pedido ainda AWAITING_PAYMENT
  // não é acionável ainda — o push disparado aqui esperaria até liberar
  // (ver updateOrderStatus).
  if (order.source !== "POS" && order.status !== "AWAITING_PAYMENT") {
    background(sendNewOrderPush(tenantId, order).catch((err) => console.error("Falha ao enviar push:", err)));
    background(sendOwnerOrderTicket(tenantId, order).catch((err) => console.error("Falha ao enviar ticket por WhatsApp:", err)));
  }

  // Pedido feito direto pelo cardápio digital (não pelo WhatsApp) — o cliente
  // não teve nenhuma conversa com o bot ainda, então avisa que o pedido caiu
  // e que dá pra acompanhar por ali mesmo (as próximas etapas já notificam
  // sozinhas via notifyStatusChange, disparado de updateOrderStatus).
  if (order.source !== "POS" && order.customer?.phone) {
    const leadPhone = order.customer.phone;
    background(import("../whatsapp/labels.service.js")
      .then((m) => m.moveLead(tenantId, leadPhone, "ORDERED"))
      .catch((err) => console.error("Falha ao etiquetar pedido:", err)));
  }
  if (order.source === "MENU" && order.customer?.phone) {
    background(notifyOrderReceived(tenantId, order.id).catch((err) =>
      console.error("Falha ao notificar pedido recebido:", err),
    ));
  }

  return { ...order, earnedPoints, earnedCashbackCents };
}

export async function validateCoupon(
  tenantId: string,
  code: string,
  subtotalCents: number,
  customerId?: string | null,
) {
  const coupon = await prisma.coupon.findFirst({
    where: { tenantId, code: code.toUpperCase().trim(), active: true },
  });
  if (!coupon) throw new AppError(404, "Cupom inválido");
  if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new AppError(410, "Cupom expirado");
  if (coupon.maxUses != null && coupon.usedCount >= coupon.maxUses)
    throw new AppError(410, "Cupom esgotado");
  if (subtotalCents < coupon.minOrderCents)
    throw new AppError(400, `Cupom válido para pedidos acima de R$ ${(coupon.minOrderCents / 100).toFixed(2)}`);
  if (coupon.firstPurchaseOnly && customerId) {
    const previousOrders = await prisma.order.count({
      where: { tenantId, customerId, status: { not: "CANCELED" } },
    });
    if (previousOrders > 0) throw new AppError(400, "Cupom válido apenas para a primeira compra");
  }
  if (coupon.birthdayOnly && customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    const today = new Date();
    if (
      !customer?.birthDate ||
      customer.birthDate.getMonth() !== today.getMonth() ||
      customer.birthDate.getDate() !== today.getDate()
    ) {
      throw new AppError(400, "Cupom válido apenas no seu aniversário");
    }
  }
  return coupon;
}

const VALID_TRANSITIONS: Record<string, OrderStatus[]> = {
  // Sem atalho direto pra DELIVERED/SETTLED (diferente de NEW logo abaixo) —
  // deixaria o staff pular a confirmação de pagamento sem querer. Só libera
  // pra NEW (confirma o pagamento e entra na fila normal) ou CANCELED.
  AWAITING_PAYMENT: ["NEW", "CANCELED"],
  // DELIVERED sempre alcançável direto — lojas sem KDS/fluxo de cozinha
  // concluem o pedido de uma vez, sem passar pelos estágios de preparo.
  NEW: ["PREPARING", "DELIVERED", "SETTLED", "CANCELED"],
  PREPARING: ["FINISHING", "READY", "DELIVERED", "SETTLED", "CANCELED"],
  FINISHING: ["READY", "DELIVERED", "SETTLED", "CANCELED"],
  READY: ["OUT_FOR_DELIVERY", "DELIVERED", "SETTLED", "CANCELED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "CANCELED"],
  DELIVERED: [],
  SETTLED: [],
  CANCELED: [],
};

export async function updateOrderStatus(params: {
  tenantId: string;
  orderId: string;
  toStatus: OrderStatus;
  userId?: string;
  cancelReason?: string;
}) {
  const { tenantId, orderId, toStatus } = params;
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: { customer: true },
  });
  if (!order) throw new AppError(404, "Pedido não encontrado");

  if (!VALID_TRANSITIONS[order.status]?.includes(toStatus)) {
    throw new AppError(409, `Transição inválida: ${order.status} → ${toStatus}`);
  }

  const now = new Date();
  // Liberando um pedido preso esperando o Pix (qualquer um dos 3 caminhos:
  // webhook automático do Mercado Pago, comprovante lido pela IA, ou staff
  // liberando manual) também confirma o pagamento — mesmo lugar que já faz
  // isso pra DELIVERED/SETTLED, sem duplicar a lógica em outro arquivo.
  const releasingFromPaymentGate = order.status === "AWAITING_PAYMENT" && toStatus === "NEW";
  const timestamps: Record<string, object> = {
    PREPARING: { confirmedAt: now },
    READY: { readyAt: now },
    OUT_FOR_DELIVERY: { dispatchedAt: now },
    DELIVERED: { deliveredAt: now, paymentStatus: "PAID" },
    SETTLED: { settledAt: now, paymentStatus: "PAID" },
    CANCELED: { canceledAt: now, cancelReason: params.cancelReason },
    ...(releasingFromPaymentGate ? { NEW: { paymentStatus: "PAID", paymentReviewRequired: false } } : {}),
  };

  let createdDeliveryId: string | null = null;

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.order.update({
      where: { id: order.id },
      data: {
        status: toStatus,
        ...(timestamps[toStatus] ?? {}),
        statusEvents: {
          create: { fromStatus: order.status, toStatus, byUserId: params.userId },
        },
      },
      include: {
        items: { include: { addons: true, removals: true } },
        customer: true,
      },
    });

    // Pedido de entrega ficou pronto → entra automaticamente na Central de Despacho
    if (toStatus === "READY" && result.type === "DELIVERY") {
      const delivery = await createDeliveryForOrder(tx, {
        tenantId,
        orderId: result.id,
        deliveryLat: result.deliveryLat,
        deliveryLng: result.deliveryLng,
        prepMinutesRemaining: 0,
      });
      createdDeliveryId = delivery?.id ?? null;
    }

    // Entrega concluída ou conta de mesa fechada → lançamento financeiro automático (entrada)
    if (toStatus === "DELIVERED" || toStatus === "SETTLED") {
      await tx.financialEntry.create({
        data: {
          tenantId,
          type: "INCOME",
          category: "Vendas",
          description: `Pedido #${order.number}`,
          amountCents: order.totalCents,
          paidAt: now,
          refOrderId: order.id,
        },
      });

      // Sincroniza a entrega associada — sem isso, concluir o pedido direto pela
      // aba Pedidos (atalho pra loja sem KDS, ver VALID_TRANSITIONS) deixava o
      // Delivery "pendurado" no status antigo, continuando ativo na Central de
      // Despacho mesmo com o pedido já finalizado (mesmo problema já corrigido
      // pro cancelamento, ver bloco de CANCELED logo abaixo).
      const delivery = await tx.delivery.findUnique({ where: { orderId: order.id } });
      if (delivery && !["DELIVERED", "FAILED", "CANCELED"].includes(delivery.status)) {
        await tx.delivery.update({
          where: { id: delivery.id },
          data: {
            status: "DELIVERED",
            deliveredAt: now,
            events: {
              create: { type: "STATUS_CHANGED", fromStatus: delivery.status, toStatus: "DELIVERED", byUserId: params.userId },
            },
          },
        });
        if (delivery.driverId) {
          const stillActive = await tx.delivery.count({
            where: { driverId: delivery.driverId, id: { not: delivery.id }, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
          });
          await tx.driver.update({
            where: { id: delivery.driverId },
            data: { status: stillActive > 0 ? "DELIVERING" : "AVAILABLE" },
          });
        }
      }
    }

    // Cancelamento → devolve estoque e estorna fidelidade (pontos/cashback ganhos ou resgatados)
    if (toStatus === "CANCELED") {
      const movements = await tx.stockMovement.findMany({
        where: { tenantId, refOrderId: order.id, type: "OUT" },
      });
      for (const m of movements) {
        await tx.ingredient.update({
          where: { id: m.ingredientId },
          data: { stockQty: { increment: -m.quantity } },
        });
        await tx.stockMovement.create({
          data: {
            tenantId,
            ingredientId: m.ingredientId,
            type: "IN",
            quantity: -m.quantity,
            reason: `Cancelamento pedido #${order.number}`,
            refOrderId: order.id,
          },
        });
      }

      const loyaltyTxs = await tx.loyaltyTransaction.findMany({ where: { orderId: order.id } });
      for (const lt of loyaltyTxs) {
        if (lt.type === "EARN") {
          await tx.customer.update({
            where: { id: lt.customerId },
            data: {
              loyaltyPoints: { decrement: lt.points },
              cashbackCents: { decrement: lt.cashCents },
            },
          });
        } else if (lt.type === "REDEEM") {
          await tx.customer.update({
            where: { id: lt.customerId },
            data: { cashbackCents: { increment: lt.cashCents } },
          });
        }
      }

      // Sincroniza a entrega associada — sem isso, o Delivery ficava "pendurado"
      // no status antigo e o chat/tracking público de acompanhamento continuava
      // aberto indefinidamente pra um pedido morto (achado da revisão de segurança).
      const delivery = await tx.delivery.findUnique({ where: { orderId: order.id } });
      if (delivery && !["DELIVERED", "FAILED", "CANCELED"].includes(delivery.status)) {
        await tx.delivery.update({
          where: { id: delivery.id },
          data: {
            status: "CANCELED",
            events: {
              create: { type: "STATUS_CHANGED", fromStatus: delivery.status, toStatus: "CANCELED", byUserId: params.userId },
            },
          },
        });
        if (delivery.driverId) {
          const stillActive = await tx.delivery.count({
            where: { driverId: delivery.driverId, id: { not: delivery.id }, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
          });
          await tx.driver.update({
            where: { id: delivery.driverId },
            data: { status: stillActive > 0 ? "DELIVERING" : "AVAILABLE" },
          });
        }
      }
    }

    return result;
  }, { timeout: 15_000 });

  await audit({
    tenantId,
    userId: params.userId,
    action: "STATUS_CHANGE",
    entity: "Order",
    entityId: order.id,
    detail: { from: order.status, to: toStatus, orderNumber: order.number },
  });

  // Notificação WhatsApp (integração Evolution API — fila/stub)
  background(notifyStatusChange(tenantId, updated.id, toStatus).catch((err) =>
    console.error("Falha ao notificar WhatsApp:", err),
  ));

  // Pedido de entrega pronto → avisa o provedor de logística (frota própria: no-op; iFood Entregas: solicita coleta)
  if (createdDeliveryId) {
    const deliveryId = createdDeliveryId;
    background(getDeliveryProviderFor(tenantId)
      .then((provider) => provider.requestDelivery(deliveryId, tenantId))
      .catch((err) => console.error("Falha ao solicitar entrega ao provedor de logística:", err)));
  }

  // Pedido saiu de AWAITING_PAYMENT agora — é o momento certo de avisar o
  // staff (o push de "pedido novo" em createOrder foi propositalmente pulado
  // pra esse pedido até aqui, ver createOrder).
  if (releasingFromPaymentGate && updated.source !== "POS") {
    background(sendNewOrderPush(tenantId, updated).catch((err) => console.error("Falha ao enviar push:", err)));
    background(sendOwnerOrderTicket(tenantId, updated).catch((err) => console.error("Falha ao enviar ticket por WhatsApp:", err)));
  }

  return updated;
}

const ticketBrl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const TICKET_TYPE_LABELS: Record<string, string> = { DELIVERY: "Entrega", PICKUP: "Retirada", DINE_IN: "No local" };
const TICKET_PAYMENT_LABELS: Record<string, string> = {
  PIX: "Pix",
  CASH: "Dinheiro",
  CREDIT: "Crédito",
  DEBIT: "Débito",
  VR: "VR",
  VA: "VA",
  ONLINE: "Pix (automático)",
};

interface OrderTicketInfo {
  number: number;
  type: string;
  paymentMethod: string | null;
  changeForCents: number | null;
  totalCents: number;
  notes: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressNeighborhood: string | null;
  addressComplement: string | null;
  deliveryLat?: number | null;
  deliveryLng?: number | null;
  customer: { name: string; phone: string } | null;
  items: {
    nameSnapshot: string;
    quantity: number;
    unitPriceCents: number;
    notes: string | null;
    addons: { nameSnapshot: string; quantity: number }[];
    removals: { nameSnapshot: string }[];
  }[];
}

/**
 * Manda um "ticket" do pedido pro WhatsApp do dono — gambiarra pra quem ainda
 * não tem impressora térmica. Só dispara se orderAlertPhone estiver configurado
 * em Configurações; mesmos gatilhos do push de "pedido novo" (criação e
 * liberação de AWAITING_PAYMENT), nunca em pedido de PDV.
 */
async function sendOwnerOrderTicket(tenantId: string, order: OrderTicketInfo) {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.orderAlertPhone) return;

  const { getWhatsAppSenderFor } = await import("../whatsapp/transport.js");
  const sender = await getWhatsAppSenderFor(tenantId);
  if (!sender) return;

  const itemsText = order.items
    .map((i) => {
      const lines = [`${i.quantity}x ${i.nameSnapshot} — ${ticketBrl(i.unitPriceCents * i.quantity)}`];
      for (const a of i.addons) lines.push(`  + ${a.quantity}x ${a.nameSnapshot}`);
      for (const r of i.removals) lines.push(`  - SEM ${r.nameSnapshot}`);
      if (i.notes) lines.push(`  Obs: ${i.notes}`);
      return lines.join("\n");
    })
    .join("\n");

  const addressLine =
    order.type === "DELIVERY" && order.addressStreet
      ? `\n📍 ${order.addressStreet}, ${order.addressNumber ?? "s/n"} — ${order.addressNeighborhood ?? ""}${order.addressComplement ? ` (${order.addressComplement})` : ""}`
      : "";
  const mapLine =
    order.type === "DELIVERY" && order.deliveryLat != null && order.deliveryLng != null
      ? `\n🗺️ Waze: https://waze.com/ul?ll=${order.deliveryLat},${order.deliveryLng}&navigate=yes\n🗺️ Google Maps: https://www.google.com/maps/search/?api=1&query=${order.deliveryLat},${order.deliveryLng}`
      : "";
  const paymentLine = order.paymentMethod
    ? `\n💳 ${TICKET_PAYMENT_LABELS[order.paymentMethod] ?? order.paymentMethod}${order.changeForCents ? ` (troco p/ ${ticketBrl(order.changeForCents)})` : ""}`
    : "";
  const customerLine = order.customer
    ? `\n👤 ${order.customer.name} — ${order.customer.phone}\n💬 ${brazilCellphoneLink(order.customer.phone)}`
    : "";
  const notesLine = order.notes ? `\n📝 ${order.notes}` : "";

  const text =
    `🧾 *Pedido #${order.number}* — ${TICKET_TYPE_LABELS[order.type] ?? order.type}\n\n${itemsText}\n\n*Total: ${ticketBrl(order.totalCents)}*` +
    `${customerLine}${addressLine}${mapLine}${paymentLine}${notesLine}`;

  await sender.sendText(settings.orderAlertPhone, text);
}

/** Envia mensagem automática de status pelo WhatsApp conectado do estabelecimento. */
async function notifyStatusChange(tenantId: string, orderId: string, status: OrderStatus) {
  const { getWhatsAppSenderFor } = await import("../whatsapp/transport.js");
  const sender = await getWhatsAppSenderFor(tenantId);
  if (!sender) return;

  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings) return;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true, tenant: { select: { slug: true } } },
  });
  if (!order?.customer?.phone) return;

  const templates: Partial<Record<OrderStatus, string>> = {
    PREPARING: settings.msgOrderPreparing,
    OUT_FOR_DELIVERY: settings.msgOrderOut,
    DELIVERED: settings.msgOrderDelivered,
    SETTLED: settings.msgOrderDelivered,
  };
  const template = templates[status];
  if (!template) return;

  const link =
    status === "DELIVERED" || status === "SETTLED"
      ? `${env.publicWebUrl}/cardapio/${order.tenant.slug}/avaliar/${order.id}`
      : "";
  const text = template.replace("{n}", String(order.number)).replace("{link}", link);
  await sender.sendText(order.customer.phone, text);
  const { recordOutboundMessage } = await import("../whatsapp/messages.service.js");
  await recordOutboundMessage(tenantId, order.customer.phone, text, { senderType: "SYSTEM" });
}

/**
 * Confirma por WhatsApp o pedido feito direto pelo cardápio digital — o cliente
 * não passou pelo bot, então essa é a única confirmação que ele recebe de que o
 * pedido caiu; as etapas seguintes (preparo, saída, entrega) já são cobertas
 * por notifyStatusChange, disparado a cada mudança de status.
 */
async function notifyOrderReceived(tenantId: string, orderId: string) {
  const { getWhatsAppSenderFor } = await import("../whatsapp/transport.js");
  const sender = await getWhatsAppSenderFor(tenantId);
  if (!sender) return;

  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.msgOrderReceived) return;

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
  if (!order?.customer?.phone) return;

  const text = settings.msgOrderReceived.replace("{n}", String(order.number));
  await sender.sendText(order.customer.phone, text);
  const { recordOutboundMessage } = await import("../whatsapp/messages.service.js");
  await recordOutboundMessage(tenantId, order.customer.phone, text, { senderType: "SYSTEM" });
}
