import { AppError } from "../../middlewares/error.js";

export interface LoyaltyProgramConfig {
  type: string; // POINTS | CASHBACK | BUY_X_GET_Y
  active: boolean;
  pointsPerReal: number;
  cashbackPct: number;
}

/** Quanto o cliente ganha de pontos/cashback num pedido — sempre sobre o subtotal (sem frete/descontos). */
export function computeEarn(
  program: LoyaltyProgramConfig,
  subtotalCents: number,
): { points: number; cashbackCents: number } {
  if (!program.active) return { points: 0, cashbackCents: 0 };
  if (program.type === "CASHBACK") {
    return { points: 0, cashbackCents: Math.round((subtotalCents * program.cashbackPct) / 100) };
  }
  if (program.type === "POINTS") {
    return { points: Math.floor(subtotalCents / 100) * program.pointsPerReal, cashbackCents: 0 };
  }
  // BUY_X_GET_Y: v1 é só contador visual, sem crédito automático de pontos/cashback.
  return { points: 0, cashbackCents: 0 };
}

/** Valida e capa o resgate de cashback no checkout — nunca deixa o total negativo. */
export function validateRedeem(
  program: LoyaltyProgramConfig,
  customerCashbackCents: number,
  redeemCashbackCents: number,
  subtotalCents: number,
): number {
  if (!redeemCashbackCents || redeemCashbackCents <= 0) return 0;
  if (!program.active) throw new AppError(400, "Programa de fidelidade não está ativo");
  if (redeemCashbackCents > customerCashbackCents) {
    throw new AppError(400, "Saldo de cashback insuficiente");
  }
  return Math.min(redeemCashbackCents, customerCashbackCents, subtotalCents);
}
