"use client";

import { useCallback, useRef, useState } from "react";
import type { Role } from "@claudius/shared";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import type {
  ConversationSummary,
  DocumentView,
  ModelOption,
} from "@/lib/chat/view-types";
import type { JobView } from "@/lib/jobs/view";
import { BudgetBanner } from "./budget-banner";
import { ChatPane } from "./chat-pane";
import { Sidebar, type SidebarUser } from "./sidebar";

export interface BudgetInfo {
  level: "warn" | "blocked";
  ratio: number | null;
}

/**
 * Top-level chat shell: the sidebar (persistent on desktop, a drawer on mobile)
 * plus the active conversation pane. It owns conversation-list state and which
 * conversation is active; ChatPane owns the live message stream for that one
 * conversation. Switching conversations remounts ChatPane via `paneKey` so its
 * useChat re-seeds cleanly.
 */
export function ChatApp({
  user,
  initialConversations,
  models,
  initialConversationId,
  initialMessages,
  initialDocuments,
  initialJobs,
  budget,
}: {
  user: SidebarUser;
  initialConversations: ConversationSummary[];
  models: ModelOption[];
  initialConversationId: string | null;
  initialMessages: ClaudiusUIMessage[];
  initialDocuments: DocumentView[];
  initialJobs: JobView[];
  budget: BudgetInfo | null;
}): React.ReactNode {
  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(
    initialConversationId,
  );
  const [seedMessages, setSeedMessages] =
    useState<ClaudiusUIMessage[]>(initialMessages);
  const [seedDocuments, setSeedDocuments] =
    useState<DocumentView[]>(initialDocuments);
  const [seedJobs, setSeedJobs] = useState<JobView[]>(initialJobs);
  const [paneKey, setPaneKey] = useState<string>(
    initialConversationId ?? "new-0",
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const activeModelId =
    conversations.find((c) => c.id === initialConversationId)?.modelId ??
    models[0]?.id ??
    "";
  const [modelId, setModelId] = useState(activeModelId);

  const newCounter = useRef(0);

  const setUrl = (id: string | null): void => {
    window.history.replaceState(null, "", id ? `/chat?c=${id}` : "/chat");
  };

  const refreshConversations = useCallback(async (): Promise<void> => {
    const res = await fetch("/api/conversations");
    if (!res.ok) return;
    const data = (await res.json()) as { conversations: ConversationSummary[] };
    setConversations(data.conversations);
  }, []);

  const selectConversation = useCallback(
    async (id: string): Promise<void> => {
      setSidebarOpen(false);
      if (id === activeId) return;
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        conversation: ConversationSummary;
        messages: ClaudiusUIMessage[];
        documents: DocumentView[];
        jobs: JobView[];
      };
      setSeedMessages(data.messages);
      setSeedDocuments(data.documents);
      setSeedJobs(data.jobs);
      setActiveId(id);
      setModelId(
        models.some((m) => m.id === data.conversation.modelId)
          ? data.conversation.modelId
          : (models[0]?.id ?? ""),
      );
      setPaneKey(id);
      setUrl(id);
    },
    [activeId, models],
  );

  const newChat = useCallback((): void => {
    setSidebarOpen(false);
    setActiveId(null);
    setSeedMessages([]);
    setSeedDocuments([]);
    setSeedJobs([]);
    newCounter.current += 1;
    setPaneKey(`new-${newCounter.current}`);
    setUrl(null);
  }, []);

  const onConversationCreated = useCallback(
    (id: string, title: string): void => {
      // The first turn created this conversation server-side. Adopt its id
      // without remounting the pane (paneKey unchanged) so the streamed
      // messages survive, and show it in the sidebar immediately.
      setActiveId(id);
      setUrl(id);
      setConversations((prev) =>
        prev.some((c) => c.id === id)
          ? prev
          : [
              {
                id,
                title,
                modelId,
                archived: false,
                updatedAt: new Date().toISOString(),
                lastMessagePreview: null,
              },
              ...prev,
            ],
      );
    },
    [modelId],
  );

  const onTurnComplete = useCallback((): void => {
    void refreshConversations();
    // The title is generated just after the response flushes; pick it up shortly.
    setTimeout(() => void refreshConversations(), 2500);
  }, [refreshConversations]);

  const archive = useCallback(
    async (id: string): Promise<void> => {
      await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
      await refreshConversations();
      if (id === activeId) newChat();
    },
    [activeId, newChat, refreshConversations],
  );

  const sidebar = (
    <Sidebar
      conversations={conversations}
      activeId={activeId}
      onSelect={(id) => void selectConversation(id)}
      onNew={newChat}
      onArchive={(id) => void archive(id)}
      user={user}
    />
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {budget && <BudgetBanner level={budget.level} ratio={budget.ratio} />}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="hidden w-64 shrink-0 border-r border-sidebar-border lg:block">
          {sidebar}
        </aside>

        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-72 p-0">
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            {sidebar}
          </SheetContent>
        </Sheet>

        <main className="min-w-0 flex-1">
          <ChatPane
            key={paneKey}
            conversationId={activeId}
            initialMessages={seedMessages}
            initialDocuments={seedDocuments}
            initialJobs={seedJobs}
            role={user.role as Role}
            modelId={modelId}
            models={models}
            onModelChange={setModelId}
            onConversationCreated={onConversationCreated}
            onTurnComplete={onTurnComplete}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        </main>
      </div>
    </div>
  );
}
