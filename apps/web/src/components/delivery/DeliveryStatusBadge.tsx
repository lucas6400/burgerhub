import { Badge } from "../ui";
import { DELIVERY_STATUS_LABELS, type DeliveryStatus, type DelayRisk } from "../../pages/delivery/types";

const STATUS_COLOR: Record<DeliveryStatus, "gray" | "blue" | "green" | "amber" | "red" | "purple"> = {
  AWAITING_DRIVER: "gray",
  DRIVER_ASSIGNED: "blue",
  HEADING_TO_STORE: "blue",
  WAITING_PICKUP: "blue",
  PICKED_UP: "purple",
  OUT_FOR_DELIVERY: "blue",
  ARRIVING: "amber",
  DELIVERED: "green",
  FAILED: "red",
  CANCELED: "gray",
};

/** Badge de status da entrega — cor consistente em toda a Central de Despacho. */
export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  return <Badge color={STATUS_COLOR[status]}>{DELIVERY_STATUS_LABELS[status]}</Badge>;
}

const RISK_STYLE: Record<DelayRisk, string> = {
  normal: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  attention: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "bg-red-500/10 text-red-600 dark:text-red-400",
};

const RISK_LABEL: Record<DelayRisk, string> = {
  normal: "No prazo",
  attention: "Atenção",
  critical: "Atrasado",
};

/** Indicador de risco de atraso — verde/amarelo/vermelho, sem exagerar nas cores. */
export function DelayRiskBadge({ risk }: { risk: DelayRisk }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${RISK_STYLE[risk]}`}>
      {RISK_LABEL[risk]}
    </span>
  );
}
