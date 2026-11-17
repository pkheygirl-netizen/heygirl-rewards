import { Queue } from "bullmq";
import IORedis from "ioredis";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");

function makeRedis() {
  const conn = new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  conn.on("error", (err) => console.error("[Redis] connection error:", err));
  return conn;
}

// Retries: default attempts=1 would make any passing failure permanent.
// Clean-up: finished jobs are removed (an hour, or 1,000, is plenty for
// de-duplicating webhook redeliveries); failed jobs are kept for two weeks,
// capped at 5,000, so they can be inspected without Redis growing for ever.
// Eight attempts, 30 s doubling: retries at 30 s, 1, 2, 4, 8, 16 and 32 min,
// about an hour in all, which rides out a Shopify or database outage. What
// still fails after that is picked up by the pending-code sweep (cron).
export const DEFAULT_JOB_OPTIONS = {
  attempts: 8,
  backoff: { type: "exponential" as const, delay: 30_000 },
  removeOnComplete: { age: 60 * 60, count: 1000 },
  removeOnFail: { age: 14 * 24 * 60 * 60, count: 5000 },
};

export const pointsQueue = new Queue("points", { connection: makeRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
export const socialQueue = new Queue("social-actions", { connection: makeRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
export const notificationQueue = new Queue("notifications", { connection: makeRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });
export const cronQueue = new Queue("cron", { connection: makeRedis(), defaultJobOptions: DEFAULT_JOB_OPTIONS });

export const ALL_QUEUES = { points: pointsQueue, social: socialQueue, notifications: notificationQueue, cron: cronQueue };

/** Failed-job counts per queue, for the system-health heartbeat. */
export async function failedJobCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, queue] of Object.entries(ALL_QUEUES)) {
    try {
      out[name] = await queue.getFailedCount();
    } catch {
      out[name] = -1; // unknown
    }
  }
  return out;
}

type UniqueQueue = {
  add: (name: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => Promise<unknown>;
  getJob: (id: string) => Promise<{ isFailed: () => Promise<boolean>; remove: () => Promise<unknown> } | undefined | null>;
};

/**
 * Add a job under a fixed id (so two copies cannot be queued at once) without
 * the trap that a FAILED job with that id, kept for two weeks, silently blocks
 * every later add: a failed one is removed first.
 */
export async function addUnique(queue: UniqueQueue, name: string, data: Record<string, unknown>, jobId: string): Promise<void> {
  const existing = await queue.getJob(jobId);
  if (existing && (await existing.isFailed())) await existing.remove();
  await queue.add(name, data, { jobId });
}

// Workers run ONLY in the dedicated worker process (WORKER=1), never the web process.
export function startWorkers() {
  if (process.env.WORKER !== "1") return;
  // Imported lazily so the web process never pulls worker code paths.
  void import("../workers/points.worker");
  void import("../workers/social.worker");
  void import("../workers/cron.worker");
  void import("../workers/notification.worker");
  void import("../workers/import.worker"); // Smile import (plan / execute)
  console.log("[workers] started");
}

export { makeRedis };
