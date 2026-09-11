import { prisma } from "../../lib/prisma.js";
import { createOrder, quoteDelivery } from "../orders/orders.service.js";

/**
 * Bot de pedidos do WhatsApp — máquina de estados por cliente.
 * Recebe uma mensagem e devolve a(s) resposta(s); quem envia é o webhook.
 */

interface CartItem {
  productId: string;
  code: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

interface SessionData {
  cart: CartItem[];
  type?: "DELIVERY" | "PICKUP";
  address?: { street: string; number: string; neighborhood: string; city: string };
  deliveryFeeCents?: number;
  deliveryDistanceKm?: number;
  paymentMethod?: string;
  changeForCents?: number;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h de inatividade reinicia a conversa

const brl = (cents: number) =>
  (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

function cartTotal(data: SessionData) {
  return data.cart.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
}

function cartSummary(data: SessionData) {
  const lines = data.cart.map(
    (i) => `  ${i.quantity}× ${i.name} — ${brl(i.unitPriceCents * i.quantity)}`,
  );
  return `${lines.join("\n")}\n  *Subtotal: ${brl(cartTotal(data))}*`;
}

/** Aceita "2", "2*3" ou "2x3" (código × quantidade), igual ao PDV. */
function parseCode(raw: string): { code: string; qty: number } | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*[*x]\s*(\d+)$/);
  if (m) return { code: m[1], qty: Math.min(50, parseInt(m[2], 10) || 1) };
  const single = raw.trim().toLowerCase().match(/^(\d+)$/);
  if (single) return { code: single[1], qty: 1 };
  return null;
}

export async function handleIncoming(
  tenantId: string,
  phone: string,
  rawText: string,
  pushName?: string,
): Promise<string[]> {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    include: { settings: true, businessHours: true },
  });
  if (!tenant?.settings?.botEnabled) return [];

  let session = await prisma.chatSession.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  const expired = session && Date.now() - session.updatedAt.getTime() > SESSION_TTL_MS;
  if (!session || expired) {
    session = await prisma.chatSession.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      update: { state: "MAIN", data: "{}" },
      create: { tenantId, phone, state: "MAIN", data: "{}" },
    });
    return [greeting(tenant.name, pushName)];
  }

  const data: SessionData = { cart: [], ...JSON.parse(session.data) };

  async function save(state: string) {
    await prisma.chatSession.update({
      where: { id: session!.id },
      data: { state, data: JSON.stringify(data) },
    });
  }

  // Comandos globais
  if (["cancelar", "recomeçar", "recomecar", "menu"].includes(lower)) {
    data.cart = [];
    data.type = undefined;
    data.address = undefined;
    data.paymentMethod = undefined;
    await save("MAIN");
    return ["🔄 Tudo bem, recomeçamos!", greeting(tenant.name, pushName)];
  }

  switch (session.state) {
    // ------------------------------------------------ MENU PRINCIPAL
    case "MAIN": {
      if (lower === "1") {
        const menuText = await buildMenuText(tenantId);
        if (!menuText) return ["Ainda não temos produtos disponíveis. 😕"];
        await save("ORDERING");
        return [
          menuText,
          "🛒 Para adicionar, envie o *código* do item.\nEx.: *2* (um) ou *2x3* (três unidades).\nQuando terminar, envie *ok*.",
        ];
      }
      if (lower === "2") {
        return [`📱 Nosso cardápio completo com fotos:\n${menuLink(tenant.slug)}`];
      }
      if (lower === "3") {
        return [hoursText(tenant.businessHours)];
      }
      return [greeting(tenant.name, pushName)];
    }

    // ------------------------------------------------ MONTANDO O PEDIDO
    case "ORDERING": {
      if (lower === "ok" || lower === "finalizar") {
        if (data.cart.length === 0) {
          return ["Seu carrinho ainda está vazio. Envie o código de um item para adicionar. 😉"];
        }
        await save("CHECKOUT_TYPE");
        return [
          `📋 Seu pedido:\n${cartSummary(data)}\n\nComo você prefere?\n1️⃣ Entrega 🛵\n2️⃣ Retirada 🏃`,
        ];
      }
      if (lower === "limpar") {
        data.cart = [];
        await save("ORDERING");
        return ["🗑️ Carrinho esvaziado. Envie o código de um item para começar de novo."];
      }
      const parsed = parseCode(text);
      if (!parsed) {
        return [
          "Não entendi. 🤔 Envie o *código* do item (ex.: *2* ou *2x3*), *ok* para finalizar ou *cancelar* para recomeçar.",
        ];
      }
      const product = await prisma.product.findFirst({
        where: { tenantId, internalCode: parsed.code },
      });
      if (!product) return [`Não encontrei o código *${parsed.code}*. Confira no cardápio acima. 😉`];
      if (!product.available) return [`Poxa, *${product.name}* está esgotado hoje. 😔`];

      const price = product.promoPriceCents ?? product.priceCents;
      const existing = data.cart.find((i) => i.productId === product.id);
      if (existing) existing.quantity = Math.min(50, existing.quantity + parsed.qty);
      else
        data.cart.push({
          productId: product.id,
          code: parsed.code,
          name: product.name,
          unitPriceCents: price,
          quantity: parsed.qty,
        });
      await save("ORDERING");
      return [
        `✅ ${parsed.qty}× *${product.name}* adicionado!\n\n${cartSummary(data)}\n\nEnvie mais códigos, *ok* para finalizar ou *limpar* para esvaziar.`,
      ];
    }

    // ------------------------------------------------ ENTREGA OU RETIRADA
    case "CHECKOUT_TYPE": {
      if (lower === "1") {
        data.type = "DELIVERY";
        await save("CHECKOUT_ADDRESS");
        return ["🏠 Me envie seu endereço completo:\n*rua, número, bairro*\nEx.: Rua das Flores, 123, Centro"];
      }
      if (lower === "2") {
        data.type = "PICKUP";
        await save("CHECKOUT_PAYMENT");
        return [paymentPrompt()];
      }
      return ["Responda *1* para entrega 🛵 ou *2* para retirada 🏃"];
    }

    // ------------------------------------------------ ENDEREÇO
    case "CHECKOUT_ADDRESS": {
      const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
      if (parts.length < 3) {
        return [
          "Preciso de *rua, número e bairro*, separados por vírgula. 🙏\nEx.: Rua das Flores, 123, Centro",
        ];
      }
      const address = {
        street: parts[0],
        number: parts[1],
        neighborhood: parts[2],
        city: parts[3] ?? parts[2],
      };
      // Taxa calculada automaticamente pela distância até o estabelecimento
      try {
        const quote = await quoteDelivery(tenantId, address, cartTotal(data));
        data.address = address;
        data.deliveryFeeCents = quote.feeCents;
        data.deliveryDistanceKm = quote.distanceKm;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Não consegui calcular a entrega para esse endereço.";
        return [`😕 ${msg}\nPode me enviar novamente? Ex.: Rua das Flores, 123, Centro`];
      }
      await save("CHECKOUT_PAYMENT");
      const feeMsg =
        data.deliveryFeeCents && data.deliveryFeeCents > 0
          ? `🛵 Taxa de entrega: ${brl(data.deliveryFeeCents)} (${data.deliveryDistanceKm} km)`
          : "🛵 Entrega grátis para você!";
      return [`📍 Endereço anotado!\n${feeMsg}`, paymentPrompt()];
    }

    // ------------------------------------------------ PAGAMENTO
    case "CHECKOUT_PAYMENT": {
      const map: Record<string, string> = { "1": "PIX", "2": "CASH", "3": "CREDIT", "4": "DEBIT" };
      const method = map[lower];
      if (!method) return [paymentPrompt()];
      data.paymentMethod = method;
      if (method === "CASH") {
        await save("CHECKOUT_CHANGE");
        return ["💵 Troco para quanto?\nEnvie o valor (ex.: *100*) ou *sem troco*."];
      }
      await save("CONFIRM");
      return [confirmText(data, tenant.settings.pixKey)];
    }

    // ------------------------------------------------ TROCO
    case "CHECKOUT_CHANGE": {
      if (!lower.includes("sem")) {
        const value = parseFloat(lower.replace("r$", "").replace(",", ".").trim());
        if (Number.isFinite(value) && value > 0) data.changeForCents = Math.round(value * 100);
      }
      await save("CONFIRM");
      return [confirmText(data, tenant.settings.pixKey)];
    }

    // ------------------------------------------------ CONFIRMAÇÃO
    case "CONFIRM": {
      if (!["confirmar", "confirmo", "sim"].includes(lower)) {
        return ["Digite *confirmar* para enviar o pedido ou *cancelar* para recomeçar. 😉"];
      }
      try {
        const order = await createOrder({
          tenantId,
          source: "WHATSAPP",
          type: data.type ?? "PICKUP",
          paymentMethod: data.paymentMethod ?? "PIX",
          changeForCents: data.changeForCents,
          customer: { name: pushName || `Cliente ${phone.slice(-4)}`, phone },
          address: data.address,
          items: data.cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        });
        data.cart = [];
        await save("MAIN");
        const pixLine =
          order.paymentMethod === "PIX" && tenant.settings.pixKey
            ? `\n\n💠 Chave Pix: *${tenant.settings.pixKey}*\nEnvie o comprovante por aqui. 🙏`
            : "";
        return [
          `🎉 *Pedido #${order.number} confirmado!*\nTotal: *${brl(order.totalCents)}*\nTempo estimado: ${tenant.settings.defaultPrepMinutes}–${tenant.settings.defaultPrepMinutes + 20} min.${pixLine}\n\nVou te avisando por aqui a cada etapa! 🍔`,
        ];
      } catch (err) {
        await save("MAIN");
        const msg = err instanceof Error ? err.message : "erro inesperado";
        return [`😕 Não consegui registrar o pedido: ${msg}\nDigite *1* para tentar de novo.`];
      }
    }

    default: {
      await save("MAIN");
      return [greeting(tenant.name, pushName)];
    }
  }
}

