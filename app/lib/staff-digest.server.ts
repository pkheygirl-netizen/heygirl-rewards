// app/lib/staff-digest.server.ts
// Staff morning email (owner decision, 19 Nov 2026): at 09:00 Pakistan time
// the worker emails the staff address from Settings (app_settings.staff_alert_email)
// a short summary, ONLY when something is waiting:
//   - referral order alerts not yet dismissed (self-referral phone / same address)
//   - referrals held for review
//   - review claims waiting for approval
//   - failed background jobs, or a stale worker heartbeat
// Counts only: never a customer's name, address, phone or email. No instant
// emails. Sent at most once per Pakistan day (app_settings.staff_digest_sent_on).
import { db } from "../db.server";
import { failedJobCounts } from "./queue.server";
import { readHeartbeats } from "./heartbeat.server";
import { getInstalledShop } from "./worker-admin.server";
import { karachiParts } from "./settings.server";
import { renderEmailLayout, sendEmail } from "./email.service";

/** Same threshold as the admin's system health (admin-health.server.ts WORKER_STALE_MINUTES). */
export const WORKER_STALE_MINUTES = 15;

export type DigestCounts = {
  referralOrderAlerts: number;
  referralsHeld: number;
  reviewClaims: number;
  failedJobs: number;
  workerStale: boolean;
};

export type DigestResult =
  | { sent: true; counts: DigestCounts }
  | { sent: false; reason: "no_address" | "smtp_not_configured" | "already_sent" | "nothing_waiting"; counts?: DigestCounts };

