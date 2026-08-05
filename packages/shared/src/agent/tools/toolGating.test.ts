import { describe, expect, it } from "vitest";
import { selectBoundTools } from "./index";

/**
 * Which tools a turn offers is a security boundary, not a UX detail: read_url is
 * member/admin only (invariant #2), and the decision is made server-side from the
 * session role. These tests assert the bound-tool set directly so the guest gate
 * can't regress into "the model was offered a tool its role forbids".
 */

function names(args: { hasDocuments: boolean; canReadUrls: boolean }): string[] {
  return selectBoundTools(args).map((t) => t.name);
}

describe("selectBoundTools", () => {
  it("offers a guest turn web_search only — never read_url", () => {
    expect(names({ hasDocuments: false, canReadUrls: false })).toEqual([
      "web_search",
    ]);
  });

  it("offers read_url when the role allows it", () => {
    const bound = names({ hasDocuments: false, canReadUrls: true });
    expect(bound).toContain("read_url");
    expect(bound).toContain("web_search");
  });

  it("withholds read_url from a guest even when documents are attached", () => {
    const bound = names({ hasDocuments: true, canReadUrls: false });
    expect(bound).toContain("retrieve_documents");
    expect(bound).not.toContain("read_url");
  });

  it("offers retrieve_documents only when the conversation has documents", () => {
    expect(names({ hasDocuments: false, canReadUrls: true })).not.toContain(
      "retrieve_documents",
    );
    expect(names({ hasDocuments: true, canReadUrls: true })).toContain(
      "retrieve_documents",
    );
  });

  it("never returns a tool that the ToolNode cannot execute", () => {
    // Every offered tool must be runnable, or the model can call into nothing.
    const executable = new Set(
      selectBoundTools({ hasDocuments: true, canReadUrls: true }).map(
        (t) => t.name,
      ),
    );
    expect(executable).toEqual(
      new Set(["web_search", "retrieve_documents", "read_url"]),
    );
  });
});
