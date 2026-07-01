"use client";

import { useState } from "react";
import type { Role, Tier } from "@claudius/shared";
import { Button } from "@/components/ui/button";
import { sendJson } from "@/lib/admin-client";

const ROLES: Role[] = ["admin", "member", "guest"];

interface DraftTier {
  dailyMessageCap: string;
  memoryCap: string;
  monthlyTokenBudget: string;
  features: string;
}

type Tiers = Record<Role, Tier>;
type Draft = Record<Role, DraftTier>;

function toDraft(tiers: Tiers): Draft {
  const entries = ROLES.map((role) => {
    const t = tiers[role];
    return [
      role,
      {
        dailyMessageCap: t.dailyMessageCap.toString(),
        memoryCap: t.memoryCap.toString(),
        monthlyTokenBudget: t.monthlyTokenBudget?.toString() ?? "",
        features: t.features.join(", "),
      },
    ] as const;
  });
  return Object.fromEntries(entries) as Draft;
}

/**
 * Tier editor: daily message caps, memory caps, monthly token budgets, and
 * feature flags per role. A blank monthly budget means unlimited (null).
 */
export function TierEditor({ initial }: { initial: Tiers }): React.ReactNode {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function set(role: Role, field: keyof DraftTier, value: string): void {
    setSaved(false);
    setDraft((prev) => ({ ...prev, [role]: { ...prev[role], [field]: value } }));
  }

  function buildTier(d: DraftTier): Tier | null {
    const dailyMessageCap = Number(d.dailyMessageCap);
    const memoryCap = Number(d.memoryCap);
    const budgetTrimmed = d.monthlyTokenBudget.trim();
    const monthlyTokenBudget = budgetTrimmed === "" ? null : Number(budgetTrimmed);
    if (
      !Number.isInteger(dailyMessageCap) ||
      dailyMessageCap < 0 ||
      !Number.isInteger(memoryCap) ||
      memoryCap < 0 ||
      (monthlyTokenBudget !== null &&
        (!Number.isInteger(monthlyTokenBudget) || monthlyTokenBudget < 0))
    ) {
      return null;
    }
    const features = d.features
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    return { dailyMessageCap, memoryCap, monthlyTokenBudget, features };
  }

  async function save(): Promise<void> {
    const built = {} as Tiers;
    for (const role of ROLES) {
      const tier = buildTier(draft[role]);
      if (!tier) {
        setError(`Invalid values for ${role}. Caps must be non-negative integers.`);
        return;
      }
      built[role] = tier;
    }
    setBusy(true);
    setError(null);
    const res = await sendJson("/api/admin/tiers", "PUT", built);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Tiers</h2>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-muted-foreground">Saved</span>}
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2 font-medium">Daily cap</th>
              <th className="pb-2 font-medium">Memory cap</th>
              <th className="pb-2 font-medium">Monthly tokens</th>
              <th className="pb-2 font-medium">Features</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => (
              <tr key={role} className="border-b border-border/50">
                <td className="py-2 pr-2 font-medium capitalize">{role}</td>
                <td className="py-2 pr-2">
                  <NumInput
                    value={draft[role].dailyMessageCap}
                    onChange={(v) => set(role, "dailyMessageCap", v)}
                  />
                </td>
                <td className="py-2 pr-2">
                  <NumInput
                    value={draft[role].memoryCap}
                    onChange={(v) => set(role, "memoryCap", v)}
                  />
                </td>
                <td className="py-2 pr-2">
                  <NumInput
                    value={draft[role].monthlyTokenBudget}
                    placeholder="∞"
                    onChange={(v) => set(role, "monthlyTokenBudget", v)}
                  />
                </td>
                <td className="py-2 pr-2">
                  <input
                    type="text"
                    value={draft[role].features}
                    onChange={(e) => set(role, "features", e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Monthly tokens blank = unlimited. Features are comma-separated flags.
      </p>
    </section>
  );
}

function NumInput({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}): React.ReactNode {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-28 rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums"
    />
  );
}
