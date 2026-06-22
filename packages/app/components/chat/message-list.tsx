"use client";

import type { DynamicToolUIPart } from "ai";
import { useEffect, useRef } from "react";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import { Markdown } from "./markdown";
import { ToolActivity } from "./tool-activity";

/**
 * The scrolling transcript. User turns sit in a quiet right-aligned bubble;
 * assistant turns render full-width as Markdown with any tool activity inline.
 * The view auto-scrolls to the newest content as tokens stream in.
 */
export function MessageList({
  messages,
  isWaiting,
}: {
  messages: ClaudiusUIMessage[];
  /** True between submit and the first assistant token (the "thinking" gap). */
  isWaiting: boolean;
}): React.ReactNode {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isWaiting]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-secondary px-4 py-2.5 text-secondary-foreground">
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
          <div
            key={message.id}
            className="prose-none max-w-none text-[0.95rem] leading-7"
          >
            {message.parts.map((part, i) => {
              if (part.type === "text") {
                return <Markdown key={i}>{part.text}</Markdown>;
              }
              if (part.type === "dynamic-tool") {
                return (
                  <ToolActivity key={i} part={part as DynamicToolUIPart} />
                );
              }
              return null;
            })}
          </div>
        ),
      )}

      {isWaiting && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-2 animate-bounce rounded-full bg-current" />
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
