const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error(
    "JWT_SECRET não configurado. Defina essa variável de ambiente antes de iniciar a API.",
  );
}

export const env = {
  port: Number(process.env.PORT ?? 3333),
  jwtSecret,
  jwtExpiresIn: "12h" as const,
  // Infraestrutura de WhatsApp da PLATAFORMA (invisível para o tenant).
  // O lojista só escaneia o QR Code — toda a configuração fica aqui.
  whatsapp: {
    serverUrl: process.env.WA_SERVER_URL ?? "",
    apiKey: process.env.WA_SERVER_KEY ?? "",
    /** URL pública desta API, usada para receber webhooks de mensagens. */
    publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3333}`,
    /** Modo demonstração: simula conexão sem servidor de WhatsApp real. */
    mock: process.env.WA_MOCK === "true",
  },
  mercadoPago: {
    /** Modo demonstração: simula Pix/cartão sem conta Mercado Pago real. */
    mock: process.env.MP_MOCK === "true",
    // Credenciais da APLICAÇÃO BurgerHub no Mercado Pago Developers (diferente
    // do Access Token de cada loja) — habilitam "Conectar com Mercado Pago"
    // em 1 clique via OAuth em vez do lojista colar token manualmente.
    oauthClientId: process.env.MP_OAUTH_CLIENT_ID ?? "",
    oauthClientSecret: process.env.MP_OAUTH_CLIENT_SECRET ?? "",
  },
  // E-mail transacional (recuperação de senha). Sem RESEND_API_KEY configurada,
  // roda em modo demonstração: o link só é registrado no log do servidor.
  email: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.EMAIL_FROM ?? "BurgerHub <onboarding@resend.dev>",
  },
  publicWebUrl: process.env.PUBLIC_WEB_URL ?? "http://localhost:5173",
  /** URL pública desta API — usada em callbacks OAuth (Mercado Pago) e webhooks. */
  publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 3333}`,
};
