import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { geocodeAddress, reverseGeocode } from "../orders/geocoding.js";
import { audit } from "../../utils/audit.js";

export const settingsRoutes = Router();
settingsRoutes.use(requireAuth);

settingsRoutes.get(
  "/",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const [tenant, settings, hours, tiers] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: tenantId } }),
      prisma.tenantSettings.findUnique({ where: { tenantId } }),
      prisma.businessHour.findMany({ where: { tenantId }, orderBy: { weekday: "asc" } }),
      prisma.deliveryRadiusTier.findMany({ where: { tenantId }, orderBy: { maxKm: "asc" } }),
    ]);
    // Nunca devolve tokens/secrets nem o interruptor interno de split; só sinaliza se estão configurados
    const { mpAccessToken, mpRefreshToken, mpUserId, mpSplitEnabled, ifoodClientSecret, waCloudAccessToken, ...safeSettings } =
      settings ?? ({} as never);
    res.json({
      tenant,
      settings: settings
        ? { ...safeSettings, mpConfigured: !!mpAccessToken, ifoodConfigured: !!ifoodClientSecret }
        : null,
      businessHours: hours,
      deliveryRadiusTiers: tiers,
    });
  }),
);

/** Renomeia a hamburgueria — nome tem que ser único, igual ao slug. */
settingsRoutes.put(
  "/tenant-name",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { name } = z
      .object({ name: z.string().trim().min(2).max(100) })
      .parse(req.body);
    const tenantId = tenantOf(req);

    const existing = await prisma.tenant.findUnique({ where: { name } });
    if (existing && existing.id !== tenantId) {
      throw new AppError(409, "Já existe uma hamburgueria cadastrada com esse nome");
    }

    const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: { name } });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE_TENANT_NAME",
      entity: "Tenant",
      entityId: tenantId,
      detail: { name },
    });
    res.json({ id: tenant.id, slug: tenant.slug, name: tenant.name });
  }),
);

/** Muda o endereço (slug) do cardápio digital — link/QR code antigos param de funcionar. */
settingsRoutes.put(
  "/tenant-slug",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { slug } = z
      .object({
        slug: z
          .string()
          .trim()
          .min(3)
          .max(60)
          .regex(/^[a-z0-9-]+$/, "Use apenas letras minúsculas, números e hífens"),
      })
      .parse(req.body);
    const tenantId = tenantOf(req);

    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing && existing.id !== tenantId) {
      throw new AppError(409, "Esse endereço já está em uso por outra hamburgueria");
    }

    const tenant = await prisma.tenant.update({ where: { id: tenantId }, data: { slug } });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE_TENANT_SLUG",
      entity: "Tenant",
      entityId: tenantId,
      detail: { slug },
    });
    res.json({ id: tenant.id, slug: tenant.slug, name: tenant.name });
  }),
);

const settingsSchema = z.object({
  logoUrl: z.string().optional().nullable(),
  bannerUrl: z.string().optional().nullable(),
  primaryColor: z.string().optional(),
  address: z.string().optional().nullable(),
  instagram: z.string().optional().nullable(),
  facebook: z.string().optional().nullable(),
  pixKey: z.string().optional().nullable(),
  acceptsDelivery: z.boolean().optional(),
  acceptsPickup: z.boolean().optional(),
  acceptsDineIn: z.boolean().optional(),
  kdsEnabled: z.boolean().optional(),
  defaultPrepMinutes: z.number().int().min(0).optional(),
  minOrderCents: z.number().int().min(0).optional(),
  freeDeliveryAbove: z.number().int().min(0).optional().nullable(),
  storeLat: z.number().min(-90).max(90).optional().nullable(),
  storeLng: z.number().min(-180).max(180).optional().nullable(),
  maxDeliveryRadiusKm: z.number().min(0.5).max(100).optional(),
  isOpenOverride: z.boolean().optional().nullable(),
  closedMessage: z.string().optional(),
  paymentMethods: z.string().optional(),
  autoPrint: z.boolean().optional(),
  botEnabled: z.boolean().optional(),
  mpEnabled: z.boolean().optional(),
  mpAccessToken: z.string().optional().nullable(),
  mpPublicKey: z.string().optional().nullable(),
  ifoodEnabled: z.boolean().optional(),
  ifoodMerchantId: z.string().optional().nullable(),
  ifoodClientId: z.string().optional().nullable(),
  ifoodClientSecret: z.string().optional().nullable(),
  msgOrderReceived: z.string().optional(),
  msgOrderPreparing: z.string().optional(),
  msgOrderOut: z.string().optional(),
  msgOrderDelivered: z.string().optional(),
});

