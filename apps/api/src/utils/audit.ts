import { prisma } from "../lib/prisma.js";

export async function audit(params: {
  tenantId: string;
  userId?: string;
  action: string;
  entity: string;
  entityId?: string;
  detail?: unknown;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: params.tenantId,
        userId: params.userId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        detail: params.detail ? JSON.stringify(params.detail) : undefined,
      },
    });
  } catch (err) {
    // Auditoria nunca deve derrubar a operação principal
    console.error("Falha ao registrar auditoria:", err);
  }
}
