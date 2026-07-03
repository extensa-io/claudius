import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { traceable } from "langsmith/traceable";
import type { WithId } from "mongodb";
import { z } from "zod";
import {
  appendJobProgress,
  assertCanInvoke,
  buildChatModel,
  completeJob,
  isJobCancelled,
  loadResearchBudget,
  type ResearchJob,
  type ResearchSource,
  writeUsageEvent,
} from "@claudius/shared";
import { log } from "../log";
import { appendResearchToThread } from "../thread";
import { extractPages, searchWeb } from "./tavily";

/**
 * The deep-research pipeline: plan, then loop (search -> read -> decide) until the
 * model says it has enough or a budget runs out, then synthesize a cited report.
 * It is an explicit orchestrated loop rather than a free tool-using agent, because
 * this phase needs three things a ReAct loop makes awkward: hard budgets enforced
 * between every step, live progress the UI can poll, and a cancellation check that
 * lands within one step. Every model call goes through the tier gate and writes a
 * `research` usage_events row (invariant #3).
 */

const PLAN_SYSTEM = `You are a research planner. Given a question, produce 2-4 focused web search queries that together would gather the evidence needed to answer it well. Prefer specific, differentiated queries over paraphrases of the question.

Respond with ONLY a JSON object: {"queries":["...","..."]}. No prose, no markdown fences.`;

const ITERATE_SYSTEM = `You are a research supervisor deciding whether the evidence gathered so far is enough to answer the question thoroughly. If it is, stop. If there are clear gaps, propose 1-3 new, more targeted search queries to fill them (do not repeat queries already run).

Respond with ONLY a JSON object: {"sufficient": true|false, "nextQueries":["..."]}. No prose, no markdown fences.`;

const SYNTH_SYSTEM = `You are a research analyst writing a final report that answers the question using ONLY the numbered sources provided. Write clear, well-structured Markdown. Support claims with inline citations in square brackets referencing the source numbers, like [1] or [2][3]. Do not invent facts or sources beyond those given. End with a "## Sources" section listing each cited source as "[n] Title — URL".`;

const PlanSchema = z.object({ queries: z.array(z.string()).max(6) });
const IterateSchema = z.object({
  sufficient: z.boolean(),
  nextQueries: z.array(z.string()).max(4),
});

