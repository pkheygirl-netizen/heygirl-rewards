import { Worker } from "bullmq";
import { makeRedis, cronQueue, pointsQueue, notificationQueue, failedJobCounts } from "../lib/queue.server";
import { awardOverdueSocialActions, expireSilverPoints } from "../lib/points.service";
import { listBirthdayMemberIds } from "../lib/birthday.service";
import { sweepPendingCodes } from "../lib/redemption.service";
import { finishClaimedReferrals } from "../lib/referrals.service";
import { getAdminForShop } from "../lib/worker-admin.server";
import { syncStorefrontConfig } from "../lib/storefront-config.server";
import { clearHeartbeat, recordHeartbeat } from "../lib/heartbeat.server";
import { getSettings, isEarnRuleEnabled } from "../lib/settings.server";
import { db } from "../db.server";
import { runStaffDigest } from "../lib/staff-digest.server";

const TZ = "Asia/Karachi";

// Every schedule is in Pakistan time.
const SCHEDULE: Array<{ name: string; pattern: string }> = [
  { name: "cron_heartbeat", pattern: "* * * * *" }, // every minute: "the worker is alive"
  { name: "cron_pending_codes", pattern: "*/10 * * * *" }, // finish or undo codes left half-made; finish referral payments left half-done
  { name: "cron_social_sweep", pattern: "7,37 * * * *" }, // award social claims whose delayed job was lost
  { name: "cron_storefront_config", pattern: "5 * * * *" }, // see runStorefrontConfig
  { name: "cron_expiry", pattern: "0 2 * * *" },
  { name: "cron_expiry_warning", pattern: "30 2 * * *" },
  // Every day at 09:00, not only on the 1st: the issue is idempotent per
  // member and year, so a day the worker was down is simply caught up.
  { name: "cron_birthday", pattern: "0 9 * * *" },
  // Staff morning email, only when something is waiting; at most once a day
  // (runStaffDigest claims the Pakistan date in app_settings before sending).
  // Heartbeat key: cron:staff_digest.
  { name: "cron_staff_digest", pattern: "0 9 * * *" },
];

/**
 * Schedules that no longer exist. A repeatable job stays in Redis until it is
 * removed, so each one is removed with the exact options it was added with.
 * cron_review_release paid review claims automatically; since 18 Nov 2026
 * staff approve every claim (rule 14), so it must never run again.
 */
export const RETIRED_SCHEDULES: Array<{ name: string; pattern: string }> = [
  { name: "cron_review_release", pattern: "*/15 * * * *" },
];

export async function registerCronJobs() {
  for (const job of SCHEDULE) {
    await cronQueue.add(job.name, {}, { repeat: { pattern: job.pattern, tz: TZ }, jobId: job.name });
  }
  for (const old of RETIRED_SCHEDULES) {
    try {
      await cronQueue.removeRepeatable(old.name, { pattern: old.pattern, tz: TZ }, old.name);
    } catch (err) {
      console.error(`[cronWorker] could not remove retired schedule ${old.name}:`, err instanceof Error ? err.message : err);
    }
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

/**
 * One email per member for points that expire within 30 days and have not been
 * announced yet. Reads every such tranche in pages (no cap that a large import
 * cohort could starve), skips the ones already logged, and writes the log row
 * only after the notification was queued, so a failure is retried next night.
 */
export async function runExpiryWarning(now: Date = new Date()) {
  const until = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const PAGE = 1000;
  type Tranche = { id: string; member_id: string; points_remaining: number | null; expires_at: string | null };
  const perMember = new Map<string, { points: number; earliest: string; trancheIds: string[] }>();

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("points_ledger")
      .select("id, member_id, points_remaining, expires_at, members!inner(tier, opted_out)")
      .gt("points", 0)
      .eq("expired", false)
      .gt("points_remaining", 0)
      .gt("expires_at", now.toISOString())
      .lte("expires_at", until)
      .eq("members.tier", "silver")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`expiry warning query failed: ${error.message}`);
    const page = ((data ?? []) as unknown as Array<Tranche & { members?: { tier?: string; opted_out?: boolean } | null }>).filter(
      (t) => t.members?.tier === "silver" && !t.members?.opted_out,
    );

    // Leave out tranches already announced.
    const announced = new Set<string>();
    const ids = page.map((t) => String(t.id));
    for (let i = 0; i < ids.length; i += 200) {
      const { data: logged, error: logErr } = await db
        .from("notification_log")
        .select("reference_id")
        .eq("event_type", "expiry_warning")
        .in("reference_id", ids.slice(i, i + 200));
      if (logErr) throw new Error(`expiry warning log query failed: ${logErr.message}`);
      for (const l of logged ?? []) announced.add(String(l.reference_id));
    }

    for (const t of page) {
      if (announced.has(String(t.id))) continue;
      const expiresAt = String(t.expires_at);
      const cur = perMember.get(t.member_id);
      if (cur) {
        cur.points += t.points_remaining ?? 0;
        if (expiresAt < cur.earliest) cur.earliest = expiresAt;
        cur.trancheIds.push(String(t.id));
      } else {
        perMember.set(t.member_id, { points: t.points_remaining ?? 0, earliest: expiresAt, trancheIds: [String(t.id)] });
      }
    }
    if (!data || data.length < PAGE) break;
  }

  let warned = 0;
  let failed = 0;
  for (const [memberId, v] of perMember) {
    try {
      await notificationQueue.add("points_expiring", { memberId, expiringPoints: v.points, expiresAt: v.earliest });
    } catch (err) {
      failed++; // not logged, so tomorrow's run tries this member again
      console.error("[cron_expiry_warning] enqueue failed:", err instanceof Error ? err.message : err);
      continue;
    }
    const { error: logErr } = await db
      .from("notification_log")
      .insert(v.trancheIds.map((id) => ({ member_id: memberId, event_type: "expiry_warning", reference_id: id })));
    if (logErr) console.error("[cron_expiry_warning] log write failed:", logErr.message);
    warned++;
  }
  return failed > 0 ? { warned, failed } : { warned };
}

