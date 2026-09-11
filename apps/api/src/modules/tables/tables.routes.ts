import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, requireRole, tenantOf } from "../../middlewares/auth.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";
import { createOrder } from "../orders/orders.service.js";
import { closeTable } from "./tables.service.js";

export const tablesRoutes = Router();
tablesRoutes.use(requireAuth);

const ACTIVE_ORDER_STATUSES = ["NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"];

const tableSchema = z.object({
  number: z.number().int().min(1),
  seats: z.number().int().min(1).max(50).default(4),
});

tablesRoutes.get(
  "/",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const tables = await prisma.table.findMany({
      where: { tenantId },
      orderBy: { number: "asc" },
      include: {
        orders: {
          where: { status: { in: ACTIVE_ORDER_STATUSES } },
          select: { id: true, totalCents: true },
        },
      },
    });
    res.json(
      tables.map((t) => ({
        id: t.id,
        number: t.number,
        seats: t.seats,
        status: t.status,
        openedAt: t.openedAt,
        openOrdersCount: t.orders.length,
        runningTotalCents: t.orders.reduce((sum, o) => sum + o.totalCents, 0),
      })),
    );
  }),
);

tablesRoutes.get(
  "/:id",
  h(async (req, res) => {
    const table = await prisma.table.findFirst({
      where: { id: req.params.id, tenantId: tenantOf(req) },
      include: {
        orders: {
          where: { status: { in: ACTIVE_ORDER_STATUSES } },
          include: { items: { include: { addons: true, removals: true } } },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!table) throw new AppError(404, "Mesa não encontrada");
    res.json(table);
  }),
);

tablesRoutes.post(
  "/",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = tableSchema.parse(req.body);
    const exists = await prisma.table.findUnique({
      where: { tenantId_number: { tenantId, number: data.number } },
    });
    if (exists) throw new AppError(409, "Já existe uma mesa com este número");
    const table = await prisma.table.create({ data: { ...data, tenantId } });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "CREATE",
      entity: "Table",
      entityId: table.id,
      detail: { number: table.number },
    });
    res.status(201).json(table);
  }),
);

tablesRoutes.put(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const data = tableSchema.partial().parse(req.body);
    const existing = await prisma.table.findFirst({ where: { id: req.params.id, tenantId } });
    if (!existing) throw new AppError(404, "Mesa não encontrada");
    const table = await prisma.table.update({ where: { id: existing.id }, data });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "Table",
      entityId: table.id,
      detail: data,
    });
    res.json(table);
  }),
);

tablesRoutes.delete(
  "/:id",
  requireRole("MANAGER"),
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const used = await prisma.order.count({ where: { tableId: req.params.id, tenantId } });
    if (used > 0) {
      throw new AppError(409, "Mesa já tem pedidos no histórico — não pode ser excluída");
    }
    const { count } = await prisma.table.deleteMany({ where: { id: req.params.id, tenantId } });
    if (!count) throw new AppError(404, "Mesa não encontrada");
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "DELETE",
      entity: "Table",
      entityId: req.params.id,
    });
    res.status(204).end();
  }),
);

tablesRoutes.post(
  "/:id/open",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const table = await prisma.table.findFirst({ where: { id: req.params.id, tenantId } });
    if (!table) throw new AppError(404, "Mesa não encontrada");
    if (table.status === "OPEN") throw new AppError(409, "Mesa já está aberta");
    const updated = await prisma.table.update({
      where: { id: table.id },
      data: { status: "OPEN", openedAt: new Date() },
    });
    await audit({
      tenantId,
      userId: req.auth!.userId,
      action: "UPDATE",
      entity: "Table",
      entityId: table.id,
      detail: { opened: true, number: table.number },
    });
    res.json(updated);
  }),
);

const launchOrderSchema = z.object({
  paymentMethod: z.enum(["PIX", "CASH", "CREDIT", "DEBIT", "VR", "VA", "ONLINE"]).default("PIX"),
  notes: z.string().optional(),
  customerId: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        quantity: z.number().int().min(1).max(99),
        notes: z.string().optional(),
        addonIds: z
          .array(z.object({ addonId: z.string(), quantity: z.number().int().min(1) }))
          .optional(),
        removedIngredientIds: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

tablesRoutes.post(
  "/:id/orders",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const table = await prisma.table.findFirst({ where: { id: req.params.id, tenantId } });
    if (!table) throw new AppError(404, "Mesa não encontrada");
    if (table.status !== "OPEN") throw new AppError(409, "Mesa não está aberta");

    const data = launchOrderSchema.parse(req.body);
    const order = await createOrder({
      ...data,
      tenantId,
      tableId: table.id,
      type: "DINE_IN",
      source: "TABLE",
    });
    res.status(201).json(order);
  }),
);

const closeTableSchema = z.object({
  paymentMethod: z.enum(["PIX", "CASH", "CREDIT", "DEBIT", "VR", "VA", "ONLINE"]),
});

tablesRoutes.post(
  "/:id/close",
  h(async (req, res) => {
    const { paymentMethod } = closeTableSchema.parse(req.body);
    const result = await closeTable({
      tenantId: tenantOf(req),
      tableId: req.params.id,
      paymentMethod,
      userId: req.auth!.userId,
    });
    res.json(result);
  }),
);
