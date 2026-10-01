/**
 * Serializa a execução de `fn` por chave — usado para o processamento do
 * webhook do WhatsApp, onde duas mensagens do MESMO cliente podem chegar com
 * poucos segundos de diferença (comum: o cliente manda várias mensagens
 * seguidas). Sem isso, duas chamadas concorrentes de handleIncoming() podem
 * ler o mesmo ChatSession antes de qualquer uma delas salvar, e uma
 * sobrescreve o resultado da outra (carrinho errado, etapa pulada etc.).
 *
 * Só serializa dentro da MESMA instância de processo (em memória) — não é um
 * lock distribuído. Como a Vercel tende a reaproveitar a mesma instância
 * "quente" para requisições próximas no tempo (o cenário real que causava o
 * bug), isso resolve o caso prático; mesma limitação já aceita em outros
 * pontos do projeto (cache de geocoding, throttle de IA).
 */
const tails = new Map<string, Promise<void>>();

export function serializeByKey(key: string, fn: () => Promise<void>): Promise<void> {
  const tail = tails.get(key) ?? Promise.resolve();
  // .then(fn, fn): roda `fn` mesmo se a mensagem anterior tiver falhado, pra um
  // erro pontual não travar as próximas mensagens desse cliente para sempre.
  const next = tail.then(fn, fn).finally(() => {
    if (tails.get(key) === next) tails.delete(key);
  });
  tails.set(key, next);
  return next;
}
