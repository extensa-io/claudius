import { describe, expect, it } from "vitest";
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
