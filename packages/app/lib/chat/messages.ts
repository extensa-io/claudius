import type { BaseMessage } from "@langchain/core/messages";
import type { ClaudiusUIMessage } from "./types";

/**
 * Render a checkpointed thread as UI messages for resume. We surface the user
 * and assistant *text* turns — enough to redisplay the conversation. Tool
 * messages and empty tool-call-only assistant turns are folded away: they carry
 * no text to show, and the model still sees the complete history because it
 * reads from the checkpointer, not from what the UI chose to render.
 *
 * Research question/report messages (tagged by the worker) are also folded away:
 * the research card is the canonical place they render, so showing them here too
 * would duplicate the report. The model still reads them from the checkpoint.
 */
export function toUIMessages(
  messages: BaseMessage[],
): ClaudiusUIMessage[] {
  const ui: ClaudiusUIMessage[] = [];

  messages.forEach((message, index) => {
    if (message.additional_kwargs?.claudius_research) return;
    const type = message.getType();
    const text = message.text.trim();

    if (type === "human") {
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
      });
    }
    // "tool" and "system" messages, and tool-call-only AI turns, are not shown.
  });

  return ui;
}
