"use client";

import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useRef, useState } from "react";
import { DocumentChips } from "./document-chips";
import type { DocChip } from "./use-documents";

/**
 * The message composer, pinned to the bottom of the thread. A fixed three-line
 * textarea (top-aligned) with the send button beneath it; Enter sends,
 * Shift+Enter inserts a newline. While the agent is responding the send button
 * becomes a stop button. Solid background — no backdrop blur, which softened the
 * text rendering.
 *
 * Members and admins also get an attach button and document chips here; the
 * affordance is hidden entirely for guests (uploads are a member/admin feature,
 * and the routes reject guests regardless).
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled,
  canAttach,
  chips,
  onUploadFiles,
  onRetryDoc,
  onRemoveDoc,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  canAttach: boolean;
  chips: DocChip[];
  onUploadFiles: (files: FileList) => void;
  onRetryDoc: (id: string) => void;
  onRemoveDoc: (id: string) => void;
}): React.ReactNode {
  const [value, setValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setValue("");
  };

  return (
    <div className="border-t border-border bg-background">
      <div className="mx-auto w-full max-w-3xl px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {canAttach && (
          <DocumentChips
            chips={chips}
            onRetry={onRetryDoc}
            onRemove={onRemoveDoc}
          />
        )}
        <div className="rounded-lg border border-border bg-card px-3 py-2.5 focus-within:border-ring">
          <textarea
            rows={3}
            value={value}
            disabled={disabled}
            placeholder="Message Claudius…"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="block max-h-48 w-full resize-none border-0 bg-transparent p-0 align-top text-sm leading-6 placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          <div className="mt-2 flex items-center justify-between">
            {canAttach ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files?.length) onUploadFiles(e.target.files);
                    // Reset so re-picking the same file fires change again.
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach files"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="size-4" />
                </button>
              </>
            ) : (
              <span />
            )}
            {busy ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop"
                className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!value.trim() || disabled}
                aria-label="Send"
                className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
        <p className="mt-1.5 px-1 text-center text-[0.7rem] text-muted-foreground">
          Claudius can make mistakes. Verify important information.
        </p>
      </div>
    </div>
  );
}
