"use client";

import {
  Archive,
  Brain,
  EyeOff,
  Loader2,
  Settings,
  Shield,
  Trash2,
} from "lucide-react";
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
  onArchive,
  onDelete,
  user,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onArchive: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
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

  // Delete is irreversible and sits one pixel from archive, so it takes a second
  // click on an explicit confirm rather than firing from the icon. Kept inline as
  // a row state instead of a modal: the row itself is the thing being destroyed,
  // so naming it in a dialog would be redundant.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const handleDelete = async (id: string): Promise<void> => {
    setDeletingId(id);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="px-1 text-lg font-semibold tracking-tight">
          Claudius
        </span>
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
                    <span className="flex min-w-0 items-center gap-1.5">
                      {c.incognito && (
                        <EyeOff
                          className="size-3.5 shrink-0 self-center text-muted-foreground"
                          aria-label="Incognito conversation"
                        />
                      )}
                      <span className="truncate text-sm font-medium">
                        {c.title}
                      </span>
                    </span>
                    {/* The row actions occupy this same slot. On a pointer device
                        they appear on hover, so the stamp only yields then; on
                        touch there is no hover, so the actions are always shown
                        and the stamp gives up the slot permanently. */}
                    <span className="invisible shrink-0 text-[0.7rem] text-muted-foreground lg:visible lg:group-hover:invisible">
                      {relativeStamp(c.updatedAt)}
                    </span>
                  </div>
                  <p className="truncate pr-6 text-xs text-muted-foreground">
                    {c.lastMessagePreview ?? "…"}
                  </p>
                </button>
                <div
                  className={cn(
                    "absolute top-1 right-1 flex items-center gap-0.5",
                    archiving.has(c.id) || confirmingId === c.id
                      ? "flex"
                      : "flex lg:hidden lg:group-hover:flex",
                  )}
                >
                  <button
                    type="button"
                    aria-label="Archive conversation"
                    onClick={() => void handleArchive(c.id)}
                    disabled={archiving.has(c.id)}
                    className="rounded p-2 text-warning hover:bg-warning/10 disabled:opacity-100 lg:p-1"
                  >
                    {archiving.has(c.id) ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Archive className="size-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete conversation"
                    onClick={() => setConfirmingId(c.id)}
                    className="rounded p-2 text-destructive hover:bg-destructive/10 lg:p-1"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {confirmingId === c.id && (
                  <div className="mx-1 mb-1 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5">
                    <p className="text-xs text-muted-foreground">
                      Delete this conversation and any files attached to it?
                      This cannot be undone.
                    </p>
                    <div className="mt-1.5 flex gap-2">
                      <button
                        type="button"
                        onClick={() => void handleDelete(c.id)}
                        disabled={deletingId === c.id}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        {deletingId === c.id && (
                          <Loader2 className="size-3 animate-spin" />
                        )}
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-sidebar-accent"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
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
