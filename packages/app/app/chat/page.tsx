import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  getMonthlyBudgetStatus,
  getUsableModels,
  loadThreadMessages,
} from "@claudius/shared";
import { ChatApp, type BudgetInfo } from "@/components/chat/chat-app";
import { auth } from "@/lib/auth";
import { signOut } from "@/lib/auth";
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

  // A disabled account can still hold a valid session; block it here rather than
  // redirecting (the landing page would just send it back and loop). Model calls
  // are already refused server-side in assertCanInvoke — this closes the UI.
  if (session.user.status === "disabled") {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-2xl font-semibold">Account disabled</h1>
        <p className="max-w-md text-muted-foreground">
          Your account has been disabled. Please contact an administrator.
        </p>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            type="submit"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
          >
            Sign out
          </button>
        </form>
      </main>
    );
  }

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

  const [conversations, modelEntries, budgetStatus] = await Promise.all([
    listConversations(userId),
    getUsableModels(userId),
    getMonthlyBudgetStatus(userId),
  ]);
  const models = modelEntries.map((m) => ({
    id: m.id,
    displayName: m.displayName,
  }));

  // Surface the monthly budget banner only when it's limited and at/near cap.
  const budget: BudgetInfo | null =
    budgetStatus.limited && budgetStatus.level !== "ok"
      ? { level: budgetStatus.level, ratio: budgetStatus.ratio }
      : null;

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
      budget={budget}
    />
  );
}
