// The jobs coordination layer (Phase 5), shared by the app and the worker.
// App side: enqueue + access. Worker side: claim + progress. One source of truth
// for the lifecycle so both runtimes agree on what a job transition means.
export {
  enqueueResearchJob,
  enqueueMemoryExtractionJob,
  enqueueMemoryConsolidationJob,
  type EnqueueResearchParams,
  type EnqueueMemoryParams,
} from "./enqueue";
export { claimNextJob, recoverStaleJobs } from "./claim";
export {
  appendJobProgress,
  completeJob,
  failJob,
  isJobCancelled,
} from "./progress";
export {
  getJobForOwner,
  listConversationJobs,
  requestJobCancel,
} from "./access";
