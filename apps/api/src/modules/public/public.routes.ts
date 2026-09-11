import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { AppError } from "../../middlewares/error.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { createOrder, quoteDelivery, validateCoupon } from "../orders/orders.service.js";
import { reverseGeocode } from "../orders/geocoding.js";
import {
  createDeliveryMessage,
  findDeliveryByOrder,
  getDeliveryTracking,
  listDeliveryMessages,
} from "../delivery/delivery.service.js";
import {
  cardCheckoutAvailable,
  onlinePaymentsAvailable,
  refreshPaymentStatus,
  startPayment,
} from "../payments/payments.service.js";

/**
 * Rotas PÚBLICAS do Cardápio Digital (sem autenticação).
 * Escopadas por slug do tenant — nunca expõem dados de outros estabelecimentos.
 */
export const publicRoutes = Router();

async function tenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    include: { settings: true, businessHours: true },
  });
  if (!tenant || !tenant.active) throw new AppError(404, "Estabelecimento não encontrado");
  return tenant;
}

function isOpenNow(tenant: Awaited<ReturnType<typeof tenantBySlug>>) {
  if (tenant.settings?.isOpenOverride != null) return tenant.settings.isOpenOverride;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return tenant.businessHours.some(
    (h) => h.weekday === now.getDay() && !h.closed && h.openTime <= hhmm && hhmm <= h.closeTime,
  );
}

/** Cardápio completo do estabelecimento. */
publicRoutes.get(
  "/:slug/menu",
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);

    const categories = await prisma.category.findMany({
      where: { tenantId: tenant.id, active: true },
      orderBy: { displayOrder: "asc" },
      include: {
        products: {
          orderBy: [{ displayOrder: "asc" }, { priceCents: "asc" }],
          include: {
            ingredients: {
              include: { ingredient: { select: { name: true } } },
            },
            addonGroups: {
              include: {
                group: { include: { addons: { where: { available: true } } } },
              },
            },
          },
        },
      },
    });

    const combos = await prisma.combo.findMany({
      where: { tenantId: tenant.id, active: true },
      include: { items: { include: { product: true } }, baseProduct: true },
    });

    const featuredProducts = await prisma.product.findMany({
      where: { tenantId: tenant.id, available: true, featured: true },
      orderBy: [{ favorite: "desc" }, { displayOrder: "asc" }],
      take: 12,
      include: {
        ingredients: { include: { ingredient: { select: { name: true } } } },
        addonGroups: { include: { group: { include: { addons: { where: { available: true } } } } } },
      },
    });

    res.json({
      tenant: {
        name: tenant.name,
        slug: tenant.slug,
        phone: tenant.phone,
        logoUrl: tenant.settings?.logoUrl,
        bannerUrl: tenant.settings?.bannerUrl,
        primaryColor: tenant.settings?.primaryColor,
        address: tenant.settings?.address,
        storeLat: tenant.settings?.storeLat ?? null,
        storeLng: tenant.settings?.storeLng ?? null,
        instagram: tenant.settings?.instagram,
        minOrderCents: tenant.settings?.minOrderCents ?? 0,
        freeDeliveryAbove: tenant.settings?.freeDeliveryAbove,
        paymentMethods: tenant.settings?.paymentMethods?.split(",") ?? [],
        onlinePayments: onlinePaymentsAvailable(tenant.settings),
        mpPublicKey: tenant.settings?.mpPublicKey ?? null,
        cardCheckoutAvailable: cardCheckoutAvailable(tenant.settings),
        acceptsDelivery: tenant.settings?.acceptsDelivery ?? true,
        acceptsPickup: tenant.settings?.acceptsPickup ?? true,
        prepMinutes: tenant.settings?.defaultPrepMinutes ?? 30,
        isOpen: isOpenNow(tenant),
        closedMessage: tenant.settings?.closedMessage,
        businessHours: tenant.businessHours,
      },
      categories,
      combos,
      featuredProducts,
    });
  }),
);

