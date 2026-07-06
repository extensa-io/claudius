"use client";

import { Brain } from "lucide-react";
import { useState } from "react";
import type { UsedMemory } from "@/lib/chat/types";
import { IconChip } from "./activity-icons";

const CATEGORY_LABEL: Record<UsedMemory["category"], string> = {
  fact: "fact",
  preference: "preference",
  context: "context",
};

/** "2 from your profile · 3 recalled" — describe the split when both are present
 * (Phase 6), otherwise a plain count. Profile rows are the always-on identity
 * block; retrieved rows are this turn's salience-weighted match. */
function summarize(profileCount: number, retrievedCount: number): string {
  const total = profileCount + retrievedCount;
  if (profileCount > 0 && retrievedCount > 0) {
    return `used ${total} memories · ${profileCount} from your profile, ${retrievedCount} recalled`;
  }
  if (profileCount > 0) {
    return `used ${profileCount} from your profile`;
  }
  return `recalled ${retrievedCount} ${retrievedCount === 1 ? "memory" : "memories"}`;
}

/**
 * The most differentiating moment in the UI (design.md): under an assistant
 * turn that drew on memory, a quiet chip shows how many memories informed it;
 * clicking it reveals exactly which ones. Phase 6 splits them into the always-on
 * profile and this turn's recall, so the user sees identity vs task memory.
 */
export function MemoryUsedChip({
  memories,
}: {
  memories: UsedMemory[];
}): React.ReactNode {
  const [open, setOpen] = useState(false);
  if (memories.length === 0) return null;

  // Absent source (older turns) counts as retrieved.
  const profile = memories.filter((m) => m.source === "profile");
  const retrieved = memories.filter((m) => m.source !== "profile");

  const groups: Array<{ label: string; items: UsedMemory[] }> = [];
  if (profile.length > 0) groups.push({ label: "From your profile", items: profile });
  if (retrieved.length > 0) groups.push({ label: "Recalled this turn", items: retrieved });

  return (
    <>
      <IconChip
        icon={<Brain className="size-3.5" />}
        summary={summarize(profile.length, retrieved.length)}
        accent
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && (
        // basis-full so, inside the flex-wrap activity strip, the detail drops
        // to its own row below the icons rather than squeezing into the row.
        <div className="mt-2 w-full basis-full space-y-2">
          {groups.map((group) => (
            <div key={group.label}>
              {groups.length > 1 && (
                <p className="mb-1 text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {group.label}
                </p>
              )}
              <ul className="space-y-1 border-l-2 border-primary/30 pl-3">
                {group.items.map((m) => (
                  <li key={m.id} className="text-xs text-muted-foreground">
                    <span className="text-foreground">{m.content}</span>{" "}
                    <span className="opacity-70">({CATEGORY_LABEL[m.category]})</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
