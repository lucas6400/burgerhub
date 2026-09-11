import { X } from "lucide-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

// ---------- Button ----------

const buttonVariants = {
  primary:
    "bg-brand-500 text-white hover:bg-brand-600 shadow-sm shadow-brand-500/20 disabled:opacity-50",
  secondary:
    "bg-surface-100 text-surface-800 hover:bg-surface-200 dark:bg-surface-800 dark:text-surface-100 dark:hover:bg-surface-700",
  ghost:
    "text-surface-600 hover:bg-surface-100 dark:text-surface-300 dark:hover:bg-surface-800",
  danger: "bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400",
} as const;

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof buttonVariants;
  size?: "sm" | "md" | "lg";
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonProps) {
  const sizes = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm", lg: "px-5 py-3 text-base" };
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${buttonVariants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// ---------- Card ----------

export function Card({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={`rounded-2xl border border-surface-200 bg-white shadow-sm dark:border-surface-800 dark:bg-surface-900 ${className}`}
    >
      {children}
    </div>
  );
}

// ---------- Inputs ----------

const fieldClass =
  "w-full rounded-xl border border-surface-200 bg-white px-3.5 py-2.5 text-sm text-surface-900 placeholder-surface-400 outline-none transition-all focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-surface-700 dark:bg-surface-850 dark:text-surface-100";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${fieldClass} ${className}`} {...props} />;
  },
);

export function Textarea({ className = "", ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldClass} ${className}`} {...props} />;
}

export function Select({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldClass} ${className}`} {...props} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-surface-500 dark:text-surface-400">
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------- Badge ----------

const badgeColors = {
  gray: "bg-surface-100 text-surface-600 dark:bg-surface-800 dark:text-surface-300",
  green: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  red: "bg-red-500/10 text-red-600 dark:text-red-400",
  blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  purple: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
} as const;

export function Badge({
  color = "gray",
  children,
}: {
  color?: keyof typeof badgeColors;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${badgeColors[color]}`}
    >
      {children}
    </span>
  );
}

export const statusBadgeColor: Record<string, keyof typeof badgeColors> = {
  NEW: "blue",
  PREPARING: "amber",
  FINISHING: "amber",
  READY: "green",
  OUT_FOR_DELIVERY: "purple",
  DELIVERED: "green",
  SETTLED: "green",
  CANCELED: "red",
};

// ---------- Modal ----------

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className={`max-h-[92vh] w-full ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"} animate-slide-up overflow-y-auto rounded-t-2xl bg-white p-6 shadow-2xl sm:rounded-2xl dark:bg-surface-900`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-surface-400 transition-colors hover:bg-surface-100 hover:text-surface-600 dark:hover:bg-surface-800"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- Skeleton ----------

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-xl bg-surface-200 dark:bg-surface-800 ${className}`} />
  );
}

// ---------- Empty state ----------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-100 text-surface-400 dark:bg-surface-800">
        {icon}
      </div>
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-surface-500">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

// ---------- Toggle ----------

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${checked ? "bg-brand-500" : "bg-surface-300 dark:bg-surface-700"}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-[22px]" : "translate-x-0"}`}
        />
      </button>
      {label && <span className="text-sm">{label}</span>}
    </label>
  );
}

// ---------- Page header ----------

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-surface-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
