import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { notifyMember } from "../lib/notifications.service";

export const notificationWorker = new Worker(
  "notifications",
  async (job) => {
    switch (job.name) {
      case "birthday_reward":
        // Only send email if code was already created (by award_birthday_reward job in points.worker)
        if (job.data.code) {
          await notifyMember(String(job.data.memberId), "birthday_reward", {
            code: job.data.code,
            discountPkr: job.data.discountPkr,
          });
        }
        return;
      case "tier_upgrade":
        await notifyMember(String(job.data.memberId), "tier_upgrade", {
          newTier: job.data.newTier,
        });
        return;
      case "redemption_confirmed":
        await notifyMember(String(job.data.memberId), "redemption_confirmed", {
          code: job.data.code,
          discountPkr: job.data.discountPkr,
        });
        return;
      case "referral_success":
        await notifyMember(String(job.data.memberId), "referral_success", {
          points: job.data.points,
        });
        return;
      case "referral_bonus":
        await notifyMember(String(job.data.memberId), "referral_bonus", {
          code: job.data.code,
        });
        return;
      case "expiry_warning":
        await notifyMember(String(job.data.memberId), "expiry_warning", {
          expiringPoints: job.data.expiringPoints,
          expiresAt: job.data.expiresAt,
        });
        return;
      default:
        console.warn("[notificationWorker] unknown job:", job.name);
    }
  },
  { connection: makeRedis() },
);

notificationWorker.on("failed", (job, err) =>
  console.error("[notificationWorker] failed:", job?.id, job?.name, err.message),
);
