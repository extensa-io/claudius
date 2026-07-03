import { listConversationJobs } from "@claudius/shared";
import type { Job, JobStatus, ResearchSource } from "@claudius/shared";
import type { ObjectId, WithId } from "mongodb";

/**
 * The client-safe shape of a job. The polling endpoint and the conversation's
 * job list both return this — never the raw document — so ObjectIds and Dates are
 * serialized and only the fields the UI renders are exposed.
 */
export interface JobView {
  id: string;
  type: Job["type"];
  status: JobStatus;
  /** The research question (research jobs only), for the card header. */
  question: string | null;
  progress: Array<{ step: string; detail: string; at: string }>;
  /** The finished markdown report (research jobs, when done). */
  report: string | null;
  sources: ResearchSource[];
  error: string | null;
  createdAt: string;
}

export function serializeJob(job: WithId<Job>): JobView {
  const base = {
    id: job._id.toString(),
    type: job.type,
    status: job.status,
    progress: job.progress.map((p) => ({
      step: p.step,
      detail: p.detail,
      at: p.at.toISOString(),
    })),
    error: job.error,
    createdAt: job.createdAt.toISOString(),
  };

  if (job.type === "research") {
    return {
      ...base,
      question: job.input.question,
      report: job.result?.report ?? null,
      sources: job.result?.sources ?? [],
    };
  }
  return { ...base, question: null, report: null, sources: [] };
}

/**
 * The research jobs for a conversation, for seeding the client on load or
 * conversation switch. Includes finished (done/failed) as well as in-flight jobs
 * so their cards — and the report download — persist across reloads. The report
 * message the worker appends to the thread is tagged and folded out of the
 * transcript (see toUIMessages), so the card is the single place it renders.
 * Cancelled jobs are dropped as noise. Returned oldest-first so cards read in the
 * order the research happened.
 */
export async function getConversationResearchJobs(
  userId: ObjectId,
  conversationId: ObjectId,
): Promise<JobView[]> {
  const jobs = await listConversationJobs(userId, conversationId);
  return jobs
    .filter((j) => j.type === "research" && j.status !== "cancelled")
    .map(serializeJob)
    .reverse();
}
