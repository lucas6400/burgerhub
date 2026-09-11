/**
 * Abstração de provedor de entrega — desacopla a Central de Despacho de QUEM
 * está de fato entregando (frota própria hoje; iFood Entregas na Fase 6).
 * Nenhuma regra de um provedor específico deve vazar pro DispatchService.
 */
import { assignDriver, advanceDeliveryStatus, type DeliveryStatus } from "./delivery.service.js";
import { prisma } from "../../lib/prisma.js";

export interface DeliveryProvider {
  /** Aceita/confirma o recebimento de uma entrega já criada internamente. */
  acceptOrder(deliveryId: string, tenantId: string): Promise<void>;
  /** Solicita a um provedor externo que busque/entregue um pedido. Frota própria: no-op. */
  requestDelivery(deliveryId: string, tenantId: string): Promise<void>;
  /** Atualiza o status da entrega (chamado tanto pelo operador quanto por webhook externo, no futuro). */
  updateDeliveryStatus(
    deliveryId: string,
    tenantId: string,
    status: DeliveryStatus,
    opts?: { userId?: string; driverId?: string },
  ): Promise<unknown>;
  cancelDelivery(deliveryId: string, tenantId: string, reason?: string): Promise<unknown>;
  getDeliveryStatus(deliveryId: string, tenantId: string): Promise<DeliveryStatus | null>;
}

/** Implementação atual: frota própria (entregadores cadastrados no próprio tenant). */
export class InternalDeliveryProvider implements DeliveryProvider {
  async acceptOrder(): Promise<void> {
    // Frota própria: a entrega já nasce "aceita" ao ficar pronta (createDeliveryForOrder).
  }

  async requestDelivery(deliveryId: string, tenantId: string): Promise<void> {
    // Frota própria não "solicita" a ninguém — o despacho é manual/automático
    // via assignDriver. Método existe pra manter a mesma interface de futuros
    // provedores externos (ex.: acionar a API do iFood aqui).
    void deliveryId;
    void tenantId;
  }

  async updateDeliveryStatus(
    deliveryId: string,
    tenantId: string,
    status: DeliveryStatus,
    opts?: { userId?: string; driverId?: string },
  ) {
    if (status === "DRIVER_ASSIGNED" && opts?.driverId) {
      return assignDriver({ tenantId, deliveryId, driverId: opts.driverId, userId: opts.userId });
    }
    return advanceDeliveryStatus({ tenantId, deliveryId, toStatus: status, userId: opts?.userId });
  }

  async cancelDelivery(deliveryId: string, tenantId: string, reason?: string) {
    return advanceDeliveryStatus({ tenantId, deliveryId, toStatus: "CANCELED", userId: undefined, failedReason: reason });
  }

  async getDeliveryStatus(deliveryId: string, tenantId: string): Promise<DeliveryStatus | null> {
    const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, tenantId } });
    return (delivery?.status as DeliveryStatus) ?? null;
  }
}

/**
 * iFood Entregas — pede pra logística do iFood buscar e entregar um pedido
 * que chegou por um canal PRÓPRIO da loja (cardápio/WhatsApp/balcão), não um
 * pedido do marketplace iFood. Fica atrás da mesma interface do InternalDeliveryProvider
 * pra Central de Despacho não precisar saber quem está entregando de fato.
 *
 * SEM client secret configurado (padrão), roda 100% em modo demonstração — só
 * loga no console, igual ao mock de WhatsApp (transport.ts). Com credenciais
 * reais (Configurações → iFood), tenta o fluxo real de OAuth + despacho — mas
 * os endpoints abaixo seguem a documentação pública do Portal do Parceiro
 * iFood conhecida até o momento desta implementação e NÃO foram testados
 * contra uma conta real (não há credenciais disponíveis nesta sessão).
 * Antes de habilitar em produção, valide num pedido de teste real e confira
 * a documentação atual em developer.ifood.com.br — o contrato pode ter mudado.
 */
export class IFoodDeliveryProvider implements DeliveryProvider {
  constructor(
    private readonly credentials: { merchantId: string; clientId: string; clientSecret: string } | null,
  ) {}

