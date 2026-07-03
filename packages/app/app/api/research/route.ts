import { ObjectId } from "mongodb";
import { after } from "next/server";
import { z } from "zod";
import { AppError, assertCanInvoke, enqueueResearchJob } from "@claudius/shared";
import { auth } from "@/lib/auth";
import {
  createConversation,
  getOwnedConversation,
  setConversationTitle,
  touchConversation,
} from "@/lib/chat/conversations";
import { generateTitle } from "@/lib/chat/titleGen";
import { errorResponse } from "@/lib/http";
import { enforceRateLimit } from "@/lib/ratelimit";

/** A readable provisional title from the question, shown until the polished
 * Haiku title lands. Trims to a word boundary so it never cuts mid-word. */
function provisionalTitle(question: string): string {
  const trimmed = question.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 52) return trimmed;
  const cut = trimmed.slice(0, 52);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]+$/, "")}…`;
}

// Enqueue only — no model runs here. This returns immediately with a job id; the
// Railway worker does the long-running research off Vercel entirely.
export const runtime = "nodejs";

const ResearchRequestSchema = z.object({
  conversationId: z.string().min(1).nullish(),
  modelId: z.string().min(1),
  question: z.string().min(1).max(2_000),
});

/**
 * Start a deep-research job (member/admin only — research is not a guest
 * feature). Validates input, resolves or creates the conversation, checks the
 * user may invoke the model and clears the cost controls (WITHOUT consuming a
 * daily message — the worker consumes one per model call it makes), then inserts
 * a research job and hands back its id. The client polls the job status endpoint.
 */
export const POST = auth(async (req) => {
  if (!req.auth?.user) {
    return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
  }
  const userId = new ObjectId(req.auth.user.id);
  const role = req.auth.user.role;
  if (role === "guest") {
    return errorResponse(
      new AppError("model_not_permitted", "Research isn't available on your plan."),
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(new AppError("invalid_input", "Malformed request."));
  }
  const parsed = ResearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(new AppError("invalid_input", "Invalid research request."));
  }
  const { conversationId, modelId, question } = parsed.data;

  try {
    let conversation = conversationId
      ? await getOwnedConversation(userId, conversationId)
      : null;
    if (conversationId && !conversation) {
      throw new AppError("not_found", "Conversation not found.");
    }

    await enforceRateLimit(userId, "chat");
    // Validate eligibility + cost controls up front so a blocked user gets
    // immediate feedback instead of a job that fails on its first step. No daily
    // message is consumed here; the worker's model calls each consume one.
    await assertCanInvoke(userId, modelId, { consumeDailyMessage: false });

    const isNewConversation = conversation === null;
    if (!conversation) {
      conversation = await createConversation({ userId, role, modelId });
    }
    const conversationObjId = conversation._id!;

    // A fresh research thread would otherwise sit as "New chat" with no subtitle
    // (research never ran the chat title path). Give it an immediate provisional
    // title and a subtitle now, then polish the title with the usual Haiku pass.
    let title = conversation.title;
    if (isNewConversation) {
      title = provisionalTitle(question);
      await setConversationTitle(userId, conversationObjId, title);
      await touchConversation({
        userId,
        conversationId: conversationObjId,
        preview: `Deep research: ${question}`,
        modelId,
      });
      after(() =>
        generateTitle({
          userId,
          conversationId: conversationObjId,
          userText: question,
          assistantText: "A deep-research report.",
        }),
      );
    }

    const jobId = await enqueueResearchJob({
      userId,
      conversationId: conversationObjId,
      question,
      modelId,
    });

    return Response.json({
      jobId: jobId.toString(),
      conversationId: conversationObjId.toString(),
      title,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
