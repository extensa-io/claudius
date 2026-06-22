import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { getUsableModels, loadThreadMessages } from "@claudius/shared";
import { ChatApp } from "@/components/chat/chat-app";
import { auth } from "@/lib/auth";
import { getOwnedConversation, listConversations } from "@/lib/chat/conversations";
import { toUIMessages } from "@/lib/chat/messages";
import type { ClaudiusUIMessage } from "@/lib/chat/types";

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
  if (c) {
    const conversation = await getOwnedConversation(userId, c);
    if (conversation) {
      initialConversationId = c;
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
    />
  );
}
