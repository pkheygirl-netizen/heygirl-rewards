import { Worker } from "bullmq";
import { makeRedis, cronQueue, pointsQueue, notificationQueue, failedJobCounts } from "../lib/queue.server";
import { expireSilverPoints } from "../lib/points.service";
import { listBirthdayMemberIds } from "../lib/birthday.service";
import { releaseDueReviewClaims } from "../lib/review-claims.service";
import { recordHeartbeat } from "../lib/heartbeat.server";
import { getSettings, isEarnRuleEnabled } from "../lib/settings.server";
import { db } from "../db.server";

const TZ = "Asia/Karachi";

// Every schedule is in Pakistan time.
const SCHEDULE: Array<{ name: string; pattern: string }> = [
  { name: "cron_heartbeat", pattern: "* * * * *" }, // every minute: "the worker is alive"
  { name: "cron_review_release", pattern: "*/15 * * * *" },
  { name: "cron_expiry", pattern: "0 2 * * *" },
  { name: "cron_expiry_warning", pattern: "30 2 * * *" },
  { name: "cron_birthday", pattern: "0 9 1 * *" }, // 09:00 on the 1st
];

export async function registerCronJobs() {
  for (const job of SCHEDULE) {
    await cronQueue.add(job.name, {}, { repeat: { pattern: job.pattern, tz: TZ }, jobId: job.name });
  }
}

/** Expire overdue Silver points and overdue codes. Loops so a backlog clears in one night. */
export async function runExpiry(now: Date = new Date()) {
  let membersAffected = 0;
  let pointsExpired = 0;
  for (let round = 0; round < 40; round++) {
    const r = await expireSilverPoints(now);
    membersAffected += r.membersAffected;
    pointsExpired += r.pointsExpired;
    if (r.tranches === 0) break;
  }
  const { error } = await db
    .from("loyalty_codes")
    .update({ status: "expired" })
    .lt("expires_at", now.toISOString())
    .eq("status", "active");
  if (error) console.error("[cron_expiry] loyalty_codes expiry error:", error.message);
  return { membersAffected, pointsExpired };
}

/** One email per member for points that expire within 30 days and have not been announced yet. */
export async function runExpiryWarning(now: Date = new Date()) {
  const until = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const { data: tranches, error } = await db
    .from("points_ledger")
    .select("id, member_id, points_remaining, expires_at, members!inner(tier, opted_out)")
    .gt("points", 0)
    .eq("expired", false)
    .gt("points_remaining", 0)
    .gt("expires_at", now.toISOString())
    .lte("expires_at", until)
    .eq("members.tier", "silver")
    .order("expires_at", { ascending: true })
    .limit(2000);
  if (error) throw new Error(`expiry warning query failed: ${error.message}`);

  const perMember = new Map<string, { points: number; earliest: string }>();
  for (const t of tranches ?? []) {
    const m = (t as unknown as { members?: { tier?: string; opted_out?: boolean } | null }).members;
    if (m?.tier !== "silver" || m?.opted_out) continue;
    // The log row is the de-duplication: a tranche is announced once.
    const { error: logErr } = await db.from("notification_log").insert({
      member_id: t.member_id,
      event_type: "expiry_warning",
      reference_id: String(t.id),
    });
    if (logErr) continue;
    const cur = perMember.get(t.member_id);
    const expiresAt = String(t.expires_at);
    if (cur) cur.points += t.points_remaining ?? 0;
    else perMember.set(t.member_id, { points: t.points_remaining ?? 0, earliest: expiresAt });
  }
  for (const [memberId, v] of perMember) {
    await notificationQueue.add("points_expiring", { memberId, expiringPoints: v.points, expiresAt: v.earliest });
  }
  return { warned: perMember.size };
}

export async function runBirthday(now: Date = new Date()) {
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "birthday")) return { queued: 0, reason: "disabled" };
  const ids = await listBirthdayMemberIds(now);
  for (const memberId of ids) {
    // The issue itself is idempotent per member and year; the job id only saves work.
    await pointsQueue.add("issue_birthday_reward", { memberId }, { jobId: `birthday-${memberId}-${now.getUTCFullYear()}` });
  }
  return { queued: ids.length };
}

export async function runCronJob(name: string): Promise<unknown> {
  switch (name) {
    case "cron_heartbeat":
      await recordHeartbeat("worker", { failed: await failedJobCounts() });
      return { ok: true };
    case "cron_expiry":
      return runExpiry();
    case "cron_expiry_warning":
      return runExpiryWarning();
    case "cron_birthday":
      return runBirthday();
    case "cron_review_release":
      return releaseDueReviewClaims();
    default:
      console.warn("[cronWorker] unknown job:", name);
      return { ignored: name };
  }
}

export const cronWorker = new Worker(
  "cron",
  async (job) => {
    const result = await runCronJob(job.name);
    // Each cron run leaves its own heartbeat with what it did.
    if (job.name !== "cron_heartbeat") {
      await recordHeartbeat(`cron:${job.name.replace(/^cron_/, "")}`, { result: (result ?? null) as Record<string, unknown> | null });
      console.log(`[${job.name}]`, JSON.stringify(result));
    }
    return result;
  },
  // Two at a time so the minute heartbeat is not stuck behind a long expiry run.
  { connection: makeRedis(), concurrency: 2 },
);

cronWorker.on("failed", (job, err) => {
  console.error("[cronWorker] failed:", job?.id, job?.name, err.message);
  if (job?.name) void recordHeartbeat(`cron_failed:${job.name.replace(/^cron_/, "")}`, { error: err.message });
});

void registerCronJobs()
  .then(() => recordHeartbeat("worker", { started: true }))
  .catch((err) => console.error("[cronWorker] could not register schedules:", err));
