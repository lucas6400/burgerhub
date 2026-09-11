/**
 * Envio via WhatsApp Cloud API oficial (Meta) — alternativa ao Evolution API
 * (transport.ts) pra tenants que conectam o PRÓPRIO número via Embedded
 * Signup em vez de QR code. Diferente do Evolution, aqui não existe conceito
 * de "instância": cada tenant já tem um `phone_number_id` e um access token
 * próprios, obtidos no fluxo de conexão (ainda não implementado — depende da
 * BurgerHub ter App/Business verificados na Meta).
 *
 * Contrato confirmado contra a documentação pública e estável da Cloud API
 * (endpoint de envio de texto não muda há anos), mas NUNCA testado contra uma
 * conta/token reais nesta sessão — validar com um número de teste antes de
 * habilitar para qualquer tenant em produção.
 */
const GRAPH_API_VERSION = "v21.0";

export async function cloudApiSendText(phoneNumberId: string, accessToken: string, to: string, text: string) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to.replace(/\D/g, ""),
      type: "text",
      text: { body: text },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`WhatsApp Cloud API respondeu ${res.status}: ${detail}`);
  }
}