export async function runBirthday(now: Date = new Date()) {
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "birthday")) return { queued: 0, reason: "disabled" };
  const ids = await listBirthdayMemberIds(now);
  for (const memberId of ids) {
    // No fixed job id (a failed job would block the catch-up): the issue
    // itself is idempotent per member and year.
    await pointsQueue.add("issue_birthday_reward", { memberId });
  }
  return { queued: ids.length };
}

/**
 * Republish the storefront config (the app-data metafield the theme reads).
 * Admin saves already do this; this covers what happens with no save: a
 * campaign starting or ending, and the next of two back-to-back campaigns
 * moving up. Runs hourly but only calls Shopify when a campaign started or
 * ended in the last 65 minutes, plus once a day (the 00:05 run) regardless.
 */
export async function runStorefrontConfig(now: Date = new Date(), force = false) {
  const karachiHour = new Date(now.getTime() + 5 * 3_600_000).getUTCHours();
  let due = force || karachiHour === 0;
  if (!due) {
    const since = new Date(now.getTime() - 65 * 60_000).toISOString();
    const nowIso = now.toISOString();
    const { data: started, error: e1 } = await db
      .from("bonus_campaigns").select("id").gte("starts_at", since).lte("starts_at", nowIso).limit(1);
    const { data: ended, error: e2 } = await db
      .from("bonus_campaigns").select("id").gte("ends_at", since).lte("ends_at", nowIso).limit(1);
    if (e1 || e2) throw new Error(`campaign boundary query failed: ${(e1 ?? e2)?.message}`);
    due = (started ?? []).length > 0 || (ended ?? []).length > 0;
  }
  if (!due) return { synced: false, reason: "nothing_changed" };
  const admin = await getAdminForShop();
  const result = await syncStorefrontConfig(admin as Parameters<typeof syncStorefrontConfig>[0]);
  if (!result.ok) throw new Error(`storefront config not published: ${result.reason ?? "unknown"}`);
  return { synced: true };
}

/** Heartbeat key raised when the referral sweep could not finish some payments (review 12, item 3). */
export const REFERRAL_SWEEP_ALERT_KEY = "alert:referral_payments";

/**
 * Every 10 minutes: codes left half-made (sweepPendingCodes) and, review 11
 * item 10, referral payments left half-done (finishClaimedReferrals: claimed,
 * points_awarded still false). One failing does not stop the other; a failure
 * still fails the run (heartbeat cron_failed:pending_codes) after both ran.
 * Review 12, item 3: when the sweep ran but some referrals failed, the run
 * itself succeeds (so cron_failed would count as recovered at once), so the
 * dedicated alert heartbeat `alert:referral_payments` is written instead
 * (System health and the staff morning email show it); a later sweep with
 * no failure removes it.
 */
export async function runPendingSweeps(now: Date = new Date()) {
  let referrals: Awaited<ReturnType<typeof finishClaimedReferrals>> | null = null;
  let referralError: unknown = null;
  try {
    referrals = await finishClaimedReferrals(now);
  } catch (err) {
    referralError = err;
  }
  if (referrals && referrals.failed > 0) {
    await recordHeartbeat(REFERRAL_SWEEP_ALERT_KEY, { failed: referrals.failed, note: "Some half-done referral payments could not be finished; see the worker log" });
  } else if (referrals) {
    await clearHeartbeat(REFERRAL_SWEEP_ALERT_KEY);
  }
  const codes = await sweepPendingCodes(now);
  if (referralError) throw referralError;
  return { ...codes, referrals };
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
      // Retired (rule 14: staff approve every review claim). A run already
      // queued before the schedule was removed does nothing.
      return { retired: true };
    case "cron_pending_codes":
      return runPendingSweeps();
    case "cron_social_sweep":
      return awardOverdueSocialActions();
    case "cron_storefront_config":
      return runStorefrontConfig();
    case "cron_staff_digest":
      return runStaffDigest();
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
