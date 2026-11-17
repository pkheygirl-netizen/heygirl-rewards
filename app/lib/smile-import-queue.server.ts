// app/lib/smile-import-queue.server.ts
// The BullMQ queue for the Smile import. Kept apart from queue.server.ts
// (stream A's file); it reuses that module's Redis connection factory and
// default job options. The worker is app/workers/import.worker.ts.
import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, makeRedis } from "./queue.server";

export const IMPORT_QUEUE_NAME = "smile-import";

export type ImportJobName = "plan" | "execute";

export const importQueue = new Queue(IMPORT_QUEUE_NAME, {
  connection: makeRedis(),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/**
 * Queue one phase of a run. The job id carries a timestamp because finished
 * job ids are remembered for an hour and a resumed run must not be ignored.
 * Running the same phase twice is harmless: every step is idempotent.
 */
export async function enqueueImportJob(name: ImportJobName, runId: string): Promise<void> {
  await importQueue.add(name, { runId }, { jobId: `import-${name}-${runId}-${Date.now()}` });
}
