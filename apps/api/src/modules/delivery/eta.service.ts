/**
 * ETAService — previsão de horário de entrega e nível de risco de atraso.
 * Regra fica só aqui: telas apenas exibem o resultado.
 */

export type DelayRisk = "normal" | "attention" | "critical";

/** Minutos de folga aplicados sempre, pra absorver imprevistos operacionais. */
export const OPERATIONAL_BUFFER_MINUTES = 5;

export interface EstimateDeliveryInput {
  /** Minutos restantes até o pedido ficar pronto na cozinha (0 se já está pronto). */
  prepMinutesRemaining: number;
  /** Minutos até o entregador chegar na loja (0 se ele já está lá / já foi atribuído perto). */
  driverToStoreMinutes: number;
  /** Minutos de deslocamento da loja até o cliente. */
  travelMinutes: number;
  /** Minutos fixos de coleta no balcão (embalar, conferir). */
  pickupMinutes?: number;
}

export function estimateDeliveryTime(input: EstimateDeliveryInput, from: Date = new Date()) {
  const pickupMinutes = input.pickupMinutes ?? 2;
  const totalMinutes =
    Math.max(input.prepMinutesRemaining, input.driverToStoreMinutes) + // o que demorar mais define quando a coleta pode começar
    pickupMinutes +
    input.travelMinutes +
    OPERATIONAL_BUFFER_MINUTES;

  const estimatedAt = new Date(from.getTime() + totalMinutes * 60_000);
  return { estimatedMinutes: Math.round(totalMinutes), estimatedAt };
}

/**
 * Compara a previsão atual com o horário prometido ao cliente (se houver) pra
 * classificar o risco. Sem horário prometido, usa só a folga operacional como
 * referência de "atenção".
 */
export function delayRisk(
  estimatedAt: Date,
  promisedAt: Date | null | undefined,
  now: Date = new Date(),
): DelayRisk {
  if (promisedAt) {
    if (now > promisedAt) return "critical";
    const minutesToPromise = (promisedAt.getTime() - now.getTime()) / 60_000;
    if (minutesToPromise <= OPERATIONAL_BUFFER_MINUTES) return "attention";
    return "normal";
  }
  const minutesToEstimate = (estimatedAt.getTime() - now.getTime()) / 60_000;
  if (minutesToEstimate < 0) return "critical";
  if (minutesToEstimate <= OPERATIONAL_BUFFER_MINUTES) return "attention";
  return "normal";
}
