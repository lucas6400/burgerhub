import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";
import { DRIVER_STATUSES, VEHICLE_TYPES, recordDriverLocation, setDriverStatus } from "./driver.service.js";

export const driversRoutes = Router();
driversRoutes.use(requireAuth);

const driverSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  document: z.string().optional().nullable(),
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
  vehiclePlate: z.string().optional().nullable(),
  maxSimultaneousOrders: z.number().int().min(1).max(10).optional(),
  active: z.boolean().optional(),
});

driversRoutes.get(
  "/",
  h(async (req, res) => {
    const drivers = await prisma.driver.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { deliveries: { where: { status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } } } } } },
    });
    res.json(
      drivers.map((d) => ({
        ...d,
        currentOrdersCount: d._count.deliveries,
        hasAccess: !!d.userId,
        _count: undefined,
      })),
    );
  }),
);

driversRoutes.post(
  "/",
  requireRole("DISPATCHER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { email, password, ...data } = driverSchema
      .extend({ email: z.string().email().optional(), password: z.string().min(6).optional() })
      .parse(req.body);

    let userId: string | undefined;
    if (email && password) {
      const exists = await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email: email.toLowerCase() } } });
      if (exists) throw new AppError(409, "E-mail já cadastrado nesta equipe");
      const user = await prisma.user.create({
        data: { tenantId, name: data.name, email: email.toLowerCase(), role: "COURIER", passwordHash: await bcrypt.hash(password, 10) },
      });
      userId = user.id;
    }

    const driver = await prisma.driver.create({ data: { ...data, tenantId, userId } });
    await audit({ tenantId, userId: req.auth!.userId, action: "CREATE", entity: "Driver", entityId: driver.id });
    res.status(201).json({ ...driver, hasAccess: !!driver.userId });
  }),
);

/** Cria login (usuário COURIER) pra um entregador já cadastrado sem acesso ao app. */
driversRoutes.post(
  "/:id/create-access",
  requireRole("DISPATCHER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(6) }).parse(req.body);
    const driver = await prisma.driver.findFirst({ where: { id: req.params.id, tenantId } });
    if (!driver) throw new AppError(404, "Entregador não encontrado");
    if (driver.userId) throw new AppError(409, "Esse entregador já tem acesso ao app");

    const exists = await prisma.user.findUnique({ where: { tenantId_email: { tenantId, email: email.toLowerCase() } } });
    if (exists) throw new AppError(409, "E-mail já cadastrado nesta equipe");

    const user = await prisma.user.create({
      data: { tenantId, name: driver.name, email: email.toLowerCase(), role: "COURIER", passwordHash: await bcrypt.hash(password, 10) },
    });
    await prisma.driver.update({ where: { id: driver.id }, data: { userId: user.id } });
    await audit({ tenantId, userId: req.auth!.userId, action: "CREATE_ACCESS", entity: "Driver", entityId: driver.id });
    res.json({ ok: true });
  }),
);

driversRoutes.put(
  "/:id",
  requireRole("DISPATCHER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = driverSchema.partial().parse(req.body);
    const { count } = await prisma.driver.updateMany({
      where: { id: req.params.id, tenantId },
      data,
    });
    if (!count) throw new AppError(404, "Entregador não encontrado");
    res.json(await prisma.driver.findUnique({ where: { id: req.params.id } }));
  }),
);

driversRoutes.patch(
  "/:id/status",
  requireRole("DISPATCHER"),
  h(async (req, res) => {
    const { status } = z.object({ status: z.enum(DRIVER_STATUSES) }).parse(req.body);
    await setDriverStatus(tenantOf(req), req.params.id, status);
    res.json({ ok: true });
  }),
);

/** Atualização periódica de localização — usada pelo entregador (Fase 4/PWA) ou testes manuais. */
driversRoutes.post(
  "/:id/location",
  h(async (req, res) => {
    const data = z
      .object({
        lat: z.number(),
        lng: z.number(),
        speed: z.number().optional(),
        heading: z.number().optional(),
        accuracy: z.number().optional(),
      })
      .parse(req.body);
    await recordDriverLocation(tenantOf(req), req.params.id, data);
    res.json({ ok: true });
  }),
);

driversRoutes.delete(
  "/:id",
  requireRole("DISPATCHER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const activeCount = await prisma.delivery.count({
      where: { driverId: req.params.id, status: { notIn: ["DELIVERED", "FAILED", "CANCELED"] } },
    });
    if (activeCount > 0) {
      throw new AppError(409, "Entregador tem entregas em andamento — finalize antes de remover");
    }
    const { count } = await prisma.driver.updateMany({
      where: { id: req.params.id, tenantId },
      data: { active: false, status: "OFFLINE" },
    });
    if (!count) throw new AppError(404, "Entregador não encontrado");
    res.json({ ok: true, softDeleted: true });
  }),
);
