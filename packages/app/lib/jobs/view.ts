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
 * The IN-FLIGHT research jobs for a conversation, for seeding the client on load
 * or conversation switch — only queued/running. A finished report is a normal
 * (tagged) message in the transcript at its chronological place (see
 * toUIMessages), so a done job is NOT seeded as a card; it would otherwise both
 * duplicate the report and float it to the bottom. This seeds only the cards that
 * still show live progress.
 */
export async function getActiveResearchJobViews(
  userId: ObjectId,
  conversationId: ObjectId,
): Promise<JobView[]> {
  const jobs = await listConversationJobs(userId, conversationId);
  return jobs
    .filter(
      (j) =>
        j.type === "research" &&
        (j.status === "queued" || j.status === "running"),
    )
    .map(serializeJob);
}
