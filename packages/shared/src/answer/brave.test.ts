import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Brave client tests: the hit → canonical mapping and the failure modes that
 * make selection fall back (timeout, non-2xx, malformed body). `fetch` is
 * stubbed so no network is touched. The in-process rate-limit spacing is real
 * but harmless here — the first call in a fresh module has no prior slot to
 * wait on, so tests do not stall.
 */

const { braveSearch, BraveSearchError } = await import("./brave");

const okResponse = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: async () => body,
  }) as unknown as Response;

describe("braveSearch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps Brave web results to the canonical { title, url, snippet } shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          web: {
            results: [
              {
                title: "Result A",
                url: "https://a.example",
                description: "snippet A",
              },
              {
                title: "Result B",
                url: "https://b.example",
                description: "snippet B",
              },
            ],
          },
        }),
      ),
    );
    const results = await braveSearch("test query", 5);
    expect(results).toEqual([
      { title: "Result A", url: "https://a.example", snippet: "snippet A" },
      { title: "Result B", url: "https://b.example", snippet: "snippet B" },
    ]);
  });

  it("drops hits missing a title or url and defaults a missing description", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({
          web: {
            results: [
              { title: "Keep", url: "https://keep.example" }, // no description
              { url: "https://no-title.example" }, // dropped
              { title: "No url" }, // dropped
            ],
          },
        }),
      ),
    );
    const results = await braveSearch("q");
    expect(results).toEqual([
      { title: "Keep", url: "https://keep.example", snippet: "" },
    ]);
  });

  it("returns [] when Brave reports no web block", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({})));
    expect(await braveSearch("q")).toEqual([]);
  });

  it("throws BraveSearchError on a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ ok: false, status: 429, json: async () => ({}) }) as unknown as Response,
      ),
    );
    await expect(braveSearch("q")).rejects.toBeInstanceOf(BraveSearchError);
  });

  it("throws BraveSearchError when the request fails (timeout/network)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    await expect(braveSearch("q")).rejects.toBeInstanceOf(BraveSearchError);
  });

  it("throws BraveSearchError on a malformed JSON body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new Error("bad json");
            },
          }) as unknown as Response,
      ),
    );
    await expect(braveSearch("q")).rejects.toBeInstanceOf(BraveSearchError);
  });
});