/** Slice the first JSON object out of a model reply, tolerant of stray prose. */
function parseJson(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

interface UsageMetadata {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { cache_read?: number };
}

// Independent of the search/page budgets: a hard cap on reasoning rounds so a
// model that never declares itself "sufficient" still terminates.
const MAX_ROUNDS = 5;
// Read at most this many new pages per round, so a round can't consume the whole
// page budget in one burst before the supervisor re-evaluates.
const PAGES_PER_ROUND = 4;

async function researchPipeline(job: WithId<ResearchJob>): Promise<void> {
  const jobId = job._id;
  const { userId, conversationId } = job;
  const { question, modelId } = job.input;

  const budget = await loadResearchBudget();
  const deadline = Date.now() + budget.wallClockMs;

  let searchesRun = 0;
  let pagesRead = 0;
  let tokensUsed = 0;

  // Discovery order fixes citation numbers. `text` is filled once a page is read.
  interface Source {
    n: number;
    title: string;
    url: string;
    snippet: string;
    text?: string;
  }
  const sources: Source[] = [];
  const seenUrls = new Set<string>();

  function budgetHit(): string | null {
    if (Date.now() > deadline) return "time";
    if (searchesRun >= budget.maxSearches) return "searches";
    if (pagesRead >= budget.maxFetchedPages) return "pages";
    if (tokensUsed >= budget.maxTokens) return "tokens";
    return null;
  }

  /** One model call: tier gate (consumes a daily message — the chosen cost model),
   * invoke, record usage. Throws the tier layer's user-safe AppError on a cap. */
  async function think(system: string, user: string, maxTokens: number): Promise<string> {
    const grant = await assertCanInvoke(userId, modelId);
    const model = buildChatModel(grant.inferenceProfileId, { maxTokens });
    const startedAt = Date.now();
    const response = await model.invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    const usage = response.usage_metadata as UsageMetadata | undefined;
    const inputTokens = usage?.input_tokens ?? 0;
    const outputTokens = usage?.output_tokens ?? 0;
    tokensUsed += inputTokens + outputTokens;
    await writeUsageEvent({
      userId,
      conversationId,
      modelId: grant.modelId,
      purpose: "research",
      inputTokens,
      outputTokens,
      cacheReadTokens: usage?.input_token_details?.cache_read ?? 0,
      latencyMs: Date.now() - startedAt,
    });
    return response.text;
  }

  async function cancelled(): Promise<boolean> {
    if (await isJobCancelled(jobId)) {
      log.info("research job cancelled mid-run", { jobId: jobId.toString() });
      return true;
    }
    return false;
  }

  // --- 1. Plan --------------------------------------------------------------
  if (await cancelled()) return;
  await appendJobProgress(jobId, {
    step: "plan",
    detail: `Planning research on: ${question.slice(0, 80)}`,
  });
  const planned = PlanSchema.safeParse(parseJson(await think(PLAN_SYSTEM, question, 800)));
  let queries =
    planned.success && planned.data.queries.length > 0
      ? planned.data.queries
      : [question];

  // --- 2. Search -> read -> decide, until enough or a budget runs out -------
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (await cancelled()) return;
    const stop = budgetHit();
    if (stop) {
      log.info("research budget reached", { jobId: jobId.toString(), stop, round });
      break;
    }

    for (const query of queries) {
      if (budgetHit()) break;
      await appendJobProgress(jobId, {
        step: "search",
        detail: `Searching: ${query.slice(0, 80)}`,
      });
      const hits = await searchWeb(query);
      searchesRun += 1;
      for (const hit of hits) {
        if (seenUrls.has(hit.url)) continue;
        seenUrls.add(hit.url);
        sources.push({
          n: sources.length + 1,
          title: hit.title,
          url: hit.url,
          snippet: hit.snippet,
        });
      }
    }

    // Read a bounded batch of not-yet-read sources.
    const pageBudgetLeft = budget.maxFetchedPages - pagesRead;
    const toRead = sources
      .filter((s) => s.text === undefined)
      .slice(0, Math.max(0, Math.min(PAGES_PER_ROUND, pageBudgetLeft)));
    if (toRead.length > 0) {
      await appendJobProgress(jobId, {
        step: "read",
        detail: `Reading ${toRead.length} source(s) (${pagesRead + toRead.length} of up to ${budget.maxFetchedPages})`,
      });
      const pages = await extractPages(toRead.map((s) => s.url));
      for (const page of pages) {
        const source = sources.find((s) => s.url === page.url);
        if (source) source.text = page.text;
      }
      pagesRead += pages.length;
    }

    if (await cancelled()) return;
    if (budgetHit()) break;

    // Ask the supervisor whether to stop or dig further.
    const digest = sources
      .map((s) => `[${s.n}] ${s.title}\n${(s.text ?? s.snippet).slice(0, 600)}`)
      .join("\n\n");
    const decisionRaw = await think(
      ITERATE_SYSTEM,
      `Question: ${question}\n\nEvidence gathered so far:\n\n${digest}`,
      800,
    );
    const decision = IterateSchema.safeParse(parseJson(decisionRaw));
    if (!decision.success) break;
    if (decision.data.sufficient || decision.data.nextQueries.length === 0) break;
    queries = decision.data.nextQueries;
  }

  // --- 3. Synthesize --------------------------------------------------------
  if (await cancelled()) return;
  await appendJobProgress(jobId, { step: "synthesize", detail: "Writing the report" });

  // Cite only sources actually read; renumber them 1..k so the report's [n] line
  // up with the stored source list exactly.
  const read = sources.filter((s) => s.text !== undefined);
  const cited: Array<Source & { citeN: number }> = read.map((s, i) => ({
    ...s,
    citeN: i + 1,
  }));
  const sourceBlock = cited
    .map((s) => `[${s.citeN}] ${s.title} (${s.url})\n${s.text ?? ""}`)
    .join("\n\n---\n\n");
  const report = await think(
    SYNTH_SYSTEM,
    `Question: ${question}\n\nNumbered sources:\n\n${sourceBlock}`,
    4096,
  );

  const resultSources: ResearchSource[] = cited.map((s) => ({
    n: s.citeN,
    title: s.title,
    url: s.url,
  }));

  // --- 4. Persist: report into chat history, then finalize the job ----------
  if (await cancelled()) return;
  await appendResearchToThread(conversationId.toString(), question, report);
  await appendJobProgress(jobId, { step: "done", detail: "Report ready" });
  await completeJob(jobId, {
    report,
    sources: resultSources,
    searchesRun,
    pagesRead,
  });
  log.info("research job complete", {
    jobId: jobId.toString(),
    searchesRun,
    pagesRead,
  });
}

/**
 * The exported runner wraps the pipeline in a LangSmith `traceable`, so when
 * tracing is enabled (LANGSMITH_TRACING=true + an API key — the same flags the
 * app uses) every model call in the run nests under ONE research trace instead of
 * three disconnected ones. When tracing is off, `traceable` is a passthrough and
 * no code path changes (invariant: tracing absent → tracing simply off). LangChain
 * auto-instruments the Bedrock calls and, via langsmith's async-local run tree,
 * they attach to this root — giving the app-to-worker research run end-to-end
 * coverage (the app enqueue is a plain DB insert with no model span of its own).
 */
export const runResearchJob = traceable(researchPipeline, {
  name: "research_job",
  // Record the question and model on the trace (consistent with the chat graph,
  // which traces full turns when enabled); never the raw job document/ids.
  processInputs: (job: Readonly<WithId<ResearchJob>>) => ({
    question: job.input.question,
    modelId: job.input.modelId,
  }),
  processOutputs: () => ({}),
});
