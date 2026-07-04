import { Worker } from "bullmq";
import { makeRedis, notificationQueue } from "../lib/queue.server";
import { awardPurchase, awardRefund, awardSignup, enrolMember } from "../lib/points.service";
import { awardReferral } from "../lib/referrals.service";
import { awardBirthdayReward } from "../lib/birthday.service";
import { getWorkerAdmin } from "../lib/worker-admin.server";

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
      case "enrol_member":
        return enrolMember(job.data.customer);
      case "enrol_and_signup": {
        // Enrol BEFORE awarding — awardSignup looks up the member row (W5: was a
        // fire-and-forget IIFE in the webhook, lost on dyno restart).
        await enrolMember(job.data.customer);
        return awardSignup(String(job.data.customer.id));
      }
      case "award_referral": {
        const adminClient = await getWorkerAdmin().catch(() => null);
        return awardReferral(String(job.data.referredShopifyCustomerId), adminClient ?? undefined);
      }
      case "award_birthday_reward": {
        const admin = await getWorkerAdmin();
        const result = await awardBirthdayReward(String(job.data.memberId), admin);
        if (result.awarded && result.code) {
          await notificationQueue.add("birthday_reward", {
            memberId: job.data.memberId,
            code: result.code,
            discountPkr: result.discountPkr,
          });
        }
        return result;
      }
      default:
        console.warn("[pointsWorker] unknown job:", job.name);
    }
  },
  { connection: makeRedis() },
);

pointsWorker.on("failed", (job, err) =>
  console.error("[pointsWorker] failed:", job?.id, job?.name, err.message),
);
