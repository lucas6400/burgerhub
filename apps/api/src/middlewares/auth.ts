import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
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

/**
 * Cargo e "ativo" ficam no token (12h), então sozinhos não refletem mudança nenhuma: usuário desativado seguia com
 * acesso e troca de cargo só valia no próximo login. Confere no banco com cache curto (20s) — o suficiente pra
 * a mudança valer quase na hora sem uma consulta por requisição.
 */
const USER_STATE_TTL_MS = 20_000;
const userStateCache = new Map<string, { role: string; active: boolean; at: number }>();

async function currentUserState(userId: string): Promise<{ role: string; active: boolean } | null> {
  const cached = userStateCache.get(userId);
  if (cached && Date.now() - cached.at < USER_STATE_TTL_MS) return cached;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
  if (!user) return null;
  userStateCache.set(userId, { ...user, at: Date.now() });
  return user;
}

/** Chamado depois de editar/desativar/remover um usuário, pra a mudança valer já nesta instância. */
export function invalidateUserState(userId: string): void {
  userStateCache.delete(userId);
}

/** Exige JWT válido. Injeta req.auth com o tenant do usuário —
 *  TODA query subsequente DEVE filtrar por req.auth.tenantId. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return next(new AppError(401, "Token não informado"));
  }
  let payload: AuthPayload;
  try {
    payload = jwt.verify(header.slice(7), env.jwtSecret) as AuthPayload;
  } catch {
    return next(new AppError(401, "Token inválido ou expirado"));
  }
  try {
    const state = await currentUserState(payload.userId);
    if (!state || !state.active) return next(new AppError(401, "Acesso desativado. Fale com o administrador."));
    req.auth = { ...payload, role: state.role };
    next();
  } catch (err) {
    next(err);
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
