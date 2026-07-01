"use client";

import { Fragment, useState } from "react";
import type { AdminUserRow, Role } from "@claudius/shared";
import { Button } from "@/components/ui/button";
import { formatTokens, formatUsd } from "@/lib/format";

interface ModelOption {
  id: string;
  displayName: string;
}

/**
 * The admin Users table. Each row edits inline and persists through the
 * /api/admin/users endpoints; the local row state is updated from the action so
 * the table reflects changes without a full reload. Usage columns are read-only
 * (aggregated server-side) — admin sees numbers, never conversation content.
 */
export function UsersTable({
  initialUsers,
  models,
}: {
  initialUsers: AdminUserRow[];
  models: ModelOption[];
}): React.ReactNode {
  const [users, setUsers] = useState(initialUsers);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  function patchRow(id: string, patch: Partial<AdminUserRow>): void {
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<boolean> {
    setError(null);
    try {
      const res = await fetch(path, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? "Action failed.");
        return false;
      }
      return true;
    } catch {
      setError("Network error.");
      return false;
    }
  }

  async function setRole(u: AdminUserRow, role: Role): Promise<void> {
    if (await call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    })) {
      patchRow(u.id, { role });
    }
  }

  async function toggleStatus(u: AdminUserRow): Promise<void> {
    const status = u.status === "active" ? "disabled" : "active";
    if (await call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    })) {
      patchRow(u.id, { status });
    }
  }

  async function saveBudget(u: AdminUserRow, raw: string): Promise<void> {
    const trimmed = raw.trim();
    const monthlyTokenBudget = trimmed === "" ? null : Number(trimmed);
    if (monthlyTokenBudget !== null && !Number.isFinite(monthlyTokenBudget)) {
      setError("Budget must be a number or blank.");
      return;
    }
    if (await call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ monthlyTokenBudget }),
    })) {
      patchRow(u.id, { monthlyTokenBudget });
    }
  }

  async function promote(u: AdminUserRow): Promise<void> {
    if (await call(`/api/admin/users/${u.id}/promote`, { method: "POST" })) {
      patchRow(u.id, { role: "member" });
    }
  }

  async function saveModels(u: AdminUserRow, ids: string[] | null): Promise<void> {
    if (await call(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify({ allowedModels: ids }),
    })) {
      patchRow(u.id, { allowedModels: ids });
    }
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="pb-2 font-medium">User</th>
              <th className="pb-2 font-medium">Role</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 text-right font-medium">Daily</th>
              <th className="pb-2 text-right font-medium">Tokens (MTD)</th>
              <th className="pb-2 text-right font-medium">Spend</th>
              <th className="pb-2 text-right font-medium">Budget</th>
              <th className="pb-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <Fragment key={u.id}>
                <tr className="border-b border-border/50 align-middle">
                  <td className="py-2 pr-2">
                    <div className="font-medium">{u.name ?? u.email}</div>
                    {u.name && (
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    )}
                  </td>
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={u.role}
                        disabled={u.isEnvAdmin}
                        onChange={(e) => void setRole(u, e.target.value as Role)}
                        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
                      >
                        <option value="guest">guest</option>
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                      {u.isEnvAdmin && (
                        <span
                          title="Bootstrap admin (ADMIN_EMAIL); cannot be changed here"
                          className="rounded bg-muted px-1.5 py-0.5 text-[0.65rem] text-muted-foreground"
                        >
                          env
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="py-2 pr-2">
                    <span
                      className={
                        u.status === "active"
                          ? "text-xs text-foreground"
                          : "text-xs text-destructive"
                      }
                    >
                      {u.status}
                    </span>
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                    {u.dailyUsed}/{u.dailyCap}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {formatTokens(u.monthTokens)}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
                    {formatUsd(u.monthSpendUsd)}
                  </td>
                  <td className="py-2 pr-2 text-right">
                    <input
                      type="text"
                      defaultValue={u.monthlyTokenBudget?.toString() ?? ""}
                      placeholder="tier"
                      onBlur={(e) => void saveBudget(u, e.target.value)}
                      className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-xs tabular-nums"
                    />
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      {u.role === "guest" && (
                        <Button size="xs" variant="outline" onClick={() => void promote(u)}>
                          Promote
                        </Button>
                      )}
                      <Button
                        size="xs"
                        variant={u.status === "active" ? "destructive" : "outline"}
                        disabled={u.isEnvAdmin}
                        onClick={() => void toggleStatus(u)}
                      >
                        {u.status === "active" ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          setExpanded(expanded === u.id ? null : u.id)
                        }
                      >
                        Models
                      </Button>
                    </div>
                  </td>
                </tr>
                {expanded === u.id && (
                  <tr className="border-b border-border/50 bg-muted/30">
                    <td colSpan={8} className="px-2 py-3">
                      <ModelOverrideEditor
                        models={models}
                        value={u.allowedModels}
                        onSave={(ids) => void saveModels(u, ids)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Per-user model override. `null` means "inherit the tier default"; ticking any
 * box switches to an explicit allow-list for that user (the exact semantics of
 * `isModelPermitted` on the server).
 */
function ModelOverrideEditor({
  models,
  value,
  onSave,
}: {
  models: ModelOption[];
  value: string[] | null;
  onSave: (ids: string[] | null) => void;
}): React.ReactNode {
  const override = value !== null;
  const selected = new Set(value ?? []);

  function toggle(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSave([...next]);
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground">Model access:</span>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={!override}
            onChange={() => onSave(null)}
          />
          Tier default
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={override}
            onChange={() => onSave(value ?? [])}
          />
          Custom
        </label>
      </div>
      {override && (
        <div className="flex flex-wrap gap-3">
          {models.map((m) => (
            <label key={m.id} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onChange={() => toggle(m.id)}
              />
              {m.displayName}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
