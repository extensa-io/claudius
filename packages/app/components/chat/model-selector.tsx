"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ModelOption } from "@/lib/chat/view-types";
import { cn } from "@/lib/utils";

/**
 * Model picker for the top bar. Options come from /api/models (already filtered
 * to what the user's role allows), the choice persists per conversation, and it
 * can change mid-thread. The selected model id is shown in mono beneath the
 * display name (design.md).
 */
export function ModelSelector({
  models,
  selectedId,
  onSelect,
  disabled,
}: {
  models: ModelOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
}): React.ReactNode {
  const selected = models.find((m) => m.id === selectedId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent disabled:opacity-50"
      >
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium">
            {selected?.displayName ?? "Select model"}
          </span>
          <span className="font-mono text-[0.7rem] text-muted-foreground">
            {selected?.id ?? ""}
          </span>
        </div>
        <ChevronsUpDown className="size-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {models.map((model) => (
          <DropdownMenuItem
            key={model.id}
            onSelect={() => onSelect(model.id)}
            className="flex items-center justify-between gap-2"
          >
            <div className="flex flex-col leading-tight">
              <span className="text-sm">{model.displayName}</span>
              <span className="font-mono text-[0.7rem] text-muted-foreground">
                {model.id}
              </span>
            </div>
            <Check
              className={cn(
                "size-4 text-primary",
                model.id === selectedId ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
