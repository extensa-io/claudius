/** Presentation helpers shared by the admin dashboard and panels. */

const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact token counts: 1234567 -> "1.2M". */
export function formatTokens(n: number): string {
  return compact.format(n);
}

/** USD with a floor so sub-cent spend doesn't render as "$0.00". */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** A ratio (0..1) as a whole-number percent. */
export function formatPct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
