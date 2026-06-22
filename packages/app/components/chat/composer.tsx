"use client";

import { ArrowUp, Square } from "lucide-react";
import { useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";

/**
 * The message composer, pinned to the bottom of the thread. Enter sends,
 * Shift+Enter inserts a newline. While the agent is responding the send button
 * becomes a stop button. The textarea auto-grows up to a cap.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
}): React.ReactNode {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  const grow = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  const submit = (): void => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setValue("");
    if (ref.current) ref.current.style.height = "auto";
  };

  return (
    <div className="border-t border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-card px-3 py-2 focus-within:border-ring">
          <Textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder="Message Claudius…"
            onChange={(e) => {
              setValue(e.target.value);
              grow(e.target);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-[200px] min-h-0 flex-1 resize-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          {busy ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || disabled}
              aria-label="Send"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-center text-[0.7rem] text-muted-foreground">
          Claudius can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
