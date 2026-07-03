import type { UIMessage, UIMessageStreamWriter } from "ai";
import { z } from "zod";

/**
 * The custom data part the chat stream emits once, up front: the id and title
 * of the conversation this turn belongs to. On a brand-new conversation the
 * server creates the row and sends the id back here so the client can adopt it
 * (update the URL, show it in the sidebar) without a second round trip. Marked
 * transient when written, so it drives UI state without becoming a message part.
 */
export interface ConversationDataPart {
  id: string;
  title: string;
}

/** A single memory the agent recalled this turn, for the "used" chip. */
export interface UsedMemory {
  id: string;
  content: string;
  category: "fact" | "preference" | "context";
}

/**
 * Emitted once by `load_context` (via the graph's `memories_used` custom event)
 * when memories informed the answer. Written as a NON-transient part so it lives
 * on the assistant message and renders as a footer chip under that turn.
 */
export interface MemoriesDataPart {
  memories: UsedMemory[];
}

/**
 * Message-level metadata. A finished research report is a normal assistant
 * message (so it sits at its chronological place in the thread and never floats),
 * tagged with `research` so the UI can give it a "Research report" header and a
 * download button. The question rides along for the download filename.
 */
export interface ClaudiusMessageMetadata {
  /** Present on a research report message. `jobId` is the report's job, used to
   * refine it (start a follow-up run seeded with this report). */
  research?: { question: string; jobId?: string };
}

/** Claudius's UIMessage shape: research metadata, two custom data parts. */
export type ClaudiusUIMessage = UIMessage<
  ClaudiusMessageMetadata,
  { conversation: ConversationDataPart; memories: MemoriesDataPart }
>;

export type ClaudiusStreamWriter = UIMessageStreamWriter<ClaudiusUIMessage>;

/**
 * The chat request contract. We deliberately send only the *new* user text plus
 * the target conversation and model, never the whole transcript: the
 * checkpointer is the source of truth for history (keyed by conversationId), so
 * re-sending it would be redundant and a tampering surface. `conversationId` is
 * absent on the first message of a new conversation; the server creates it.
 */
export const ChatRequestSchema = z.object({
  // nullish, not optional: the client sends `null` (not just an absent key) for
  // the first message of a new conversation, and `.optional()` rejects `null`.
  conversationId: z.string().min(1).nullish(),
  modelId: z.string().min(1),
  text: z.string().min(1).max(32_000),
  // Pending attachments uploaded before the conversation existed. The route
  // associates these to the conversation (only the user's own, still-pending
  // ones) before the turn runs. Bounded to keep the payload sane.
  documentIds: z.array(z.string().min(1)).max(20).optional(),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