/**
 * Cotação automática de frete (distância até o estabelecimento) — sem o cliente
 * escolher. Aceita endereço em texto OU coordenadas (mapa/GPS); com coordenadas,
 * pula a geocodificação por texto e devolve um endereço sugerido (geocodificação
 * reversa) para preencher os campos automaticamente.
 */
const quoteDeliverySchema = z
  .object({
    street: z.string().optional(),
    number: z.string().optional(),
    neighborhood: z.string().optional(),
    city: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    subtotalCents: z.number().int().min(0).default(0),
  })
  .refine(
    (d) => (d.lat != null && d.lng != null) || (d.street && d.number && d.neighborhood && d.city),
    { message: "Informe o endereço completo ou uma localização no mapa" },
  );

publicRoutes.post(
  "/:slug/quote-delivery",
  rateLimit(60, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const data = quoteDeliverySchema.parse(req.body);
    const usingCoords = data.lat != null && data.lng != null;

    const quote = await quoteDelivery(
      tenant.id,
      {
        street: data.street ?? "",
        number: data.number ?? "",
        neighborhood: data.neighborhood ?? "",
        city: data.city ?? "",
        lat: data.lat,
        lng: data.lng,
      },
      data.subtotalCents,
    );

    const suggestedAddress = usingCoords
      ? await reverseGeocode({ lat: data.lat!, lng: data.lng! }).catch(() => null)
      : null;

    res.json({ ...quote, suggestedAddress });
  }),
);

/** Validação de cupom no carrinho. */
publicRoutes.post(
  "/:slug/validate-coupon",
  rateLimit(30, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const { code, subtotalCents } = z
      .object({ code: z.string(), subtotalCents: z.number().int().min(0) })
      .parse(req.body);
    const coupon = await validateCoupon(tenant.id, code, subtotalCents);
    res.json({
      code: coupon.code,
      type: coupon.type,
      valueCents: coupon.valueCents,
      valuePct: coupon.valuePct,
    });
  }),
);

/** Saldo de fidelidade do cliente (pelo telefone) — só quando o programa está ativo. */
publicRoutes.get(
  "/:slug/loyalty/:phone",
  rateLimit(60, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const program = await prisma.loyaltyProgram.findUnique({ where: { tenantId: tenant.id } });
    if (!program?.active) {
      return res.json({ active: false, points: 0, cashbackCents: 0 });
    }
    const customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId: tenant.id, phone: req.params.phone } },
      select: { loyaltyPoints: true, cashbackCents: true },
    });
    res.json({
      active: true,
      points: customer?.loyaltyPoints ?? 0,
      cashbackCents: customer?.cashbackCents ?? 0,
    });
  }),
);

/** Resolve uma mesa pelo número (pra pré-selecionar no cardápio via QR Code). */
publicRoutes.get(
  "/:slug/tables/:number",
  rateLimit(60, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const number = Number(req.params.number);
    if (!Number.isInteger(number)) throw new AppError(400, "Número de mesa inválido");
    const table = await prisma.table.findUnique({
      where: { tenantId_number: { tenantId: tenant.id, number } },
      select: { id: true, number: true, seats: true, status: true },
    });
    if (!table) throw new AppError(404, "Mesa não encontrada");
    res.json(table);
  }),
);

