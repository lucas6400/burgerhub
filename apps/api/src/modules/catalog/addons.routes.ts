import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const addonsRoutes = Router();
addonsRoutes.use(requireAuth);

const groupSchema = z.object({
  name: z.string().min(1),
  minSelect: z.number().int().min(0).optional(),
  maxSelect: z.number().int().min(1).optional(),
  required: z.boolean().optional(),
  addons: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1),
        priceCents: z.number().int().min(0),
        imageUrl: z.string().optional().nullable(),
        maxQty: z.number().int().min(1).optional(),
        available: z.boolean().optional(),
      }),
    )
    .optional(),
});

addonsRoutes.get(
  "/",
  h(async (req, res) => {
    const groups = await prisma.addonGroup.findMany({
      where: { tenantId: tenantOf(req) },
      include: { addons: true, _count: { select: { products: true } } },
    });
    res.json(groups);
  }),
);

addonsRoutes.post(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { addons, ...data } = groupSchema.parse(req.body);
    const group = await prisma.addonGroup.create({
      data: {
        ...data,
        tenantId: tenantOf(req),
        addons: addons ? { create: addons.map(({ id, ...a }) => a) } : undefined,
      },
      include: { addons: true },
    });
    res.status(201).json(group);
  }),
);

addonsRoutes.put(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { addons, ...data } = groupSchema.partial().parse(req.body);

    const existing = await prisma.addonGroup.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Grupo não encontrado");

    const group = await prisma.addonGroup.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(addons
          ? {
              addons: {
                deleteMany: { id: { notIn: addons.filter((a) => a.id).map((a) => a.id!) } },
                upsert: addons.map(({ id, ...a }) => ({
                  where: { id: id ?? "novo" },
                  update: a,
                  create: a,
                })),
              },
            }
          : {}),
      },
      include: { addons: true },
    });
    res.json(group);
  }),
);

addonsRoutes.delete(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { count } = await prisma.addonGroup.deleteMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
    });
    if (!count) throw new AppError(404, "Grupo não encontrado");
    res.status(204).end();
  }),
);
