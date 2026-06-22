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

/** Claudius's UIMessage shape: no metadata, one custom `data-conversation` part. */
export type ClaudiusUIMessage = UIMessage<
  never,
  { conversation: ConversationDataPart }
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
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
