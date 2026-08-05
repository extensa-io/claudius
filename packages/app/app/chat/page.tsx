import { ObjectId } from "mongodb";
import { redirect } from "next/navigation";
import { after } from "next/server";
import {
  getMonthlyBudgetStatus,
  getUsableModels,
  getUserSettings,
  loadThreadMessages,
  loadTier,
} from "@claudius/shared";
import { ChatApp, type BudgetInfo } from "@/components/chat/chat-app";
import { auth } from "@/lib/auth";
import { signOut } from "@/lib/auth";
import { getOwnedConversation, listConversations } from "@/lib/chat/conversations";
import { sanitizeDeepLinkQuery } from "@/lib/chat/deep-link";
import { toUIMessages } from "@/lib/chat/messages";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import type { DocumentView } from "@/lib/chat/view-types";
import { listConversationDocuments } from "@/lib/documents";
import { getActiveResearchJobViews, type JobView } from "@/lib/jobs/view";
import { enqueueUserMemories } from "@/lib/memory/enqueue";

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
  searchParams: Promise<{ c?: string; q?: string }>;
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
  const { c, q } = await searchParams;

  // Deep-link auto-send (Phase 9): `?q=` seeds and sends the first message of a
  // NEW conversation, used by the Android home-screen widget. It only applies
  // when there's no `c` (a resumed conversation ignores it), and it's sanitized
  // to plain text here. The client fires it through the normal composer send
  // path, so tier enforcement, usage_events, and userId scoping all still apply.
  const initialPrompt = c ? null : sanitizeDeepLinkQuery(q);

  // The sticky model preference is a member/admin feature: guests never get a
  // user_settings document, so skip the read for them entirely (invariant #4).
  const [conversations, modelEntries, budgetStatus, userSettings] =
    await Promise.all([
      listConversations(userId),
      getUsableModels(userId),
      getMonthlyBudgetStatus(userId),
      session.user.role === "guest" ? null : getUserSettings(userId),
    ]);

  // Opening /chat with no explicit target — no `?c=` and no `?q=` deep link —
  // resumes where the user left off instead of dropping them on a blank thread.
  // We pick the newest non-archived conversation: the same set the sidebar shows,
  // already sorted updatedAt-desc, so reopening the app returns to the last one
  // used. With none to resume (a new or fully archived account) we fall through
  // to the blank new-chat state. The redirected request carries `c`, so a resume
  // never loops back through this branch.
  if (!c && !initialPrompt) {
    const mostRecent = conversations.find((conv) => !conv.archived);
    if (mostRecent) redirect(`/chat?c=${mostRecent.id}`);
  }

  // Lazy memory extraction (Phase 3, now enqueue-only in Phase 5): after this
  // page responds, ENQUEUE extraction jobs for a few of the user's conversations
  // that have new turns since their last extraction — the worker does the actual
  // model work. `after` runs post-response so it never delays the paint; the
  // daily cron is the backstop. Enqueuing dedupes, so it's a cheap no-op when
  // everything is already queued or up to date. Registered after the resume
  // redirect so it's scheduled once, on the request that actually renders.
  after(async () => {
    try {
      await enqueueUserMemories(userId);
    } catch (err) {
      console.error(
        "Sign-in memory enqueue failed:",
        err instanceof Error ? `${err.name}: ${err.message}` : err,
      );
    }
  });

  const models = modelEntries.map((m) => ({
    id: m.id,
    displayName: m.displayName,
    supportsImages: m.supportsImages ?? false,
  }));

  // The role's image policy (Phase 12). Absent means the role gets no image
  // service at all, which is how the guest tier is configured off rather than
  // special-cased — so guests simply get null here and no attach affordance.
  const imagePolicy = (await loadTier(session.user.role)).images ?? null;

  // Seed new conversations from the remembered choice, but only if it's still a
  // model the user may use (a role or catalog change can strip access). Null
  // otherwise, and ChatApp falls back to the first allowed model.
  const preferredModelId =
    userSettings?.preferredModelId != null &&
    models.some((m) => m.id === userSettings.preferredModelId)
      ? userSettings.preferredModelId
      : null;

  // Surface the monthly budget banner only when it's limited and at/near cap.
  const budget: BudgetInfo | null =
    budgetStatus.limited && budgetStatus.level !== "ok"
      ? { level: budgetStatus.level, ratio: budgetStatus.ratio }
      : null;

  let initialConversationId: string | null = null;
  let initialMessages: ClaudiusUIMessage[] = [];
  let initialDocuments: DocumentView[] = [];
  let initialJobs: JobView[] = [];
  if (c) {
    const conversation = await getOwnedConversation(userId, c);
    if (conversation) {
      initialConversationId = c;
      [initialDocuments, initialJobs] = await Promise.all([
        listConversationDocuments(userId, conversation._id!),
        getActiveResearchJobViews(userId, conversation._id!),
      ]);
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
      preferredModelId={preferredModelId}
      initialConversationId={initialConversationId}
      initialMessages={initialMessages}
      initialDocuments={initialDocuments}
      initialJobs={initialJobs}
      budget={budget}
      imagePolicy={imagePolicy}
      initialPrompt={initialPrompt}
    />
  );
}
