import { Queue, Worker } from "bullmq";
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

// BullMQ requires a separate IORedis instance per Queue and Worker
export const pointsQueue = new Queue("points", { connection: makeRedis() });
export const socialQueue = new Queue("social-actions", { connection: makeRedis() });
export const notificationQueue = new Queue("notifications", { connection: makeRedis() });

// Worker stubs — business logic added Week 2-3
export const pointsWorker = new Worker(
  "points",
  async (job) => {
    console.log("[pointsWorker] job received (stub):", job.id, job.name);
  },
  { connection: makeRedis() }
);

pointsWorker.on("failed", (job, err) => {
  console.error("[pointsWorker] failed:", job?.id, err.message);
});
