import { HumanMessage } from "@langchain/core/messages";
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { ObjectId } from "mongodb";
import { after } from "next/server";
import {
  AppError,
  assertCanInvoke,
  getChatGraph,
  isAppError,
  writeUsageEvent,
} from "@claudius/shared";
import { auth } from "@/lib/auth";
import { bridgeGraphEvents } from "@/lib/chat/bridge";
import {
  createConversation,
  getOwnedConversation,
  touchConversation,
} from "@/lib/chat/conversations";
import {
  associatePendingDocuments,
  getRetrievableDocuments,
} from "@/lib/documents";
import { generateTitle } from "@/lib/chat/titleGen";
import { type ClaudiusUIMessage, ChatRequestSchema } from "@/lib/chat/types";
import { errorResponse } from "@/lib/http";

// LangGraph and the Mongo driver need the Node runtime, not edge. maxDuration is
// raised so a streamed multi-step turn (model -> tool -> model) has room to run.
export const runtime = "nodejs";
export const maxDuration = 60;

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

    // 2. Enforce tiers: model permission, circuit breaker, atomic daily cap.
    const grant = await assertCanInvoke(userId, modelId);

    // 3. Now safe to create a new conversation for a first message.
    const isNewConversation = conversation === null;
    if (!conversation) {
      conversation = await createConversation({ userId, role, modelId });
    }
    const conversationObjId = conversation._id!;
    const threadId = conversationObjId.toString();
    const conversationTitle = conversation.title;

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
          { messages: [new HumanMessage(text)] },
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
            },
            signal: req.signal,
          },
        );

        const startedAt = Date.now();
        const { usage, assistantText } = await bridgeGraphEvents(events, writer);
        const latencyMs = Date.now() - startedAt;

        writer.write({ type: "finish-step" });
        writer.write({ type: "finish" });

        // Exactly one usage_events row per chat turn, summed across model calls
        // (a tool loop invokes the model more than once). Invariant #3.
        await writeUsageEvent({
          userId,
          conversationId: conversationObjId,
          modelId: grant.modelId,
          purpose: "chat",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          latencyMs,
        });

        await touchConversation({
          userId,
          conversationId: conversationObjId,
          preview: assistantText || text,
          modelId: grant.modelId,
        });

        // First exchange done: generate a title after the response flushes.
        if (isNewConversation) {
          after(() =>
            generateTitle({
              userId,
              conversationId: conversationObjId,
              userText: text,
              assistantText,
            }),
          );
        }
      },
    });

    return createUIMessageStreamResponse({ stream });
  } catch (err) {
    return errorResponse(err);
  }
});
