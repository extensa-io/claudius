"use client";

import { useState } from "react";
import type { GuestBreakerView } from "@claudius/shared";
import { Button } from "@/components/ui/button";
import { sendJson } from "@/lib/admin-client";
import { formatUsd } from "@/lib/format";

/**
 * Guest circuit-breaker panel. Shows today's live guest spend against the
 * ceiling and the two independent controls: the automatic spend breaker
 * (trip/reset) and the manual kill switch (never auto-reset).
 */
export function BreakerPanel({
  initial,
}: {
  initial: GuestBreakerView;
}): React.ReactNode {
  const [breaker, setBreaker] = useState(initial);
  const [ceiling, setCeiling] = useState(initial.dailyCeilingUsd.toString());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(body: unknown): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await sendJson("/api/admin/circuit-breaker", "POST", body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const { breaker: next } = res.data as { breaker: GuestBreakerView };
    setBreaker(next);
    setCeiling(next.dailyCeilingUsd.toString());
  }

  const overBudget = breaker.spendTodayUsd >= breaker.dailyCeilingUsd;

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">Guest circuit breaker</h2>
      {error && (
        <p className="mb-3 text-sm text-destructive">{error}</p>
      )}
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="State" value={breaker.state} danger={breaker.state === "tripped"} />
        <Stat
          label="Kill switch"
          value={breaker.killSwitch ? "ON" : "off"}
          danger={breaker.killSwitch}
        />
        <Stat
          label="Spend today"
          value={formatUsd(breaker.spendTodayUsd)}
          danger={overBudget}
        />
        <Stat label="Ceiling" value={formatUsd(breaker.dailyCeilingUsd)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || breaker.state === "tripped"}
          onClick={() => void act({ action: "trip" })}
        >
          Trip now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || breaker.state === "open"}
          onClick={() => void act({ action: "reset" })}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant={breaker.killSwitch ? "outline" : "destructive"}
          disabled={busy}
          onClick={() => void act({ action: "killSwitch", on: !breaker.killSwitch })}
        >
          {breaker.killSwitch ? "Re-enable guests" : "Kill guest access"}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Ceiling $</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={ceiling}
            onChange={(e) => setCeiling(e.target.value)}
            className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-xs tabular-nums"
          />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act({ action: "ceiling", usd: Number(ceiling) })}
          >
            Save
          </Button>
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}): React.ReactNode {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={
          danger
            ? "mt-0.5 font-semibold text-destructive"
            : "mt-0.5 font-semibold"
        }
      >
        {value}
      </p>
    </div>
  );
}
