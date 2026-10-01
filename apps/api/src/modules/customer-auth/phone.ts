import { AppError } from "../../middlewares/error.js";

/** Só dígitos, DDD + número (10 ou 11 dígitos) — mesmo formato já usado no resto do app. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) {
    throw new AppError(400, "Telefone inválido — informe DDD + número");
  }
  return digits;
}
