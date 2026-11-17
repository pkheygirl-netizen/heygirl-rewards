import { Worker } from "bullmq";
import { addUnique, makeRedis, notificationQueue } from "../lib/queue.server";
import { awardSignup, enrolMember } from "../lib/points.service";
import {
  processOrderCancelled,
  processOrderEvent,
  processRefundEvent,
  type OrderEvent,
  type RefundEvent,
} from "../lib/orders.server";
import { issueBirthdayReward } from "../lib/birthday.service";
import { issueReferralFriendCode } from "../lib/referral-bonus.service";
import { issueTierRewards } from "../lib/tier-rewards.service";

const shopOf = (data: { shop?: unknown }): string | null => (typeof data?.shop === "string" && data.shop ? data.shop : null);

// One job at a time (BullMQ's default concurrency of 1): events for the same
// order are handled in the order they were queued.
export const pointsWorker = new Worker(
  "points",
  async (job) => {
    switch (job.name) {
      case "order_event":
        return processOrderEvent(job.data.event as OrderEvent, shopOf(job.data));
      case "order_cancelled":
        return processOrderCancelled(job.data.event as OrderEvent, shopOf(job.data));
      case "refund_event":
        return processRefundEvent(job.data.event as RefundEvent);
      case "award_signup_points":
        if (!job.data.memberId) return { awarded: false, reason: "legacy_job_without_member" };
        return awardSignup(String(job.data.memberId));
      case "enrol_member":
        return enrolMember(job.data.customer);
      case "issue_birthday_reward": {
        const result = await issueBirthdayReward(String(job.data.memberId), { shop: shopOf(job.data) });
        if (result.issued) {
          await notificationQueue.add("birthday", {
            memberId: job.data.memberId,
            code: result.code,
            discountPkr: result.discountPkr,
            expiresAt: result.expiresAt,
          });
        }
        return result;
      }
      case "issue_referral_friend_code": {
        const result = await issueReferralFriendCode(String(job.data.referralId), shopOf(job.data));
        if (!result.issued && !["already_issued", "disabled", "program_disabled", "referral_closed", "blocked", "opted_out", "member_not_found", "referral_not_found"].includes(result.reason ?? "")) {
          throw new Error(`friend code not issued (${result.reason}); will retry`);
        }
        return result;
      }
      case "issue_tier_reward": {
        const result = await issueTierRewards({
          memberId: String(job.data.memberId),
          fromTier: job.data.fromTier ?? null,
          toTier: String(job.data.toTier),
          shop: shopOf(job.data),
        });
        // The upgrade email carries the codes, so it is sent from here.
        // Fixed id so a retried job does not mail twice; a failed mail job is replaced.
        await addUnique(
          notificationQueue,
          "tier_upgrade",
          { memberId: job.data.memberId, newTier: job.data.toTier, codes: result.issued },
          `tier-upgrade-mail-${job.data.memberId}-${job.data.toTier}`,
        );
        return result;
      }
      default:
        // Job types from before v3 (award_purchase_points, award_refund,
        // award_referral, enrol_and_signup, award_birthday_reward) carried the
        // old payloads and are dropped; the next order webhook re-drives them.
        console.warn("[pointsWorker] ignoring unknown job:", job.name);
        return { ignored: job.name };
    }
  },
  { connection: makeRedis(), concurrency: 1 },
);

pointsWorker.on("failed", (job, err) =>
  console.error("[pointsWorker] failed:", job?.id, job?.name, err.message),
);
