"use client";

import { useState } from "react";
import type { Bang, CacheTtls } from "@claudius/shared";
import { Button } from "@/components/ui/button";
import { sendJson } from "@/lib/admin-client";

/**
 * Answer-engine search settings (Phase 8). Edits the Brave free-tier threshold,
 * the quality gate, the custom bang table, the Tavily escalation keywords, and
 * the per-intent cache TTLs — all of which take effect without a redeploy. The
 * Brave monthly counter is shown READ-ONLY (the engine owns it; a save never
 * touches it).
 */

export interface SearchSettingsView {
  braveMonthlyThreshold: number;
  highValueMinResults: number;
  customBangs: Bang[];
  escalationKeywords: string[];
  cacheTtls: CacheTtls;
  braveUsage: { month: string; count: number };
}

interface Draft {
  braveMonthlyThreshold: string;
  highValueMinResults: string;
  // Bangs as "token url" lines; escalation as comma-separated; TTLs as strings.
  bangs: string;
  escalation: string;
  freshSeconds: string;
  evergreenSeconds: string;
  transactionalSeconds: string;
}

function toDraft(s: SearchSettingsView): Draft {
  return {
    braveMonthlyThreshold: s.braveMonthlyThreshold.toString(),
    highValueMinResults: s.highValueMinResults.toString(),
    bangs: s.customBangs.map((b) => `${b.token} ${b.urlTemplate}`).join("\n"),
    escalation: s.escalationKeywords.join(", "),
    freshSeconds: s.cacheTtls.freshSeconds.toString(),
    evergreenSeconds: s.cacheTtls.evergreenSeconds.toString(),
    transactionalSeconds: s.cacheTtls.transactionalSeconds.toString(),
  };
}

/** Parse "token https://site/search?q={query}" lines into a bang table. Each
 * non-empty line must have a token and a template; anything malformed fails the
 * whole save (returns null) so the panel can't persist half a table. */
function parseBangs(text: string): Bang[] | null {
  const bangs: Bang[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.search(/\s/);
    if (idx < 0) return null;
    const token = trimmed.slice(0, idx).replace(/^!/, "").trim();
    const urlTemplate = trimmed.slice(idx + 1).trim();
    if (!token || !/^https?:\/\//i.test(urlTemplate)) return null;
    bangs.push({ token, urlTemplate });
  }
  return bangs;
}

function nonNegInt(v: string): number | null {
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function SearchSettingsEditor({
  initial,
}: {
  initial: SearchSettingsView;
}): React.ReactNode {
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  function set(field: keyof Draft, value: string): void {
    setSaved(false);
    setDraft((prev) => ({ ...prev, [field]: value }));
  }

  async function save(): Promise<void> {
    const braveMonthlyThreshold = nonNegInt(draft.braveMonthlyThreshold);
    const highValueMinResults = nonNegInt(draft.highValueMinResults);
    const freshSeconds = nonNegInt(draft.freshSeconds);
    const evergreenSeconds = nonNegInt(draft.evergreenSeconds);
    const transactionalSeconds = nonNegInt(draft.transactionalSeconds);
    const customBangs = parseBangs(draft.bangs);
    if (
      braveMonthlyThreshold === null ||
      highValueMinResults === null ||
      freshSeconds === null ||
      evergreenSeconds === null ||
      transactionalSeconds === null
    ) {
      setError("Thresholds and TTLs must be non-negative integers.");
      return;
    }
    if (customBangs === null) {
      setError(
        'Each bang must be "token https://site/...{query}" on its own line.',
      );
      return;
    }
    const escalationKeywords = draft.escalation
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    setBusy(true);
    setError(null);
    const res = await sendJson("/api/admin/search", "PUT", {
      braveMonthlyThreshold,
      highValueMinResults,
      customBangs,
      escalationKeywords,
      cacheTtls: { freshSeconds, evergreenSeconds, transactionalSeconds },
    });
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
        <h2 className="text-sm font-semibold">Answer engine (search)</h2>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-muted-foreground">Saved</span>}
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Save changes
          </Button>
        </div>
      </div>
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      <p className="mb-4 text-xs text-muted-foreground">
        Brave usage this month ({initial.braveUsage.month}):{" "}
        <span className="font-medium tabular-nums">{initial.braveUsage.count}</span>{" "}
        calls (read-only).
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Brave monthly threshold">
          <NumInput
            value={draft.braveMonthlyThreshold}
            onChange={(v) => set("braveMonthlyThreshold", v)}
          />
        </Field>
        <Field label="Min Brave results (quality gate)">
          <NumInput
            value={draft.highValueMinResults}
            onChange={(v) => set("highValueMinResults", v)}
          />
        </Field>
        <Field label="Cache TTL — fresh / news (s)">
          <NumInput value={draft.freshSeconds} onChange={(v) => set("freshSeconds", v)} />
        </Field>
        <Field label="Cache TTL — evergreen (s)">
          <NumInput
            value={draft.evergreenSeconds}
            onChange={(v) => set("evergreenSeconds", v)}
          />
        </Field>
        <Field label="Cache TTL — transactional (s)">
          <NumInput
            value={draft.transactionalSeconds}
            onChange={(v) => set("transactionalSeconds", v)}
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label="Tavily escalation keywords (comma-separated)">
          <input
            type="text"
            value={draft.escalation}
            onChange={(e) => set("escalation", e.target.value)}
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
        </Field>
      </div>

      <div className="mt-4">
        <Field label='Custom bangs — one per line: "token https://site/search?q={query}"'>
          <textarea
            value={draft.bangs}
            onChange={(e) => set("bangs", e.target.value)}
            rows={6}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
          />
        </Field>
        <p className="mt-1 text-xs text-muted-foreground">
          These merge over the built-in table; a matching token overrides a
          built-in. Use {"{query}"} where the search terms go.
        </p>
      </div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function NumInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}): React.ReactNode {
  return (
    <input
      type="text"
      inputMode="numeric"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums"
    />
  );
}