settingsRoutes.put(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = settingsSchema.parse(req.body);
    // String vazia = "não alterar o token" (o campo vem mascarado no painel)
    if (data.mpAccessToken === "") delete data.mpAccessToken;
    if (data.ifoodClientSecret === "") delete data.ifoodClientSecret;
    if (data.mpAccessToken !== undefined || data.mpEnabled !== undefined) {
      await audit({
        tenantId,
        userId: req.auth!.userId,
        action: "UPDATE_PAYMENT_SETTINGS",
        entity: "TenantSettings",
        detail: { mpEnabled: data.mpEnabled, tokenChanged: data.mpAccessToken !== undefined },
      });
    }
    if (data.ifoodClientSecret !== undefined || data.ifoodEnabled !== undefined) {
      await audit({
        tenantId,
        userId: req.auth!.userId,
        action: "UPDATE_IFOOD_SETTINGS",
        entity: "TenantSettings",
        detail: { ifoodEnabled: data.ifoodEnabled, credentialsChanged: data.ifoodClientSecret !== undefined },
      });
    }
    // Trocar o Access Token manualmente invalida o vínculo OAuth anterior —
    // senão o split de pagamento (application_fee) tentaria usar um token que
    // não é mais de marketplace, e o Mercado Pago passaria a rejeitar a cobrança.
    const updateData: typeof data & { mpRefreshToken?: null; mpUserId?: null } = { ...data };
    if (data.mpAccessToken !== undefined) {
      updateData.mpRefreshToken = null;
      updateData.mpUserId = null;
    }

    const settings = await prisma.tenantSettings.upsert({
      where: { tenantId },
      update: updateData,
      create: { ...updateData, tenantId },
    });
    // Nunca devolve tokens/secrets nem o interruptor interno de split, igual ao GET
    const { mpAccessToken, mpRefreshToken, mpUserId, mpSplitEnabled, ifoodClientSecret, waCloudAccessToken, ...safeSettings } =
      settings;
    res.json({ ...safeSettings, mpConfigured: !!mpAccessToken, ifoodConfigured: !!ifoodClientSecret });
  }),
);

settingsRoutes.put(
  "/business-hours",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const hours = z
      .array(
        z.object({
          weekday: z.number().int().min(0).max(6),
          openTime: z.string().regex(/^\d{2}:\d{2}$/),
          closeTime: z.string().regex(/^\d{2}:\d{2}$/),
          closed: z.boolean().optional(),
        }),
      )
      .parse(req.body);

    await prisma.$transaction([
      prisma.businessHour.deleteMany({ where: { tenantId } }),
      prisma.businessHour.createMany({
        data: hours.map((h) => ({ ...h, tenantId })),
      }),
    ]);
    res.json(await prisma.businessHour.findMany({ where: { tenantId }, orderBy: { weekday: "asc" } }));
  }),
);

/** Geocodifica um endereço em texto → coordenadas. Usado para localizar o estabelecimento. */
settingsRoutes.post(
  "/geocode",
  requireRole("MANAGER"),
  rateLimit(10, 60_000),
  h(async (req, res) => {
    const { address } = z.object({ address: z.string().min(5) }).parse(req.body);
    const point = await geocodeAddress(`${address}, Brasil`);
    if (!point) throw new AppError(404, "Endereço não encontrado. Tente ser mais específico.");
    res.json(point);
  }),
);

/**
 * Reverso de /geocode: usado quando o lojista define a localização pelo mapa
 * ou pelo GPS (em vez de digitar o endereço) — sem isso, o campo de endereço
 * fica vazio e o cardápio digital não tem o que mostrar pro cliente.
 */
settingsRoutes.post(
  "/reverse-geocode",
  requireRole("MANAGER"),
  rateLimit(10, 60_000),
  h(async (req, res) => {
    const { lat, lng } = z.object({ lat: z.number(), lng: z.number() }).parse(req.body);
    const result = await reverseGeocode({ lat, lng });
    if (!result) return res.json({ address: null });
    const composed = [
      [result.street, result.number].filter(Boolean).join(", "),
      result.neighborhood,
      result.city,
    ]
      .filter(Boolean)
      .join(" - ");
    res.json({ address: composed || null });
  }),
);

const tierSchema = z.object({
  maxKm: z.number().min(0.1).max(200),
  feeCents: z.number().int().min(0),
  etaMinutes: z.number().int().min(1).optional(),
  active: z.boolean().optional(),
});

settingsRoutes.post(
  "/delivery-radius",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = tierSchema.parse(req.body);
    const tier = await prisma.deliveryRadiusTier.create({
      data: { ...data, tenantId },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "CREATE",
      entity: "DeliveryRadiusTier",
      entityId: tier.id,
      detail: data,
    });
    res.status(201).json(tier);
  }),
);

