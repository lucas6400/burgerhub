import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";

export const productsRoutes = Router();
productsRoutes.use(requireAuth);

const productSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  priceCents: z.number().int().min(0),
  promoPriceCents: z.number().int().min(0).optional().nullable(),
  imageUrl: z.string().optional().nullable(),
  categoryId: z.string(),
  available: z.boolean().optional(),
  showInKds: z.boolean().optional(),
  prepMinutes: z.number().int().min(0).optional(),
  weightGrams: z.number().int().min(0).optional().nullable(),
  sku: z.string().optional().nullable(),
  internalCode: z.string().optional().nullable(),
  displayOrder: z.number().int().optional(),
  featured: z.boolean().optional(),
  // receita: consumo de ingredientes (estoque)
  ingredients: z
    .array(
      z.object({
        ingredientId: z.string(),
        quantity: z.number().min(0),
        removable: z.boolean().optional(),
      }),
    )
    .optional(),
  addonGroupIds: z.array(z.string()).optional(),
});

/** Gera o próximo código curto sequencial do tenant (para lançamento rápido no PDV). */
async function nextInternalCode(tenantId: string): Promise<string> {
  const existing = await prisma.product.findMany({
    where: { tenantId, internalCode: { not: null } },
    select: { internalCode: true },
  });
  const max = existing.reduce((m, p) => {
    const n = parseInt(p.internalCode ?? "", 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return String(max + 1);
}

async function assertCodeAvailable(tenantId: string, code: string, ignoreProductId?: string) {
  const clash = await prisma.product.findFirst({
    where: { tenantId, internalCode: code, ...(ignoreProductId ? { id: { not: ignoreProductId } } : {}) },
  });
  if (clash) throw new AppError(409, `Código ${code} já usado por "${clash.name}"`);
}

const fullInclude = {
  category: true,
  ingredients: { include: { ingredient: true } },
  addonGroups: { include: { group: { include: { addons: true } } } },
} as const;

productsRoutes.get(
  "/",
  h(async (req, res) => {
    const products = await prisma.product.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { priceCents: "asc" }],
      include: fullInclude,
    });
    res.json(products);
  }),
);

productsRoutes.get(
  "/:id",
  h(async (req, res) => {
    const product = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: fullInclude,
    });
    if (!product) throw new AppError(404, "Produto não encontrado");
    res.json(product);
  }),
);

productsRoutes.post(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { ingredients, addonGroupIds, ...data } = productSchema.parse(req.body);

    const category = await prisma.category.findFirst({
      where: { id: data.categoryId, tenantId },
    });
    if (!category) throw new AppError(400, "Categoria inválida");

    const internalCode = data.internalCode?.trim() || (await nextInternalCode(tenantId));
    await assertCodeAvailable(tenantId, internalCode);

    // Sem posição explícita: entra ordenado pelo preço (mais barato primeiro)
    // em relação aos produtos que já existem na categoria, sem mexer na ordem
    // manual que o lojista já tiver dado aos outros itens.
    let displayOrder = data.displayOrder;
    if (displayOrder === undefined) {
      const siblings = await prisma.product.findMany({
        where: { tenantId, categoryId: data.categoryId },
        select: { id: true, priceCents: true, displayOrder: true },
        orderBy: { displayOrder: "asc" },
      });
      const insertAt = siblings.findIndex((p) => p.priceCents > data.priceCents);
      displayOrder = insertAt === -1 ? siblings.length : insertAt;
      const toShift = insertAt === -1 ? [] : siblings.slice(insertAt);
      if (toShift.length > 0) {
        await prisma.$transaction(
          toShift.map((p, i) =>
            prisma.product.update({ where: { id: p.id }, data: { displayOrder: displayOrder! + i + 1 } }),
          ),
        );
      }
    }

    const product = await prisma.product.create({
      data: {
        ...data,
        displayOrder,
        internalCode,
        tenantId,
        ingredients: ingredients
          ? { create: ingredients.map((i) => ({ ...i, removable: i.removable ?? true })) }
          : undefined,
        addonGroups: addonGroupIds
          ? { create: addonGroupIds.map((groupId) => ({ groupId })) }
          : undefined,
      },
      include: fullInclude,
    });
    await audit({ tenantId, userId: req.auth!.userId, action: "CREATE", entity: "Product", entityId: product.id });
    res.status(201).json(product);
  }),
);

/** Reordena os produtos de uma categoria (drag-and-drop no painel). */
productsRoutes.put(
  "/reorder",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { categoryId, ids } = z
      .object({ categoryId: z.string(), ids: z.array(z.string()).min(1) })
      .parse(req.body);

    const count = await prisma.product.count({
      where: { id: { in: ids }, tenantId, categoryId },
    });
    if (count !== ids.length) throw new AppError(400, "Lista de produtos inválida para essa categoria");

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.product.update({ where: { id }, data: { displayOrder: index } }),
      ),
    );
    res.json({ ok: true });
  }),
);

productsRoutes.put(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { ingredients, addonGroupIds, ...data } = productSchema.partial().parse(req.body);

    const existing = await prisma.product.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Produto não encontrado");

    if (data.internalCode?.trim()) {
      await assertCodeAvailable(tenantId, data.internalCode.trim(), existing.id);
    }

    const product = await prisma.product.update({
      where: { id: existing.id },
      data: {
        ...data,
        ...(ingredients
          ? {
              ingredients: {
                deleteMany: {},
                create: ingredients.map((i) => ({ ...i, removable: i.removable ?? true })),
              },
            }
          : {}),
        ...(addonGroupIds
          ? {
              addonGroups: {
                deleteMany: {},
                create: addonGroupIds.map((groupId) => ({ groupId })),
              },
            }
          : {}),
      },
      include: fullInclude,
    });
    await audit({ tenantId, userId: req.auth!.userId, action: "UPDATE", entity: "Product", entityId: product.id });
    res.json(product);
  }),
);

/** Alternar disponibilidade rapidamente (esgotado / disponível). */
productsRoutes.patch(
  "/:id/availability",
  h(async (req, res) => {
    const { available } = z.object({ available: z.boolean() }).parse(req.body);
    const { count } = await prisma.product.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      data: { available },
    });
    if (!count) throw new AppError(404, "Produto não encontrado");
    res.json({ ok: true });
  }),
);

/** Marca/desmarca como "favorito da casa" — só um produto por tenant pode ser o favorito. */
productsRoutes.patch(
  "/:id/favorite",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body);

    const existing = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new AppError(404, "Produto não encontrado");

    await prisma.$transaction([
      ...(favorite
        ? [prisma.product.updateMany({ where: { tenantId, favorite: true }, data: { favorite: false } })]
        : []),
      prisma.product.update({ where: { id: existing.id }, data: { favorite } }),
    ]);
    res.json({ ok: true });
  }),
);

productsRoutes.delete(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const orderCount = await prisma.orderItem.count({
      where: { productId: req.params.id, order: { tenantId } },
    });
    if (orderCount > 0) {
      // Preserva histórico: apenas desativa
      await prisma.product.updateMany({
        where: { id: req.params.id, tenantId },
        data: { available: false },
      });
      return res.json({ ok: true, softDeleted: true });
    }
    const { count } = await prisma.product.deleteMany({
      where: { id: req.params.id, tenantId },
    });
    if (!count) throw new AppError(404, "Produto não encontrado");
    res.status(204).end();
  }),
);
