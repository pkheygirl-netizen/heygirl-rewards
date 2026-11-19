import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());
const mail = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("./email.service", async (orig) => ({ ...(await orig<typeof import("./email.service")>()), sendEmail: mail.sendEmail }));

import { h, resetHarness } from "./testing/harness";
import { digestLines, karachiDate, runStaffDigest } from "./staff-digest.server";

// 19 Nov 2026 09:00 in Karachi (UTC+5)
const NINE = new Date("2026-11-19T04:00:00Z");
let attention: Record<string, number> = {};

beforeEach(() => {
  resetHarness();
  attention = { referral_order_alerts: 1, referrals_flagged: 2, review_claims_pending: 0 };
  const realRpc = h.db.rpc.bind(h.db);
  vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) =>
    fn === "admin_attention" ? { data: [attention], error: null } : realRpc(fn, args));
  h.db.table("app_settings")[0].staff_alert_email = "staff@heygirl.pk";
  h.db.table("app_settings")[0].staff_digest_sent_on = "2000-01-01";
  h.db.table("app_settings")[0].program_name = "HeyGirl.pk Rewards";
  // a fresh worker heartbeat
  h.db.seed("system_heartbeat", { key: "worker", at: new Date(NINE.getTime() - 60_000).toISOString(), detail: {} });
  process.env.SMTP_HOST = "smtp.test";
  process.env.SHOPIFY_API_KEY = "abc123";
  mail.sendEmail.mockReset();
  mail.sendEmail.mockResolvedValue({ sent: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  delete process.env.SMTP_HOST;
  delete process.env.SHOPIFY_API_KEY;
});

describe("staff morning email", () => {
  it("sends one summary with counts and a link to the app, and claims the Pakistan date", async () => {
    const r = await runStaffDigest(NINE);
    expect(r).toMatchObject({ sent: true, counts: { referralOrderAlerts: 1, referralsHeld: 2, reviewClaims: 0, failedJobs: 0, workerStale: false } });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const msg = mail.sendEmail.mock.calls[0][0] as { to: string; subject: string; html: string; text: string };
    expect(msg.to).toBe("staff@heygirl.pk");
    expect(msg.subject).toBe("HeyGirl.pk Rewards: 2 things need your attention");
    expect(msg.text).toContain("1 referral order uses the referrer's own phone number or address");
    expect(msg.text).toContain("2 referrals are held for your approval.");
    expect(msg.text).toContain("https://test-shop.myshopify.com/admin/apps/abc123");
    expect(msg.html).toContain("staff alert email");
    expect(msg.html).not.toContain("member of");
    expect(h.db.table("app_settings")[0].staff_digest_sent_on).toBe("2026-11-19");
  });

  it("is sent at most once a day: a second run (or a restarted worker) sends nothing", async () => {
    await runStaffDigest(NINE);
    expect(await runStaffDigest(new Date(NINE.getTime() + 3_600_000))).toEqual({ sent: false, reason: "already_sent" });
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    // the next Pakistan day it sends again
    expect((await runStaffDigest(new Date(NINE.getTime() + 24 * 3_600_000))).sent).toBe(true);
    expect(mail.sendEmail).toHaveBeenCalledTimes(2);
  });

  it("two runs racing: only the one that claims the day sends", async () => {
    const [a, b] = await Promise.all([runStaffDigest(NINE), runStaffDigest(NINE)]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("nothing waiting: no email, and the day is not used up", async () => {
    attention = { referral_order_alerts: 0, referrals_flagged: 0, review_claims_pending: 0 };
    expect(await runStaffDigest(NINE)).toMatchObject({ sent: false, reason: "nothing_waiting" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(h.db.table("app_settings")[0].staff_digest_sent_on).toBe("2000-01-01");
  });

  it("failed jobs or a stale worker heartbeat count as waiting", async () => {
    attention = { referral_order_alerts: 0, referrals_flagged: 0, review_claims_pending: 0 };
    h.db.table("system_heartbeat")[0].at = new Date(NINE.getTime() - 20 * 60_000).toISOString();
    const r = await runStaffDigest(NINE);
    expect(r).toMatchObject({ sent: true, counts: { workerStale: true } });
    expect((mail.sendEmail.mock.calls[0][0] as { text: string }).text).toContain("has not reported for over 15 minutes");
    expect(digestLines({ referralOrderAlerts: 0, referralsHeld: 0, reviewClaims: 3, failedJobs: 2, workerStale: false }))
      .toEqual(["3 review claims are waiting for approval.", "2 background jobs have failed in the last 14 days. See Settings, System health."]);
  });

  it("no address set or SMTP not configured: skipped quietly, one log line", async () => {
    h.db.table("app_settings")[0].staff_alert_email = null;
    expect(await runStaffDigest(NINE)).toEqual({ sent: false, reason: "no_address" });
    h.db.table("app_settings")[0].staff_alert_email = "staff@heygirl.pk";
    delete process.env.SMTP_HOST;
    expect(await runStaffDigest(NINE)).toEqual({ sent: false, reason: "smtp_not_configured" });
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("a failed send gives the day back and throws, so the retried job can send", async () => {
    mail.sendEmail.mockResolvedValueOnce({ sent: false, reason: "send_error" });
    await expect(runStaffDigest(NINE)).rejects.toThrow("staff email not sent");
    expect(h.db.table("app_settings")[0].staff_digest_sent_on).toBe("2000-01-01");
    expect((await runStaffDigest(NINE)).sent).toBe(true);
  });

  it("never contains customer details: the email is built from counts only", async () => {
    // even if a referral row held contact details, the digest never reads referral rows
    h.db.seed("referrals", { referred_email: "friend@example.com", status: "flagged" });
    h.db.seed("members", { email: "aisha@example.com", phone: "+923001234567" });
    await runStaffDigest(NINE);
    const msg = mail.sendEmail.mock.calls[0][0] as { html: string; text: string };
    expect(msg.html + msg.text).not.toMatch(/example\.com|300 ?123|923001234567/);
  });

  it("Pakistan date: 23:30 UTC is already the next day in Karachi", () => {
    expect(karachiDate(new Date("2026-11-18T23:30:00Z"))).toBe("2026-11-19");
  });
});
