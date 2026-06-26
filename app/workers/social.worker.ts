import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { awardSocial } from "../lib/points.service";

export const socialWorker = new Worker(
  "social-actions",
  async (job) => {
    if (job.name === "award_social_points") {
      return awardSocial(String(job.data.socialActionId));
    }
    console.warn("[socialWorker] unknown job:", job.name);
  },
  { connection: makeRedis() },
);

socialWorker.on("failed", (job, err) =>
  console.error("[socialWorker] failed:", job?.id, err.message),
);
