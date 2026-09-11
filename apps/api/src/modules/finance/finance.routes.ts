import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const financeRoutes = Router();
financeRoutes.use(requireAuth, requireRole("CASHIER"));

const entrySchema = z.object({
  type: z.enum(["INCOME", "EXPENSE"]),
  category: z.string().default("Outros"),
  description: z.string().min(1),
  amountCents: z.number().int().min(1),
  dueDate: z.string().datetime().optional().nullable(),
  paidAt: z.string().datetime().optional().nullable(),
});

financeRoutes.get(
  "/entries",
  h(async (req, res) => {
    const { from, to, type } = req.query as Record<string, string | undefined>;
    const entries = await prisma.financialEntry.findMany({
      where: {
        tenantId: tenantOf(req),
        ...(type ? { type } : {}),
        ...(from || to
          ? {
              createdAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 300,
    });
    res.json(entries);
  }),
);

financeRoutes.get(
  "/summary",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [income, expense, pendingReceivable, pendingPayable] = await Promise.all([
      prisma.financialEntry.aggregate({
        _sum: { amountCents: true },
        where: { tenantId, type: "INCOME", paidAt: { not: null }, createdAt: { gte: monthStart } },
      }),
      prisma.financialEntry.aggregate({
        _sum: { amountCents: true },
        where: { tenantId, type: "EXPENSE", paidAt: { not: null }, createdAt: { gte: monthStart } },
      }),
      prisma.financialEntry.aggregate({
        _sum: { amountCents: true },
        where: { tenantId, type: "INCOME", paidAt: null },
      }),
      prisma.financialEntry.aggregate({
        _sum: { amountCents: true },
        where: { tenantId, type: "EXPENSE", paidAt: null },
      }),
    ]);

    const incomeCents = income._sum.amountCents ?? 0;
    const expenseCents = expense._sum.amountCents ?? 0;
    res.json({
      monthIncomeCents: incomeCents,
      monthExpenseCents: expenseCents,
      monthProfitCents: incomeCents - expenseCents,
      receivableCents: pendingReceivable._sum.amountCents ?? 0,
      payableCents: pendingPayable._sum.amountCents ?? 0,
    });
  }),
);

financeRoutes.post(
  "/entries",
  h(async (req, res) => {
    const data = entrySchema.parse(req.body);
    const entry = await prisma.financialEntry.create({
      data: {
        ...data,
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        paidAt: data.paidAt ? new Date(data.paidAt) : null,
        tenantId: tenantOf(req),
      },
    });
    res.status(201).json(entry);
  }),
);

financeRoutes.patch(
  "/entries/:id/pay",
  h(async (req, res) => {
    const { count } = await prisma.financialEntry.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      data: { paidAt: new Date() },
    });
    if (!count) throw new AppError(404, "Lançamento não encontrado");
    res.json({ ok: true });
  }),
);

financeRoutes.delete(
  "/entries/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { count } = await prisma.financialEntry.deleteMany({
      where: { id: req.params.id, tenantId: tenantOf(req), refOrderId: null },
    });
    if (!count) throw new AppError(404, "Lançamento não encontrado ou vinculado a pedido");
    res.status(204).end();
  }),
);
