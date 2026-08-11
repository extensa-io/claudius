"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { EyeOff, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Role } from "@claudius/shared";
import { buildHelpText, isHelpCommand, type BangView } from "@/lib/chat/help";
import type { ClaudiusUIMessage } from "@/lib/chat/types";
import type {
  DocumentView,
  ImagePolicyView,
  ModelOption,
} from "@/lib/chat/view-types";
import type { JobView } from "@/lib/jobs/view";
import { Composer } from "./composer";
import { MessageList } from "./message-list";
import { ModelSelector } from "./model-selector";
import { ResearchCard } from "./research-card";
import { useDocuments } from "./use-documents";
import { useResearchJobs } from "./use-jobs";

/**
 * Owns the live chat session for one conversation. The parent remounts this
 * component (via `key`) when the user switches conversations, so useChat starts
 * fresh, seeded with that thread's history. We send only the new user text plus
 * the conversation and model ids; the checkpointer holds the transcript.
 */
export function ChatPane({
  conversationId,
  initialMessages,
  initialDocuments,
  initialJobs,
  role,
  modelId,
  models,
  incognito,
  imagePolicy,
  bangs,
  onModelChange,
  onConversationCreated,
  onTurnComplete,
  onOpenSidebar,
  initialPrompt,
  onPromptConsumed,
}: {
  conversationId: string | null;
  initialMessages: ClaudiusUIMessage[];
  initialDocuments: DocumentView[];
  initialJobs: JobView[];
  role: Role;
  modelId: string;
  models: ModelOption[];
  /**
   * This thread runs without stored personal context. For an unsent new chat it
   * is the draft's mode and rides along on the first request; for an existing
   * conversation it is read back from the server and is display-only, since the
   * flag is fixed at creation.
   */
  incognito: boolean;
  /** The role's image policy, or null when the role gets no image service. */
  imagePolicy: ImagePolicyView | null;
  /** The merged bang table, listed by the `/help` cheat sheet. */
  bangs: BangView[];
  onModelChange: (id: string) => void;
  onConversationCreated: (id: string, title: string) => void;
  onTurnComplete: () => void;
  onOpenSidebar: () => void;
  /** `?q=` deep-link prompt to auto-send once on mount (Phase 9 widget path). */
  initialPrompt?: string | null;
  /** Called after the deep-link prompt has been sent, so the parent clears it. */
  onPromptConsumed?: () => void;
}): React.ReactNode {
  const canAttach = role !== "guest";
  const canResearch = role !== "guest";
  // Images are turn-scoped, so a resumed thread must not rehydrate them as
  // attachments: the bytes are long gone and the persisted turn already names
  // them. Filter them out of the seeded chips rather than showing a chip that
  // would silently re-attach nothing.
  const documents = useDocuments({
    conversationId,
    initialDocuments: initialDocuments.filter((d) => d.status !== "ready"),
    imagePolicy,
  });
  // Vision needs BOTH the role's policy and a model that can see. The server
  // decides for real; this only drives the affordance and the explanation.
  const selectedModel = models.find((m) => m.id === modelId);
  const canAttachImages =
    imagePolicy !== null && (selectedModel?.supportsImages ?? false);
  const [researchOn, setResearchOn] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
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
              documentIds: body?.documentIds,
              imageIds: body?.imageIds,
              // Only ever acted on when this request creates the conversation;
              // on a resumed thread the server reads the stored flag instead.
              incognito: body?.incognito,
            },
          };
        },
      }),
    [],
  );

  const { messages, sendMessage, setMessages, status, stop, error } =
    useChat<ClaudiusUIMessage>({
      messages: initialMessages,
      transport,
      onData: (part) => {
        if (part.type === "data-conversation") {
          onConversationCreated(part.data.id, part.data.title);
        } else if (part.type === "data-redirect") {
          // Phase 8 zero-cost path: a bang or navigational query resolved to a
          // URL server-side. Open it in a NEW tab so the conversation stays put
          // (mirrors data-conversation's in-place handling), and leave an
          // ephemeral note in this session so the user sees where they were sent.
          if (typeof window !== "undefined") {
            window.open(part.data.url, "_blank", "noopener,noreferrer");
          }
          setMessages((prev) => [
            ...prev,
            {
              id: `redirect-${prev.length}-${part.data.url}`,
              role: "assistant",
              parts: [
                {
                  type: "text",
                  text: `↗ Opened ${part.data.url} (${part.data.label}).`,
                },
              ],
            },
          ]);
        }
      },
      onFinish: () => {
        // Pending documents were associated to the conversation by this turn;
        // they no longer need to be re-sent.
        documents.clearPending();
        onTurnComplete();
      },
    });

  // When a research job finishes, drop its report into the transcript as a normal
  // turn (question + report) so it sits at its chronological place and never
  // floats. The report is tagged `research` so it renders with a download button.
  const onReportReady = useCallback(
    (job: JobView): void => {
      if (!job.report) return;
      const reportId = `research-${job.id}-r`;
      setMessages((prev) => {
        if (prev.some((m) => m.id === reportId)) return prev;
        return [
          ...prev,
          {
            id: `research-${job.id}-q`,
            role: "user",
            parts: [{ type: "text", text: job.question ?? "" }],
          },
          {
            id: reportId,
            role: "assistant",
            parts: [{ type: "text", text: job.report ?? "" }],
            metadata: {
              research: { question: job.question ?? "", jobId: job.id },
            },
          },
        ];
      });
    },
    [setMessages],
  );

  const research = useResearchJobs({
    initialJobs,
    onConversationCreated,
    onError: setResearchError,
    onSettled: onTurnComplete,
    onReportReady,
  });

  // Refine a finished report: start a follow-up research run seeded with that
  // report (the worker builds on it) in the same conversation.
  const onRefine = (parentJobId: string, instruction: string): void => {
    setResearchError(null);
    void research.start({
      conversationId,
      modelId,
      refinement: instruction,
      parentJobId,
    });
  };

  const busy = status === "submitted" || status === "streaming";
  const isWaiting =
    status === "submitted" &&
    messages[messages.length - 1]?.role === "user";

  const send = (text: string): void => {
    setResearchError(null);
    // `/help` is answered here, in the browser: the text is static, so a round
    // trip would spend a model call, a daily message, and a checkpoint write on
    // something we already know. The pair is added to this session only — it is
    // never persisted, so the model does not read the cheat sheet on the next
    // turn. Intercepted ahead of the research toggle: help is not a question, so
    // it must not consume a queued research run.
    if (isHelpCommand(text)) {
      setMessages((prev) => [
        ...prev,
        {
          id: `help-q-${prev.length}`,
          role: "user",
          parts: [{ type: "text", text }],
        },
        {
          id: `help-a-${prev.length}`,
          role: "assistant",
          parts: [
            {
              type: "text",
              text: buildHelpText({ role, bangs, canAttachImages }),
            },
          ],
        },
      ]);
      return;
    }
    if (researchOn) {
      // Research is a one-shot per question: turn the toggle back off so the next
      // message is a normal chat turn unless the user re-enables it.
      setResearchOn(false);
      void research.start({ conversationId, modelId, question: text });
      return;
    }
    void sendMessage(
      { text },
      {
        body: {
          conversationId,
          modelId,
          documentIds: documents.pendingDocumentIds,
          imageIds: documents.attachedImageIds,
          incognito,
        },
      },
    );
    // Images live for exactly one turn: drop the chips as soon as the turn that
    // carries them is sent, so nothing implies they are still attached.
    if (documents.attachedImageIds.length > 0) documents.clearImages();
  };

  // Deep-link auto-send (Phase 9): if the page was opened with a `?q=` query on
  // a fresh conversation, submit it once as the first message through the exact
  // same path as a typed message. The ref latch guarantees a single fire despite
  // React strict-mode double-invocation and re-renders; we also strip `q` from
  // the URL immediately so a refresh before the conversation exists can't
  // re-send. Guarded on conversationId === null so it never fires on a resumed
  // thread. `send`/`onPromptConsumed` are intentionally not in the deps: this is
  // a one-shot on mount, keyed by the presence of a prompt.
  const promptFired = useRef(false);
  useEffect(() => {
    if (promptFired.current) return;
    if (conversationId !== null) return;
    const prompt = initialPrompt?.trim();
    if (!prompt) return;
    promptFired.current = true;
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("q")) {
        url.searchParams.delete("q");
        window.history.replaceState(null, "", url.pathname + url.search);
      }
    }
    send(prompt);
    onPromptConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPrompt, conversationId]);

  const isEmpty = messages.length === 0 && research.jobs.length === 0;
  const researchFooter =
    research.jobs.length > 0 ? (
      <div>
        {research.jobs.map((job) => (
          <ResearchCard
            key={job.id}
            job={job}
            onCancel={(id) => void research.cancel(id)}
          />
        ))}
      </div>
    ) : null;
  // Changes as jobs are added or their progress grows, so the transcript
  // re-sticks to the bottom while a research card streams updates.
  const footerRevision =
    research.jobs.length +
    research.jobs.reduce((n, j) => n + j.progress.length, 0);

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
        {incognito && (
          <span className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">
            <EyeOff className="size-3.5" />
            Incognito
          </span>
        )}
      </header>

      {/* The wording is deliberate about what incognito does NOT do. The thread
          is still saved, and a file the user attaches here still comes from
          their library — promising more than that would be a privacy claim the
          feature doesn't make good on. */}
      {incognito && (
        <div className="mx-auto w-full max-w-3xl px-4 pt-3">
          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This chat runs without your saved memories or custom instructions,
            and nothing said here is added to memory. The transcript is still
            saved until you delete the conversation.
          </p>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isEmpty ? (
          <div className="flex h-full items-center justify-center px-6">
            <p className="text-center text-muted-foreground">
              Ask anything to get started, or type{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-sm">
                /help
              </code>{" "}
              to see what Claudius can do.
            </p>
          </div>
        ) : (
          <MessageList
            messages={messages}
            isWaiting={isWaiting}
            footer={researchFooter}
            footerRevision={footerRevision}
            onRefine={onRefine}
          />
        )}
      </div>

      {(error || researchError) && (
        <div className="mx-auto w-full max-w-3xl px-4">
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {researchError ?? error?.message}
          </p>
        </div>
      )}

      <Composer
        onSend={send}
        onStop={stop}
        busy={busy}
        canAttach={canAttach}
        canAttachImages={canAttachImages}
        imagePolicy={imagePolicy}
        imageCount={documents.attachedImageIds.length}
        overImageCap={documents.overImageCap}
        modelDisplayName={selectedModel?.displayName ?? null}
        chips={documents.chips}
        onUploadFiles={documents.uploadFiles}
        onRetryDoc={documents.retry}
        onRemoveDoc={documents.remove}
        canResearch={canResearch}
        researchOn={researchOn}
        onToggleResearch={() => setResearchOn((v) => !v)}
      />
    </div>
  );
}
