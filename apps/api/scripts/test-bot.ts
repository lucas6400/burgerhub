import { PrismaClient } from "@prisma/client";
import { handleIncoming } from "../src/modules/whatsapp/bot.service.js";

/** Simula uma conversa completa de um cliente com o bot do WhatsApp. */
const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.findUnique({ where: { slug: "burger-do-lu" } });
  if (!tenant) throw new Error("Rode o seed antes.");

  // Garante bot habilitado e sessão limpa
  await prisma.tenantSettings.update({
    where: { tenantId: tenant.id },
    data: { botEnabled: true },
  });
  const phone = "5511987654321";
  await prisma.chatSession.deleteMany({ where: { tenantId: tenant.id, phone } });

  const conversation = [
    "oi",
    "1", // fazer pedido
    "2x2", // 2 Smash Bacon
    "4", // batata
    "99", // código inválido
    "ok",
    "1", // entrega
    "Rua Inventada Que Nao Existe De Jeito Nenhum, 999, BairroFake", // deve pedir para reenviar
    "Alameda Santos, 200, Jardim Paulista, São Paulo", // endereço real, perto da loja
    "2", // dinheiro
    "100", // troco
    "confirmar",
  ];

  for (const msg of conversation) {
    console.log(`\n👤 Cliente: ${msg}`);
    const replies = await handleIncoming(tenant.id, phone, msg, "Maria Teste");
    for (const r of replies) console.log(`🤖 Bot:\n${r.split("\n").map((l) => "   " + l).join("\n")}`);
  }

  // Confere o pedido criado
  const order = await prisma.order.findFirst({
    where: { tenantId: tenant.id, source: "WHATSAPP", customer: { phone } },
    orderBy: { createdAt: "desc" },
    include: { items: true, customer: true },
  });
  if (!order) throw new Error("❌ Pedido não foi criado!");
  console.log("\n================ VERIFICAÇÃO ================");
  console.log(`Pedido #${order.number} | origem ${order.source} | ${order.type} | ${order.paymentMethod}`);
  console.log(`Cliente: ${order.customer?.name} (${order.customer?.phone})`);
  console.log(`Endereço: ${order.addressStreet}, ${order.addressNumber} — ${order.addressNeighborhood}`);
  order.items.forEach((i) => console.log(`  ${i.quantity}× ${i.nameSnapshot} @ ${(i.unitPriceCents / 100).toFixed(2)}`));
  console.log(`Entrega: R$ ${(order.deliveryFeeCents / 100).toFixed(2)} (${order.deliveryDistanceKm} km) | Troco p/: R$ ${((order.changeForCents ?? 0) / 100).toFixed(2)}`);
  console.log(`TOTAL: R$ ${(order.totalCents / 100).toFixed(2)}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
