"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { PanelLeft } from "lucide-react";
import { useMemo } from "react";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import type { ModelOption } from "@/lib/chat/view-types";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { ModelSelector } from "./model-selector";

/**
 * Owns the live chat session for one conversation. The parent remounts this
 * component (via `key`) when the user switches conversations, so useChat starts
 * fresh, seeded with that thread's history. We send only the new user text plus
 * the conversation and model ids; the checkpointer holds the transcript.
 */
export function ChatPane({
  conversationId,
  initialMessages,
  modelId,
  models,
  onModelChange,
  onConversationCreated,
  onTurnComplete,
  onOpenSidebar,
}: {
  conversationId: string | null;
  initialMessages: ClaudiusUIMessage[];
  modelId: string;
  models: ModelOption[];
  onModelChange: (id: string) => void;
  onConversationCreated: (id: string, title: string) => void;
  onTurnComplete: () => void;
  onOpenSidebar: () => void;
}): React.ReactNode {
  const transport = useMemo(
    () =>
      new DefaultChatTransport<ClaudiusUIMessage>({
        api: "/api/chat",
        // Surface the server's user-safe error message (e.g. the daily cap) so
        // useChat's `error` carries it instead of a generic status string.
        fetch: async (url, init) => {
          const res = await fetch(url, init);
          if (!res.ok) {
            const body = (await res
              .clone()
              .json()
              .catch(() => null)) as { error?: { message?: string } } | null;
            throw new Error(body?.error?.message ?? "Request failed.");
          }
          return res;
        },
        // Send just the latest user text; conversation/model ride in the body.
        prepareSendMessagesRequest: ({ messages, body }) => {
          const last = messages[messages.length - 1];
          const text = (last?.parts ?? [])
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("");
          return {
            body: {
              conversationId: body?.conversationId ?? null,
              modelId: body?.modelId,
              text,
            },
          };
        },
      }),
    [],
  );

  const { messages, sendMessage, status, stop, error } =
    useChat<ClaudiusUIMessage>({
      messages: initialMessages,
      transport,
      onData: (part) => {
        if (part.type === "data-conversation") {
          onConversationCreated(part.data.id, part.data.title);
        }
      },
      onFinish: () => onTurnComplete(),
    });

  const busy = status === "submitted" || status === "streaming";
  const isWaiting =
    status === "submitted" &&
    messages[messages.length - 1]?.role === "user";

  const send = (text: string): void => {
    void sendMessage({ text }, { body: { conversationId, modelId } });
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button
          type="button"
          aria-label="Open conversations"
          onClick={onOpenSidebar}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
        >
          <PanelLeft className="size-4" />
        </button>
        <ModelSelector
          models={models}
          selectedId={modelId}
          onSelect={onModelChange}
          disabled={busy}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center text-muted-foreground">
              Ask anything to get started.
            </p>
          </div>
        ) : (
          <MessageList messages={messages} isWaiting={isWaiting} />
        )}
      </div>

      {error && (
        <div className="mx-auto w-full max-w-3xl px-4">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error.message}
          </p>
        </div>
      )}

      <Composer onSend={send} onStop={stop} busy={busy} />
    </div>
  );
}
