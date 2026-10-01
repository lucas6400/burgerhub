import { api } from "./api";

// VAPID public key vem em base64url — o navegador espera um Uint8Array puro.
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";
}

export async function getPushSubscriptionStatus(): Promise<"subscribed" | "not-subscribed"> {
  if (!pushSupported()) return "not-subscribed";
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const sub = await registration?.pushManager.getSubscription();
  return sub ? "subscribed" : "not-subscribed";
}

/** Pede permissão, assina o push e manda a inscrição pro servidor. Só chame a partir de um clique do usuário. */
export async function enablePushNotifications(): Promise<void> {
  if (!pushSupported()) throw new Error("Esse navegador não suporta notificações push.");

  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Permissão de notificação negada.");

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const { publicKey } = await api.get<{ publicKey: string }>("/push/vapid-public-key");
  if (!publicKey) throw new Error("Notificação push não está configurada no servidor.");

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    });
  }

  const json = subscription.toJSON();
  await api.post("/push/subscribe", { endpoint: json.endpoint, keys: json.keys });
}

export async function disablePushNotifications(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  await api.delete(`/push/subscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`).catch(() => {});
  await subscription.unsubscribe();
}