/** Pakistan calendar date, YYYY-MM-DD. */
export function karachiDate(at: Date): string {
  const p = karachiParts(at);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** What is waiting right now (counts only). */
export async function digestCounts(now: Date = new Date()): Promise<DigestCounts> {
  const { data, error } = await db.rpc("admin_attention" as never, { p_days: 30 } as never);
  if (error) throw new Error(`admin_attention failed: ${(error as { message: string }).message}`);
  const a = ((Array.isArray(data) ? data[0] : data) ?? {}) as Record<string, unknown>;

  let failedJobs = 0;
  try {
    // -1 means "could not ask that queue": not counted as a failure.
    failedJobs = Object.values(await failedJobCounts()).reduce((s, c) => s + (c > 0 ? c : 0), 0);
  } catch (err) {
    console.error("[staff-digest] failed-job count unavailable:", err instanceof Error ? err.message : err);
  }

  let workerStale = false;
  try {
    const worker = (await readHeartbeats()).find((h) => h.key === "worker");
    workerStale = !worker || now.getTime() - Date.parse(worker.at) > WORKER_STALE_MINUTES * 60_000;
  } catch (err) {
    console.error("[staff-digest] heartbeats unreadable:", err instanceof Error ? err.message : err);
  }

  return {
    referralOrderAlerts: n(a.referral_order_alerts),
    referralsHeld: n(a.referrals_flagged),
    reviewClaims: n(a.review_claims_pending),
    failedJobs,
    workerStale,
  };
}

export function somethingWaiting(c: DigestCounts): boolean {
  return c.referralOrderAlerts > 0 || c.referralsHeld > 0 || c.reviewClaims > 0 || c.failedJobs > 0 || c.workerStale;
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** The summary lines (counts only; no customer details). */
export function digestLines(c: DigestCounts): string[] {
  const lines: string[] = [];
  if (c.referralOrderAlerts > 0) {
    lines.push(`${plural(c.referralOrderAlerts, "referral order uses", "referral orders use")} the referrer's own phone number or address (self-referral check). The orders are tagged "Rewards: check referral" in Shopify when the app is allowed to.`);
  }
  if (c.referralsHeld > 0) lines.push(`${plural(c.referralsHeld, "referral is", "referrals are")} held for your approval.`);
  if (c.reviewClaims > 0) lines.push(`${plural(c.reviewClaims, "review claim is", "review claims are")} waiting for approval.`);
  if (c.failedJobs > 0) lines.push(`${plural(c.failedJobs, "background job has", "background jobs have")} failed in the last 14 days. See Settings, System health.`);
  if (c.workerStale) lines.push("The background worker has not reported for over 15 minutes. Points and emails may be waiting.");
  return lines;
}

/** Link to the app in Shopify admin; null when the shop or the app's client id is unknown. */
export async function appHomeUrl(): Promise<string | null> {
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return null;
  try {
    const shop = await getInstalledShop();
    return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) ? `https://${shop}/admin/apps/${encodeURIComponent(apiKey)}` : null;
  } catch {
    return null;
  }
}

/**
 * The cron job. Order of checks: address set, SMTP set, not already sent today,
 * something waiting; then the day is claimed (staff_digest_sent_on moved to
 * today only if it is earlier, so two runs cannot both send), the email is
 * sent, and a failed send gives the day back and throws so the job is retried.
 */
export async function runStaffDigest(now: Date = new Date()): Promise<DigestResult> {
  const { data: row, error } = await db
    .from("app_settings")
    .select("staff_alert_email, staff_digest_sent_on, program_name")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw new Error(`settings lookup failed: ${error.message}`);
  const to = typeof row?.staff_alert_email === "string" ? row.staff_alert_email.trim() : "";
  // The job runs once a day, so each of these lines is logged at most once a day.
  if (!to) {
    console.log("[staff-digest] no staff email address set in Settings; not sent");
    return { sent: false, reason: "no_address" };
  }
  if (!process.env.SMTP_HOST) {
    console.log("[staff-digest] SMTP not configured; not sent");
    return { sent: false, reason: "smtp_not_configured" };
  }
  const today = karachiDate(now);
  const previous = String(row?.staff_digest_sent_on ?? "2000-01-01");
  if (previous >= today) return { sent: false, reason: "already_sent" };

  const counts = await digestCounts(now);
  if (!somethingWaiting(counts)) return { sent: false, reason: "nothing_waiting", counts };

  const { data: claimed, error: claimErr } = await db
    .from("app_settings")
    .update({ staff_digest_sent_on: today })
    .eq("id", 1)
    .lt("staff_digest_sent_on", today)
    .select("id");
  if (claimErr) throw new Error(`could not claim today's staff email: ${claimErr.message}`);
  if (!claimed || claimed.length === 0) return { sent: false, reason: "already_sent", counts };

  const programName = String(row?.program_name ?? "HeyGirl Rewards");
  const lines = digestLines(counts);
  const url = await appHomeUrl();
  const subject = `${programName}: ${lines.length === 1 ? "1 thing needs" : `${lines.length} things need`} your attention`;
  const html = renderEmailLayout({
    programName,
    preheader: "Good morning. Here is what is waiting in the rewards app.",
    heading: "Needs your attention",
    paragraphs: [...lines, url ? "" : "Open the rewards app from Apps in your Shopify admin to see the details."],
    cta: url ? { label: "Open the rewards app", url } : null,
    footerNote: "Sent each morning at 9:00 Pakistan time only when something is waiting. Change or remove this address on the app's Settings page.",
  }).replace(
    // The shared layout's member footer does not apply to a staff email.
    /You are receiving this because you are a member of [^<]*\./,
    "You are receiving this because this address is set as the staff alert email.",
  );
  const text = [...lines, url ? `Open the rewards app: ${url}` : ""].filter(Boolean).join("\n\n");
  const res = await sendEmail({ to, subject, html, text });
  if (!res.sent) {
    // Give the day back so the retried job can send.
    await db.from("app_settings").update({ staff_digest_sent_on: previous }).eq("id", 1).eq("staff_digest_sent_on", today);
    if (res.reason === "smtp_not_configured") return { sent: false, reason: "smtp_not_configured", counts };
    throw new Error(`staff email not sent (${res.reason ?? "unknown"})`);
  }
  return { sent: true, counts };
}
