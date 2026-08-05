import { describe, expect, it } from "vitest";
import {
  readUrlTool,
  URL_READ_EVENT,
  type ReadUrlToolOutput,
  type UrlReadEvent,
} from "./readUrl";

/**
 * The read_url output contract. Two properties matter beyond "it returns text":
 *
 *  1. The activity event is dispatched OUT-OF-BAND and must never leak into the
 *     JSON the model reads. The model is deliberately blind to which path served
 *     a read; if `kind`-adjacent bookkeeping like `ok` ever appeared in the
 *     output, the model would start reasoning about our fetch internals.
 *  2. Exactly one event per invocation, so the transcript renders one card.
 *
 * These cases use an SSRF-rejected URL on purpose: assertFetchableUrl refuses
 * before any egress, so the tests are hermetic (no Tavily, no GitHub, no network).
 */

interface Captured {
  events: UrlReadEvent[];
  output: ReadUrlToolOutput;
}

async function invoke(url: string): Promise<Captured> {
  const events: UrlReadEvent[] = [];
  const raw = await readUrlTool.invoke(
    { url },
    {
      callbacks: [
        {
          handleCustomEvent: (name: string, data: unknown): void => {
            if (name === URL_READ_EVENT) events.push(data as UrlReadEvent);
          },
        },
      ],
    },
  );
  return { events, output: JSON.parse(raw) as ReadUrlToolOutput };
}

describe("readUrlTool output contract", () => {
  it("returns a model-readable error instead of throwing on a blocked URL", async () => {
    const { output } = await invoke("file:///etc/passwd");
    expect(output.error).toBeTruthy();
    expect(output.url).toBe("file:///etc/passwd");
    // The turn still completes — the graph never sees a throw.
    expect(output.content).toBeUndefined();
  });

  it("does not leak the activity event's fields into the model's output", async () => {
    const { output } = await invoke("http://169.254.169.254/latest/meta-data/");
    const keys = Object.keys(output);
    expect(keys).not.toContain("ok");
    // Only the documented output contract, nothing else.
    for (const key of keys) {
      expect([
        "url",
        "kind",
        "title",
        "content",
        "metadata",
        "error",
      ]).toContain(key);
    }
  });

  it("dispatches exactly one activity event per invocation", async () => {
    const { events } = await invoke("http://127.0.0.1/admin");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ url: "http://127.0.0.1/admin", ok: false });
  });
});
