import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const categoriesRoutes = Router();
categoriesRoutes.use(requireAuth);

const categorySchema = z.object({
  name: z.string().min(1),
  icon: z.string().optional().nullable(),
  displayOrder: z.number().int().optional(),
  active: z.boolean().optional(),
});

categoriesRoutes.get(
  "/",
  h(async (req, res) => {
    const categories = await prisma.category.findMany({
      where: { tenantId: tenantOf(req) },
      orderBy: { displayOrder: "asc" },
      include: { _count: { select: { products: true } } },
    });
    res.json(categories);
  }),
);

categoriesRoutes.post(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const data = categorySchema.parse(req.body);
    const category = await prisma.category.create({
      data: { ...data, tenantId: tenantOf(req) },
    });
    res.status(201).json(category);
  }),
);

/** Reordena as categorias do cardápio (drag-and-drop no painel). */
categoriesRoutes.put(
  "/reorder",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { ids } = z.object({ ids: z.array(z.string()).min(1) }).parse(req.body);

    const count = await prisma.category.count({ where: { id: { in: ids }, tenantId } });
    if (count !== ids.length) throw new AppError(400, "Lista de categorias inválida");

    await prisma.$transaction(
      ids.map((id, index) =>
        prisma.category.update({ where: { id }, data: { displayOrder: index } }),
      ),
    );
    res.json({ ok: true });
  }),
);

categoriesRoutes.put(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const data = categorySchema.partial().parse(req.body);
    const { count } = await prisma.category.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      data,
    });
    if (!count) throw new AppError(404, "Categoria não encontrada");
    res.json(await prisma.category.findUnique({ where: { id: req.params.id } }));
  }),
);

categoriesRoutes.delete(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const productCount = await prisma.product.count({
      where: { categoryId: req.params.id, tenantId },
    });
    if (productCount > 0) {
      throw new AppError(409, "Categoria possui produtos. Mova-os antes de excluir.");
    }
    const { count } = await prisma.category.deleteMany({
      where: { id: req.params.id, tenantId },
    });
    if (!count) throw new AppError(404, "Categoria não encontrada");
    res.status(204).end();
  }),
);
