export const DELIVERY_STATUSES = [
  "AWAITING_DRIVER",
  "DRIVER_ASSIGNED",
  "HEADING_TO_STORE",
  "WAITING_PICKUP",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "ARRIVING",
  "DELIVERED",
  "FAILED",
  "CANCELED",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  AWAITING_DRIVER: "Aguardando entregador",
  DRIVER_ASSIGNED: "Entregador atribuído",
  HEADING_TO_STORE: "Indo para loja",
  WAITING_PICKUP: "Aguardando retirada",
  PICKED_UP: "Retirado",
  OUT_FOR_DELIVERY: "Saiu para entrega",
  ARRIVING: "Chegando",
  DELIVERED: "Entregue",
  FAILED: "Entrega falhou",
  CANCELED: "Cancelada",
};

export type DelayRisk = "normal" | "attention" | "critical";

export const DRIVER_STATUSES = [
  "OFFLINE",
  "AVAILABLE",
  "HEADING_TO_STORE",
  "WAITING_PICKUP",
  "DELIVERING",
  "RETURNING",
  "PAUSED",
] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const DRIVER_STATUS_LABELS: Record<DriverStatus, string> = {
  OFFLINE: "Offline",
  AVAILABLE: "Disponível",
  HEADING_TO_STORE: "Indo para loja",
  WAITING_PICKUP: "Na loja",
  DELIVERING: "Entregando",
  RETURNING: "Retornando",
  PAUSED: "Pausado",
};

export const VEHICLE_TYPE_LABELS: Record<string, string> = {
  MOTORCYCLE: "🏍️ Moto",
  BICYCLE: "🚲 Bike",
  CAR: "🚗 Carro",
  ON_FOOT: "🚶 A pé",
};

export interface DriverRow {
  id: string;
  name: string;
  phone: string;
  document?: string | null;
  vehicleType: string;
  vehiclePlate?: string | null;
  status: DriverStatus;
  active: boolean;
  currentLat?: number | null;
  currentLng?: number | null;
  lastLocationAt?: string | null;
  maxSimultaneousOrders: number;
  currentOrdersCount: number;
  hasAccess: boolean;
  createdAt: string;
}

export interface DeliveryOrderSummary {
  id: string;
  number: number;
  totalCents: number;
  createdAt: string;
  readyAt?: string | null;
  addressStreet?: string | null;
  addressNumber?: string | null;
  addressNeighborhood?: string | null;
  customer?: { name: string; phone: string } | null;
}

export interface DeliveryRow {
  id: string;
  orderId: string;
  status: DeliveryStatus;
  driverId?: string | null;
  driver?: DriverRow | null;
  stopSequence?: number | null;
  pickupLat: number;
  pickupLng: number;
  destinationLat?: number | null;
  destinationLng?: number | null;
  estimatedDistanceKm?: number | null;
  estimatedDurationMin?: number | null;
  estimatedDeliveryAt?: string | null;
  promisedDeliveryAt?: string | null;
  assignedAt?: string | null;
  createdAt: string;
  order: DeliveryOrderSummary;
  risk: DelayRisk;
}

export interface BoardCounts {
  activeOrders: number;
  preparing: number;
  awaitingDispatch: number;
  onRoute: number;
  delayed: number;
  driversActive: number;
  driversAvailable: number;
}

export interface GroupingOpportunity {
  deliveryIds: [string, string];
  orderNumbers: [number, number];
  separateDistanceKm: number;
  groupedDistanceKm: number;
  savingsKm: number;
  extraMinutes: number;
}

export interface DispatchBoardData {
  counts: BoardCounts;
  awaitingDispatch: DeliveryRow[];
  onRoute: DeliveryRow[];
  drivers: DriverRow[];
}
