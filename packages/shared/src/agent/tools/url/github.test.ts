import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubRepo, parseGitHubRepo } from "./github";

describe("parseGitHubRepo", () => {
  it("parses a bare owner/repo URL", () => {
    expect(parseGitHubRepo("https://github.com/karpathy/autoresearch")).toEqual({
      owner: "karpathy",
      repo: "autoresearch",
    });
  });

  it("parses a trailing slash and a deep path to the same owner/repo", () => {
    expect(parseGitHubRepo("https://github.com/o/r/")).toEqual({
      owner: "o",
      repo: "r",
    });
    expect(parseGitHubRepo("https://github.com/o/r/tree/main/src")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  it("strips a trailing .git", () => {
    expect(parseGitHubRepo("https://github.com/o/r.git")).toEqual({
      owner: "o",
      repo: "r",
    });
  });

  it("returns null for github.com with no repo", () => {
    expect(parseGitHubRepo("https://github.com")).toBeNull();
    expect(parseGitHubRepo("https://github.com/onlyowner")).toBeNull();
  });

  it("returns null for a gist (different host)", () => {
    expect(parseGitHubRepo("https://gist.github.com/o/abc123")).toBeNull();
  });

  it("returns null for a non-GitHub host", () => {
    expect(parseGitHubRepo("https://gitlab.com/o/r")).toBeNull();
  });

  it("returns null for reserved site paths", () => {
    expect(parseGitHubRepo("https://github.com/orgs/vercel")).toBeNull();
    expect(parseGitHubRepo("https://github.com/topics/ai")).toBeNull();
  });

  it("returns null for a non-URL string", () => {
    expect(parseGitHubRepo("karpathy/autoresearch")).toBeNull();
  });
});

describe("fetchGitHubRepo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for a 404 (not found or private)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 404 })),
    );
    expect(await fetchGitHubRepo({ owner: "o", repo: "missing" })).toBeNull();
  });

  it("maps repo metadata and README on success", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/readme")) {
        return new Response("# Auto Research\nDoes cool stuff.", {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          full_name: "karpathy/autoresearch",
          description: "An autonomous research agent",
          language: "Python",
          topics: ["ai", "agents"],
          license: { spdx_id: "MIT" },
          stargazers_count: 4200,
          default_branch: "main",
          archived: false,
          fork: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await fetchGitHubRepo({
      owner: "karpathy",
      repo: "autoresearch",
    });
    expect(info).not.toBeNull();
    expect(info?.fullName).toBe("karpathy/autoresearch");
    expect(info?.language).toBe("Python");
    expect(info?.topics).toEqual(["ai", "agents"]);
    expect(info?.license).toBe("MIT");
    expect(info?.stars).toBe(4200);
    expect(info?.readme).toContain("Auto Research");
  });

  it("returns metadata with an empty README when the repo has none", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith("/readme")) return new Response("", { status: 404 });
      return new Response(
        JSON.stringify({ full_name: "o/r", default_branch: "main" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const info = await fetchGitHubRepo({ owner: "o", repo: "r" });
    expect(info?.readme).toBe("");
    expect(info?.topics).toEqual([]);
  });
});
