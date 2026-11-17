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
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5000 },
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

// Workers run ONLY in the dedicated worker process (WORKER=1), never the web process.
export function startWorkers() {
  if (process.env.WORKER !== "1") return;
  // Imported lazily so the web process never pulls worker code paths.
  void import("../workers/points.worker");
  void import("../workers/social.worker");
  void import("../workers/cron.worker");
  void import("../workers/notification.worker");
  console.log("[workers] started");
}

export { makeRedis };
