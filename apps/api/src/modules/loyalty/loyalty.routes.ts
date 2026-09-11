import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { audit } from "../../utils/audit.js";

export const loyaltyRoutes = Router();
loyaltyRoutes.use(requireAuth);

loyaltyRoutes.get(
  "/program",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const program = await prisma.loyaltyProgram.findUnique({ where: { tenantId } });
    res.json(
      program ?? {
        type: "POINTS",
        active: false,
        pointsPerReal: 1,
        cashbackPct: 5,
        buyX: 10,
        getY: "1 hambúrguer grátis",
        validityDays: 90,
        redemptionCentsPerPoint: 0.01,
        minRedeemPoints: 0,
      },
    );
  }),
);

const programSchema = z.object({
  type: z.enum(["POINTS", "CASHBACK", "BUY_X_GET_Y"]).optional(),
  active: z.boolean().optional(),
  pointsPerReal: z.number().int().min(1).optional(),
  cashbackPct: z.number().min(0).max(100).optional(),
  buyX: z.number().int().min(1).optional(),
  getY: z.string().optional(),
  validityDays: z.number().int().min(1).optional(),
});

loyaltyRoutes.put(
  "/program",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = programSchema.parse(req.body);
    const program = await prisma.loyaltyProgram.upsert({
      where: { tenantId },
      update: data,
      create: { ...data, tenantId },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "LoyaltyProgram",
      detail: data,
    });
    res.json(program);
  }),
);
