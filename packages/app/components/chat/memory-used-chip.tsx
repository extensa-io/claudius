"use client";

import { Brain } from "lucide-react";
import { useState } from "react";
import type { UsedMemory } from "@/lib/chat/types";

const CATEGORY_LABEL: Record<UsedMemory["category"], string> = {
  fact: "fact",
  preference: "preference",
  context: "context",
};

/**
 * The most differentiating moment in the UI (design.md): under an assistant
 * turn that drew on memory, a quiet chip shows how many memories were recalled;
 * clicking it reveals exactly which ones. Recall made visible, in real time.
 */
export function MemoryUsedChip({
  memories,
}: {
  memories: UsedMemory[];
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  if (memories.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs text-primary hover:bg-primary/10"
      >
        <Brain className="size-3" />
        used {memories.length} {memories.length === 1 ? "memory" : "memories"}
      </button>
      {open && (
        <ul className="mt-2 space-y-1 border-l-2 border-primary/30 pl-3">
          {memories.map((m) => (
            <li key={m.id} className="text-xs text-muted-foreground">
              <span className="text-foreground">{m.content}</span>{" "}
              <span className="opacity-70">({CATEGORY_LABEL[m.category]})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
