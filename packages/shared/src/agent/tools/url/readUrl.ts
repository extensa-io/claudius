import { dispatchCustomEvent } from "@langchain/core/callbacks/dispatch";
import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AppError, isAppError } from "../../../errors";
import { assertFetchableUrl } from "./assertFetchableUrl";
import { extractReadable } from "./extract";
import { fetchGitHubRepo, parseGitHubRepo } from "./github";

/**
 * The read_url tool (Phase 11): read ONE specific URL the user pasted, as
 * opposed to web_search, which finds pages by query. github.com/<owner>/<repo>
 * links take a GitHub-aware path (metadata + README via the REST API); every
 * other URL is read through the shared Tavily extractor.
 *
 * Access is member/admin only, enforced in the graph (guests never get the tool
 * bound). Every SSRF concern is handled before egress by assertFetchableUrl.
 */

/**
 * Which path served a read and whether it succeeded, dispatched OUT-OF-BAND (via
 * dispatchCustomEvent, not in the tool's output JSON) so the transcript can show
 * a "read a page" activity chip while the model stays blind to path selection —
 * the same discipline as SEARCH_SOURCE_EVENT. Deliberately excluded from the
 * output the model reads so the output contract stays stable.
 */
export const URL_READ_EVENT = "url_read";

export interface UrlReadEvent {
  url: string;
  kind: "github" | "web";
  ok: boolean;
}

/** The shape read_url returns to the model (and the UI parses for its card). */
export interface ReadUrlToolOutput {
  url: string;
  kind: "github" | "web";
  title?: string;
  content?: string;
  metadata?: {
    fullName: string;
    description: string | null;
    language: string | null;
    topics: string[];
    license: string | null;
    stars: number;
    defaultBranch: string;
    archived: boolean;
    fork: boolean;
  };
  error?: string;
}

const readUrlSchema = z.object({
  url: z
    .string()
    .describe("The full URL of the page or repository to read, including scheme."),
});

export const readUrlTool = tool(
  async ({ url }, config: RunnableConfig): Promise<string> => {
    // Determine the path up front so the activity event carries the right kind
    // even when validation fails before either path runs. parseGitHubRepo only
    // inspects the string, so it's safe to call before the SSRF check.
    const repo = parseGitHubRepo(url);
    const kind: "github" | "web" = repo ? "github" : "web";

    const emit = async (ok: boolean): Promise<void> => {
      const event: UrlReadEvent = { url, kind, ok };
      await dispatchCustomEvent(URL_READ_EVENT, event, config);
    };

    try {
      // SSRF backstop before any egress: rejects non-HTTP schemes and private/
      // internal targets with a user-safe message.
      await assertFetchableUrl(url);

      if (repo) {
        const info = await fetchGitHubRepo(repo);
        await emit(info !== null);
        if (!info) {
          const out: ReadUrlToolOutput = {
            url,
            kind: "github",
            error: "That repository was not found or is private.",
          };
          return JSON.stringify(out);
        }
        const { readme, ...metadata } = info;
        const out: ReadUrlToolOutput = {
          url,
          kind: "github",
          title: info.fullName,
          content: readme,
          metadata,
        };
        return JSON.stringify(out);
      }

      const page = await extractReadable(url);
      await emit(page !== null);
      if (!page) {
        const out: ReadUrlToolOutput = {
          url,
          kind: "web",
          error: "That page couldn't be read (it may be empty or blocked).",
        };
        return JSON.stringify(out);
      }
      const out: ReadUrlToolOutput = {
        url,
        kind: "web",
        title: page.title,
        content: page.text,
      };
      return JSON.stringify(out);
    } catch (error: unknown) {
      // Never throw into the graph — return a clean, model-readable error so the
      // turn still completes, exactly like web_search does on backend failure.
      await emit(false);
      const message =
        error instanceof AppError
          ? error.message
          : "That URL couldn't be read right now.";
      if (!isAppError(error)) {
        console.log("[read_url] unavailable:", kind);
      }
      const out: ReadUrlToolOutput = { url, kind, error: message };
      return JSON.stringify(out);
    }
  },
  {
    name: "read_url",
    description:
      "Read the contents of a SPECIFIC URL the user has pasted or referenced (an article, page, or GitHub repository) and return its text. Use this when the user gives you a link to look at, as opposed to web_search, which finds pages by query. Pass the full URL including its scheme.",
    schema: readUrlSchema,
  },
);
