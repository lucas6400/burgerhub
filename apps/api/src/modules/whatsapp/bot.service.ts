import { prisma } from "../../lib/prisma.js";
import { createOrder, quoteDelivery } from "../orders/orders.service.js";
import { reverseGeocode } from "../orders/geocoding.js";
import { recognizeCustomerIntent } from "./ai-intent.service.js";
import { onlinePaymentsAvailable, startPayment } from "../payments/payments.service.js";
import { handleAiConversation, saveLocationWhilePaused } from "./ai-conversation.service.js";
import { handleReceiptImage } from "./receipt-verification.service.js";
import type { WaRawImageMessage } from "./transport.js";

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
  address?: { street: string; number: string; neighborhood: string; city: string; lat?: number; lng?: number };
  deliveryFeeCents?: number;
  deliveryDistanceKm?: number;
  paymentMethod?: string;
  changeForCents?: number;
  pendingProductId?: string;
  pendingProductCode?: string;
  pendingClarifyContext?: string;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2h de inatividade reinicia a conversa
// Modo IA com carrinho aberto: o cliente costuma voltar horas depois ("Sim" à pergunta da equipe
// "podemos seguir com o seu pedido?") — reiniciar aos 2h jogava o pedido fora e o bot recomeçava do zero.
const AI_OPEN_CART_TTL_MS = 8 * 60 * 60 * 1000;

function hasOpenCart(sessionData: string): boolean {
  try {
    const draft = JSON.parse(sessionData)?.draft;
    return Array.isArray(draft?.cart) && draft.cart.length > 0 && !draft.finalizedOrderId;
  } catch {
    return false;
  }
}

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

/** Adiciona (ou soma +1 se já existir) um produto já revalidado pela IA — preço sempre do banco, nunca do texto. */
function addToCart(
  data: SessionData,
  product: { id: string; name: string; internalCode: string; priceCents: number; promoPriceCents: number | null },
) {
  const price = product.promoPriceCents ?? product.priceCents;
  const existing = data.cart.find((i) => i.productId === product.id);
  if (existing) existing.quantity = Math.min(50, existing.quantity + 1);
  else
    data.cart.push({
      productId: product.id,
      code: product.internalCode,
      name: product.name,
      unitPriceCents: price,
      quantity: 1,
    });
}

/** Aceita "2", "2*3" ou "2x3" (código × quantidade), igual ao PDV. */
function parseCode(raw: string): { code: string; qty: number } | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)\s*[*x]\s*(\d+)$/);
  if (m) return { code: m[1], qty: Math.min(50, parseInt(m[2], 10) || 1) };
  const single = raw.trim().toLowerCase().match(/^(\d+)$/);
  if (single) return { code: single[1], qty: 1 };
  return null;
}

/** Aceita o número da opção OU a palavra direto (cliente respondendo em texto livre). */
function parsePaymentMethod(lower: string): string | null {
  if (["1", "pix"].includes(lower)) return "PIX";
  if (["2", "dinheiro", "cash", "espécie", "especie", "em dinheiro"].includes(lower)) return "CASH";
  if (["3", "crédito", "credito", "cartão de crédito", "cartao de credito", "cartão crédito"].includes(lower))
    return "CREDIT";
  if (["4", "débito", "debito", "cartão de débito", "cartao de debito", "cartão débito"].includes(lower))
    return "DEBIT";
  return null;
}

