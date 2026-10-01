import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { AppError } from "../../middlewares/error.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { normalizePhone } from "./phone.js";
import { requireCustomerAuth, signCustomerToken } from "./customer-auth.middleware.js";

/**
 * Conta do cliente no cardápio digital público — separada da autenticação de
 * staff (módulo próprio, segredo de token próprio). Mesma tenantBySlug de
 * public.routes.ts, mas mantida num arquivo à parte para não inchar aquele.
 */
export const customerAuthRoutes = Router();

async function tenantBySlug(slug: string) {
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant || !tenant.active) throw new AppError(404, "Estabelecimento não encontrado");
  return tenant;
}

function customerResponse(c: {
  id: string;
  name: string;
  phone: string;
  tier: string;
  loyaltyPoints: number;
  cashbackCents: number;
}) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    tier: c.tier,
    loyaltyPoints: c.loyaltyPoints,
    cashbackCents: c.cashbackCents,
  };
}

const registerSchema = z.object({
  name: z.string().trim().min(2),
  phone: z.string().min(8),
  password: z.string().min(6),
});

/** Cria conta ou "reivindica" um Customer já existente (criado antes por um pedido de convidado). */
customerAuthRoutes.post(
  "/:slug/account/register",
  rateLimit(10, 60_000, (req) => `${req.ip}:${req.params.slug}`),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const data = registerSchema.parse(req.body);
    const phone = normalizePhone(data.phone);

    const existing = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId: tenant.id, phone } },
    });
    if (existing?.passwordHash) {
      throw new AppError(409, "Esse telefone já tem uma conta. Faça login.");
    }

    const passwordHash = await bcrypt.hash(data.password, 10);
    const customer = existing
      ? await prisma.customer.update({
          where: { id: existing.id },
          data: { passwordHash, name: data.name, lastLoginAt: new Date() },
        })
      : await prisma.customer.create({
          data: { tenantId: tenant.id, name: data.name, phone, passwordHash, lastLoginAt: new Date() },
        });

    const token = signCustomerToken({
      scope: "customer",
      customerId: customer.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    });
    res.status(201).json({ token, customer: customerResponse(customer) });
  }),
);

const loginSchema = z.object({
  phone: z.string().min(8),
  password: z.string().min(1),
});

customerAuthRoutes.post(
  "/:slug/account/login",
  rateLimit(15, 60_000, (req) => `${req.ip}:${req.params.slug}`),
  h(async (req, res) => {
    const tenant = await tenantBySlug(req.params.slug);
    const data = loginSchema.parse(req.body);
    const phone = normalizePhone(data.phone);

    const customer = await prisma.customer.findUnique({
      where: { tenantId_phone: { tenantId: tenant.id, phone } },
    });
    // Mensagem genérica em qualquer caso de falha (sem conta / sem senha / senha
    // errada) — não dá pra descobrir se um telefone tem conta só tentando logar.
    const invalid = () => new AppError(401, "Telefone ou senha inválidos");
    if (!customer?.passwordHash) throw invalid();
    const ok = await bcrypt.compare(data.password, customer.passwordHash);
    if (!ok) throw invalid();

    await prisma.customer.update({ where: { id: customer.id }, data: { lastLoginAt: new Date() } });

    const token = signCustomerToken({
      scope: "customer",
      customerId: customer.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    });
    res.json({ token, customer: customerResponse(customer) });
  }),
);

customerAuthRoutes.get(
  "/:slug/account/me",
  requireCustomerAuth,
  h(async (req, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: req.customerAuth!.customerId, tenantId: req.customerAuth!.tenantId },
      include: { addresses: true },
    });
    if (!customer) throw new AppError(404, "Conta não encontrada");
    res.json({ ...customerResponse(customer), addresses: customer.addresses });
  }),
);

customerAuthRoutes.get(
  "/:slug/account/orders",
  requireCustomerAuth,
  h(async (req, res) => {
    const orders = await prisma.order.findMany({
      where: { tenantId: req.customerAuth!.tenantId, customerId: req.customerAuth!.customerId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, number: true, status: true, type: true, totalCents: true, createdAt: true },
    });
    res.json(orders);
  }),
);

const customerAddressSchema = z.object({
  label: z.string().trim().min(1).default("Casa"),
  street: z.string().trim().min(1),
  number: z.string().trim().min(1),
  complement: z.string().trim().optional().nullable(),
  neighborhood: z.string().trim().min(1),
  city: z.string().trim().min(1),
  state: z.string().trim().optional(),
  cep: z.string().trim().optional().nullable(),
  reference: z.string().trim().optional().nullable(),
  isDefault: z.boolean().optional(),
  // Confirmado no mapa (GPS ou arrastando o pino) ao salvar — é o que faz esse
  // endereço não disparar mais o aviso de "localização aproximada" pro motoboy.
  lat: z.number().optional(),
  lng: z.number().optional(),
});

/** Endereços salvos do próprio cliente — reusados no checkout pra não digitar/confirmar de novo toda vez. */
customerAuthRoutes.post(
  "/:slug/account/addresses",
  requireCustomerAuth,
  h(async (req, res) => {
    const data = customerAddressSchema.parse(req.body);
    const customerId = req.customerAuth!.customerId;
    if (data.isDefault) {
      await prisma.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
    }
    const address = await prisma.customerAddress.create({ data: { ...data, customerId } });
    res.status(201).json(address);
  }),
);

customerAuthRoutes.put(
  "/:slug/account/addresses/:id",
  requireCustomerAuth,
  h(async (req, res) => {
    const customerId = req.customerAuth!.customerId;
    const existing = await prisma.customerAddress.findFirst({ where: { id: req.params.id, customerId } });
    if (!existing) throw new AppError(404, "Endereço não encontrado");

    const data = customerAddressSchema.partial().parse(req.body);
    if (data.isDefault) {
      await prisma.customerAddress.updateMany({ where: { customerId }, data: { isDefault: false } });
    }
    const address = await prisma.customerAddress.update({ where: { id: existing.id }, data });
    res.json(address);
  }),
);

customerAuthRoutes.delete(
  "/:slug/account/addresses/:id",
  requireCustomerAuth,
  h(async (req, res) => {
    const { count } = await prisma.customerAddress.deleteMany({
      where: { id: req.params.id, customerId: req.customerAuth!.customerId },
    });
    if (!count) throw new AppError(404, "Endereço não encontrado");
    res.status(204).end();
  }),
);
