import { claimNextJob, env, jobsCol } from "@claudius/shared";
import { log, errMsg } from "./log";
import { runJob } from "./runJob";

/**
 * The worker's consume loop. MongoDB is the entire bus (Phase 5's deliberate
 * constraint): the worker wakes on a change stream over `jobs` inserts and, as a
 * fallback for readers on Atlas M0 (no change streams there) behind
 * JOB_CONSUME_MODE=poll, on a timer. Either way it claims and runs jobs the same
 * way — the trigger differs, the work does not.
 *
 * Jobs run one at a time. A single worker keeps the model spends serialized and
 * the reasoning simple; the atomic claim already makes a second instance safe, so
 * horizontal scaling is a config change, not a rewrite (out of scope this phase).
 */

const POLL_MS = 3_000;
// Even on change streams, a low-frequency safety sweep catches any insert missed
// during a reconnect, so a dropped event never strands a job indefinitely.
const SAFETY_MS = 30_000;

let draining = false;
let pending = false;
let stopped = false;

/**
 * Claim and run every queued job, one after another. Re-entrant calls (a change
 * event arriving mid-drain) don't run concurrently; they set `pending` so the
 * loop rescans once it finishes, which is what stops a burst of inserts from
 * leaving the last one unclaimed until the next trigger.
 */
async function drain(): Promise<void> {
  if (draining) {
    pending = true;
    return;
  }
  draining = true;
  try {
    do {
      pending = false;
      while (!stopped) {
        const job = await claimNextJob();
        if (!job) break;
        await runJob(job);
      }
    } while (pending && !stopped);
  } catch (err) {
    log.error("drain loop error", { error: errMsg(err) });
  } finally {
    draining = false;
  }
}

/** Start consuming. Returns a stop function for graceful shutdown. */
export async function startConsumer(): Promise<() => Promise<void>> {
  const mode = env.JOB_CONSUME_MODE ?? "changestream";
  log.info("starting consumer", { mode });

  if (mode === "poll") {
    void drain(); // catch up on anything already queued
    const timer = setInterval(() => void drain(), POLL_MS);
    return async () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  // Change-stream mode: set up the watcher first, then drain, so an insert that
  // lands during the initial catch-up is coalesced rather than lost.
  const col = await jobsCol();
  const stream = col.watch([{ $match: { operationType: "insert" } }]);
  stream.on("change", () => void drain());
  stream.on("error", (err) =>
    log.error("change stream error", { error: errMsg(err) }),
  );
  const safety = setInterval(() => void drain(), SAFETY_MS);
  void drain();

  return async () => {
    stopped = true;
    clearInterval(safety);
    await stream.close();
  };
}