/** Criação de pedido pelo cardápio digital. */
publicRoutes.post(
  "/:slug/orders",
  rateLimit(15, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    if (!isOpenNow(tenant)) {
      throw new AppError(
        409,
        tenant.settings?.closedMessage ?? "Estamos fechados no momento.",
      );
    }

    const schema = z.object({
      type: z.enum(["DELIVERY", "PICKUP", "DINE_IN"]),
      tableNumber: z.number().int().optional(),
      paymentMethod: z.enum(["PIX", "CASH", "CREDIT", "DEBIT", "VR", "VA", "ONLINE"]),
      changeForCents: z.number().int().optional(),
      notes: z.string().max(500).optional(),
      couponCode: z.string().optional(),
      redeemCashbackCents: z.number().int().min(0).optional(),
      customer: z.object({
        name: z.string().min(2),
        phone: z.string().min(8),
        email: z.string().email().optional(),
      }),
      address: z
        .object({
          label: z.string().optional(),
          street: z.string().min(1),
          number: z.string().min(1),
          neighborhood: z.string().min(1),
          city: z.string().min(1),
          complement: z.string().optional(),
          reference: z.string().optional(),
          lat: z.number().optional(),
          lng: z.number().optional(),
        })
        .optional(),
      items: z
        .array(
          z.object({
            productId: z.string(),
            quantity: z.number().int().min(1).max(50),
            notes: z.string().max(300).optional(),
            addonIds: z
              .array(z.object({ addonId: z.string(), quantity: z.number().int().min(1) }))
              .optional(),
            removedIngredientIds: z.array(z.string()).optional(),
          }),
        )
        .min(1),
    });
    const data = schema.parse(req.body);

    if (data.type === "DELIVERY" && !data.address) {
      throw new AppError(400, "Endereço obrigatório para entrega");
    }

    // tableId nunca vem do cliente — resolvido aqui pelo número + tenant, evita
    // que um cliente aponte pra mesa de outro estabelecimento.
    let tableId: string | undefined;
    if (data.type === "DINE_IN") {
      if (data.tableNumber == null) throw new AppError(400, "Número da mesa obrigatório");
      const table = await prisma.table.findUnique({
        where: { tenantId_number: { tenantId: tenant.id, number: data.tableNumber } },
      });
      if (!table || table.status !== "OPEN") {
        throw new AppError(409, "Mesa fechada — chame o garçom para abrir a mesa");
      }
      tableId = table.id;
    }

    const { tableNumber: _tableNumber, ...orderInput } = data;
    const order = await createOrder({ ...orderInput, tenantId: tenant.id, source: tableId ? "TABLE" : "MENU", tableId });
    res.status(201).json({
      orderId: order.id,
      number: order.number,
      totalCents: order.totalCents,
      status: order.status,
      earnedPoints: order.earnedPoints,
      earnedCashbackCents: order.earnedCashbackCents,
    });
  }),
);

/** Acompanhamento público do pedido. */
publicRoutes.get(
  "/:slug/orders/:orderId",
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: tenant.id },
      select: {
        id: true,
        number: true,
        status: true,
        type: true,
        totalCents: true,
        paymentStatus: true,
        paymentMethod: true,
        createdAt: true,
        items: { select: { nameSnapshot: true, quantity: true } },
      },
    });
    if (!order) throw new AppError(404, "Pedido não encontrado");
    res.json(order);
  }),
);

/** Inicia pagamento online (Pix transparente ou checkout de cartão). */
publicRoutes.post(
  "/:slug/orders/:orderId/pay",
  rateLimit(20, 60_000),
  // Teto por pedido (não só por IP) — evita usar um único pedido barato como
  // oráculo para testar vários cartões (carding) via proxies/IPs diferentes.
  rateLimit(5, 10 * 60_000, (req) => req.params.orderId),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const body = z
      .object({
        method: z.enum(["PIX", "CARD"]),
        // Enviados pelo Payment Brick (checkout de cartão embutido) — o token
        // já é o cartão tokenizado no navegador do cliente, nunca o cartão em si.
        token: z.string().max(200).optional(),
        installments: z.number().int().min(1).max(24).optional(),
        paymentMethodId: z.string().max(50).optional(),
        payerDocType: z.enum(["CPF", "CNPJ"]).optional(),
        payerDocNumber: z
          .string()
          .regex(/^\d{11}$|^\d{14}$/, "CPF/CNPJ inválido")
          .optional(),
      })
      .parse(req.body);

    if (body.method === "CARD" && (!body.token || !body.installments || !body.paymentMethodId)) {
      throw new AppError(400, "Dados do cartão incompletos");
    }

    const payment = await startPayment({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      orderId: req.params.orderId,
      method: body.method,
      card:
        body.method === "CARD"
          ? {
              token: body.token!,
              installments: body.installments!,
              paymentMethodId: body.paymentMethodId!,
              payerDocType: body.payerDocType,
              payerDocNumber: body.payerDocNumber,
            }
          : undefined,
    });
    res.status(201).json({
      method: payment.method,
      status: payment.status,
      pixQrCode: payment.pixQrCode,
      pixQrBase64: payment.pixQrBase64,
    });
  }),
);

