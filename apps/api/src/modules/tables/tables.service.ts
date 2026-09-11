import { prisma } from "../../lib/prisma.js";
import { AppError } from "../../middlewares/error.js";
import { audit } from "../../utils/audit.js";

const ACTIVE_ORDER_STATUSES = ["NEW", "PREPARING", "FINISHING", "READY", "OUT_FOR_DELIVERY"];

/**
 * Fecha a conta de uma mesa: todos os pedidos ativos viram SETTLED de uma vez
 * (mesmo lançamento financeiro automático que a entrega concluída gera),
 * atomicamente com a liberação da mesa. Nunca cria pedido novo — só resolve
 * os que já existem para aquela mesa.
 */
export async function closeTable(params: {
  tenantId: string;
  tableId: string;
  paymentMethod: string;
  userId?: string;
}) {
  const { tenantId, tableId, paymentMethod, userId } = params;

  const table = await prisma.table.findFirst({ where: { id: tableId, tenantId } });
  if (!table) throw new AppError(404, "Mesa não encontrada");
  if (table.status !== "OPEN") throw new AppError(409, "Mesa não está aberta");

  const orders = await prisma.order.findMany({
    where: { tenantId, tableId, status: { in: ACTIVE_ORDER_STATUSES } },
  });
  if (orders.length === 0) throw new AppError(409, "Mesa não tem pedidos em aberto");

  const now = new Date();
  const totalCents = orders.reduce((sum, o) => sum + o.totalCents, 0);

  await prisma.$transaction(async (tx) => {
    for (const order of orders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: "SETTLED",
          settledAt: now,
          paymentStatus: "PAID",
          paymentMethod,
          statusEvents: {
            create: { fromStatus: order.status, toStatus: "SETTLED", byUserId: userId },
          },
        },
      });
      await tx.financialEntry.create({
        data: {
          tenantId,
          type: "INCOME",
          category: "Vendas",
          description: `Pedido #${order.number} (Mesa ${table.number})`,
          amountCents: order.totalCents,
          paidAt: now,
          refOrderId: order.id,
        },
      });
    }

    await tx.table.update({
      where: { id: table.id },
      data: { status: "FREE", openedAt: null },
    });
  });

  await audit({
    tenantId,
    userId,
    action: "SETTLE_TABLE",
    entity: "Table",
    entityId: table.id,
    detail: { tableNumber: table.number, orderIds: orders.map((o) => o.id), totalCents },
  });

  return { tableNumber: table.number, orderIds: orders.map((o) => o.id), totalCents };
}
