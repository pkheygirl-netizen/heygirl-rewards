import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { awardPurchase, awardRefund, awardSignup } from "../lib/points.service";

export const pointsWorker = new Worker(
  "points",
  async (job) => {
    switch (job.name) {
      case "award_purchase_points":
        return awardPurchase(job.data);
      case "award_refund":
        return awardRefund(job.data);
      case "award_signup_points":
        return awardSignup(String(job.data.shopifyCustomerId));
      default:
        console.warn("[pointsWorker] unknown job:", job.name);
    }
  },
  { connection: makeRedis() },
);

pointsWorker.on("failed", (job, err) =>
  console.error("[pointsWorker] failed:", job?.id, job?.name, err.message),
);
