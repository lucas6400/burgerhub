import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { AppError } from "./error.js";

export interface AuthPayload {
  userId: string;
  tenantId: string;
  role: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/** Exige JWT válido. Injeta req.auth com o tenant do usuário —
 *  TODA query subsequente DEVE filtrar por req.auth.tenantId. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AppError(401, "Token não informado");
  }
  try {
    const payload = jwt.verify(header.slice(7), env.jwtSecret) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    throw new AppError(401, "Token inválido ou expirado");
  }
}

const ROLE_LEVELS: Record<string, number> = {
  COURIER: 1,
  KITCHEN: 1,
  ATTENDANT: 2,
  DISPATCHER: 2,
  CASHIER: 3,
  MANAGER: 4,
  ADMIN: 5,
};

/** Exige nível mínimo de permissão (hierarquia de papéis). */
export function requireRole(minRole: keyof typeof ROLE_LEVELS) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.auth?.role ?? "";
    if ((ROLE_LEVELS[role] ?? 0) < ROLE_LEVELS[minRole]) {
      throw new AppError(403, "Sem permissão para esta ação");
    }
    next();
  };
}

/** Atalho: tenantId autenticado (lança se ausente). */
export function tenantOf(req: Request): string {
  const id = req.auth?.tenantId;
  if (!id) throw new AppError(401, "Não autenticado");
  return id;
}
