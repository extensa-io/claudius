import type { BaseMessage } from "@langchain/core/messages";
import type { ClaudiusUIMessage } from "./types";

/**
 * Render a checkpointed thread as UI messages for resume. We surface the user
 * and assistant *text* turns — enough to redisplay the conversation. Tool
 * messages and empty tool-call-only assistant turns are folded away: they carry
 * no text to show, and the model still sees the complete history because it
 * reads from the checkpointer, not from what the UI chose to render.
 *
 * A research report (tagged by the worker) is a normal assistant message at its
 * chronological place, carrying `research` metadata so the UI adds a header and a
 * download button. Keeping it in the transcript — rather than floating it as a
 * bottom card — is what stops the report from jumping around when the user keeps
 * chatting afterward.
 */
export function toUIMessages(
  messages: BaseMessage[],
): ClaudiusUIMessage[] {
  const ui: ClaudiusUIMessage[] = [];
  let lastResearchQuestion = "";

  messages.forEach((message, index) => {
    const isResearch = Boolean(message.additional_kwargs?.claudius_research);
    const type = message.getType();
    const text = message.text.trim();

    if (type === "human") {
      if (isResearch) lastResearchQuestion = text;
      ui.push({
        id: message.id ?? `msg-${index}`,
        role: "user",
        parts: [{ type: "text", text }],
      });
    } else if (type === "ai" && text.length > 0) {
      ui.push({
        id: message.id ?? `msg-${index}`,
        role: "assistant",
        parts: [{ type: "text", text }],
        ...(isResearch
          ? { metadata: { research: { question: lastResearchQuestion } } }
          : {}),
      });
    }
    // "tool" and "system" messages, and tool-call-only AI turns, are not shown.
  });

  return ui;
}