settingsRoutes.put(
  "/delivery-radius/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = tierSchema.partial().parse(req.body);
    const { count } = await prisma.deliveryRadiusTier.updateMany({
      where: { id: req.params.id, tenantId },
      data,
    });
    if (!count) throw new AppError(404, "Faixa de entrega não encontrada");
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "DeliveryRadiusTier",
      entityId: req.params.id,
      detail: data,
    });
    res.json(await prisma.deliveryRadiusTier.findUnique({ where: { id: req.params.id } }));
  }),
);

settingsRoutes.delete(
  "/delivery-radius/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { count } = await prisma.deliveryRadiusTier.deleteMany({
      where: { id: req.params.id, tenantId },
    });
    if (!count) throw new AppError(404, "Faixa de entrega não encontrada");
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "DELETE",
      entity: "DeliveryRadiusTier",
      entityId: req.params.id,
    });
    res.status(204).end();
  }),
);

// ---------------- USUÁRIOS DA EQUIPE ----------------

const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6).optional(),
  role: z.enum(["ADMIN", "MANAGER", "CASHIER", "ATTENDANT", "DISPATCHER", "KITCHEN", "COURIER"]),
  active: z.boolean().optional(),
});

settingsRoutes.get(
  "/users",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const users = await prisma.user.findMany({
      where: { tenantId: tenantOf(req) },
      select: { id: true, name: true, email: true, role: true, active: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    res.json(users);
  }),
);

settingsRoutes.post(
  "/users",
  requireRole("ADMIN"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = userSchema.parse(req.body);
    if (!data.password) throw new AppError(400, "Senha obrigatória para novo usuário");

    const exists = await prisma.user.findUnique({
      where: { tenantId_email: { tenantId, email: data.email.toLowerCase() } },
    });
    if (exists) throw new AppError(409, "E-mail já cadastrado nesta equipe");

    const user = await prisma.user.create({
      data: {
        tenantId,
        name: data.name,
        email: data.email.toLowerCase(),
        role: data.role,
        passwordHash: await bcrypt.hash(data.password, 10),
      },
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "CREATE",
      entity: "User",
      entityId: user.id,
      detail: { name: user.name, email: user.email, role: user.role },
    });
    res.status(201).json(user);
  }),
);

settingsRoutes.put(
  "/users/:id",
  requireRole("ADMIN"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = userSchema.partial().parse(req.body);
    if (data.active === false && req.params.id === req.auth!.userId) {
      throw new AppError(400, "Você não pode desativar sua própria conta");
    }
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Usuário não encontrado");

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: data.name,
        role: data.role,
        active: data.active,
        ...(data.password ? { passwordHash: await bcrypt.hash(data.password, 10) } : {}),
      },
      select: { id: true, name: true, email: true, role: true, active: true },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "User",
      entityId: user.id,
      detail: { name: data.name, role: data.role, active: data.active, passwordChanged: !!data.password },
    });
    res.json(user);
  }),
);

settingsRoutes.delete(
  "/users/:id",
  requireRole("ADMIN"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    if (req.params.id === req.auth!.userId) {
      throw new AppError(400, "Você não pode remover sua própria conta");
    }
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Usuário não encontrado");

    // Preserva histórico: se já tem ações no log de auditoria, só desativa
    const hasHistory = await prisma.auditLog.count({ where: { userId: existing.id } });
    if (hasHistory > 0) {
      await prisma.user.updateMany({
        where: { id: existing.id, tenantId },
        data: { active: false },
      });
      await audit({
        tenantId,
        userId: req.auth!.userId,
        action: "DELETE",
        entity: "User",
        entityId: existing.id,
        detail: { softDeleted: true },
      });
      return res.json({ ok: true, softDeleted: true });
    }

    await prisma.user.delete({ where: { id: existing.id } });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "DELETE",
      entity: "User",
      entityId: existing.id,
    });
    res.status(204).end();
  }),
);

// ---------------- AUDITORIA ----------------

settingsRoutes.get(
  "/audit-log",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { limit, cursor } = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      })
      .parse(req.query);
    const take = limit ?? 50;

    const logs = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { user: { select: { name: true } } },
    });

    const hasMore = logs.length > take;
    const items = hasMore ? logs.slice(0, take) : logs;

    res.json({
      items: items.map((l) => ({
        id: l.id,
        action: l.action,
        entity: l.entity,
        entityId: l.entityId,
        detail: l.detail,
        createdAt: l.createdAt,
        userName: l.user?.name ?? "Sistema",
      })),
      nextCursor: hasMore ? items[items.length - 1].id : null,
    });
  }),
);
