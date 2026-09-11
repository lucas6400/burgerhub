import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { distanceKm, geocodeAddress } from "./geocoding.js";
import { env } from "../../config/env.js";
import { audit } from "../../utils/audit.js";
import { computeEarn, validateRedeem } from "../loyalty/loyalty.service.js";
import { createDeliveryForOrder } from "../delivery/delivery.service.js";
import { getDeliveryProviderFor } from "../delivery/delivery-provider.js";

export const ORDER_STATUSES = [
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
}

/**
 * Calcula a taxa de entrega automaticamente pela distância até o estabelecimento
 * (geocodifica o endereço e casa com a faixa de km configurada). O cliente nunca
 * escolhe a taxa — ela é sempre derivada da localização real.
 */
export async function quoteDelivery(
  tenantId: string,
  address: Pick<DeliveryAddressInput, "street" | "number" | "neighborhood" | "city" | "lat" | "lng">,
  subtotalCents = 0,
): Promise<DeliveryQuote> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  const tiers = await prisma.deliveryRadiusTier.findMany({
    where: { tenantId, active: true },
    orderBy: { maxKm: "asc" },
  });
  if (settings?.storeLat == null || settings?.storeLng == null || tiers.length === 0) {
    throw new AppError(
      409,
      "A entrega ainda não está configurada. Entre em contato com o estabelecimento.",
    );
  }

  // Coordenadas vindas do mapa/GPS são mais confiáveis do que geocodificar o
  // texto — evita depender do serviço gratuito conseguir achar o endereço.
  let point =
    address.lat != null && address.lng != null ? { lat: address.lat, lng: address.lng } : null;
  if (!point) {
    const query = `${address.street}, ${address.number}, ${address.neighborhood}, ${address.city}, Brasil`;
    point = await geocodeAddress(query);
  }
  // Cidades com endereçamento por quadra (Palmas, Brasília etc.) não têm nome
  // de rua reconhecível pelo geocodificador gratuito — cai pro nível de bairro,
  // que é suficiente pra faixa de frete (calculada em km, não é preciso ao metro).
  if (!point && address.neighborhood && address.city) {
    point = await geocodeAddress(`${address.neighborhood}, ${address.city}, Brasil`);
  }
  if (!point) {
    throw new AppError(400, "Não conseguimos localizar esse endereço. Confira e tente novamente.");
  }

  const distance = distanceKm({ lat: settings.storeLat, lng: settings.storeLng }, point);
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

  return { feeCents, distanceKm: Math.round(distance * 10) / 10, etaMinutes: tier.etaMinutes, point };
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
  if (input.type === "DELIVERY") {
    if (!input.address) throw new AppError(400, "Endereço obrigatório para entrega");
    const quote = await quoteDelivery(tenantId, input.address, subtotalCents);
    deliveryFeeCents = quote.feeCents;
    deliveryDistanceKm = quote.distanceKm;
    deliveryLat = quote.point.lat;
    deliveryLng = quote.point.lng;
  }

  // ---- Cliente (encontra ou cria pelo telefone)
  let customerId = input.customerId ?? null;
  if (!customerId && input.customer) {
    const customer = await prisma.customer.upsert({
      where: { tenantId_phone: { tenantId, phone: input.customer.phone } },
      update: { name: input.customer.name, email: input.customer.email ?? undefined },
      create: { tenantId, ...input.customer },
    });
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
    if (customer && loyaltyProgram) {
      const earn = computeEarn(loyaltyProgram, subtotalCents);
      earnedPoints = earn.points;
      earnedCashbackCents = earn.cashbackCents;
    }
  } else if (input.redeemCashbackCents) {
    throw new AppError(400, "Identifique-se para resgatar cashback");
  }
  discountCents += redeemedCashbackCents;

  const totalCents = subtotalCents - discountCents + deliveryFeeCents;

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
        status: "NEW",
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
        items: { create: itemsData },
        statusEvents: { create: { toStatus: "NEW" } },
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
    if ((earnedPoints > 0 || earnedCashbackCents > 0) && customerId) {
      await tx.customer.update({
        where: { id: customerId },
        data: {
          loyaltyPoints: { increment: earnedPoints },
          cashbackCents: { increment: earnedCashbackCents },
        },
      });
      await tx.loyaltyTransaction.create({
        data: {
          customerId,
          type: "EARN",
          points: earnedPoints,
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
  const timestamps: Record<string, object> = {
    PREPARING: { confirmedAt: now },
    READY: { readyAt: now },
    OUT_FOR_DELIVERY: { dispatchedAt: now },
    DELIVERED: { deliveredAt: now, paymentStatus: "PAID" },
    SETTLED: { settledAt: now, paymentStatus: "PAID" },
    CANCELED: { canceledAt: now, cancelReason: params.cancelReason },
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
  void notifyStatusChange(tenantId, updated.id, toStatus).catch((err) =>
    console.error("Falha ao notificar WhatsApp:", err),
  );

  // Pedido de entrega pronto → avisa o provedor de logística (frota própria: no-op; iFood Entregas: solicita coleta)
  if (createdDeliveryId) {
    const deliveryId = createdDeliveryId;
    void getDeliveryProviderFor(tenantId)
      .then((provider) => provider.requestDelivery(deliveryId, tenantId))
      .catch((err) => console.error("Falha ao solicitar entrega ao provedor de logística:", err));
  }

  return updated;
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
}
