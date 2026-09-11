import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  // Local e produção usam o MESMO banco Neon — não dá pra distinguir ambiente
  // pela DATABASE_URL. Exige confirmação explícita antes de apagar/recriar o
  // tenant demo, pra não rodar por engano contra dados reais.
  if (process.env.SEED_CONFIRM !== "yes") {
    console.error(
      "Seed bloqueado: isso apaga e recria o tenant demo 'burger-do-lu'.\n" +
        "Rode novamente com SEED_CONFIRM=yes para confirmar.",
    );
    process.exit(1);
  }

  console.log("🌱 Populando banco com dados demo...");

  await prisma.tenant.deleteMany({ where: { slug: "burger-do-lu" } });

  const passwordHash = await bcrypt.hash("123456", 10);

  const tenant = await prisma.tenant.create({
    data: {
      slug: "burger-do-lu",
      name: "Burger do Lu",
      phone: "(11) 99999-0000",
      settings: {
        create: {
          primaryColor: "#f59e0b",
          address: "Rua das Brasas, 123 — Centro",
          instagram: "@burgerdolu",
          pixKey: "burgerdolu@pix.com",
          freeDeliveryAbove: 8000,
          defaultPrepMinutes: 35,
          mpEnabled: true, // pagamento online (mock em dev)
          // Localização real (Av. Paulista, São Paulo) — usada para calcular
          // a taxa de entrega automaticamente pela distância até o cliente.
          storeLat: -23.561684,
          storeLng: -46.655981,
          maxDeliveryRadiusKm: 10,
        },
      },
      businessHours: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          openTime: "00:00",
          closeTime: "23:59",
        })),
      },
      users: {
        create: [
          { name: "Lu Admin", email: "admin@burger.com", passwordHash, role: "ADMIN" },
          { name: "Carlos Gerente", email: "gerente@burger.com", passwordHash, role: "MANAGER" },
          { name: "Cozinha", email: "cozinha@burger.com", passwordHash, role: "KITCHEN" },
        ],
      },
      deliveryRadiusTiers: {
        create: [
          { maxKm: 3, feeCents: 500, etaMinutes: 30 },
          { maxKm: 6, feeCents: 800, etaMinutes: 45 },
          { maxKm: 10, feeCents: 1200, etaMinutes: 60 },
        ],
      },
    },
  });

  // ---------- Ingredientes (estoque) ----------
  const ing = async (name: string, unit: string, stockQty: number, minStockQty: number, cost: number) =>
    prisma.ingredient.create({
      data: { tenantId: tenant.id, name, unit, stockQty, minStockQty, costCentsPerUnit: cost },
    });

  const pao = await ing("Pão brioche", "un", 120, 30, 250);
  const carne = await ing("Blend bovino", "g", 15000, 3000, 4);
  const cheddar = await ing("Cheddar fatia", "un", 200, 50, 120);
  const bacon = await ing("Bacon", "g", 5000, 1000, 6);
  const alface = await ing("Alface", "g", 2000, 500, 1);
  const tomate = await ing("Tomate", "g", 3000, 500, 1);
  const cebola = await ing("Cebola roxa", "g", 2500, 500, 1);
  const picles = await ing("Picles", "g", 1200, 300, 3);
  const molhoCasa = await ing("Molho da casa", "g", 4000, 800, 2);
  const batata = await ing("Batata pré-frita", "g", 20000, 5000, 2);
  const refri = await ing("Refrigerante lata", "un", 96, 24, 350);

  // ---------- Categorias ----------
  const catNames = [
    ["Smash", "🍔"],
    ["Artesanais", "🥩"],
    ["Combos", "🍟"],
    ["Porções", "🧺"],
    ["Bebidas", "🥤"],
    ["Milk Shakes", "🥛"],
    ["Sobremesas", "🍰"],
    ["Molhos", "🥫"],
  ] as const;
  const categories: Record<string, string> = {};
  for (let i = 0; i < catNames.length; i++) {
    const c = await prisma.category.create({
      data: { tenantId: tenant.id, name: catNames[i][0], icon: catNames[i][1], displayOrder: i },
    });
    categories[catNames[i][0]] = c.id;
  }

  // ---------- Grupo de adicionais ----------
  const addonsGroup = await prisma.addonGroup.create({
    data: {
      tenantId: tenant.id,
      name: "Adicionais",
      minSelect: 0,
      maxSelect: 6,
      addons: {
        create: [
          { name: "Bacon extra", priceCents: 600, maxQty: 3 },
          { name: "Cheddar extra", priceCents: 400, maxQty: 3 },
          { name: "Catupiry", priceCents: 500, maxQty: 2 },
          { name: "Onion Rings", priceCents: 700, maxQty: 2 },
          { name: "Ovo", priceCents: 300, maxQty: 2 },
          { name: "Molho especial", priceCents: 350, maxQty: 2 },
          { name: "Picles extra", priceCents: 250, maxQty: 2 },
        ],
      },
    },
  });

  const molhosGroup = await prisma.addonGroup.create({
    data: {
      tenantId: tenant.id,
      name: "Molhos",
      minSelect: 0,
      maxSelect: 3,
      addons: {
        create: [
          { name: "Barbecue", priceCents: 300, maxQty: 2 },
          { name: "Maionese verde", priceCents: 300, maxQty: 2 },
          { name: "Alho", priceCents: 300, maxQty: 2 },
        ],
      },
    },
  });

  // ---------- Produtos ----------
  const img = (seed: string) => `https://picsum.photos/seed/${seed}/600/400`;

  const smashClassic = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Smash"],
      name: "Smash Classic",
      description: "Pão brioche, smash 120g, cheddar duplo, cebola roxa e molho da casa.",
      priceCents: 2490,
      imageUrl: img("smash1"),
      prepMinutes: 15,
      weightGrams: 280,
      sku: "SMH-001",
      displayOrder: 0,
      ingredients: {
        create: [
          { ingredientId: pao.id, quantity: 1, removable: false },
          { ingredientId: carne.id, quantity: 120, removable: false },
          { ingredientId: cheddar.id, quantity: 2, removable: true },
          { ingredientId: cebola.id, quantity: 30, removable: true },
          { ingredientId: molhoCasa.id, quantity: 20, removable: true },
        ],
      },
      addonGroups: { create: [{ groupId: addonsGroup.id }, { groupId: molhosGroup.id }] },
    },
  });

  const smashBacon = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Smash"],
      name: "Smash Bacon",
      description: "Smash 120g, cheddar, muito bacon crocante e maionese defumada.",
      priceCents: 2890,
      promoPriceCents: 2590,
      imageUrl: img("smash2"),
      prepMinutes: 15,
      weightGrams: 320,
      sku: "SMH-002",
      displayOrder: 1,
      ingredients: {
        create: [
          { ingredientId: pao.id, quantity: 1, removable: false },
          { ingredientId: carne.id, quantity: 120, removable: false },
          { ingredientId: cheddar.id, quantity: 1, removable: true },
          { ingredientId: bacon.id, quantity: 40, removable: true },
          { ingredientId: molhoCasa.id, quantity: 20, removable: true },
        ],
      },
      addonGroups: { create: [{ groupId: addonsGroup.id }] },
    },
  });

  const artesanal = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Artesanais"],
      name: "Brasa Supreme",
      description: "Burger artesanal 180g, queijo prato, alface, tomate, picles e molho da casa.",
      priceCents: 3490,
      imageUrl: img("supreme"),
      prepMinutes: 25,
      weightGrams: 420,
      sku: "ART-001",
      ingredients: {
        create: [
          { ingredientId: pao.id, quantity: 1, removable: false },
          { ingredientId: carne.id, quantity: 180, removable: false },
          { ingredientId: alface.id, quantity: 20, removable: true },
          { ingredientId: tomate.id, quantity: 30, removable: true },
          { ingredientId: picles.id, quantity: 15, removable: true },
          { ingredientId: molhoCasa.id, quantity: 25, removable: true },
        ],
      },
      addonGroups: { create: [{ groupId: addonsGroup.id }, { groupId: molhosGroup.id }] },
    },
  });

  const batataP = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Porções"],
      name: "Batata Frita",
      description: "Porção generosa com sal e alecrim. Acompanha molho da casa.",
      priceCents: 1590,
      imageUrl: img("fries"),
      prepMinutes: 10,
      ingredients: { create: [{ ingredientId: batata.id, quantity: 300, removable: false }] },
      addonGroups: { create: [{ groupId: molhosGroup.id }] },
    },
  });

  const refriP = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Bebidas"],
      name: "Refrigerante Lata",
      description: "Coca-Cola, Guaraná ou Fanta — 350ml gelada.",
      priceCents: 690,
      imageUrl: img("soda"),
      prepMinutes: 1,
      ingredients: { create: [{ ingredientId: refri.id, quantity: 1, removable: false }] },
    },
  });

  const shake = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Milk Shakes"],
      name: "Milk Shake Ovomaltine",
      description: "500ml de cremosidade com Ovomaltine crocante.",
      priceCents: 1890,
      imageUrl: img("shake"),
      prepMinutes: 8,
    },
  });

  const brownie = await prisma.product.create({
    data: {
      tenantId: tenant.id,
      categoryId: categories["Sobremesas"],
      name: "Brownie com Sorvete",
      description: "Brownie quente de chocolate belga com sorvete de creme.",
      priceCents: 1490,
      imageUrl: img("brownie"),
      prepMinutes: 8,
    },
  });

  // ---------- Combo inteligente ----------
  await prisma.combo.create({
    data: {
      tenantId: tenant.id,
      name: "Combo Smash Classic",
      baseProductId: smashClassic.id,
      promoPriceCents: 3990, // burger + batata + refri
      items: {
        create: [
          { productId: batataP.id, quantity: 1 },
          { productId: refriP.id, quantity: 1 },
        ],
      },
    },
  });

  // ---------- Cupons ----------
  await prisma.coupon.createMany({
    data: [
      {
        tenantId: tenant.id,
        code: "BEMVINDO10",
        type: "PERCENT",
        valuePct: 10,
        firstPurchaseOnly: true,
        maxUses: 500,
      },
      {
        tenantId: tenant.id,
        code: "FRETEGRATIS",
        type: "FREE_SHIPPING",
        minOrderCents: 5000,
      },
      {
        tenantId: tenant.id,
        code: "NIVER",
        type: "FIXED",
        valueCents: 1500,
        birthdayOnly: true,
      },
    ],
  });

  // ---------- Programa de fidelidade ----------
  await prisma.loyaltyProgram.create({
    data: { tenantId: tenant.id, type: "POINTS", active: true, pointsPerReal: 1, validityDays: 90 },
  });

  // ---------- Mesas ----------
  await prisma.table.createMany({
    data: Array.from({ length: 8 }, (_, i) => ({ tenantId: tenant.id, number: i + 1, seats: 4 })),
  });

  // ---------- Fornecedor ----------
  await prisma.supplier.create({
    data: {
      tenantId: tenant.id,
      name: "Distribuidora Brasa Forte",
      phone: "(11) 98888-7777",
      email: "vendas@brasaforte.com",
    },
  });

  // ---------- Clientes + pedidos históricos ----------
  const customerData = [
    { name: "João Silva", phone: "11999990001" },
    { name: "Maria Santos", phone: "11999990002" },
    { name: "Pedro Costa", phone: "11999990003" },
    { name: "Ana Oliveira", phone: "11999990004" },
    { name: "Lucas Pereira", phone: "11999990005" },
    { name: "Julia Rodrigues", phone: "11999990006" },
  ];
  const customers = [];
  for (const c of customerData) {
    customers.push(
      await prisma.customer.create({
        data: {
          ...c,
          tenantId: tenant.id,
          addresses: {
            create: {
              label: "Casa",
              street: "Rua das Flores",
              number: String(Math.floor(Math.random() * 900) + 100),
              neighborhood: "Centro",
              city: "São Paulo",
              isDefault: true,
            },
          },
        },
      }),
    );
  }

  const products = [smashClassic, smashBacon, artesanal, batataP, refriP, shake, brownie];

  // Códigos curtos sequenciais para lançamento rápido no PDV (balcão)
  for (let i = 0; i < products.length; i++) {
    await prisma.product.update({
      where: { id: products[i].id },
      data: { internalCode: String(i + 1) },
    });
  }
  const statuses = ["DELIVERED", "DELIVERED", "DELIVERED", "DELIVERED", "CANCELED"];
  let orderNumber = 0;

  // 14 dias de histórico
  for (let day = 13; day >= 0; day--) {
    const ordersInDay = Math.floor(Math.random() * 6) + 3;
    for (let j = 0; j < ordersInDay; j++) {
      orderNumber++;
      const customer = customers[Math.floor(Math.random() * customers.length)];
      const itemCount = Math.floor(Math.random() * 3) + 1;
      const chosen = Array.from(
        { length: itemCount },
        () => products[Math.floor(Math.random() * products.length)],
      );
      const subtotal = chosen.reduce((s, p) => s + (p.promoPriceCents ?? p.priceCents), 0);
      const fee = 500;
      const isToday = day === 0;
      const status = isToday
        ? ["NEW", "PREPARING", "READY", "OUT_FOR_DELIVERY", "DELIVERED"][j % 5]
        : statuses[Math.floor(Math.random() * statuses.length)];

      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - day);
      createdAt.setHours(18 + Math.floor(Math.random() * 5), Math.floor(Math.random() * 59), 0, 0);
      if (isToday) createdAt.setHours(new Date().getHours(), Math.max(0, new Date().getMinutes() - j * 7));

      const order = await prisma.order.create({
        data: {
          tenantId: tenant.id,
          number: orderNumber,
          customerId: customer.id,
          type: j % 3 === 0 ? "PICKUP" : "DELIVERY",
          source: j % 2 === 0 ? "WHATSAPP" : "MENU",
          status,
          subtotalCents: subtotal,
          deliveryFeeCents: fee,
          totalCents: subtotal + fee,
          paymentMethod: ["PIX", "CASH", "CREDIT", "DEBIT"][j % 4],
          paymentStatus: status === "DELIVERED" ? "PAID" : "PENDING",
          createdAt,
          deliveredAt: status === "DELIVERED" ? new Date(createdAt.getTime() + 45 * 60000) : null,
          addressStreet: "Rua das Flores",
          addressNumber: "123",
          addressNeighborhood: "Centro",
          addressCity: "São Paulo",
          items: {
            create: chosen.map((p) => ({
              productId: p.id,
              nameSnapshot: p.name,
              unitPriceCents: p.promoPriceCents ?? p.priceCents,
              quantity: 1,
            })),
          },
          statusEvents: { create: { toStatus: status } },
        },
      });

      if (status === "DELIVERED") {
        await prisma.financialEntry.create({
          data: {
            tenantId: tenant.id,
            type: "INCOME",
            category: "Vendas",
            description: `Pedido #${order.number}`,
            amountCents: order.totalCents,
            paidAt: order.deliveredAt,
            refOrderId: order.id,
            createdAt,
          },
        });
      }
    }
  }

  // Despesas de exemplo
  await prisma.financialEntry.createMany({
    data: [
      { tenantId: tenant.id, type: "EXPENSE", category: "Aluguel", description: "Aluguel do ponto", amountCents: 350000, paidAt: new Date() },
      { tenantId: tenant.id, type: "EXPENSE", category: "Insumos", description: "Compra semanal — Brasa Forte", amountCents: 185000, paidAt: new Date() },
      { tenantId: tenant.id, type: "EXPENSE", category: "Salários", description: "Folha de pagamento", amountCents: 620000, dueDate: new Date(Date.now() + 7 * 86400000) },
    ],
  });

  console.log("✅ Seed concluído!");
  console.log("   Painel:  admin@burger.com / 123456");
  console.log("   Cardápio público: /cardapio/burger-do-lu");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
