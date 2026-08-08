import { beforeEach, describe, expect, it, vi } from "vitest";
import { extensionOf, messageOf, sizeBucketOf } from "./report-error";

/**
 * These two helpers are the privacy boundary of the client error sink: what
 * they return is what reaches the logs, so "never the filename" (invariant #5)
 * is the property being pinned here, not just the happy path.
 */

describe("extensionOf", () => {
  it("returns the lowercased extension", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
  });

  it("never returns any part of the name itself", () => {
    expect(extensionOf("Q3-severance-agreement.pdf")).toBe("pdf");
  });

  it("is null when there is no extension to take", () => {
    expect(extensionOf("README")).toBeNull();
    expect(extensionOf("trailing.")).toBeNull();
  });

  it("treats a dotfile as having no extension", () => {
    expect(extensionOf(".env")).toBeNull();
  });
});

describe("sizeBucketOf", () => {
  it("buckets rather than reporting the exact size", () => {
    expect(sizeBucketOf(500)).toBe("<1MB");
    expect(sizeBucketOf(3 * 1024 * 1024)).toBe("1-5MB");
    expect(sizeBucketOf(19 * 1024 * 1024)).toBe("10-20MB");
  });

  it("flags a file past the 20MB document cap", () => {
    expect(sizeBucketOf(21 * 1024 * 1024)).toBe(">20MB");
  });
});

describe("messageOf", () => {
  it("unwraps an Error, a string, and anything else", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("boom")).toBe("boom");
    expect(messageOf({ weird: true })).toBe("Unknown error");
  });
});

/**
 * The volume guards hold per-page-load state in module scope, so each case
 * re-imports the module to get a fresh "page". The property under test is that
 * a runaway loop can't exhaust the 64KiB keepalive budget and silently take
 * reporting offline with it.
 */
describe("reportClientError volume guards", () => {
  const fetchMock = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(() => Promise.resolve(new Response(null)));

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {});
  });

  async function freshReporter(): Promise<
    (typeof import("./report-error"))["reportClientError"]
  > {
    const mod = await import("./report-error");
    return mod.reportClientError;
  }

  function bodyOf(call: number): Record<string, unknown> {
    const init = fetchMock.mock.calls[call]?.[1];
    if (!init) throw new Error(`no fetch call at index ${call}`);
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  it("sends the first occurrence, with no count on it", async () => {
    const report = await freshReporter();
    report({ stage: "upload", message: "boom" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyOf(0).occurrence).toBeUndefined();
  });

  it("reports repeats on a doubling curve, carrying the count", async () => {
    const report = await freshReporter();
    for (let i = 0; i < 8; i += 1) {
      report({ stage: "upload", message: "boom" });
    }

    // Occurrences 1, 2, 4 and 8, not all eight.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(bodyOf(1).occurrence).toBe(2);
    expect(bodyOf(3).occurrence).toBe(8);
  });

  it("counts distinct errors separately", async () => {
    const report = await freshReporter();
    report({ stage: "upload", message: "boom" });
    report({ stage: "upload", message: "different" });
    report({ stage: "window", message: "boom" });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops entirely once the per-page ceiling is reached", async () => {
    const report = await freshReporter();
    for (let i = 0; i < 50; i += 1) {
      report({ stage: "window", message: `distinct ${i}` });
    }

    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it("keeps the keepalive body well inside the shared 64KiB budget", async () => {
    const report = await freshReporter();
    report({
      stage: "upload",
      message: "x".repeat(5000),
      stack: "y".repeat(50_000),
    });

    const init = fetchMock.mock.calls[0]?.[1];
    if (!init) throw new Error("expected a fetch call");
    expect(init.keepalive).toBe(true);
    expect((init.body as string).length).toBeLessThan(2048);
  });
});
