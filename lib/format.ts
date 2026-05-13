// Display formatters keyed by `formatHint` on `measurables`. Server-safe,
// client-safe — pure functions, no Intl side effects.

export type FormatHint =
  | "currency_usd"
  | "currency_usd_trend"
  | "percent"
  | "days"
  | "turns"
  | "count";

const USD0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const PERCENT1 = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

export function formatActual(value: number | null, hint: string | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  switch (hint as FormatHint | null) {
    case "currency_usd":
    case "currency_usd_trend":
      return USD0.format(value);
    case "percent":
      return PERCENT1.format(value);
    case "days":
      return `${value.toFixed(1)} d`;
    case "turns":
      return `${value.toFixed(2)}×`;
    case "count":
      return value.toLocaleString("en-US");
    default:
      return String(value);
  }
}

export function formatGoal(
  direction: string,
  value: number | null,
  secondary: number | null,
  hint: string | null,
): string {
  if (direction === "trend_down") return "↓ trending";
  if (direction === "trend_up") return "↑ trending";
  if (value === null) return "—";
  const formatted = formatActual(value, hint);
  switch (direction) {
    case "gte":
      return `≥ ${formatted}`;
    case "lte":
      return `≤ ${formatted}`;
    case "eq":
      return `= ${formatted}`;
    case "between":
      return `${formatted} – ${formatActual(secondary, hint)}`;
    default:
      return formatted;
  }
}
