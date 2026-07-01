"use client";

import { useState } from "react";
import type { ModelCatalogEntry, Role } from "@claudius/shared";
import { Button } from "@/components/ui/button";
import { sendJson } from "@/lib/admin-client";

const ROLES: Role[] = ["guest", "member", "admin"];

/**
 * Model catalog editor: per-model pricing (per million tokens) and which roles
 * may use each model. Unchecking every role disables a model without deleting
 * it — the same effect as removing it from the tier, but reversible. Ids and
 * inference-profile ids stay read-only; changing those is a code/seed concern.
 */
export function ModelCatalogEditor({
  initial,
}: {
  initial: ModelCatalogEntry[];
}): React.ReactNode {
  const [models, setModels] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function update(id: string, patch: Partial<ModelCatalogEntry>): void {
    setSaved(false);
    setModels((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function toggleRole(id: string, role: Role): void {
    const model = models.find((m) => m.id === id);
    if (!model) return;
    const roles = model.roles.includes(role)
      ? model.roles.filter((r) => r !== role)
      : [...model.roles, role];
    update(id, { roles });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await sendJson("/api/admin/models", "PUT", { models });
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
        <h2 className="text-sm font-semibold">Model catalog</h2>
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
              <th className="pb-2 font-medium">Model</th>
              <th className="pb-2 text-right font-medium">$/MTok in</th>
              <th className="pb-2 text-right font-medium">$/MTok out</th>
              <th className="pb-2 font-medium">Roles</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} className="border-b border-border/50">
                <td className="py-2 pr-2">
                  <div className="font-medium">{m.displayName}</div>
                  <div className="text-xs text-muted-foreground">{m.id}</div>
                </td>
                <td className="py-2 pr-2 text-right">
                  <PriceInput
                    value={m.inputPricePerMTok}
                    onChange={(v) => update(m.id, { inputPricePerMTok: v })}
                  />
                </td>
                <td className="py-2 pr-2 text-right">
                  <PriceInput
                    value={m.outputPricePerMTok}
                    onChange={(v) => update(m.id, { outputPricePerMTok: v })}
                  />
                </td>
                <td className="py-2">
                  <div className="flex gap-3">
                    {ROLES.map((role) => (
                      <label key={role} className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={m.roles.includes(role)}
                          onChange={() => toggleRole(m.id, role)}
                        />
                        {role}
                      </label>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        A price of -1 means unconfirmed. Uncheck all roles to disable a model.
      </p>
    </section>
  );
}

function PriceInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}): React.ReactNode {
  return (
    <input
      type="number"
      step="0.01"
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-xs tabular-nums"
    />
  );
}