// ---------------------------------------------------------------- textos

function greeting(restaurantName: string, pushName?: string) {
  const hi = pushName ? `Olá, *${pushName.split(" ")[0]}*! 👋` : "Olá! 👋";
  return `${hi} Bem-vindo à *${restaurantName}*!\n\n1️⃣ Fazer pedido 🍔\n2️⃣ Cardápio com fotos 📱\n3️⃣ Horários 🕐\n\nResponda com o número da opção.`;
}

function paymentPrompt() {
  return "💳 Como vai pagar?\n1️⃣ Pix\n2️⃣ Dinheiro\n3️⃣ Cartão de crédito\n4️⃣ Cartão de débito";
}

function confirmText(data: SessionData, pixKey?: string | null) {
  const fee = data.deliveryFeeCents ?? 0;
  const total = cartTotal(data) + fee;
  const typeLine = data.type === "DELIVERY" ? "🛵 Entrega" : "🏃 Retirada";
  const addressLine = data.address
    ? `\n📍 ${data.address.street}, ${data.address.number}${data.address.neighborhood ? ` — ${data.address.neighborhood}` : ""}`
    : "";
  const payLabel: Record<string, string> = {
    PIX: "Pix",
    CASH: "Dinheiro",
    CREDIT: "Cartão de crédito",
    DEBIT: "Cartão de débito",
  };
  const changeLine = data.changeForCents ? ` (troco para ${brl(data.changeForCents)})` : "";
  const feeLine = data.type === "DELIVERY" ? `\nEntrega: ${fee === 0 ? "grátis 🎉" : brl(fee)}` : "";
  return `📝 *Resumo do pedido*\n${cartSummary(data)}${feeLine}\n*Total: ${brl(total)}*\n\n${typeLine}${addressLine}\n💳 ${payLabel[data.paymentMethod ?? "PIX"]}${changeLine}\n\nDigite *confirmar* para enviar. ✅`;
}

