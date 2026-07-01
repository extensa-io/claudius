"use client";

import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { sendJson } from "@/lib/admin-client";

/**
 * Allowlist CRUD, parameterized by endpoint so the same component drives both the
 * member allowlist and the admin allowlist. Emails here resolve to the given
 * role at sign-in (see `resolveRole`).
 */
export function AllowlistEditor({
  title,
  endpoint,
  initial,
  note,
}: {
  title: string;
  endpoint: string;
  initial: string[];
  note?: string;
}): React.ReactNode {
  const [emails, setEmails] = useState(initial);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function mutate(method: string, email: string): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await sendJson(endpoint, method, { email });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setEmails((res.data as { emails: string[] }).emails);
  }

  async function add(): Promise<void> {
    const email = input.trim();
    if (!email) return;
    await mutate("POST", email);
    setInput("");
  }

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {note && <p className="mb-3 text-xs text-muted-foreground">{note}</p>}
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="mb-3 flex gap-2">
        <input
          type="email"
          value={input}
          placeholder="name@example.com"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void add();
          }}
          className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
        />
        <Button size="sm" disabled={busy} onClick={() => void add()}>
          Add
        </Button>
      </div>
      {emails.length === 0 ? (
        <p className="text-sm text-muted-foreground">No emails yet.</p>
      ) : (
        <ul className="space-y-1">
          {emails.map((email) => (
            <li
              key={email}
              className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-1.5 text-sm"
            >
              <span>{email}</span>
              <button
                type="button"
                aria-label={`Remove ${email}`}
                disabled={busy}
                onClick={() => void mutate("DELETE", email)}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
