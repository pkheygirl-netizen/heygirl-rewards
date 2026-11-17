// app/lib/smile-import-queue.server.ts
// The BullMQ queue for the Smile import. Kept apart from queue.server.ts
// (stream A's file); it reuses that module's Redis connection factory and
// default job options. The worker is app/workers/import.worker.ts.
import { Queue } from "bullmq";
import { DEFAULT_JOB_OPTIONS, makeRedis } from "./queue.server";

/** Queue name. Exported so the admin health card can count failed import jobs. */
export const IMPORT_QUEUE_NAME = "smile-import";

export type ImportJobName = "plan" | "execute";
export const IMPORT_JOB_NAMES: ImportJobName[] = ["plan", "execute"];

export const importQueue = new Queue(IMPORT_QUEUE_NAME, {
  connection: makeRedis(),
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

/** Failed import jobs, for the system-health card (-1 = unknown). */
export async function failedImportJobCount(): Promise<number> {
  try {
    return await importQueue.getFailedCount();
  } catch {
    return -1;
  }
}

/** One fixed id per run and phase: the same phase can never be queued twice. */
export function importJobId(name: ImportJobName, runId: string): string {
  return `import-${name}-${runId}`;
}

// A job in one of these states will still run (or is running).
const LIVE_STATES = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

type JobLike = { getState: () => Promise<string>; remove: () => Promise<unknown> };
export type ImportQueueLike = {
  getJob: (id: string) => Promise<JobLike | null | undefined>;
  add: (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
};

/** True when a job for this run is queued, waiting for a retry, or running. */
export async function importJobBusy(runId: string, queue: ImportQueueLike = importQueue as unknown as ImportQueueLike): Promise<boolean> {
  for (const name of IMPORT_JOB_NAMES) {
    const job = await queue.getJob(importJobId(name, runId));
    if (job && LIVE_STATES.has(await job.getState())) return true;
  }
  return false;
}

/**
 * Queue one phase of a run under its fixed id. A live job with that id is
 * left alone (queued: false). A finished or failed one, which BullMQ keeps
 * for a while and which would silently block the add, is removed first.
 */
export async function enqueueImportJob(
  name: ImportJobName,
  runId: string,
  queue: ImportQueueLike = importQueue as unknown as ImportQueueLike,
): Promise<{ queued: boolean }> {
  const id = importJobId(name, runId);
  const existing = await queue.getJob(id);
  if (existing) {
    if (LIVE_STATES.has(await existing.getState())) return { queued: false };
    await existing.remove();
  }
  await queue.add(name, { runId }, { jobId: id });
  return { queued: true };
}
