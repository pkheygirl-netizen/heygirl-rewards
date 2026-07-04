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

// M1 (2026-07-03 gate): default attempts=1 made any transient worker failure
// permanent — with fixed jobIds the webhook/customer retry re-adds were no-ops.
const RETRY = { attempts: 3, backoff: { type: "exponential" as const, delay: 5000 } };

export const pointsQueue = new Queue("points", { connection: makeRedis(), defaultJobOptions: RETRY });
export const socialQueue = new Queue("social-actions", { connection: makeRedis(), defaultJobOptions: RETRY });
export const notificationQueue = new Queue("notifications", { connection: makeRedis(), defaultJobOptions: RETRY });
export const cronQueue = new Queue("cron", { connection: makeRedis(), defaultJobOptions: RETRY });

// Workers run ONLY in the dedicated worker process (WORKER=1), never the web dyno.
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
