import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const stockRoutes = Router();
stockRoutes.use(requireAuth);

const ingredientSchema = z.object({
  name: z.string().min(1),
  unit: z.enum(["un", "g", "kg", "ml", "l"]).optional(),
  stockQty: z.number().optional(),
  minStockQty: z.number().min(0).optional(),
  costCentsPerUnit: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

stockRoutes.get(
  "/ingredients",
  h(async (req, res) => {
    const ingredients = await prisma.ingredient.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { name: "asc" },
    });
    res.json(
      ingredients.map((i) => ({ ...i, lowStock: i.stockQty <= i.minStockQty })),
    );
  }),
);

stockRoutes.post(
  "/ingredients",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const data = ingredientSchema.parse(req.body);
    const ingredient = await prisma.ingredient.create({
      data: { ...data, tenantId: tenantOf(req) },
    });
    res.status(201).json(ingredient);
  }),
);

stockRoutes.put(
  "/ingredients/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const data = ingredientSchema.partial().parse(req.body);
    const { count } = await prisma.ingredient.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      data,
    });
    if (!count) throw new AppError(404, "Ingrediente não encontrado");
    res.json(await prisma.ingredient.findUnique({ where: { id: req.params.id } }));
  }),
);

/** Ajuste manual de estoque (entrada, saída ou correção). */
stockRoutes.post(
  "/ingredients/:id/adjust",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { quantity, reason } = z
      .object({ quantity: z.number(), reason: z.string().optional() })
      .parse(req.body);

    const ingredient = await prisma.ingredient.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!ingredient) throw new AppError(404, "Ingrediente não encontrado");

    const [updated] = await prisma.$transaction([
      prisma.ingredient.update({
        where: { id: ingredient.id },
        data: { stockQty: { increment: quantity } },
      }),
      prisma.stockMovement.create({
        data: {
          tenantId,
          ingredientId: ingredient.id,
          type: "ADJUST",
          quantity,
          reason: reason ?? "Ajuste manual",
        },
      }),
    ]);
    res.json(updated);
  }),
);

stockRoutes.get(
  "/movements",
  h(async (req, res) => {
    const movements = await prisma.stockMovement.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { ingredient: { select: { name: true, unit: true } } },
    });
    res.json(movements);
  }),
);

// ---------------- FORNECEDORES / COMPRAS ----------------

const supplierSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  cnpj: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

stockRoutes.get(
  "/suppliers",
  h(async (req, res) => {
    const suppliers = await prisma.supplier.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { name: "asc" },
      include: { _count: { select: { purchases: true } } },
    });
    res.json(suppliers);
  }),
);

stockRoutes.post(
  "/suppliers",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const data = supplierSchema.parse(req.body);
    const supplier = await prisma.supplier.create({
      data: { ...data, tenantId: tenantOf(req) },
    });
    res.status(201).json(supplier);
  }),
);

/** Registrar compra: dá entrada no estoque, atualiza custo e lança despesa no financeiro. */
stockRoutes.post(
  "/purchases",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = z
      .object({
        supplierId: z.string(),
        notes: z.string().optional(),
        items: z
          .array(
            z.object({
              ingredientId: z.string(),
              quantity: z.number().min(0.001),
              unitCostCents: z.number().int().min(0),
            }),
          )
          .min(1),
      })
      .parse(req.body);

    const supplier = await prisma.supplier.findFirst({
      where: { id: data.supplierId, tenantId },
    });
    if (!supplier) throw new AppError(400, "Fornecedor inválido");

    const totalCents = data.items.reduce(
      (sum, i) => sum + Math.round(i.quantity * i.unitCostCents),
      0,
    );

    const purchase = await prisma.$transaction(async (tx) => {
      const created = await tx.purchase.create({
        data: {
          tenantId,
          supplierId: supplier.id,
          totalCents,
          notes: data.notes,
          items: { create: data.items },
        },
        include: { items: { include: { ingredient: true } }, supplier: true },
      });

      for (const item of data.items) {
        await tx.ingredient.update({
          where: { id: item.ingredientId },
          data: {
            stockQty: { increment: item.quantity },
            costCentsPerUnit: item.unitCostCents,
          },
        });
        await tx.stockMovement.create({
          data: {
            tenantId,
            ingredientId: item.ingredientId,
            type: "IN",
            quantity: item.quantity,
            reason: `Compra — ${supplier.name}`,
            refPurchaseId: created.id,
          },
        });
      }

      await tx.financialEntry.create({
        data: {
          tenantId,
          type: "EXPENSE",
          category: "Insumos",
          description: `Compra — ${supplier.name}`,
          amountCents: totalCents,
          paidAt: new Date(),
        },
      });

      return created;
    });

    res.status(201).json(purchase);
  }),
);

stockRoutes.get(
  "/purchases",
  h(async (req, res) => {
    const purchases = await prisma.purchase.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { supplier: true, items: { include: { ingredient: true } } },
    });
    res.json(purchases);
  }),
);
