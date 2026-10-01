import { prisma } from "../../lib/prisma.js";
import { findOrCreateCustomerByPhone } from "../customers/customers.service.js";

/** Registra uma mensagem recebida do cliente — alimenta a Central de Atendimento. */
export async function recordInboundMessage(
  tenantId: string,
  phone: string,
  body: string,
  pushName?: string,
) {
  const customer = await findOrCreateCustomerByPhone(
    tenantId,
    { name: pushName || `Cliente ${phone.slice(-4)}`, phone },
    { overwriteName: false },
  );
  return prisma.whatsAppMessage.create({
    data: { tenantId, customerId: customer.id, phone, direction: "IN", body, senderType: "CUSTOMER" },
  });
}

/** Registra uma mensagem enviada (bot, atendente humano ou aviso automático de sistema). */
export async function recordOutboundMessage(
  tenantId: string,
  phone: string,
  body: string,
  opts: { senderType: "BOT" | "HUMAN" | "SYSTEM"; byUserId?: string },
) {
  const customer = await findOrCreateCustomerByPhone(
    tenantId,
    { name: `Cliente ${phone.slice(-4)}`, phone },
    { overwriteName: false },
  );
  return prisma.whatsAppMessage.create({
    data: {
      tenantId,
      customerId: customer.id,
      phone,
      direction: "OUT",
      body,
      readAt: new Date(),
      senderType: opts.senderType,
      byUserId: opts.byUserId,
    },
  });
}
