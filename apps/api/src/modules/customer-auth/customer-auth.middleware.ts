import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { AppError } from "../../middlewares/error.js";

export interface CustomerAuthPayload {
  scope: "customer";
  customerId: string;
  tenantId: string;
  tenantSlug: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customerAuth?: CustomerAuthPayload;
    }
  }
}

export function signCustomerToken(payload: CustomerAuthPayload) {
  return jwt.sign(payload, env.customerJwtSecret, { expiresIn: env.customerJwtExpiresIn });
}

function verifyCustomerToken(header: string | undefined): CustomerAuthPayload | null {
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const payload = jwt.verify(header.slice(7), env.customerJwtSecret) as CustomerAuthPayload;
    if (payload.scope !== "customer") return null;
    return payload;
  } catch {
    return null;
  }
}

/** Exige sessão de cliente válida para ESTA loja (impede reusar token de outro tenant). */
export function requireCustomerAuth(req: Request, _res: Response, next: NextFunction) {
  const payload = verifyCustomerToken(req.headers.authorization);
  if (!payload || payload.tenantSlug !== req.params.slug) {
    throw new AppError(401, "Sessão inválida ou expirada");
  }
  req.customerAuth = payload;
  next();
}

/** Igual, mas nunca bloqueia — usado no checkout público pra vincular o pedido quando o cliente estiver logado, sem exigir login. */
export function optionalCustomerAuth(req: Request, _res: Response, next: NextFunction) {
  const payload = verifyCustomerToken(req.headers.authorization);
  if (payload && payload.tenantSlug === req.params.slug) req.customerAuth = payload;
  next();
}
