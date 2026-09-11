export interface OrderItemAddon {
  id: string;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
}

export interface OrderItemRemoval {
  id: string;
  nameSnapshot: string;
}

export interface OrderItem {
  id: string;
  nameSnapshot: string;
  unitPriceCents: number;
  quantity: number;
  notes?: string | null;
  showInKds?: boolean;
  addons: OrderItemAddon[];
  removals: OrderItemRemoval[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string | null;
  tier: string;
  loyaltyPoints?: number;
  cashbackCents?: number;
}

export interface LoyaltyProgram {
  type: string;
  active: boolean;
  pointsPerReal: number;
  cashbackPct: number;
  buyX: number;
  getY: string;
  validityDays: number;
}

export interface Table {
  id: string;
  number: number;
  seats: number;
  status: string;
  openedAt?: string | null;
  openOrdersCount?: number;
  runningTotalCents?: number;
}

export interface Order {
  id: string;
  number: number;
  status: string;
  type: string;
  source: string;
  priority: boolean;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  paymentMethod: string | null;
  paymentStatus: string;
  changeForCents?: number | null;
  couponCode?: string | null;
  notes?: string | null;
  addressStreet?: string | null;
  addressNumber?: string | null;
  addressNeighborhood?: string | null;
  addressCity?: string | null;
  addressComplement?: string | null;
  createdAt: string;
  customer?: Customer | null;
  table?: { number: number } | null;
  items: OrderItem[];
}

export interface Product {
  id: string;
  name: string;
  description?: string | null;
  priceCents: number;
  promoPriceCents?: number | null;
  imageUrl?: string | null;
  categoryId: string;
  available: boolean;
  showInKds: boolean;
  prepMinutes: number;
  weightGrams?: number | null;
  sku?: string | null;
  internalCode?: string | null;
  displayOrder: number;
  featured?: boolean;
  favorite?: boolean;
  category?: { id: string; name: string };
  ingredients?: {
    id: string;
    quantity: number;
    removable: boolean;
    ingredient: { id: string; name: string; unit: string };
  }[];
  addonGroups?: {
    group: {
      id: string;
      name: string;
      minSelect: number;
      maxSelect: number;
      required: boolean;
      addons: Addon[];
    };
  }[];
}

export interface Addon {
  id: string;
  name: string;
  priceCents: number;
  maxQty: number;
  available: boolean;
}

export interface Category {
  id: string;
  name: string;
  icon?: string | null;
  displayOrder: number;
  active: boolean;
  _count?: { products: number };
}
