import { PrismaClient } from "@prisma/client";

/** Atribui códigos curtos sequenciais (por tenant) aos produtos que ainda não têm. */
const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  for (const tenant of tenants) {
    const products = await prisma.product.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ category: { displayOrder: "asc" } }, { displayOrder: "asc" }, { createdAt: "asc" }],
    });
    let next =
      products.reduce((m, p) => {
        const n = parseInt(p.internalCode ?? "", 10);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0) + 1;

    for (const p of products) {
      if (p.internalCode?.trim()) continue;
      await prisma.product.update({ where: { id: p.id }, data: { internalCode: String(next) } });
      console.log(`${tenant.name}: ${p.name} → código ${next}`);
      next++;
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
