import webpush from "web-push";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!env.vapid.publicKey || !env.vapid.privateKey) return false;
  webpush.setVapidDetails(env.vapid.subject, env.vapid.publicKey, env.vapid.privateKey);
  configured = true;
  return true;
}

interface NewOrderInfo {
  number: number;
  totalCents: number;
  type: string;
}

const TYPE_LABELS: Record<string, string> = { DELIVERY: "Entrega", PICKUP: "Retirada", DINE_IN: "Mesa" };

/** Avisa todos os dispositivos do staff inscritos nesse tenant — pedido chegou mesmo com o painel fechado. */
export async function sendNewOrderPush(tenantId: string, order: NewOrderInfo) {
  if (!ensureConfigured()) return;

  const subscriptions = await prisma.pushSubscription.findMany({ where: { tenantId } });
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: "🔔 Novo pedido!",
    body: `Pedido #${order.number} · R$ ${(order.totalCents / 100).toFixed(2)} · ${TYPE_LABELS[order.type] ?? order.type}`,
    url: "/pedidos",
  });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          // Inscrição não existe mais no navegador (desinstalou, limpou dados etc.)
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
        } else {
          console.error("Falha ao enviar push:", err);
        }
      }
    }),
  );
}
