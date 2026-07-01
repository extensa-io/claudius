import { AlertTriangle } from "lucide-react";

/**
 * Monthly budget banner (Phase 4). Shows a soft warning from 80% and a hard
 * "blocked" notice at 100%. The block is informational here — enforcement lives
 * server-side in `assertCanInvoke`; this just explains why sends will fail.
 */
export function BudgetBanner({
  level,
  ratio,
}: {
  level: "warn" | "blocked";
  ratio: number | null;
}): React.ReactNode {
  const pct = ratio === null ? null : Math.round(ratio * 100);
  const blocked = level === "blocked";

  return (
    <div
      className={
        blocked
          ? "flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
          : "flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-foreground"
      }
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span>
        {blocked
          ? "You've reached your monthly usage budget. Contact an administrator to continue."
          : `You've used ${pct ?? ""}% of your monthly usage budget.`}
      </span>
    </div>
  );
}