async function buildMenuText(tenantId: string): Promise<string | null> {
  const categories = await prisma.category.findMany({
    where: { tenantId, active: true },
    orderBy: { displayOrder: "asc" },
    include: {
      products: {
        where: { available: true, internalCode: { not: null } },
        orderBy: { displayOrder: "asc" },
      },
    },
  });
  const sections = categories
    .filter((c) => c.products.length > 0)
    .map((c) => {
      const items = c.products
        .map((p) => {
          const price = p.promoPriceCents ?? p.priceCents;
          const promo = p.promoPriceCents ? " 🔥" : "";
          return `  *${p.internalCode}* — ${p.name} · ${brl(price)}${promo}`;
        })
        .join("\n");
      return `${c.icon ?? "🍽️"} *${c.name.toUpperCase()}*\n${items}`;
    });
  if (sections.length === 0) return null;
  return `📖 *NOSSO CARDÁPIO*\n\n${sections.join("\n\n")}`;
}

function hoursText(hours: { weekday: number; openTime: string; closeTime: string }[]) {
  const days = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  if (hours.length === 0) return "🕐 Consulte nossos horários pelo telefone.";
  const lines = [...hours]
    .sort((a, b) => a.weekday - b.weekday)
    .map((h) => `  ${days[h.weekday]}: ${h.openTime} às ${h.closeTime}`);
  return `🕐 *Horários de funcionamento*\n${lines.join("\n")}`;
}

function menuLink(slug: string) {
  return `${process.env.PUBLIC_WEB_URL ?? "http://localhost:5173"}/cardapio/${slug}`;
}
