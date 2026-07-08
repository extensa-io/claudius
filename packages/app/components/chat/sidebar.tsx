"use client";

import { Archive, Brain, Loader2, Plus, Settings, Shield } from "lucide-react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useState } from "react";
import type { ConversationSummary } from "@/lib/chat/view-types";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

/** "Jun 21", or "3:04 PM" if today — a quiet last-activity stamp. */
function relativeStamp(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface SidebarUser {
  name: string | null;
  email: string | null;
  role: string;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onArchive,
  user,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string) => Promise<void>;
  user: SidebarUser;
}): React.ReactNode {
  const visible = conversations.filter((c) => !c.archived);

  // Archiving hits the network and takes a beat; track in-flight ids so the
  // button shows a spinner and ignores repeat clicks (otherwise the lack of
  // feedback makes people click it several times).
  const [archiving, setArchiving] = useState<ReadonlySet<string>>(new Set());
  const handleArchive = async (id: string): Promise<void> => {
    if (archiving.has(id)) return;
    setArchiving((prev) => new Set(prev).add(id));
    try {
      await onArchive(id);
    } finally {
      setArchiving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="px-1 text-lg font-semibold tracking-tight">
          Claudius
        </span>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1.5 text-sm hover:bg-sidebar-accent"
        >
          <Plus className="size-4" />
          New
        </button>
      </div>

      <Link
        href="/memories"
        className="mx-2 mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
      >
        <Brain className="size-4" />
        Memory
      </Link>

      {/* Authored settings are member/admin-only; guests can't personalize. */}
      {user.role !== "guest" && (
        <Link
          href="/settings"
          className="mx-2 mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <Settings className="size-4" />
          Instructions
        </Link>
      )}

      {user.role === "admin" && (
        <Link
          href="/admin"
          className="mx-2 mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <Shield className="size-4" />
          Admin
        </Link>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {visible.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">
            No conversations yet.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {visible.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={cn(
                    "w-full rounded-md px-3 py-2 text-left hover:bg-sidebar-accent",
                    activeId === c.id && "bg-sidebar-accent",
                  )}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.title}
                    </span>
                    {/* Hidden on hover so the archive button can sit here
                        without overlapping the timestamp. */}
                    <span className="shrink-0 text-[0.7rem] text-muted-foreground group-hover:invisible">
                      {relativeStamp(c.updatedAt)}
                    </span>
                  </div>
                  <p className="truncate pr-6 text-xs text-muted-foreground">
                    {c.lastMessagePreview ?? "…"}
                  </p>
                </button>
                <button
                  type="button"
                  aria-label="Archive conversation"
                  onClick={() => void handleArchive(c.id)}
                  disabled={archiving.has(c.id)}
                  className={cn(
                    "absolute top-1.5 right-1.5 rounded p-1 text-warning hover:bg-warning/10 disabled:opacity-100",
                    archiving.has(c.id) ? "block" : "hidden group-hover:block",
                  )}
                >
                  {archiving.has(c.id) ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Archive className="size-3.5" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-sidebar-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {user.name ?? user.email}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="capitalize">{user.role}</span>
            {user.name ? ` · ${user.email}` : ""}
          </p>
        </div>
        <ThemeToggle />
        <button
          type="button"
          onClick={() => void signOut({ callbackUrl: "/" })}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
