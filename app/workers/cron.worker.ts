import { Worker } from "bullmq";
import { makeRedis, cronQueue, pointsQueue, notificationQueue } from "../lib/queue.server";
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
  await cronQueue.add("cron_expiry_warning", {}, {
    repeat: { pattern: "30 2 * * *", tz: "Asia/Karachi" }, jobId: "cron_expiry_warning",
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
      console.log("[cron_expiry]", r);
      return r;
    }

    if (job.name === "cron_birthday") {
      const month = new Date().getMonth() + 1;
      const { data: members } = await db
        .from("members")
        .select("id, email, tier")
        .eq("birthday_month", month);
      for (const m of members ?? []) {
        // Enqueue award_birthday_reward to points worker (needs Shopify admin for discount code)
        await pointsQueue.add("award_birthday_reward", { memberId: m.id, tier: m.tier });
      }
      console.log(`[cron_birthday] queued ${members?.length ?? 0} birthday rewards`);
      return { queued: members?.length ?? 0 };
    }

    if (job.name === "cron_expiry_warning") {
      const warnDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      const { data: tranches } = await db
        .from("points_ledger")
        .select("id, member_id, points_remaining, expires_at, members!inner(tier)")
        .eq("action_type", "purchase")
        .eq("expired", false)
        .gt("points_remaining", 0)
        .gt("expires_at", now)
        .lte("expires_at", warnDate);

      let warned = 0;
      for (const t of tranches ?? []) {
        const tier = (t as Record<string, unknown> & { members?: { tier?: string } }).members?.tier;
        if (tier !== "silver") continue;

        // Dedup via notification_log — skip if already warned for this tranche
        const { error } = await db.from("notification_log").insert({
          member_id: t.member_id,
          event_type: "expiry_warning",
          reference_id: String(t.id),
        });
        if (error) continue;

        await notificationQueue.add("expiry_warning", {
          memberId: t.member_id,
          expiringPoints: t.points_remaining,
          expiresAt: t.expires_at,
        });
        warned++;
      }
      console.log(`[cron_expiry_warning] warned ${warned} members`);
      return { warned };
    }
  },
  { connection: makeRedis() },
);

cronWorker.on("failed", (job, err) =>
  console.error("[cronWorker] failed:", job?.id, job?.name, err.message),
);

void registerCronJobs();
