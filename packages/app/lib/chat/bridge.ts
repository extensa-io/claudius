import type { BaseMessage } from "@langchain/core/messages";
import type { ClaudiusStreamWriter } from "./types";

/**
 * Bridge LangGraph's `streamEvents` (v2) output onto the AI SDK UI message
 * stream protocol. The graph emits a flat event log — model token chunks, tool
 * starts and ends, run boundaries — and the AI SDK client expects typed parts:
 * text-start/text-delta/text-end for prose, tool-input/tool-output for tool
 * activity. This function is the translation layer between the two.
 *
 * It also accumulates token usage as it goes, returning the totals so the route
 * can write a single usage_events row for the whole turn (a turn may invoke the
 * model more than once when a tool is called, so we sum across model calls).
 */

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface BridgeResult {
  usage: UsageTotals;
  /** The assistant's full text for this turn, for the preview and title. */
  assistantText: string;
}

/** The subset of LangChain's usage_metadata we record. */
interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

/** The fields we read off each streamEvents item; the real type has more. */
interface GraphStreamEvent {
  event: string;
  name: string;
  run_id: string;
  data?: { chunk?: unknown; input?: unknown; output?: unknown };
}

function addUsage(totals: UsageTotals, usage: UsageMetadata | undefined): void {
  if (!usage) return;
  totals.inputTokens += usage.input_tokens ?? 0;
  totals.outputTokens += usage.output_tokens ?? 0;
  totals.cacheReadTokens += usage.input_token_details?.cache_read ?? 0;
}

/**
 * A tool returns a JSON string (see web_search). Parse it back to an object so
 * the UI can render structured sources; fall back to the raw value if it isn't
 * the shape we expect.
 */
function parseToolOutput(output: unknown): unknown {
  const content = (output as BaseMessage | undefined)?.text ?? output;
  if (typeof content !== "string") return content;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

export async function bridgeGraphEvents(
  events: AsyncIterable<GraphStreamEvent>,
  writer: ClaudiusStreamWriter,
): Promise<BridgeResult> {
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  };
  let assistantText = "";

  // A turn can produce several text segments (e.g. a sentence, a tool call, then
  // more text). Each segment is its own text part with a stable id.
  let textId: string | null = null;
  let textSegment = 0;

  const endText = (): void => {
    if (textId !== null) {
      writer.write({ type: "text-end", id: textId });
      textId = null;
    }
  };

  for await (const ev of events) {
    switch (ev.event) {
      case "on_chat_model_stream": {
        const chunk = ev.data?.chunk as BaseMessage | undefined;
        const delta = chunk?.text ?? "";
        if (delta.length > 0) {
          if (textId === null) {
            textId = `text-${textSegment++}`;
            writer.write({ type: "text-start", id: textId });
          }
          writer.write({ type: "text-delta", id: textId, delta });
          assistantText += delta;
        }
        break;
      }

      case "on_chat_model_end": {
        // Close any open text segment before a tool call or the end of the turn.
        endText();
        const output = ev.data?.output as
          | { usage_metadata?: UsageMetadata }
          | undefined;
        addUsage(totals, output?.usage_metadata);
        break;
      }

      case "on_tool_start": {
        // dynamic: true so these assemble into a `dynamic-tool` UI part on the
        // client. The tool isn't registered client-side with a schema, so it is
        // dynamic by definition; this keeps the part strongly typed to render.
        writer.write({
          type: "tool-input-start",
          toolCallId: ev.run_id,
          toolName: ev.name,
          dynamic: true,
        });
        writer.write({
          type: "tool-input-available",
          toolCallId: ev.run_id,
          toolName: ev.name,
          input: ev.data?.input ?? {},
          dynamic: true,
        });
        break;
      }

      case "on_tool_end": {
        writer.write({
          type: "tool-output-available",
          toolCallId: ev.run_id,
          output: parseToolOutput(ev.data?.output),
          dynamic: true,
        });
        break;
      }
    }
  }

  // Defensive: close a dangling text segment if the stream ended mid-text.
  endText();
  return { usage: totals, assistantText };
}