  private get mock() {
    return !this.credentials;
  }

  private async getAccessToken(): Promise<string> {
    if (!this.credentials) throw new Error("iFood não configurado");
    const res = await fetch("https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grantType: "client_credentials",
        clientId: this.credentials.clientId,
        clientSecret: this.credentials.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`iFood OAuth falhou (${res.status})`);
    const data = (await res.json()) as { accessToken: string };
    return data.accessToken;
  }

  async acceptOrder(deliveryId: string): Promise<void> {
    if (this.mock) {
      console.log(`📦 [iFood demo] Confirmando recebimento da entrega ${deliveryId}`);
      return;
    }
    // Real: os pedidos do MARKETPLACE iFood chegam por webhook e precisam ser
    // confirmados via POST /order/v1.0/orders/{id}/confirm — não é o caso aqui
    // (iFood Entregas atua sobre pedido já criado pela própria loja), mantido
    // só pra fechar a interface caso o merchant também receba pedidos do app iFood.
  }

  async requestDelivery(deliveryId: string, tenantId: string): Promise<void> {
    const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, tenantId }, include: { order: true } });
    if (!delivery) return;

    if (this.mock) {
      console.log(
        `📦 [iFood demo] Solicitando entregador do iFood para o pedido #${delivery.order.number} ` +
          `(destino: ${delivery.destinationLat}, ${delivery.destinationLng})`,
      );
      return;
    }

    const token = await this.getAccessToken();
    // Endpoint de despacho pra logística do iFood — confirmar path exato na
    // documentação do Portal do Parceiro antes de usar em produção.
    await fetch(`https://merchant-api.ifood.com.br/logistics/v1.0/merchants/${this.credentials!.merchantId}/deliveries`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        externalDeliveryId: delivery.id,
        destination: { lat: delivery.destinationLat, lng: delivery.destinationLng },
      }),
    });
  }

  async updateDeliveryStatus(
    deliveryId: string,
    tenantId: string,
    status: DeliveryStatus,
    opts?: { userId?: string; driverId?: string },
  ) {
    if (this.mock) {
      console.log(`📦 [iFood demo] Status da entrega ${deliveryId} avançou para ${status} (sincronizaria com o iFood aqui)`);
    }
    // A entrega em si continua sendo controlada localmente (mesma máquina de
    // estados) — o provedor externo só espelha o status, não substitui o
    // Delivery.status que o resto do sistema (board, app do entregador) usa.
    if (status === "DRIVER_ASSIGNED" && opts?.driverId) {
      return assignDriver({ tenantId, deliveryId, driverId: opts.driverId, userId: opts.userId });
    }
    return advanceDeliveryStatus({ tenantId, deliveryId, toStatus: status, userId: opts?.userId });
  }

  async cancelDelivery(deliveryId: string, tenantId: string, reason?: string) {
    if (this.mock) {
      console.log(`📦 [iFood demo] Cancelando entrega ${deliveryId} junto ao iFood (${reason ?? "sem motivo informado"})`);
    }
    return advanceDeliveryStatus({ tenantId, deliveryId, toStatus: "CANCELED", userId: undefined, failedReason: reason });
  }

  async getDeliveryStatus(deliveryId: string, tenantId: string): Promise<DeliveryStatus | null> {
    const delivery = await prisma.delivery.findFirst({ where: { id: deliveryId, tenantId } });
    return (delivery?.status as DeliveryStatus) ?? null;
  }
}

const internalProvider = new InternalDeliveryProvider();

/** Resolve qual provedor usar PRA ESTE tenant — cada loja escolhe a própria logística. */
export async function getDeliveryProviderFor(tenantId: string): Promise<DeliveryProvider> {
  const settings = await prisma.tenantSettings.findUnique({ where: { tenantId } });
  if (!settings?.ifoodEnabled) return internalProvider;

  const credentials =
    settings.ifoodMerchantId && settings.ifoodClientId && settings.ifoodClientSecret
      ? { merchantId: settings.ifoodMerchantId, clientId: settings.ifoodClientId, clientSecret: settings.ifoodClientSecret }
      : null;
  return new IFoodDeliveryProvider(credentials);
}
