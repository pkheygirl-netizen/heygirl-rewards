import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { notifyMember } from "../lib/notifications.service";

// The job name is the event (welcome, points_earned, reward_code_issued,
// tier_upgrade, birthday, referral_completed, points_expiring,
// review_released); pre-v3 names are mapped inside notifyMember.
export const notificationWorker = new Worker(
  "notifications",
  async (job) => {
    const memberId = String(job.data?.memberId ?? "");
    if (!memberId) return { skipped: "no_member" };
    return notifyMember(memberId, job.name, (job.data ?? {}) as Record<string, unknown>);
  },
  { connection: makeRedis() },
);

notificationWorker.on("failed", (job, err) =>
  console.error("[notificationWorker] failed:", job?.id, job?.name, err.message),
);
