"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobView } from "@/lib/jobs/view";

/**
 * Client state for a conversation's research jobs: it seeds from the server, adds
 * a job optimistically when one is started, and polls the status endpoint for the
 * ones still in flight until they reach a terminal state. Polling (not SSE) keeps
 * the transport simple and robust on Vercel, and matches Mongo-as-bus: the worker
 * writes progress to the job document, the client reads it back.
 *
 * The hook lives at ChatPane scope, which remounts per conversation, so its state
 * resets cleanly on a conversation switch — same lifecycle as useChat.
 */

const POLL_MS = 2_000;

function isActive(job: JobView): boolean {
  return job.status === "queued" || job.status === "running";
}

export interface StartResearchParams {
  conversationId: string | null;
  modelId: string;
  question: string;
}

export interface UseResearchJobs {
  jobs: JobView[];
  start: (params: StartResearchParams) => Promise<void>;
  cancel: (jobId: string) => Promise<void>;
}

export function useResearchJobs({
  initialJobs,
  onConversationCreated,
  onError,
  onSettled,
  onReportReady,
}: {
  initialJobs: JobView[];
  onConversationCreated: (id: string, title: string) => void;
  onError: (message: string) => void;
  onSettled: () => void;
  /** Called once when a research job finishes, so the caller can drop the report
   * into the transcript as a message (where it stays put) instead of a card. */
  onReportReady: (job: JobView) => void;
}): UseResearchJobs {
  const [jobs, setJobs] = useState<JobView[]>(initialJobs);
  // Latest callbacks without retriggering the poll effect.
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const reportReadyRef = useRef(onReportReady);
  reportReadyRef.current = onReportReady;
  // Jobs whose report we've already handed off, so we do it exactly once.
  const handedOff = useRef<Set<string>>(new Set());

  const hasActive = jobs.some(isActive);

  useEffect(() => {
    if (!hasActive) return;
    let cancelled = false;

    const tick = async (): Promise<void> => {
      const active = jobs.filter(isActive);
      const results = await Promise.all(
        active.map(async (job) => {
          try {
            const res = await fetch(`/api/jobs/${job.id}`);
            if (!res.ok) return null;
            const data = (await res.json()) as { job: JobView };
            return data.job;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const updates = results.filter((j): j is JobView => j !== null);
      if (updates.length === 0) return;

      // A job that just finished becomes a real message in the transcript (via
      // onReportReady), so drop its card here — that's what keeps the report at
      // its chronological spot instead of floating at the bottom.
      const nowDone = updates.filter(
        (u) => u.status === "done" && u.report && !handedOff.current.has(u.id),
      );
      for (const u of nowDone) {
        handedOff.current.add(u.id);
        reportReadyRef.current(u);
      }
      const droppedIds = new Set(nowDone.map((u) => u.id));

      setJobs((prev) =>
        prev
          .map((j) => updates.find((u) => u.id === j.id) ?? j)
          .filter((j) => !droppedIds.has(j.id)),
      );
      // If any job just left the active set, let the shell refresh (sidebar
      // title/preview now that the report is in the thread).
      if (updates.some((u) => !isActive(u))) settledRef.current();
    };

    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hasActive, jobs]);

  const start = useCallback(
    async ({ conversationId, modelId, question }: StartResearchParams): Promise<void> => {
      let res: Response;
      try {
        res = await fetch("/api/research", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId, modelId, question }),
        });
      } catch {
        onError("Could not start research. Check your connection.");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        onError(body?.error?.message ?? "Could not start research.");
        return;
      }
      const data = (await res.json()) as {
        jobId: string;
        conversationId: string;
        title: string;
      };
      if (!conversationId) {
        onConversationCreated(data.conversationId, data.title);
      }
      const optimistic: JobView = {
        id: data.jobId,
        type: "research",
        status: "queued",
        question,
        progress: [],
        report: null,
        sources: [],
        error: null,
        createdAt: new Date().toISOString(),
      };
      setJobs((prev) => [...prev, optimistic]);
    },
    [onConversationCreated, onError],
  );

  const cancel = useCallback(async (jobId: string): Promise<void> => {
    // Optimistic: reflect the cancel immediately; the worker stops within a step.
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, status: "cancelled" } : j)),
    );
    try {
      await fetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
    } catch {
      // If the request failed the poll will correct the status on the next tick.
    }
  }, []);

  return { jobs, start, cancel };
}
