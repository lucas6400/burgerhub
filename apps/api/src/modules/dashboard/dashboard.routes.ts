import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { h } from "../../lib/http.js";
import { requireAuth, tenantOf } from "../../middlewares/auth.js";

export const dashboardRoutes = Router();
dashboardRoutes.use(requireAuth);

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function daysAgo(n: number) {
  const x = startOfDay();
  x.setDate(x.getDate() - n);
  return x;
}

const REVENUE_STATUSES = [
  "DELIVERED",
  "SETTLED",
  "READY",
  "OUT_FOR_DELIVERY",
  "PREPARING",
  "FINISHING",
  "NEW",
];

dashboardRoutes.get(
  "/summary",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const today = startOfDay();
    const weekStart = daysAgo(6);
    const monthStart = daysAgo(29);

    const [ordersToday, revenueToday, revenueWeek, revenueMonth, inProduction, completedToday, canceledToday, newCustomers, activeCustomerIds] =
      await Promise.all([
        prisma.order.count({ where: { tenantId, createdAt: { gte: today }, status: { not: "CANCELED" } } }),
        prisma.order.aggregate({
          _sum: { totalCents: true },
          where: { tenantId, createdAt: { gte: today }, status: { in: REVENUE_STATUSES } },
        }),
        prisma.order.aggregate({
          _sum: { totalCents: true },
          where: { tenantId, createdAt: { gte: weekStart }, status: { in: REVENUE_STATUSES } },
        }),
        prisma.order.aggregate({
          _sum: { totalCents: true },
          where: { tenantId, createdAt: { gte: monthStart }, status: { in: REVENUE_STATUSES } },
        }),
        prisma.order.count({
          where: { tenantId, status: { in: ["NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"] } },
        }),
        prisma.order.count({
          where: { tenantId, status: { in: ["DELIVERED", "SETTLED"] }, createdAt: { gte: today } },
        }),
        prisma.order.count({ where: { tenantId, status: "CANCELED", createdAt: { gte: today } } }),
        prisma.customer.count({ where: { tenantId, createdAt: { gte: monthStart } } }),
        prisma.order.groupBy({
          by: ["customerId"],
          where: { tenantId, createdAt: { gte: monthStart }, customerId: { not: null } },
          _count: { _all: true },
        }),
      ]);

    const revToday = revenueToday._sum.totalCents ?? 0;
    const recurring = activeCustomerIds.filter((g) => g._count._all > 1).length;

    res.json({
      revenueTodayCents: revToday,
      revenueWeekCents: revenueWeek._sum.totalCents ?? 0,
      revenueMonthCents: revenueMonth._sum.totalCents ?? 0,
      ordersToday,
      avgTicketCents: ordersToday ? Math.round(revToday / ordersToday) : 0,
      newCustomers30d: newCustomers,
      recurringCustomers30d: recurring,
      ordersInProduction: inProduction,
      ordersCompletedToday: completedToday,
      ordersCanceledToday: canceledToday,
    });
  }),
);

dashboardRoutes.get(
  "/charts",
  h(async (req, res) => {
    const tenantId = tenantOf(req);
    const since = daysAgo(13);

    const orders = await prisma.order.findMany({
      where: { tenantId, createdAt: { gte: since }, status: { not: "CANCELED" } },
      select: { totalCents: true, createdAt: true },
    });

    // Vendas por dia (últimos 14 dias)
    const byDay = new Map<string, { revenueCents: number; orders: number }>();
    for (let i = 13; i >= 0; i--) {
      const d = daysAgo(i);
      byDay.set(d.toISOString().slice(0, 10), { revenueCents: 0, orders: 0 });
    }
    // Horários de pico
    const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));

    for (const o of orders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      const day = byDay.get(key);
      if (day) {
        day.revenueCents += o.totalCents;
        day.orders += 1;
      }
      byHour[o.createdAt.getHours()].orders += 1;
    }

    // Produtos mais / menos vendidos (30 dias)
    const itemAgg = await prisma.orderItem.groupBy({
      by: ["nameSnapshot"],
      where: { order: { tenantId, createdAt: { gte: daysAgo(29) }, status: { not: "CANCELED" } } },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: "desc" } },
    });
    const products = itemAgg.map((i) => ({ name: i.nameSnapshot, quantity: i._sum.quantity ?? 0 }));

    res.json({
      salesByDay: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
      ordersByHour: byHour,
      topProducts: products.slice(0, 8),
      bottomProducts: products.slice(-5).reverse(),
    });
  }),
);
