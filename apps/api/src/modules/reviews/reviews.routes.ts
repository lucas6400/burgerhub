import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";

export const reviewsRoutes = Router();
reviewsRoutes.use(requireAuth);

/** Resumo das avaliações dos clientes: nota média, NPS médio e comentários recentes. */
reviewsRoutes.get(
  "/",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).optional() })
      .parse(req.query);

    const [aggregate, recent] = await Promise.all([
      prisma.review.aggregate({
        where: { tenantId },
        _avg: { rating: true, npsScore: true },
        _count: true,
      }),
      prisma.review.findMany({
        where: { tenantId },
        orderBy: { createdAt: "desc" },
        take: limit ?? 20,
        include: { order: { select: { number: true, customer: { select: { name: true } } } } },
      }),
    ]);

    res.json({
      avgRating: aggregate._avg.rating,
      avgNpsScore: aggregate._avg.npsScore,
      totalReviews: aggregate._count,
      recent: recent.map((r) => ({
        id: r.id,
        rating: r.rating,
        npsScore: r.npsScore,
        comment: r.comment,
        createdAt: r.createdAt,
        orderNumber: r.order.number,
        customerName: r.order.customer?.name ?? null,
      })),
    });
  }),
);
