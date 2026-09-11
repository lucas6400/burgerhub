import { createApp } from "../src/app.js";

// Entrypoint de função serverless da Vercel — sem app.listen(); a Vercel
// invoca este handler diretamente a cada requisição (Express é compatível
// com a assinatura (req, res) esperada pelo runtime Node da Vercel).
export default createApp();
