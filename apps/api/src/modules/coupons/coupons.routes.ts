import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";

export const couponsRoutes = Router();
couponsRoutes.use(requireAuth);

const couponSchema = z.object({
  code: z.string().min(2).transform((c) => c.toUpperCase().trim()),
  type: z.enum(["PERCENT", "FIXED", "FREE_SHIPPING"]),
  valueCents: z.number().int().min(0).optional(),
  valuePct: z.number().min(0).max(100).optional(),
  minOrderCents: z.number().int().min(0).optional(),
  maxUses: z.number().int().min(1).optional().nullable(),
  firstPurchaseOnly: z.boolean().optional(),
  birthdayOnly: z.boolean().optional(),
  active: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
});

couponsRoutes.get(
  "/",
  h(async (req, res) => {
    const coupons = await prisma.coupon.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { orders: true } } },
    });
    res.json(coupons);
  }),
);

couponsRoutes.post(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = couponSchema.parse(req.body);
    const exists = await prisma.coupon.findUnique({
      where: { tenantId_code: { tenantId, code: data.code } },
    });
    if (exists) throw new AppError(409, "Já existe um cupom com este código");
    const coupon = await prisma.coupon.create({
      data: {
        ...data,
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        tenantId,
      },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "CREATE",
      entity: "Coupon",
      entityId: coupon.id,
      detail: { code: coupon.code, type: coupon.type },
    });
    res.status(201).json(coupon);
  }),
);

couponsRoutes.put(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = couponSchema.partial().parse(req.body);
    const existing = await prisma.coupon.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Cupom não encontrado");
    const coupon = await prisma.coupon.update({
      where: { id: existing.id },
      data: { ...data, expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "Coupon",
      entityId: coupon.id,
      detail: data,
    });
    res.json(coupon);
  }),
);

couponsRoutes.delete(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const used = await prisma.order.count({
      where: { couponId: req.params.id, tenantId },
    });
    if (used > 0) {
      await prisma.coupon.updateMany({
        where: { id: req.params.id, tenantId },
        data: { active: false },
      });
      await audit({
        tenantId,
        userId: req.auth!.userId,
        action: "DELETE",
        entity: "Coupon",
        entityId: req.params.id,
        detail: { softDeleted: true },
      });
      return res.json({ ok: true, softDeleted: true });
    }
    const { count } = await prisma.coupon.deleteMany({
      where: { id: req.params.id, tenantId },
    });
    if (!count) throw new AppError(404, "Cupom não encontrado");
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "DELETE",
      entity: "Coupon",
      entityId: req.params.id,
    });
    res.status(204).end();
  }),
);
