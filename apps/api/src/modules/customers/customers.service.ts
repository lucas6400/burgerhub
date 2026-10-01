import { prisma } from "../../lib/prisma.js";

/**
 * Encontra ou cria um cliente pelo telefone. `overwriteName` controla se um
 * nome já cadastrado pode ser sobrescrito — usado pelo checkout (nome digitado
 * é correção intencional do cliente), mas NÃO pelo webhook do WhatsApp (o
 * `pushName` de uma mensagem qualquer, ou o fallback "Cliente 1234", não deve
 * apagar um nome real já salvo).
 */
export async function findOrCreateCustomerByPhone(
  tenantId: string,
  input: { name: string; phone: string; email?: string | null },
  opts: { overwriteName: boolean } = { overwriteName: false },
) {
  return prisma.customer.upsert({
    where: { tenantId_phone: { tenantId, phone: input.phone } },
    update: opts.overwriteName
      ? { name: input.name, email: input.email ?? undefined }
      : {},
    create: { tenantId, name: input.name, phone: input.phone, email: input.email ?? undefined },
  });
}
