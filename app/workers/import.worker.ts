// app/workers/import.worker.ts
// Runs the Smile import in the worker process (WORKER=1). Two job names:
//   plan     dry run: Shopify customer lookup for every e-mail
//   execute  the confirmed import
// Both continue from import_rows.state, so a job that is retried, or picked
// up again after the worker restarted in the middle (BullMQ returns a stalled
// job to the queue), carries on where it stopped. One job at a time per
// process; across processes a database lease on the run (planRun / executeRun
// throw ImportLockedError, and the job is retried later) keeps a second
// worker out.
import { Worker, type Job } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { IMPORT_QUEUE_NAME } from "../lib/smile-import-queue.server";
import { executeRun, markRunFailed, planRun, purgeExpiredRows } from "../lib/smile-import.server";

export async function processImportJob(job: Pick<Job, "name" | "data">): Promise<unknown> {
  const runId = typeof job.data?.runId === "string" ? job.data.runId : "";
  if (!runId) return { ignored: "no_run_id" };
  await purgeExpiredRows(); // retention: old runs lose their stored rows
  switch (job.name) {
    case "plan":
      return planRun(runId);
    case "execute":
      return executeRun(runId);
    default:
      console.warn("[importWorker] ignoring unknown job:", job.name);
      return { ignored: job.name };
  }
}

export const importWorker = new Worker(IMPORT_QUEUE_NAME, processImportJob, {
  connection: makeRedis(),
  concurrency: 1,
  // A batch is short, but give long Shopify waits room before the job counts as stalled.
  lockDuration: 120_000,
});

importWorker.on("failed", (job, err) => {
  console.error("[importWorker] failed:", job?.id, job?.name, err.message);
  // Out of attempts: show the failure on the Import page, where it can be resumed.
  const runId = typeof job?.data?.runId === "string" ? job.data.runId : "";
  // "Locked" means another worker is doing this run: that is not a failure of the run.
  if (err.name === "ImportLockedError") return;
  if (runId && job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
    void markRunFailed(runId, err.message).catch((e) => console.error("[importWorker] could not mark the run failed:", e));
  }
});
