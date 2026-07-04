"use client";

import type {
  MemorySettings,
  MemorySort,
  MemoryView,
  SupersededRef,
} from "@claudius/shared";
import { Dialog } from "radix-ui";
import { ArrowLeft, Brain } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MemoryCard } from "./memory-card";

type CategoryFilter = "all" | MemoryView["category"];

const CATEGORY_CHIPS: Array<{ value: CategoryFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "fact", label: "Facts" },
  { value: "preference", label: "Preferences" },
  { value: "context", label: "Context" },
];

const SORT_OPTIONS: Array<{ value: MemorySort; label: string }> = [
  { value: "newest", label: "Newest" },
  { value: "important", label: "Most defining" },
  { value: "last_used", label: "Last used" },
  { value: "oldest", label: "Oldest" },
];

/**
 * The /memories dashboard. Server-rendered initial data, then this owns all
 * interaction: category filter, sort, substring search, inline edit, delete, and
 * the memory master switch (with a confirmation modal that spells out what
 * turning it off does). Transparency is the feature — every memory here is
 * visible, inspectable, and undoable.
 */
export function MemoriesView({
  initialMemories,
  initialSettings,
}: {
  initialMemories: MemoryView[];
  initialSettings: MemorySettings;
}): React.ReactNode {
  const [memories, setMemories] = useState(initialMemories);
  const [count, setCount] = useState(initialSettings.count);
  const [enabled, setEnabled] = useState(initialSettings.enabled);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sort, setSort] = useState<MemorySort>("newest");
  const [search, setSearch] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isFiltering = category !== "all" || search.trim().length > 0;

  // Skip the fetch on first mount — the server already provided newest/all.
  const mounted = useRef(false);

  const refetch = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams({ sort });
    if (category !== "all") params.set("category", category);
    if (search.trim().length > 0) params.set("q", search.trim());
    const res = await fetch(`/api/memories?${params.toString()}`);
    if (!res.ok) return;
    const data = (await res.json()) as { memories: MemoryView[] };
    setMemories(data.memories);
  }, [category, sort, search]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const t = setTimeout(() => void refetch(), 250);
    return () => clearTimeout(t);
  }, [refetch]);

  const handleEdit = useCallback(
    async (id: string, content: string): Promise<void> => {
      const res = await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        setMemories((prev) =>
          prev.map((m) => (m.id === id ? { ...m, content } : m)),
        );
      }
    },
    [],
  );

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`/api/memories/${id}`, { method: "DELETE" });
      if (res.ok) {
        setMemories((prev) => prev.filter((m) => m.id !== id));
        setCount((c) => Math.max(0, c - 1));
      }
    },
    [],
  );

  const handleSetImportance = useCallback(
    async (id: string, importance: number): Promise<void> => {
      // Optimistic: reflect the new band immediately, then persist.
      setMemories((prev) =>
        prev.map((m) => (m.id === id ? { ...m, importance } : m)),
      );
      await fetch(`/api/memories/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ importance }),
      });
    },
    [],
  );

  const fetchChain = useCallback(
    async (id: string): Promise<SupersededRef[]> => {
      const res = await fetch(`/api/memories/${id}/chain`);
      if (!res.ok) return [];
      const data = (await res.json()) as { chain: SupersededRef[] };
      return data.chain;
    },
    [],
  );

  const setMemoryEnabledRemote = async (next: boolean): Promise<void> => {
    setEnabled(next);
    await fetch("/api/memory-settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
  };

  const onToggle = (): void => {
    if (enabled) {
      // Turning off is the consequential direction — confirm first.
      setConfirmOpen(true);
    } else {
      void setMemoryEnabledRemote(true);
    }
  };

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col px-4 py-8">
      <Link
        href="/chat"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to chat
      </Link>

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Things I remember about you
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {count} {count === 1 ? "memory" : "memories"}
            {!enabled && " · memory is off"}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle memory"
          onClick={onToggle}
          className={cn(
            "relative mt-1 h-6 w-11 shrink-0 rounded-full transition-colors",
            enabled ? "bg-primary" : "bg-border",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform",
              enabled ? "translate-x-[22px]" : "translate-x-0.5",
            )}
          />
        </button>
      </header>

      {enabled ? (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {CATEGORY_CHIPS.map((chip) => (
              <button
                key={chip.value}
                type="button"
                onClick={() => setCategory(chip.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm transition-colors",
                  category === chip.value
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {chip.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search memories"
                className="w-40 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/50"
              />
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as MemorySort)}
                aria-label="Sort memories"
                className="rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary/50"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4 flex flex-col gap-2.5 pb-12">
            {memories.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">
                {isFiltering
                  ? "No memories match."
                  : "Nothing remembered yet. As we talk, I'll save durable facts here. You stay in control."}
              </p>
            ) : (
              memories.map((memory) => (
                <MemoryCard
                  key={memory.id}
                  memory={memory}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onSetImportance={handleSetImportance}
                  fetchChain={fetchChain}
                />
              ))
            )}
          </div>
        </>
      ) : (
        <p className="mt-10 rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          Memory is off. Claudius won&rsquo;t save new memories or use existing
          ones. Your saved memories are kept and will be used again if you turn
          memory back on.
        </p>
      )}

      <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0" />
          <Dialog.Content className="fixed top-1/2 left-1/2 z-50 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-6 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0">
            <Dialog.Title className="font-heading text-lg font-medium">
              Turn memory off?
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              Claudius will stop saving new memories and won&rsquo;t use your
              existing ones to personalize answers. Your saved memories aren&rsquo;t
              deleted — you can turn memory back on any time.
            </Dialog.Description>
            <div className="mt-6 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  void setMemoryEnabledRemote(false);
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Turn off
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <div className="mt-auto flex items-center gap-1.5 pt-4 text-xs text-muted-foreground">
        <Brain className="size-3.5" />
        Every memory here was learned from your conversations and can be edited or
        deleted.
      </div>
    </div>
  );
}
