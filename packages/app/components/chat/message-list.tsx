"use client";

import type { DynamicToolUIPart } from "ai";
import { useEffect, useRef } from "react";
import type {
  ClaudiusUIMessage,
  SearchActivityDataPart,
  UrlReadActivityDataPart,
  UsedMemory,
} from "@/lib/chat/types";
import { SearchActivityChip, UrlReadActivityChip } from "./activity-icons";
import { Markdown } from "./markdown";
import { MemoryUsedChip } from "./memory-used-chip";
import { ReportControls } from "./report-controls";
import { ToolActivity } from "./tool-activity";

function messageText(message: ClaudiusUIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * The scrolling transcript. User turns sit in a quiet right-aligned bubble;
 * assistant turns render full-width as Markdown with any tool activity inline.
 *
 * Auto-scroll "sticks" to the bottom only while the user is already near the
 * bottom. The moment they scroll up to read earlier content, streaming tokens
 * stop yanking the view down; it resumes sticking when they scroll back.
 */
export function MessageList({
  messages,
  isWaiting,
  footer,
  footerRevision,
  onRefine,
}: {
  messages: ClaudiusUIMessage[];
  /** True between submit and the first assistant token (the "thinking" gap). */
  isWaiting: boolean;
  /** Extra content rendered after the transcript (e.g. research job cards). */
  footer?: React.ReactNode;
  /** Bump to re-run the stick-to-bottom effect as the footer content changes. */
  footerRevision?: number;
  /** Start a follow-up run that refines a finished report. */
  onRefine?: (jobId: string, instruction: string) => void;
}): React.ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const handleScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, isWaiting, footerRevision]);

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="h-full overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-4 py-2.5 text-[1.05rem] text-secondary-foreground sm:text-base">
                {message.parts.map((part, i) =>
                  part.type === "text" ? (
                    <p key={i} className="whitespace-pre-wrap">
                      {part.text}
                    </p>
                  ) : null,
                )}
              </div>
            </div>
          ) : (
            (() => {
              // Activity for this turn: which memories informed it, and which
              // backend served each web search. Both render as compact icons in
              // one strip under the answer. When search icons are present, the
              // settled web-search cards collapse (the icon is their resting form).
              const usedMemories = message.parts.find(
                (p): p is { type: "data-memories"; data: { memories: UsedMemory[] } } =>
                  p.type === "data-memories",
              );
              const searches = message.parts.filter(
                (p): p is { type: "data-search"; data: SearchActivityDataPart } =>
                  p.type === "data-search",
              );
              const urlReads = message.parts.filter(
                (p): p is { type: "data-url"; data: UrlReadActivityDataPart } =>
                  p.type === "data-url",
              );
              const hasSearchIcons = searches.length > 0;
              const hasUrlIcons = urlReads.length > 0;
              const hasActivity =
                Boolean(usedMemories) || hasSearchIcons || hasUrlIcons;

              return (
                <div
                  key={message.id}
                  // min-w-0 so a long unbroken code line scrolls inside its own
                  // block on narrow screens rather than widening the whole column.
                  className="min-w-0 max-w-none text-[1.05rem] leading-7 sm:text-[0.95rem]"
                >
                  {message.metadata?.research && (
                    <ReportControls
                      question={message.metadata.research.question}
                      report={messageText(message)}
                      jobId={message.metadata.research.jobId}
                      onRefine={onRefine ?? (() => {})}
                    />
                  )}
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return <Markdown key={i}>{part.text}</Markdown>;
                    }
                    if (part.type === "dynamic-tool") {
                      return (
                        <ToolActivity
                          key={i}
                          part={part as DynamicToolUIPart}
                          suppressCompletedWebSearch={hasSearchIcons}
                          suppressCompletedUrlRead={hasUrlIcons}
                        />
                      );
                    }
                    return null;
                  })}
                  {/* Compact activity strip: memory + web-search backend icons. */}
                  {hasActivity && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {usedMemories && (
                        <MemoryUsedChip memories={usedMemories.data.memories} />
                      )}
                      {searches.map((s, i) => (
                        <SearchActivityChip key={i} search={s.data} />
                      ))}
                      {urlReads.map((u, i) => (
                        <UrlReadActivityChip key={i} read={u.data} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })()
          ),
        )}

        {isWaiting && (
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
            <span className="size-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
            <span className="size-2 animate-bounce rounded-full bg-current" />
          </div>
        )}

        {footer}
      </div>
    </div>
  );
}