export async function handleIncoming(
  tenantId: string,
  phone: string,
  rawText: string,
  pushName?: string,
  location?: { lat: number; lng: number },
  image?: WaRawImageMessage,
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
  // Atendente assumiu essa conversa na Central de Atendimento — bot fica calado.
  if (session?.botPausedUntil && session.botPausedUntil > new Date()) {
    // O bot fica calado, mas NÃO pode perder a localização que o cliente mandou: depois ele pediria de novo.
    if (location && tenant.settings.aiConversationEnabled) await saveLocationWhilePaused(tenantId, session.id, session.data, location);
    return [];
  }

  // Comprovante de Pix (imagem) pra um pedido preso esperando pagamento —
  // trata ANTES de decidir entre os dois modos do bot, então funciona igual
  // pros dois sem duplicar código. Imagem sem pedido pendente é ignorada
  // (nenhum dos dois modos faz algo especial com imagem solta hoje).
  if (image) {
    const pendingOrder = await prisma.order.findFirst({
      where: { tenantId, status: "AWAITING_PAYMENT", customer: { phone } },
      orderBy: { createdAt: "desc" },
    });
    if (pendingOrder) return handleReceiptImage(tenantId, pendingOrder, image);
  }

  // Modo beta: IA conduz a conversa inteira, sem o menu numerado abaixo — o
  // resto desta função fica intocado pra quem não ativou o interruptor.
  if (tenant.settings.aiConversationEnabled) {
    const idleMs = session ? Date.now() - session.updatedAt.getTime() : 0;
    const expiredAi = session && idleMs > SESSION_TTL_MS && !(idleMs <= AI_OPEN_CART_TTL_MS && hasOpenCart(session.data));
    if (!session || expiredAi) {
      session = await prisma.chatSession.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        update: { state: "AI_CONVO", data: "{}" },
        create: { tenantId, phone, state: "AI_CONVO", data: "{}" },
      });
    }
    return handleAiConversation(
      tenantId,
      phone,
      text,
      pushName,
      { ...tenant, settings: tenant.settings },
      session,
      location,
      image,
    );
  }

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
  if (["cancelar", "recomeçar", "recomecar", "menu", "sair", "voltar", "recomeçar tudo", "começar de novo", "comecar de novo"].includes(lower)) {
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
      // Mensagem livre (ex.: cliente veio de anúncio "Tenho interesse no
      // X-Bacon", ou pergunta se a loja entrega em tal lugar) — tenta
      // reconhecer a intenção antes de cair no menu genérico. Sem IA
      // configurada ou sem reconhecimento, comportamento idêntico ao de sempre.
      const intent = await recognizeCustomerIntent(tenantId, phone, text, tenant.name);
      if (intent?.kind === "product") {
        data.pendingProductId = intent.product.id;
        data.pendingProductCode = intent.product.internalCode;
        await save("MAIN_CONFIRM_PRODUCT");
        return [intent.replyText];
      }
      if (
        intent?.kind === "deliveryArea" ||
        intent?.kind === "generalDelivery" ||
        intent?.kind === "storeAddress"
      ) {
        return [intent.replyText];
      }
      if (intent?.kind === "clarify") {
        data.pendingClarifyContext = text;
        await save("MAIN_CLARIFY_PRODUCT");
        return [intent.question];
      }
      return [greeting(tenant.name, pushName)];
    }

    // ------------------------------------------------ ESCLARECENDO QUAL PRODUTO (2+ itens parecidos no catálogo)
    case "MAIN_CLARIFY_PRODUCT": {
      const original = data.pendingClarifyContext ?? "";

      const intent = await recognizeCustomerIntent(tenantId, phone, text, tenant.name, original);
      if (intent?.kind === "product") {
        data.pendingClarifyContext = undefined;
        data.pendingProductId = intent.product.id;
        data.pendingProductCode = intent.product.internalCode;
        await save("MAIN_CONFIRM_PRODUCT");
        return [intent.replyText];
      }
      if (intent?.kind === "clarify") {
        data.pendingClarifyContext = `${original} — ${text}`;
        await save("MAIN_CLARIFY_PRODUCT");
        return [intent.question];
      }
      if (
        intent?.kind === "deliveryArea" ||
        intent?.kind === "generalDelivery" ||
        intent?.kind === "storeAddress"
      ) {
        // Responde a pergunta sem perder o fio da meada — a dúvida sobre qual
        // produto (ex.: 1L ou 2L) continua pendente pra próxima mensagem.
        return [intent.replyText, "E aí, sobre o combo: qual das opções você prefere?"];
      }
      data.pendingClarifyContext = undefined;
      await save("MAIN");
      return ["Não consegui identificar certinho. 🤔", greeting(tenant.name, pushName)];
    }

    // ------------------------------------------------ CONFIRMAÇÃO DE PRODUTO RECONHECIDO PELA IA
    case "MAIN_CONFIRM_PRODUCT": {
      const negative = ["não", "nao", "n", "cancelar", "agora não", "agora nao", "depois"].includes(lower);
      const affirmative = ["sim", "s", "quero", "bora", "adicionar", "pode ser", "claro", "1"].includes(lower);
      const code = data.pendingProductCode;

      if (negative || !code) {
        data.pendingProductId = undefined;
        data.pendingProductCode = undefined;
        await save("MAIN");
        return [greeting(tenant.name, pushName)];
      }

      if (!affirmative) {
        // Não foi um "sim" nem um "não" claro — em vez de desistir e jogar o
        // cliente de volta pro menu genérico (o que ficava "engessado" demais
        // pra quem só queria escolher o tamanho certo do combo, por ex.),
        // deixa a IA reinterpretar a resposta à luz do catálogo de novo.
        const intent = await recognizeCustomerIntent(
          tenantId,
          phone,
          text,
          tenant.name,
          `estava confirmando o item de código ${code}`,
        );
        if (intent?.kind === "product") {
          data.pendingProductId = intent.product.id;
          data.pendingProductCode = intent.product.internalCode;
          await save("MAIN_CONFIRM_PRODUCT");
          return [intent.replyText];
        }
        if (
          intent?.kind === "deliveryArea" ||
          intent?.kind === "generalDelivery" ||
          intent?.kind === "storeAddress"
        ) {
          // Responde sem perder o item pendente — o cliente ainda pode
          // confirmar com *sim* na próxima mensagem.
          return [intent.replyText, "E sobre o pedido: posso confirmar? Digite *sim* ou *cancelar*."];
        }
        return ["Não entendi bem. 🤔 Pode confirmar com *sim*, pedir outro item, ou digitar *cancelar*."];
      }

      data.pendingProductId = undefined;
      data.pendingProductCode = undefined;

      // Revalida do zero — o item pode ter ficado indisponível nesse meio-tempo.
      const product = await prisma.product.findFirst({
        where: { tenantId, internalCode: code, available: true },
      });
      if (!product) {
        await save("MAIN");
        return ["Poxa, esse item não está mais disponível. 😕", greeting(tenant.name, pushName)];
      }

      const price = product.promoPriceCents ?? product.priceCents;
      data.cart.push({
        productId: product.id,
        code: product.internalCode!,
        name: product.name,
        unitPriceCents: price,
        quantity: 1,
      });
      await save("ORDERING");
      return [
        `✅ 1× *${product.name}* adicionado!\n\n${cartSummary(data)}\n\nEnvie mais códigos, *ok* para finalizar ou *limpar* para esvaziar.`,
      ];
    }

    // ------------------------------------------------ MONTANDO O PEDIDO
    case "ORDERING": {
      if (["ok", "finalizar", "pronto", "só isso", "so isso", "fechar pedido", "chega"].includes(lower)) {
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
      if (parsed) {
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

      // Não é um código — tenta reconhecer pergunta/produto por linguagem
      // natural (mesmo mecanismo do início da conversa) antes de desistir.
      // É o ponto mais comum de o cliente perguntar algo no meio do pedido
      // (ex.: "vocês entregam aí?"), então merece o mesmo tratamento.
      const intent = await recognizeCustomerIntent(tenantId, phone, text, tenant.name);
      if (intent?.kind === "product") {
        addToCart(data, intent.product);
        await save("ORDERING");
        return [
          `✅ 1× *${intent.product.name}* adicionado!\n\n${cartSummary(data)}\n\nEnvie mais códigos, *ok* para finalizar ou *limpar* para esvaziar.`,
        ];
      }
      if (intent?.kind === "clarify") {
        data.pendingClarifyContext = text;
        await save("ORDERING_CLARIFY");
        return [intent.question];
      }
      if (
        intent?.kind === "deliveryArea" ||
        intent?.kind === "generalDelivery" ||
        intent?.kind === "storeAddress"
      ) {
        return [intent.replyText];
      }
      return [
        "Não entendi. 🤔 Envie o *código* do item (ex.: *2* ou *2x3*), *ok* para finalizar ou *cancelar* para recomeçar.",
      ];
    }

    // ------------------------------------------------ ESCLARECENDO QUAL PRODUTO (durante a montagem do pedido)
    case "ORDERING_CLARIFY": {
      const original = data.pendingClarifyContext ?? "";
      const intent = await recognizeCustomerIntent(tenantId, phone, text, tenant.name, original);
      if (intent?.kind === "product") {
        data.pendingClarifyContext = undefined;
        addToCart(data, intent.product);
        await save("ORDERING");
        return [
          `✅ 1× *${intent.product.name}* adicionado!\n\n${cartSummary(data)}\n\nEnvie mais códigos, *ok* para finalizar ou *limpar* para esvaziar.`,
        ];
      }
      if (intent?.kind === "clarify") {
        data.pendingClarifyContext = `${original} — ${text}`;
        await save("ORDERING_CLARIFY");
        return [intent.question];
      }
      if (
        intent?.kind === "deliveryArea" ||
        intent?.kind === "generalDelivery" ||
        intent?.kind === "storeAddress"
      ) {
        return [intent.replyText, "E sobre o item: qual das opções você prefere?"];
      }
      data.pendingClarifyContext = undefined;
      await save("ORDERING");
      return ["Não consegui identificar certinho. 🤔 Envie o *código* do item, ou me diga de novo o que você quer."];
    }

    // ------------------------------------------------ ENTREGA OU RETIRADA
    case "CHECKOUT_TYPE": {
      if (["1", "entrega", "delivery", "entregar"].includes(lower)) {
        data.type = "DELIVERY";
        await save("CHECKOUT_ADDRESS");
        return [
          "📍 Me envie sua *localização* pelo WhatsApp:\ntoque no 📎 (clipe) → *Localização* → *Enviar localização atual*.\n\nSe preferir, pode digitar o endereço (rua, número, bairro).",
        ];
      }
      if (["2", "retirada", "retirar", "buscar", "balcão", "balcao"].includes(lower)) {
        data.type = "PICKUP";
        await save("CHECKOUT_PAYMENT");
        return [paymentPrompt()];
      }
      return ["Responda *1* para entrega 🛵 ou *2* para retirada 🏃"];
    }

    // ------------------------------------------------ ENDEREÇO
    case "CHECKOUT_ADDRESS": {
      let address: { street: string; number: string; neighborhood: string; city: string };
      const lat = location?.lat;
      const lng = location?.lng;

      if (location) {
        const reverse = await reverseGeocode(location);
        // Bairro fica de fora: em Palmas (endereço por quadra) o geocodificador
        // gratuito costuma "chutar" um distrito genérico ("103 Norte") mesmo com
        // o PINO certo — já confundiu a equipe achando que a localização veio errada.
        address = { ...(reverse ?? { street: "Localização compartilhada", number: "", neighborhood: "", city: "" }), neighborhood: "" };
      } else {
        const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
        // Formato ideal é "rua, número, bairro", mas se o cliente mandar
        // corrido (sem vírgulas certinhas), tenta geocodificar o texto
        // inteiro em vez de travar pedindo pra reformatar.
        address =
          parts.length >= 3
            ? { street: parts[0], number: parts[1], neighborhood: parts[2], city: parts[3] ?? parts[2] }
            : { street: "", number: "", neighborhood: text, city: "" };
      }

      // Taxa calculada automaticamente pela distância até o estabelecimento
      try {
        const quote = await quoteDelivery(tenantId, { ...address, lat, lng }, cartTotal(data));
        // Texto sem pino cai num ponto "chutado" do bairro — dentro de zona desenhada
        // isso pode aceitar entrega fora da área. Sem certeza, exige a localização.
        if (!location && !quote.precise && quote.zoneName) {
          return ["📍 Não consigo confirmar esse endereço só pelo texto. Me manda sua *localização*: toque no 📎 (clipe) → *Localização* → *Enviar localização atual*."];
        }
        // Sem vir de localização/formato estruturado, tenta transformar o ponto
        // encontrado num endereço legível pra guardar/mostrar mais bonito.
        if (!location && !address.number) {
          const reverse = await reverseGeocode(quote.point);
          if (reverse) address = reverse;
        }
        // Guarda o pino quando veio de localização — senão o pedido re-geocodifica o texto.
        data.address = location ? { ...address, lat, lng } : address;
        data.deliveryFeeCents = quote.feeCents;
        data.deliveryDistanceKm = quote.distanceKm;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Não consegui calcular a entrega para esse endereço.";
        return [
          `😕 ${msg}\nPode me mandar sua 📍 *localização*? (📎 → *Localização* → *Enviar localização atual*). Se preferir, digite o endereço.`,
        ];
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
      const method = parsePaymentMethod(lower);
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
      const affirmativeConfirm = [
        "confirmar",
        "confirmo",
        "confirmado",
        "sim",
        "s",
        "ok",
        "okay",
        "beleza",
        "blz",
        "fechado",
        "certo",
        "isso",
        "pode confirmar",
        "pode ser",
        "manda",
        "correto",
      ];
      if (!affirmativeConfirm.includes(lower)) {
        return ["Digite *confirmar* para enviar o pedido ou *cancelar* para recomeçar. 😉"];
      }
      try {
        // Pix automático via Mercado Pago quando o estabelecimento tem online
        // conectado — o pedido nasce "ONLINE" (mesmo campo que o cardápio web
        // usa) pra reaproveitar os selos de pagamento já existentes no painel.
        // Sem Mercado Pago conectado (ou se a chamada falhar), cai no fluxo
        // manual de sempre (chave fixa + comprovante), sem travar o pedido.
        const useOnlinePix =
          data.paymentMethod === "PIX" && tenant.settings.botAutoPixEnabled && onlinePaymentsAvailable(tenant.settings);

        const order = await createOrder({
          tenantId,
          source: "WHATSAPP",
          type: data.type ?? "PICKUP",
          paymentMethod: useOnlinePix ? "ONLINE" : (data.paymentMethod ?? "PIX"),
          changeForCents: data.changeForCents,
          customer: { name: pushName || `Cliente ${phone.slice(-4)}`, phone },
          address: data.address,
          items: data.cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
        });
        data.cart = [];
        await save("MAIN");

        // O código do Pix vai numa mensagem SÓ dele (sem nenhum outro texto
        // junto) — no WhatsApp, um toque-e-segure copia a mensagem inteira, e
        // misturado com o resto do texto fica fácil copiar errado.
        let pixIntro = "";
        let pixCode = "";
        if (useOnlinePix) {
          try {
            const payment = await startPayment({ tenantId, tenantSlug: tenant.slug, orderId: order.id, method: "PIX" });
            if (payment.pixQrCode) {
              pixIntro = "💠 *Pix Copia e Cola* — toque e segure a mensagem abaixo pra copiar:";
              pixCode = payment.pixQrCode;
            }
          } catch (err) {
            console.error("Falha ao gerar Pix automático, cliente cai no fluxo manual:", err);
          }
        }
        if (!pixCode && order.paymentMethod === "PIX" && tenant.settings.pixKey) {
          pixIntro = "💠 *Chave Pix* — toque e segure a mensagem abaixo pra copiar:";
          pixCode = tenant.settings.pixKey;
        }
        // Entrega no Pix fica presa (AWAITING_PAYMENT) até confirmar o
        // pagamento — nunca afirmar que já entrou em produção nesse caso.
        // Retirada no Pix (não bloqueada) mantém o texto simples de sempre.
        const isGated = order.status === "AWAITING_PAYMENT";
        const pixFollowUp = useOnlinePix
          ? "Assim que cair, confirmo automaticamente por aqui — não precisa mandar comprovante. ✅"
          : !pixCode
            ? ""
            : isGated
              ? "Envie o comprovante aqui assim que pagar — eu confiro automaticamente e libero seu pedido pra cozinha. 🙏"
              : "Envie o comprovante por aqui. 🙏";
        const closingLine = isGated
          ? "Assim que o Pix cair, seu pedido entra direto na produção! 🍔"
          : "Vou te avisando por aqui a cada etapa! 🍔";

        return [
          `🎉 *Pedido #${order.number} confirmado!*\nTotal: *${brl(order.totalCents)}*\nTempo estimado: ${tenant.settings.defaultPrepMinutes}–${tenant.settings.defaultPrepMinutes + 20} min.\n\n${closingLine}`,
          ...(pixCode ? [pixIntro, pixCode] : []),
          ...(pixFollowUp ? [pixFollowUp] : []),
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
