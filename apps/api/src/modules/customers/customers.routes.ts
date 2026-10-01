import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";

export const customersRoutes = Router();
customersRoutes.use(requireAuth);

const customerSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(8),
  email: z.string().email().optional().nullable(),
  cpf: z.string().optional().nullable(),
  birthDate: z.string().datetime().optional().nullable(),
  notes: z.string().optional().nullable(),
  tier: z.enum(["BRONZE", "PRATA", "OURO", "VIP"]).optional(),
});

/** Classificação automática por valor gasto (fallback quando não definida manualmente). */
export function tierFromSpend(totalSpentCents: number): string {
  if (totalSpentCents >= 100_000) return "VIP"; // R$ 1.000+
  if (totalSpentCents >= 50_000) return "OURO";
  if (totalSpentCents >= 20_000) return "PRATA";
  return "BRONZE";
}

customersRoutes.get(
  "/",
  h(async (req, res) => {
    const { search } = req.query as Record<string, string | undefined>;
    const tenantId = tenantOf(req);

    const customers = await prisma.customer.findMany({
      where: {
        tenantId,
        ...(search
          ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] }
          : {}),
      },
      include: {
        orders: {
          where: { status: { not: "CANCELED" } },
          select: { totalCents: true, createdAt: true },
        },
        addresses: true,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    res.json(
      customers.map((c) => {
        const totalSpent = c.orders.reduce((sum, o) => sum + o.totalCents, 0);
        const lastOrderAt = c.orders.length
          ? c.orders.reduce((max, o) => (o.createdAt > max ? o.createdAt : max), c.orders[0].createdAt)
          : null;
        const { orders, passwordHash, ...rest } = c;
        return {
          ...rest,
          hasAppAccess: !!passwordHash,
          ordersCount: orders.length,
          totalSpentCents: totalSpent,
          avgTicketCents: orders.length ? Math.round(totalSpent / orders.length) : 0,
          lastOrderAt,
          computedTier: tierFromSpend(totalSpent),
        };
      }),
    );
  }),
);

customersRoutes.get(
  "/:id",
  h(async (req, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: {
        addresses: true,
        orders: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { items: true },
        },
      },
    });
    if (!customer) throw new AppError(404, "Cliente não encontrado");
    const { passwordHash, ...rest } = customer;
    res.json({ ...rest, hasAppAccess: !!passwordHash });
  }),
);

customersRoutes.post(
  "/",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = customerSchema.parse(req.body);
    const exists = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId, phone: data.phone } },
    });
    if (exists) throw new AppError(409, "Já existe cliente com este telefone");

    const customer = await prisma.customer.create({
      data: {
        ...data,
        birthDate: data.birthDate ? new Date(data.birthDate) : null,
        tenantId,
      },
    });
    const { passwordHash, ...rest } = customer;
    res.status(201).json({ ...rest, hasAppAccess: !!passwordHash });
  }),
);

customersRoutes.put(
  "/:id",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = customerSchema.partial().parse(req.body);
    const existing = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!existing) throw new AppError(404, "Cliente não encontrado");

    const customer = await prisma.customer.update({
      where: { id: existing.id },
      data: { ...data, birthDate: data.birthDate ? new Date(data.birthDate) : undefined },
    });
    const { passwordHash, ...rest } = customer;
    res.json({ ...rest, hasAppAccess: !!passwordHash });
  }),
);

const addressSchema = z.object({
  label: z.string().default("Casa"),
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional().nullable(),
  neighborhood: z.string().min(1),
  city: z.string().min(1),
  state: z.string().optional(),
  cep: z.string().optional().nullable(),
  reference: z.string().optional().nullable(),
  isDefault: z.boolean().optional(),
});

customersRoutes.post(
  "/:id/addresses",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, tenantId },
    });
    if (!customer) throw new AppError(404, "Cliente não encontrado");

    const data = addressSchema.parse(req.body);
    if (data.isDefault) {
      await prisma.customerAddress.updateMany({
        where: { customerId: customer.id },
        data: { isDefault: false },
      });
    }
    const address = await prisma.customerAddress.create({
      data: { ...data, customerId: customer.id },
    });
    res.status(201).json(address);
  }),
);

/** Zera a senha do app do cliente — ele precisa "criar conta" de novo com o mesmo telefone pra voltar a acessar. */
customersRoutes.post(
  "/:id/reset-app-access",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const { count } = await prisma.customer.updateMany({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      data: { passwordHash: null },
    });
    if (!count) throw new AppError(404, "Cliente não encontrado");
    res.json({ ok: true });
  }),
);

/**
 * Marca a recompensa do "compre X, leve Y" como entregue: zera o contador do
 * cliente e registra no histórico. Sempre manual — esse tipo de programa não
 * tem resgate automático no checkout (ver LoyaltyTab.tsx).
 */
customersRoutes.post(
  "/:id/redeem-buy-x-get-y",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId } });
    if (!customer) throw new AppError(404, "Cliente não encontrado");

    const program = await prisma.loyaltyProgram.findUnique({ where: { tenantId } });
    if (!program || program.type !== "BUY_X_GET_Y") {
      throw new AppError(400, "O programa de fidelidade atual não é do tipo compre X, leve Y");
    }
    if (customer.buyXProgress < program.buyX) {
      throw new AppError(409, `Esse cliente ainda não completou os ${program.buyX} pedidos necessários`);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.customer.update({
        where: { id: customer.id },
        data: { buyXProgress: { decrement: program.buyX } },
      });
      await tx.loyaltyTransaction.create({
        data: { customerId: customer.id, type: "REDEEM", points: program.buyX },
      });
      return result;
    });
    res.json({ ok: true, buyXProgress: updated.buyXProgress });
  }),
);

customersRoutes.delete(
  "/:id/addresses/:addressId",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const { count } = await prisma.customerAddress.deleteMany({
      where: { id: req.params.addressId, customer: { id: req.params.id, tenantId } },
    });
    if (!count) throw new AppError(404, "Endereço não encontrado");
    res.status(204).end();
  }),
);
