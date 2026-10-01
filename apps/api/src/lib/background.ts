import { waitUntil } from "@vercel/functions";

/**
 * Trabalho de segundo plano (aviso no WhatsApp, push, etiqueta). Em serverless a
 * Vercel congela a função assim que a resposta HTTP sai — um `void promise` solto
 * pode ser cortado no meio (já deixou o pedido #53 sem ticket e sem "pedido recebido").
 * waitUntil mantém a função viva até a promessa terminar.
 */
export function background(promise: Promise<unknown>): void {
  waitUntil(promise);
}
