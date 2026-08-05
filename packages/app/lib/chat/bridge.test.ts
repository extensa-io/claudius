import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { bridgeGraphEvents, createTurnProgress } from "./bridge";
import type { ClaudiusStreamWriter } from "./types";

/** A writer that records nothing: these tests are about what the bridge keeps. */
const noopWriter = {
  write: () => {},
} as unknown as ClaudiusStreamWriter;

function chunkEvent(text: string) {
  return {
    event: "on_chat_model_stream",
    name: "model",
    run_id: "r1",
    data: { chunk: new AIMessageChunk({ content: text }) },
  };
}

describe("bridgeGraphEvents", () => {
  it("accumulates text and usage into the caller's progress object", async () => {
    const progress = createTurnProgress();
    async function* events() {
      yield chunkEvent("Hola");
      yield chunkEvent(" mundo");
      yield {
        event: "on_chat_model_end",
        name: "model",
        run_id: "r1",
        data: {
          output: {
            usage_metadata: {
              input_tokens: 10,
              output_tokens: 4,
              input_token_details: { cache_read: 2 },
            },
          },
        },
      };
    }

    const result = await bridgeGraphEvents(events(), noopWriter, progress);

    expect(result).toBe(progress);
    expect(progress.assistantText).toBe("Hola mundo");
    expect(progress.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
    });
  });

  // The salvage guarantee: a run that dies mid-stream must still leave the caller
  // holding the text the user already saw, so the turn can be persisted.
  it("leaves partial text in progress when the run throws mid-stream", async () => {
    const progress = createTurnProgress();
    async function* events() {
      yield chunkEvent("Empezando");
      throw new Error("aborted");
    }

    await expect(
      bridgeGraphEvents(events(), noopWriter, progress),
    ).rejects.toThrow("aborted");
    expect(progress.assistantText).toBe("Empezando");
  });
});
