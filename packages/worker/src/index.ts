import { recoverStaleJobs } from "@claudius/shared";
import { startConsumer } from "./consume";
import { log, errMsg } from "./log";

/**
 * The Railway worker entry point. On boot it recovers any job left `running` by a
 * previous process that was killed mid-job (the stale-claim recovery that keeps a
 * restart from stranding work), then starts consuming. Importing `@claudius/shared`
 * validates the base env at load, so a misconfigured worker fails fast here.
 */
async function main(): Promise<void> {
  const recovered = await recoverStaleJobs();
  if (recovered > 0) {
    log.info("recovered orphaned running jobs on boot", { count: recovered });
  }

  const stop = await startConsumer();
  log.info("worker ready");

  // Graceful shutdown: stop claiming, close the change stream, exit. An
  // in-flight job finishes its current step; anything still running is recovered
  // on the next boot.
  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    stop()
      .catch((err) => log.error("shutdown error", { error: errMsg(err) }))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("worker failed to start", { error: errMsg(err) });
  process.exit(1);
});
