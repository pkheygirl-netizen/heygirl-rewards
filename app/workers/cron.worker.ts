import { Worker } from "bullmq";
import { makeRedis, cronQueue, notificationQueue } from "../lib/queue.server";
import { expireSilverPoints } from "../lib/points.service";
import { db } from "../db.server";

// Register repeatable jobs (idempotent: stable repeat keys via jobId).
export async function registerCronJobs() {
  await cronQueue.add("cron_expiry", {}, {
    repeat: { pattern: "0 2 * * *", tz: "Asia/Karachi" }, jobId: "cron_expiry",
  });
  await cronQueue.add("cron_birthday", {}, {
    repeat: { pattern: "0 9 1 * *", tz: "Asia/Karachi" }, jobId: "cron_birthday",
  });
}

export const cronWorker = new Worker(
  "cron",
  async (job) => {
    if (job.name === "cron_expiry") {
      const r = await expireSilverPoints();
      // Also expire stale loyalty codes
      const { error: codeErr } = await db
        .from("loyalty_codes")
        .update({ status: "expired" })
        .lt("expires_at", new Date().toISOString())
        .eq("status", "active");
      if (codeErr) console.error("[cron_expiry] loyalty_codes expiry error:", codeErr);
      // 30-day warning notification stub (real email Week 4)
      console.log("[cron_expiry]", r);
      return r;
    }
    if (job.name === "cron_birthday") {
      const month = new Date().getMonth() + 1;
      const { data: members } = await db
        .from("members").select("id, email, tier").eq("birthday_month", month);
      for (const m of members ?? []) {
        // Notification stub — real reward + email wired Week 4
        await notificationQueue.add("birthday_reward", { memberId: m.id, tier: m.tier });
      }
      console.log(`[cron_birthday] queued ${members?.length ?? 0} birthday notifications`);
      return { queued: members?.length ?? 0 };
    }
  },
  { connection: makeRedis() },
);

cronWorker.on("failed", (job, err) =>
  console.error("[cronWorker] failed:", job?.id, job?.name, err.message),
);

void registerCronJobs();
