import type { NextFunction, Request, Response } from "express";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Rate limit simples em memória. Em produção, usar Redis.
 * Por padrão, chave por IP + rota (usando o padrão da rota, não a URL literal,
 * para não confundir buckets entre rotas diferentes montadas no mesmo router).
 * Passe `keyFn` para limitar por outra dimensão (ex.: por pedido).
 */
export function rateLimit(maxRequests: number, windowMs: number, keyFn?: (req: Request) => string) {
  return (req: Request, res: Response, next: NextFunction) => {
    // req.route só existe depois que o Express casa a rota específica (é o caso de
    // todo uso dentro de um router); em middleware de nível de app (sem rota casada
    // ainda), cai para req.baseUrl — preservando um único bucket global como antes.
    const routePattern = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.baseUrl;
    const key = `${keyFn ? keyFn(req) : req.ip}:${routePattern}`;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count++;
    if (bucket.count > maxRequests) {
      return res.status(429).json({ error: "Muitas requisições. Tente novamente em instantes." });
    }
    next();
  };
}

// Limpeza periódica para não vazar memória
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key);
  }
}, 60_000).unref();
