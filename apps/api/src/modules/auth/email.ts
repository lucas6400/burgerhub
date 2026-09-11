import { env } from "../../config/env.js";

/**
 * Envio de e-mail transacional (recuperação de senha). Sem RESEND_API_KEY
 * configurada, roda em modo demonstração — o link só aparece no log do
 * servidor, igual ao modo mock do WhatsApp (transport.ts).
 */
export async function sendPasswordResetEmail(to: string, userName: string, resetUrl: string) {
  const subject = "Redefinir senha — BurgerHub";
  const html = `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <p>Olá, ${userName}!</p>
      <p>Recebemos um pedido para redefinir a senha da sua conta no BurgerHub.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;background:#f59e0b;color:#fff;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600;">
          Redefinir senha
        </a>
      </p>
      <p>Esse link expira em 1 hora. Se você não pediu isso, pode ignorar este e-mail.</p>
    </div>
  `;

  if (!env.email.apiKey) {
    console.log(`📧 [E-mail demo] Redefinição de senha para ${to}:\n${resetUrl}\n`);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.email.apiKey}`,
    },
    body: JSON.stringify({ from: env.email.from, to, subject, html }),
  });
  if (!res.ok) {
    console.error(`Falha ao enviar e-mail de redefinição (status ${res.status}):`, await res.text().catch(() => ""));
  }
}