/** Polling do status do pagamento (sincroniza com o Mercado Pago). */
publicRoutes.get(
  "/:slug/orders/:orderId/payment",
  rateLimit(120, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const payment = await refreshPaymentStatus(tenant.id, req.params.orderId);
    res.json({ method: payment.method, status: payment.status, paidAt: payment.paidAt });
  }),
);

/** Acompanhamento do pedido (status, entregador, mapa) — tela "tipo iFood" do cardápio digital. */
publicRoutes.get(
  "/:slug/orders/:orderId/tracking",
  rateLimit(180, 60_000), // + folga: agora convive com o poller do chat no mesmo IP
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: tenant.id },
      select: { number: true, totalCents: true, type: true, status: true },
    });
    if (!order) throw new AppError(404, "Pedido não encontrado");
    const tracking = await getDeliveryTracking(tenant.id, req.params.orderId);
    res.json({
      tenant: {
        name: tenant.name,
        logoUrl: tenant.settings?.logoUrl ?? null,
        address: tenant.settings?.address ?? null,
        storeLat: tenant.settings?.storeLat ?? null,
        storeLng: tenant.settings?.storeLng ?? null,
      },
      order,
      ...tracking,
    });
  }),
);

/** Chat da entrega — cliente consulta as mensagens trocadas com o entregador. */
publicRoutes.get(
  "/:slug/orders/:orderId/messages",
  rateLimit(180, 60_000), // + folga: agora convive com o poller de tracking no mesmo IP
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const delivery = await findDeliveryByOrder(tenant.id, req.params.orderId);
    if (!delivery) throw new AppError(404, "Entrega não encontrada para este pedido");
    const messages = await listDeliveryMessages(tenant.id, delivery.id);
    res.json(messages);
  }),
);

/** Chat da entrega — cliente envia mensagem pro entregador. */
publicRoutes.post(
  "/:slug/orders/:orderId/messages",
  rateLimit(30, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const { body } = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body);
    const delivery = await findDeliveryByOrder(tenant.id, req.params.orderId);
    if (!delivery) throw new AppError(404, "Entrega não encontrada para este pedido");
    const message = await createDeliveryMessage({ tenantId: tenant.id, deliveryId: delivery.id, sender: "CUSTOMER", body });
    res.status(201).json(message);
  }),
);

/** Consulta a avaliação (se já existir) antes de mostrar o formulário. */
publicRoutes.get(
  "/:slug/orders/:orderId/review",
  rateLimit(30, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: tenant.id },
      select: { number: true, totalCents: true, status: true },
    });
    if (!order) throw new AppError(404, "Pedido não encontrado");

    const review = await prisma.review.findUnique({
      where: { orderId: req.params.orderId },
      select: { rating: true, npsScore: true, comment: true, createdAt: true },
    });

    res.json({
      tenant: { name: tenant.name, logoUrl: tenant.settings?.logoUrl ?? null },
      order,
      review,
    });
  }),
);

/** Avaliação pós-entrega. */
publicRoutes.post(
  "/:slug/orders/:orderId/review",
  rateLimit(10, 60_000),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const { rating, npsScore, comment } = z
      .object({
        rating: z.number().int().min(1).max(5),
        npsScore: z.number().int().min(0).max(10).optional(),
        comment: z.string().max(1000).optional(),
      })
      .parse(req.body);

    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: tenant.id, status: { in: ["DELIVERED", "SETTLED"] } },
    });
    if (!order) throw new AppError(404, "Pedido não encontrado ou ainda não entregue");

    const review = await prisma.review.upsert({
      where: { orderId: order.id },
      update: { rating, npsScore, comment },
      create: { tenantId: tenant.id, orderId: order.id, rating, npsScore, comment },
    });
    res.status(201).json(review);
  }),
);
