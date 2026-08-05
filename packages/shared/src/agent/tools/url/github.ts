import { z } from "zod";
import { env } from "../../../env";
import { AppError } from "../../../errors";
import { MAX_PAGE_CHARS } from "./extract";

/**
 * GitHub-aware path for read_url (Phase 11).
 *
 * A github.com/<owner>/<repo> page is JS-rendered, so generic HTML extraction of
 * it is thin and unreliable — a real "explain what this repo does" answer comes
 * from the structured facts the GitHub REST API returns (description, primary
 * language, topics, license, stars) plus the README. So repo URLs skip the
 * generic extractor and read those directly. The API host is fixed; we build the
 * request from a validated owner/repo slug, never from a user-chosen host, so
 * this path has no SSRF surface of its own.
 *
 * Calls are unauthenticated by default (the public rate limit is plenty for
 * interactive use); if GITHUB_TOKEN is set it rides along to raise the limit.
 */

const GITHUB_API = "https://api.github.com";

export interface GitHubRepoInfo {
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  license: string | null;
  stars: number;
  defaultBranch: string;
  archived: boolean;
  fork: boolean;
  /** README text, truncated; "" when the repo has none. */
  readme: string;
}

/**
 * Parse a GitHub repo URL to its owner/repo, or null if it isn't one. Only the
 * github.com host counts (a gist lives on gist.github.com; a raw file on
 * raw.githubusercontent.com — both fall through to the generic path). A path
 * with fewer than two segments (github.com itself, or github.com/<user>) is not
 * a repo, and a handful of reserved first segments (orgs, topics, …) are site
 * pages, not owners.
 */
export function parseGitHubRepo(
  raw: string,
): { owner: string; repo: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0];
  const repoSegment = segments[1];
  if (!owner || !repoSegment) return null;

  const reservedOwners = new Set([
    "orgs",
    "topics",
    "sponsors",
    "settings",
    "marketplace",
    "explore",
    "notifications",
    "about",
    "features",
    "pricing",
    "search",
  ]);
  if (reservedOwners.has(owner.toLowerCase())) return null;

  const repo = repoSegment.replace(/\.git$/, "");
  if (repo.length === 0) return null;
  return { owner, repo };
}

const RepoResponseSchema = z.object({
  full_name: z.string(),
  description: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  license: z.object({ spdx_id: z.string().nullable() }).nullable().optional(),
  stargazers_count: z.number().optional(),
  default_branch: z.string().optional(),
  archived: z.boolean().optional(),
  fork: z.boolean().optional(),
});

function githubHeaders(accept: string): Record<string, string> {
  const headers: Record<string, string> = {
    // GitHub rejects requests without a User-Agent.
    "User-Agent": "claudius-read-url",
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return headers;
}

/**
 * Fetch a repo's metadata and README. Returns null for a 404 — GitHub returns
 * 404 (not 403) for a private repo to an unauthorized caller, so "not found" and
 * "private" are one clean signal to the caller. Throws AppError only on a real
 * fault (rate limit, malformed payload); the tool wrapper catches that and turns
 * it into a model-readable error, so nothing throws into the graph.
 */
export async function fetchGitHubRepo({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}): Promise<GitHubRepoInfo | null> {
  const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers: githubHeaders("application/vnd.github+json"),
  });
  if (repoRes.status === 404) return null;
  if (!repoRes.ok) {
    throw new AppError("internal", "Couldn't reach GitHub for that repository.");
  }

  const parsed = RepoResponseSchema.safeParse(await repoRes.json());
  if (!parsed.success) {
    throw new AppError("internal", "GitHub returned an unexpected response.");
  }
  const data = parsed.data;

  // README is a separate endpoint; a repo may legitimately have none (404), in
  // which case we return the metadata with an empty readme rather than fail.
  let readme = "";
  const readmeRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    headers: githubHeaders("application/vnd.github.raw"),
  });
  if (readmeRes.ok) {
    readme = (await readmeRes.text()).slice(0, MAX_PAGE_CHARS);
  }

  return {
    fullName: data.full_name,
    description: data.description ?? null,
    language: data.language ?? null,
    topics: data.topics ?? [],
    license: data.license?.spdx_id ?? null,
    stars: data.stargazers_count ?? 0,
    defaultBranch: data.default_branch ?? "",
    archived: data.archived ?? false,
    fork: data.fork ?? false,
    readme,
  };
}
