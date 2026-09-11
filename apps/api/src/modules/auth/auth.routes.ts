import { Router } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";
import { requireAuth, type AuthPayload } from "../../middlewares/auth.js";
import { rateLimit } from "../../middlewares/rateLimit.js";
import { audit } from "../../utils/audit.js";
import { sendPasswordResetEmail } from "./email.js";

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export const authRoutes = Router();

const registerSchema = z.object({
  restaurantName: z.string().min(2),
  slug: z
    .string()
    .min(3)
    .regex(/^[a-z0-9-]+$/, "Use apenas letras minúsculas, números e hífens"),
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
  phone: z.string().optional(),
});

function signToken(payload: AuthPayload) {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

/** Onboarding: cria a hamburgueria (tenant), configurações padrão e o usuário admin. */
authRoutes.post(
  "/register",
  rateLimit(10, 60_000),
  h(async (req, res) => {
    const data = registerSchema.parse(req.body);

    const existingSlug = await prisma.tenant.findUnique({ where: { slug: data.slug } });
    if (existingSlug) throw new AppError(409, "Este endereço (slug) já está em uso");
    const existingName = await prisma.tenant.findUnique({ where: { name: data.restaurantName } });
    if (existingName) throw new AppError(409, "Já existe uma hamburgueria cadastrada com esse nome");

    const passwordHash = await bcrypt.hash(data.password, 10);

    const tenant = await prisma.tenant.create({
      data: {
        slug: data.slug,
        name: data.restaurantName,
        phone: data.phone,
        settings: { create: {} },
        users: {
          create: {
            name: data.name,
            email: data.email.toLowerCase(),
            passwordHash,
            role: "ADMIN",
          },
        },
        businessHours: {
          create: [1, 2, 3, 4, 5, 6, 0].map((weekday) => ({
            weekday,
            openTime: "18:00",
            closeTime: "23:30",
          })),
        },
      },
      include: { users: true, settings: true },
    });

    const user = tenant.users[0];
    const payload: AuthPayload = {
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
      name: user.name,
    };

    await audit({ tenantId: tenant.id, userId: user.id, action: "REGISTER", entity: "Tenant", entityId: tenant.id });

    res.status(201).json({
      token: signToken(payload),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, phone: tenant.phone, settings: tenant.settings },
    });
  }),
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  slug: z.string().optional(), // desambigua se o e-mail existir em mais de um tenant
});

authRoutes.post(
  "/login",
  rateLimit(20, 60_000),
  h(async (req, res) => {
    const { email, password, slug } = loginSchema.parse(req.body);

    const users = await prisma.user.findMany({
      where: {
        email: email.toLowerCase(),
        active: true,
        ...(slug ? { tenant: { slug } } : {}),
      },
      include: { tenant: { include: { settings: true } } },
    });

    for (const user of users) {
      if (await bcrypt.compare(password, user.passwordHash)) {
        if (!user.tenant.active) throw new AppError(403, "Estabelecimento desativado");
        const payload: AuthPayload = {
          userId: user.id,
          tenantId: user.tenantId,
          role: user.role,
          name: user.name,
        };
        await audit({ tenantId: user.tenantId, userId: user.id, action: "LOGIN", entity: "User", entityId: user.id });
        return res.json({
          token: signToken(payload),
          user: { id: user.id, name: user.name, email: user.email, role: user.role },
          tenant: {
            id: user.tenant.id,
            slug: user.tenant.slug,
            name: user.tenant.name,
            phone: user.tenant.phone,
            settings: user.tenant.settings,
          },
        });
      }
    }
    throw new AppError(401, "E-mail ou senha inválidos");
  }),
);

/**
 * Solicita a redefinição de senha. Sempre responde com sucesso genérico —
 * nunca revela se o e-mail existe ou não (evita enumeração de contas).
 * Uma mesma pessoa pode ter contas em mais de um estabelecimento com o
 * mesmo e-mail: nesse caso, gera um link separado pra cada uma.
 */
const forgotPasswordSchema = z.object({ email: z.string().email() });

authRoutes.post(
  "/forgot-password",
  rateLimit(5, 60_000),
  h(async (req, res) => {
    const { email } = forgotPasswordSchema.parse(req.body);
    const users = await prisma.user.findMany({
      where: { email: email.toLowerCase(), active: true },
      include: { tenant: { select: { name: true } } },
    });

    for (const user of users) {
      const rawToken = crypto.randomBytes(32).toString("hex");
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: hashToken(rawToken),
          passwordResetExpiresAt: new Date(Date.now() + 60 * 60_000),
        },
      });
      const resetUrl = `${env.publicWebUrl}/redefinir-senha?token=${rawToken}`;
      await sendPasswordResetEmail(user.email, user.name, resetUrl).catch((err) =>
        console.error("Falha ao enviar e-mail de redefinição:", err),
      );
    }

    res.json({
      ok: true,
      message: "Se esse e-mail estiver cadastrado, enviamos um link de redefinição de senha.",
    });
  }),
);

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(6),
});

authRoutes.post(
  "/reset-password",
  rateLimit(10, 60_000),
  h(async (req, res) => {
    const { token, password } = resetPasswordSchema.parse(req.body);
    const user = await prisma.user.findFirst({
      where: { passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: { gt: new Date() } },
      include: { tenant: { include: { settings: true } } },
    });
    if (!user) throw new AppError(400, "Link inválido ou expirado. Peça uma nova redefinição de senha.");

    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
    });
    await audit({ tenantId: user.tenantId, userId: user.id, action: "PASSWORD_RESET", entity: "User", entityId: user.id });

    const payload: AuthPayload = { userId: user.id, tenantId: user.tenantId, role: user.role, name: user.name };
    res.json({
      token: signToken(payload),
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: {
        id: user.tenant.id,
        slug: user.tenant.slug,
        name: user.tenant.name,
        phone: user.tenant.phone,
        settings: user.tenant.settings,
      },
    });
  }),
);

authRoutes.get(
  "/me",
  requireAuth,
  h(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.auth!.userId, tenantId: req.auth!.tenantId },
      include: { tenant: { include: { settings: true } } },
    });
    if (!user) throw new AppError(401, "Usuário não encontrado");
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      tenant: {
        id: user.tenant.id,
        slug: user.tenant.slug,
        name: user.tenant.name,
        phone: user.tenant.phone,
        settings: user.tenant.settings,
      },
    });
  }),
);
