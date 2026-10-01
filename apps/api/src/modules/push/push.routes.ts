import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";
import { env } from "../../config/env.js";

export const pushRoutes = Router();
pushRoutes.use(requireAuth);

pushRoutes.get(
  "/vapid-public-key",
  h(async (_req, res) => {
    res.json({ publicKey: env.vapid.publicKey });
  }),
);

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});

pushRoutes.post(
  "/subscribe",
  h(async (req, res) => {
    const { endpoint, keys } = subscribeSchema.parse(req.body);
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      update: { userId: req.auth!.userId, tenantId: tenantOf(req), p256dh: keys.p256dh, auth: keys.auth },
      create: { endpoint, userId: req.auth!.userId, tenantId: tenantOf(req), p256dh: keys.p256dh, auth: keys.auth },
    });
    res.status(201).json({ ok: true });
  }),
);

pushRoutes.delete(
  "/subscribe",
  h(async (req, res) => {
    const endpoint = z.string().url().parse(req.query.endpoint);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, tenantId: tenantOf(req) } });
    res.status(204).end();
  }),
);
