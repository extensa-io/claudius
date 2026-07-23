"use client";

import type { UserSettingsView } from "@claudius/shared";
import { ArrowLeft, Check, Loader2, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

// Field caps, mirrored from UserSettingsSchema in @claudius/shared. Inlined
// rather than value-imported: this is a client component, and importing a value
// from the shared barrel would drag the server graph (mongodb, tavily) into the
// client bundle. The Zod schema at the API boundary is the real enforcement;
// these just drive the input maxLength and counter. Keep in sync with the schema.
const USER_PREFERRED_NAME_MAX = 100;
const USER_INSTRUCTIONS_MAX = 8000;

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * The /settings editor. Two labeled fields — a preferred name and freeform
 * instructions — that the user authors directly. This is the user-authored
 * layer that outranks inferred memory: what you type here is fed verbatim into
 * every conversation and takes precedence over what Claudius remembers about
 * you. Empty is valid: clearing a field simply removes it from the prompt.
 */
export function SettingsView({
  initial,
}: {
  initial: UserSettingsView;
}): React.ReactNode {
  const [preferredName, setPreferredName] = useState(initial.preferredName ?? "");
  const [instructions, setInstructions] = useState(initial.instructions ?? "");
  const [save, setSave] = useState<SaveState>("idle");

  // Dirty check against what the server last confirmed, so Save is meaningful.
  const [saved, setSaved] = useState<UserSettingsView>(initial);
  const dirty =
    preferredName !== (saved.preferredName ?? "") ||
    instructions !== (saved.instructions ?? "");

  const onSave = async (): Promise<void> => {
    setSave("saving");
    try {
      const res = await fetch("/api/user-settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preferredName, instructions }),
      });
      if (!res.ok) throw new Error("save failed");
      const data = (await res.json()) as { settings: UserSettingsView };
      setSaved(data.settings);
      setPreferredName(data.settings.preferredName ?? "");
      setInstructions(data.settings.instructions ?? "");
      setSave("saved");
      setTimeout(() => setSave("idle"), 2000);
    } catch {
      setSave("error");
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

      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Instructions for Claudius
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          What you set here is yours to control. Claudius follows it in every
          conversation, and it takes precedence over anything Claudius has
          remembered about you on its own.
        </p>
      </header>

      <div className="mt-8 flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="preferredName" className="text-sm font-medium">
            What should Claudius call you?
          </label>
          <input
            id="preferredName"
            type="text"
            value={preferredName}
            maxLength={USER_PREFERRED_NAME_MAX}
            onChange={(e) => setPreferredName(e.target.value)}
            placeholder="e.g. Néstor"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <label htmlFor="instructions" className="text-sm font-medium">
              Instructions for Claudius
            </label>
            <span className="text-xs text-muted-foreground">
              {instructions.length}/{USER_INSTRUCTIONS_MAX}
            </span>
          </div>
          <textarea
            id="instructions"
            value={instructions}
            maxLength={USER_INSTRUCTIONS_MAX}
            onChange={(e) => setInstructions(e.target.value)}
            rows={10}
            placeholder="Tell Claudius how you want it to respond: your background, tone, format preferences, things to always or never do."
            className="resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:border-primary/50"
          />
          <p className="text-xs text-muted-foreground">
            These are your explicit instructions, not memories Claudius inferred.
            They are used verbatim and win any conflict with what it remembers.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!dirty || save === "saving"}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {save === "saving" && <Loader2 className="size-4 animate-spin" />}
            {save === "saved" && <Check className="size-4" />}
            {save === "saved" ? "Saved" : "Save"}
          </button>
          {save === "error" && (
            <span className="text-sm text-destructive">
              Couldn&rsquo;t save. Try again.
            </span>
          )}
        </div>
      </div>

      <div className="mt-auto flex items-center gap-1.5 pt-8 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        Set once, applied everywhere. Update it any time.
      </div>
    </div>
  );
}
