import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { getUsableModels, loadThreadMessages } from "@claudius/shared";
import { ChatApp } from "@/components/chat/chat-app";
import { auth } from "@/lib/auth";
import { getOwnedConversation, listConversations } from "@/lib/chat/conversations";
import { toUIMessages } from "@/lib/chat/messages";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import type { DocumentView } from "@/lib/chat/view-types";
import { listConversationDocuments } from "@/lib/documents";
import { sweepUserMemories } from "@/lib/memory/sweep";

// Node runtime: this page reaches Mongo and the checkpointer directly.
export const runtime = "nodejs";

/**
 * The signed-in chat experience. Initial data (conversations, allowed models,
 * and the resumed thread named by ?c=) is fetched server-side and handed to the
 * client shell, so the app paints with content rather than a loading waterfall.
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string }>;
}): Promise<React.ReactNode> {
  const session = await auth();
  if (!session?.user) redirect("/");

  const userId = new ObjectId(session.user.id);
  const { c } = await searchParams;

  // Lazy memory extraction (Phase 3): after this page responds, process a few of
  // the user's conversations that have new turns since their last extraction.
  // `after` runs post-response so it never delays the paint; the daily cron is
  // the backstop for conversations this bounded pass doesn't reach. It's a cheap
  // no-op once everything is up to date.
  after(async () => {
    try {
      await sweepUserMemories(userId);
    } catch (err) {
      console.error(
        "Sign-in memory sweep failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  });

  const [conversations, modelEntries] = await Promise.all([
    listConversations(userId),
    getUsableModels(userId),
  ]);
  const models = modelEntries.map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));

  let initialConversationId: string | null = null;
  let initialMessages: ClaudiusUIMessage[] = [];
  let initialDocuments: DocumentView[] = [];
  if (c) {
    const conversation = await getOwnedConversation(userId, c);
    if (conversation) {
      initialConversationId = c;
      initialDocuments = await listConversationDocuments(
        userId,
        conversation._id!,
      );
      try {
        initialMessages = toUIMessages(await loadThreadMessages(c));
      } catch (err) {
        // A failure to read history must not take down the whole page. Keep the
        // conversation selected (the model still has full context from the
        // checkpointer) and log the real cause for diagnosis.
        console.error(
          `Failed to load history for conversation ${c}:`,
          err instanceof Error ? `${err.name}: ${err.message}` : err,
        );
      }
    }
  }

  return (
    <ChatApp
      user={{
        name: session.user.name ?? null,
        email: session.user.email ?? null,
        role: session.user.role,
      }}
      initialConversations={conversations}
      models={models}
      initialConversationId={initialConversationId}
      initialMessages={initialMessages}
      initialDocuments={initialDocuments}
    />
  );
}
