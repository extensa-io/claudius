import { HumanMessage } from "@langchain/core/messages";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import {
  AppError,
  assertCanInvoke,
  getChatGraph,
  getUserSettings,
  isAppError,
  loadSearchSettings,
  parseDefineQuery,
  resolveTurnImages,
  writeUsageEvent,
} from "@claudius/shared";
import { auth } from "@/lib/auth";
import { bridgeGraphEvents, createTurnProgress } from "@/lib/chat/bridge";
import { handleDictionaryTurn } from "@/lib/chat/dictionary";
import {
  createConversation,
  getOwnedConversation,
  touchConversation,
} from "@/lib/chat/conversations";
import { appendPartialAssistantTurn } from "@/lib/chat/partial";
import { appendRedirectToThread } from "@/lib/chat/redirect";
import { resolveRedirect } from "@/lib/chat/routing";
import { assertImagesAllowed, attachedImagesTurnText } from "@/lib/chat/vision";
import {
  associatePendingDocuments,
  getRetrievableDocuments,
} from "@/lib/documents";
import { generateTitle } from "@/lib/chat/titleGen";
import { type ClaudiusUIMessage, ChatRequestSchema } from "@/lib/chat/types";
import { errorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/ratelimit";

// LangGraph and the Mongo driver need the Node runtime, not edge.
//
// maxDuration matters more here than anywhere else in the app. Nothing about a
// turn is durable until the run completes: the checkpointer commits the assistant
// message when the agent node returns, and the usage row, the preview and the
// title are all written after that. A turn killed by the platform therefore
// streams a full reply to the browser and persists NOTHING — the thread reloads
// as an unanswered question. At 60s that was reachable in normal use (a long
// explanation, or a tool loop with several searches), so this is the Pro ceiling.
export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The chat turn. Validates input, resolves (or creates) the conversation,
 * enforces tier rules — which atomically consumes the daily message and resolves
 * the model — then streams the LangGraph agent, bridging streamEvents to the AI
 * SDK protocol. When the run completes it writes exactly one usage_events row and
 * refreshes the conversation; on a new conversation it kicks off title generation.
 */
export const POST = auth(async (req) => {
  if (!req.auth?.user) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }
  const userId = new ObjectId(req.auth.user.id);
  const role = req.auth.user.role;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new AppError("invalid_input", "Malformed request."));
  }

  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      new AppError("invalid_input", "Invalid chat request."),
    );
  }
  const { conversationId, modelId, text, documentIds } = parsed.data;
  const imageIds = parsed.data.imageIds ?? [];

  // An empty turn is not a turn. Text may be empty ONLY when images carry it.
  if (text.trim().length === 0 && imageIds.length === 0) {
    return errorResponse(new AppError("invalid_input", "Message is empty."));
  }

  try {
    // 1. Verify ownership of an existing conversation BEFORE consuming anything,
    //    so a 404 never burns a message. (A new conversation is created only
    //    after enforcement passes, below, so a tripped cap leaves no empty row.)
    let conversation = conversationId
      ? await getOwnedConversation(userId, conversationId)
      : null;
    if (conversationId && !conversation) {
      throw new AppError("not_found", "Conversation not found.");
    }

    // 2. Burst rate limit: an abuse backstop distinct from the tier daily cap.
    //    Applied BEFORE the pre-graph router too, so bang/redirect spam can't
    //    bypass the volume backstop (it costs a DB read and maybe a checkpoint
    //    write even though it never wakes the model).
    await enforceRateLimit(userId, "chat");

    // 3. Pre-graph router (Phase 8): the ZERO-COST path. A bang or a bare
    //     URL/domain resolves to a redirect target WITHOUT waking the model, so
    //     no tier is consumed and NO usage_events row is written (the model
    //     never ran — invariant #3 holds because there is no model call to gate).
    //     Resolved before TIER enforcement so a redirect never burns a daily
    //     message. When the query already belongs to a conversation we persist a
    //     small inline record into its checkpoint so history is honest; a bang as
    //     the first message of a fresh chat does NOT create a conversation
    //     (mirrors how a tripped cap leaves no empty row) — the client shows an
    //     ephemeral note and opens the tab.
    //     An image-bearing turn skips the router and the dictionary outright: a
    //     turn with a picture attached is a question ABOUT the picture, so
    //     redirecting it to a search engine or a definition lookup would throw
    //     the attachment away and answer something the user did not ask.
    const searchSettings = await loadSearchSettings();
    const redirect =
      imageIds.length > 0 ? null : resolveRedirect(text, searchSettings);
    if (redirect) {
      if (conversation) {
        await appendRedirectToThread(
          conversation._id!.toString(),
          text,
          redirect.url,
          redirect.label,
        );
      }
      const redirectStream = createUIMessageStream<ClaudiusUIMessage>({
        execute: ({ writer }) => {
          writer.write({ type: "start" });
          writer.write({
            type: "data-redirect",
            data: { url: redirect.url, label: redirect.label },
            transient: true,
          });
          writer.write({ type: "finish" });
        },
      });
      return createUIMessageStreamResponse({ stream: redirectStream });
    }

    // 3.5 Dictionary mode (Phase 10): a leading `?` define/translate lookup
    //     routes to the dictionary engine instead of the chat graph. It runs its
    //     OWN gate (on a cache miss) and its own global/content-only cache — a
    //     cache hit costs no model call and consumes no daily message, a miss is
    //     a normal gated, logged turn. Uses the same parse primitive the
    //     classifier's `lexical` intent is built on, so the two never disagree.
    const defineTerm = imageIds.length > 0 ? null : parseDefineQuery(text);
    if (defineTerm !== null) {
      return await handleDictionaryTurn({
        userId,
        role,
        modelId,
        term: defineTerm,
        rawText: text,
        conversation,
        signal: req.signal,
      });
    }

    // 4. Enforce tiers: model permission, cost controls, atomic daily cap.
    const grant = await assertCanInvoke(userId, modelId);

    // 4.5 Vision gate (Phase 12). The client resizes and counts because that is
    //     where it can do so cheaply; the server re-checks both because the
    //     client is not trusted. Every branch REFUSES the turn rather than
    //     dropping the image — a silently dropped image means the model answers
    //     confidently about something it never saw, which is the worst failure
    //     available here.
    if (imageIds.length > 0) {
      assertImagesAllowed(imageIds.length, grant);
    }

    // 5. Now safe to create a new conversation for a first message.
    const isNewConversation = conversation === null;
    if (!conversation) {
      conversation = await createConversation({ userId, role, modelId });
    }
    const conversationObjId = conversation._id!;
    const threadId = conversationObjId.toString();
    const conversationTitle = conversation.title;

    // Title the conversation as soon as its row exists, from the user's opening
    // message. Deliberately NOT at the end of the turn: only a new conversation
    // is ever titled, so a first turn that dies mid-run used to leave the thread
    // on "New chat" permanently.
    if (isNewConversation) {
      after(() =>
        generateTitle({
          userId,
          conversationId: conversationObjId,
          userText: text,
        }),
      );
    }

    // Associate any documents uploaded before this conversation existed (only
    // the user's own, still-pending ones — see associatePendingDocuments), then
    // resolve the conversation's embedded documents to scope retrieval. The
    // agent is offered retrieve_documents only when this list is non-empty.
    if (documentIds && documentIds.length > 0) {
      await associatePendingDocuments(userId, conversationObjId, documentIds);
    }
    const attachedDocs = await getRetrievableDocuments(
      userId,
      conversationObjId,
    );
    const attachedDocumentIds = attachedDocs.map((d) => d.id);
    const attachedDocumentNames = attachedDocs.map((d) => d.filename);

    // Resolve the turn's images against the owner (invariant #1) before the run
    // starts, for two reasons: an id that isn't the user's own ready image is
    // rejected here rather than vanishing mid-run, and the filenames go into the
    // PERSISTED human turn. That last part is what keeps the thread coherent —
    // the bytes are gone after this turn, so the transcript needs to say what was
    // discussed, or a later turn reads as an answer to nothing.
    const turnImages =
      imageIds.length > 0 ? await resolveTurnImages(userId, imageIds) : [];
    if (turnImages.length !== imageIds.length) {
      throw new AppError(
        "not_found",
        "One of the attached images is no longer available. Try attaching it again.",
      );
    }
    const resolvedImageIds = turnImages.map((i) => i.id);
    const humanText =
      turnImages.length > 0
        ? attachedImagesTurnText(text, turnImages.map((i) => i.filename))
        : text;

    // User-authored personalization (preferred name + instructions), injected
    // into the prompt above and outranking inferred memory. Members and admins
    // only: guests never author settings, so we skip the read entirely for them
    // and leave the fields absent (the prompt section is then omitted).
    const userSettings =
      role === "guest"
        ? { preferredName: null, instructions: null }
        : await getUserSettings(userId);

    const graph = await getChatGraph();

    const stream = createUIMessageStream<ClaudiusUIMessage>({
      onError: (error) => {
        // Errors thrown mid-stream (e.g. a Bedrock ValidationException for a bad
        // inference profile id) never reach the outer catch, so log them here for
        // diagnosis. The client still gets only a user-safe message.
        console.error(
          `Chat stream error (model=${grant.modelId}):`,
          error instanceof Error ? `${error.name}: ${error.message}` : error,
        );
        return isAppError(error) ? error.message : "The model run failed.";
      },
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        // Hand the (possibly newly created) conversation id back to the client.
        writer.write({
          type: "data-conversation",
          data: { id: threadId, title: conversationTitle },
          transient: true,
        });
        writer.write({ type: "start-step" });

        const events = graph.streamEvents(
          // The persisted turn is TEXT-ONLY, always. The images are hydrated
          // into an ephemeral copy inside the agent node and never written back
          // to `messages` — see ChatGraphConfigurable.imageIds for why putting
          // them here instead would quietly wreck the thread.
          { messages: [new HumanMessage(humanText)] },
          {
            version: "v2",
            configurable: {
              thread_id: threadId,
              inferenceProfileId: grant.inferenceProfileId,
              userId: userId.toString(),
              attachedDocumentIds,
              attachedDocumentNames,
              // load_context skips retrieval entirely when memory is off.
              memoryEnabled: grant.memoryEnabled,
              preferredName: userSettings.preferredName,
              customInstructions: userSettings.instructions,
              // read_url is a member/admin capability (Phase 11): the flag is
              // set from the session-derived role, never from client input, so a
              // guest turn never gets the tool bound (invariant #2).
              canReadUrls: role !== "guest",
              // Per-run, NOT checkpointed — the whole point. canUseVision is
              // resolved from the server-side grant, never from client input.
              imageIds: resolvedImageIds,
              canUseVision: resolvedImageIds.length > 0,
            },
            signal: req.signal,
          },
        );

        // The bridge mutates `progress` as tokens arrive, so if the run throws
        // (client abort, a model error after streaming) we still hold the text
        // and token counts the user actually saw.
        const progress = createTurnProgress();
        const startedAt = Date.now();

        // Exactly one usage_events row per chat turn, summed across model calls
        // (a tool loop invokes the model more than once). Invariant #3. Written
        // for an interrupted turn too — the tokens were spent either way.
        const recordTurn = async (interrupted: boolean): Promise<void> => {
          const { usage, assistantText } = progress;
          await writeUsageEvent({
            userId,
            conversationId: conversationObjId,
            modelId: grant.modelId,
            purpose: "chat",
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            latencyMs: Date.now() - startedAt,
            // Image tokens already arrive inside input_tokens, so this adds no
            // accounting — it makes image-bearing turns separable in the admin
            // view, where their token profile would otherwise look like an
            // inexplicably expensive short question.
            imageCount: resolvedImageIds.length,
          });

          // On a completed run the graph has already committed the assistant
          // message; on an interrupted one it never will, so append what streamed.
          if (interrupted) {
            await appendPartialAssistantTurn(threadId, assistantText);
          }

          await touchConversation({
            userId,
            conversationId: conversationObjId,
            preview: assistantText || text,
            modelId: grant.modelId,
          });
        };

        try {
          await bridgeGraphEvents(events, writer, progress);
        } catch (err) {
          await recordTurn(true);
          throw err;
        }
        await recordTurn(false);

        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    return errorResponse(err);
  }
});
