import { beforeEach, describe, expect, it, vi } from "vitest";

const workers = vi.hoisted(() => [] as Array<{ queue: string; opts: Record<string, unknown> }>);
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(queue: string, _fn: unknown, opts: Record<string, unknown>) {
      workers.push({ queue, opts });
    }
    on() {
      return this;
    }
  },
}));
vi.mock("../db.server", async () => (await import("../lib/testing/harness")).dbModule());
vi.mock("../lib/queue.server", async () => (await import("../lib/testing/harness")).queueModule());
vi.mock("../lib/worker-admin.server", async () => (await import("../lib/testing/harness")).adminModule());
const sync = vi.hoisted(() => vi.fn());
vi.mock("../lib/storefront-config.server", () => ({ syncStorefrontConfig: sync }));

import { h, resetHarness, seedMember } from "../lib/testing/harness";
import { bustSettingsCache } from "../lib/settings.server";
import { registerCronJobs, runBirthday, runCronJob, runExpiry, runExpiryWarning, runStorefrontConfig } from "./cron.worker";

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("schedules", () => {
  it("every repeatable job runs in Asia/Karachi, including a one-minute heartbeat", async () => {
    await registerCronJobs();
    const jobs = h.cron.jobs;
    expect(jobs.map((j) => j.name).sort()).toEqual([
      "cron_birthday", "cron_expiry", "cron_expiry_warning", "cron_heartbeat", "cron_pending_codes", "cron_review_release", "cron_social_sweep", "cron_storefront_config",
    ]);
    for (const j of jobs) expect((j.opts as { repeat: { tz: string } }).repeat.tz).toBe("Asia/Karachi");
    const pattern = (n: string) => (jobs.find((j) => j.name === n)!.opts as { repeat: { pattern: string } }).repeat.pattern;
    expect(pattern("cron_heartbeat")).toBe("* * * * *");
    expect(pattern("cron_birthday")).toBe("0 9 * * *"); // M2: every day, not only the 1st
    expect(pattern("cron_pending_codes")).toBe("*/10 * * * *"); // H3
    expect(pattern("cron_storefront_config")).toBe("5 * * * *");
  });

  it("the heartbeat job writes the worker heartbeat with failed-job counts", async () => {
    await runCronJob("cron_heartbeat");
    expect(h.db.table("system_heartbeat")[0]).toMatchObject({ key: "worker", detail: { failed: { points: 0, social: 0, notifications: 0, cron: 0 } } });
  });
});

describe("runExpiry", () => {
  it("expires overdue Silver points and overdue active codes", async () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const m = seedMember(h.db, { points_balance: 500 });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "review", reference_id: "r", points: 500, points_remaining: 500, balance_after: 500, expires_at: "2026-11-01T00:00:00Z" });
    const old = h.db.seed("loyalty_codes", { member_id: m.id, code: "A", discount_amount: 1, points_spent: 0, expires_at: "2026-11-01T00:00:00Z" });
    const live = h.db.seed("loyalty_codes", { member_id: m.id, code: "B", discount_amount: 1, points_spent: 0, expires_at: "2026-12-01T00:00:00Z" });
    const used = h.db.seed("loyalty_codes", { member_id: m.id, code: "C", status: "used", discount_amount: 1, points_spent: 0, expires_at: "2026-11-01T00:00:00Z" });
    expect(await runExpiry(now)).toEqual({ membersAffected: 1, pointsExpired: 500 });
    expect(m.points_balance).toBe(0);
    expect([old.status, live.status, used.status]).toEqual(["expired", "active", "used"]);
  });
});

describe("runExpiryWarning", () => {
  it("one notification per member for points expiring within 30 days, never repeated", async () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const m = seedMember(h.db, { points_balance: 1500 });
    const gold = seedMember(h.db, { tier: "gold", points_balance: 100 });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "a", points: 1000, points_remaining: 400, balance_after: 1000, expires_at: "2026-12-01T00:00:00Z" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "social_youtube", reference_id: "b", points: 1000, points_remaining: 1000, balance_after: 2000, expires_at: "2026-12-10T00:00:00Z" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "purchase", reference_id: "c", points: 100, points_remaining: 100, balance_after: 2100, expires_at: "2027-06-01T00:00:00Z" }); // not soon
    h.db.seed("points_ledger", { member_id: gold.id, action_type: "purchase", reference_id: "d", points: 100, points_remaining: 100, balance_after: 100, expires_at: "2026-12-01T00:00:00Z" }); // Gold never expires
    expect(await runExpiryWarning(now)).toEqual({ warned: 1 });
    expect(h.notifications.named("points_expiring")).toHaveLength(1);
    expect(h.notifications.named("points_expiring")[0].data).toEqual({ memberId: m.id, expiringPoints: 1400, expiresAt: "2026-12-01T00:00:00Z" });
    expect(await runExpiryWarning(now)).toEqual({ warned: 0 });
    expect(h.notifications.named("points_expiring")).toHaveLength(1);
  });
});

describe("runBirthday", () => {
  it("queues one issue job per eligible member; nothing when the rule is off", async () => {
    const now = new Date("2026-11-01T04:00:00Z");
    const a = seedMember(h.db, { birthday_month: 11, birthday_day: 2, birthday_set_at: "2026-01-01T00:00:00Z" });
    seedMember(h.db, { birthday_month: 11, birthday_day: 2, birthday_set_at: "2026-01-01T00:00:00Z", is_blocked: true });
    seedMember(h.db, { birthday_month: 5, birthday_day: 2, birthday_set_at: "2026-01-01T00:00:00Z" });
    expect(await runBirthday(now)).toEqual({ queued: 1 });
    expect(h.points.named("issue_birthday_reward")[0].data).toEqual({ memberId: a.id });
    expect(h.points.named("issue_birthday_reward")[0].opts).toBeUndefined(); // M4: no fixed job id
    h.db.table("app_settings")[0].earn_rules = { birthday: { enabled: false } };
    bustSettingsCache();
    expect(await runBirthday(now)).toMatchObject({ queued: 0, reason: "disabled" });
  });
});

describe("cron_social_sweep: a social claim whose delayed job was lost (review item 3)", () => {
  const NOW = Date.now();
  const claim = (memberId: unknown, platform: string, minutesPastDue: number, over = {}) =>
    h.db.seed("social_actions", { member_id: memberId, action_type: platform, status: "pending", pending_until: new Date(NOW - minutesPastDue * 60_000).toISOString(), ...over });

  it("is scheduled twice an hour", async () => {
    await registerCronJobs();
    const job = h.cron.jobs.find((j) => j.name === "cron_social_sweep")!;
    expect((job.opts as { repeat: { pattern: string } }).repeat.pattern).toBe("7,37 * * * *");
  });

  it("awards rows pending more than an hour past pending_until, once; younger ones are left to their job", async () => {
    h.db.table("app_settings")[0].social_points_instagram = 750;
    const m = seedMember(h.db);
    const lost = claim(m.id, "instagram", 61);
    const recent = claim(m.id, "facebook", 59); // its own job may still be on its way
    const notDue = claim(m.id, "youtube", -30);

    expect(await runCronJob("cron_social_sweep")).toEqual({ awarded: 1, closed: 0, failed: 0 });
    expect(lost).toMatchObject({ status: "awarded", points_awarded: 750 });
    expect([recent.status, notDue.status]).toEqual(["pending", "pending"]);
    expect(m.points_balance).toBe(750);
    expect(h.db.table("points_ledger").filter((l) => l.action_type === "social_instagram")).toHaveLength(1);

    // a second run finds nothing more to do
    expect(await runCronJob("cron_social_sweep")).toEqual({ awarded: 0, closed: 0, failed: 0 });
    expect(m.points_balance).toBe(750);
  });

  it("the job turned up after all and paid: the sweep only closes the row, nothing is paid twice", async () => {
    const m = seedMember(h.db);
    const row = claim(m.id, "instagram", 120);
    // the ledger already holds the award, but the row was never marked
    await h.db.rpc("award_points", { p_member_id: m.id, p_action_type: "social_instagram", p_reference_id: String(row.id), p_points: 1000 });
    const before = m.points_balance;
    expect(await runCronJob("cron_social_sweep")).toEqual({ awarded: 0, closed: 1, failed: 0 });
    expect(row.status).toBe("awarded");
    expect(m.points_balance).toBe(before);
  });

  it("blocked members' claims are voided; a database failure leaves the row pending for the next run", async () => {
    const blocked = seedMember(h.db, { is_blocked: true });
    const voided = claim(blocked.id, "instagram", 90);
    const ok = seedMember(h.db);
    const stuck = claim(ok.id, "instagram", 80);
    h.db.failNext("rpc:award_points", "select", { code: "57014", message: "timeout" });
    expect(await runCronJob("cron_social_sweep")).toEqual({ awarded: 0, closed: 1, failed: 1 });
    expect(voided.status).toBe("voided");
    expect(stuck.status).toBe("pending");
    expect(await runCronJob("cron_social_sweep")).toEqual({ awarded: 1, closed: 0, failed: 0 });
    expect(stuck.status).toBe("awarded");
  });
});

it("unknown cron job names are ignored, not thrown", async () => {
  expect(await runCronJob("cron_nonsense")).toEqual({ ignored: "cron_nonsense" });
});

describe("M2: birthday job runs daily and catches up", () => {
  const born = (over = {}) => seedMember(h.db, { birthday_month: 11, birthday_day: 20, birthday_set_at: "2026-06-01T00:00:00Z", ...over });

  it("a run on the 9th (worker was down on the 1st) still queues the member; one already issued this year is left out", async () => {
    const pendingMember = born();
    const done = born();
    h.db.seed("loyalty_codes", { member_id: done.id, code: "BDAY-1", kind: "birthday", issue_key: `birthday:${done.id}:2026`, discount_amount: 250, points_spent: 0, expires_at: "2026-12-01", created_at: "2026-11-01T04:00:00Z" });
    const lastYear = born();
    h.db.seed("loyalty_codes", { member_id: lastYear.id, code: "BDAY-0", kind: "birthday", issue_key: `birthday:${lastYear.id}:2025`, status: "used", discount_amount: 250, points_spent: 0, expires_at: "2025-12-01", created_at: "2025-11-01T04:00:00Z" });
    const r = await runBirthday(new Date("2026-11-09T04:00:00Z"));
    expect(r).toEqual({ queued: 2 });
    expect(h.points.named("issue_birthday_reward").map((j) => j.data.memberId).sort()).toEqual([pendingMember.id, lastYear.id].sort());
  });

  it("rule 13 still holds on a daily run: a birthday first set during its own month waits until next year", async () => {
    born({ birthday_set_at: "2026-11-03T00:00:00Z" });
    expect(await runBirthday(new Date("2026-11-09T04:00:00Z"))).toEqual({ queued: 0 });
    expect(await runBirthday(new Date("2027-11-02T04:00:00Z"))).toEqual({ queued: 1 });
  });
});

describe("M3: expiry warning", () => {
  const NOW = new Date("2026-11-16T00:00:00Z");
  const tranche = (memberId: unknown, ref: string, expires = "2026-12-01T00:00:00Z") =>
    h.db.seed("points_ledger", { member_id: memberId, action_type: "import", reference_id: ref, points: 100, points_remaining: 100, balance_after: 100, expires_at: expires });

  it("covers more than 2,000 tranches in one run and does not stall on ones already announced", async () => {
    const first = seedMember(h.db, { points_balance: 100 });
    // 2,100 tranches announced on an earlier night would fill a capped query for ever
    for (let i = 0; i < 2100; i++) {
      const t = tranche(first.id, `old-${i}`);
      h.db.seed("notification_log", { member_id: first.id, event_type: "expiry_warning", reference_id: String(t.id) });
    }
    const members = Array.from({ length: 30 }, () => seedMember(h.db, { points_balance: 100 }));
    members.forEach((m, i) => tranche(m.id, `new-${i}`, "2026-12-10T00:00:00Z"));
    expect(await runExpiryWarning(NOW)).toEqual({ warned: 30 });
    expect(h.notifications.named("points_expiring")).toHaveLength(30);
    expect(await runExpiryWarning(NOW)).toEqual({ warned: 0 });
  });

  it("the log row is written only after the notification was queued: a failed enqueue is retried next run", async () => {
    const m = seedMember(h.db, { points_balance: 100 });
    tranche(m.id, "a");
    const realAdd = h.notifications.add;
    h.notifications.add = async () => { throw new Error("redis down"); };
    expect(await runExpiryWarning(NOW)).toEqual({ warned: 0, failed: 1 });
    expect(h.db.table("notification_log")).toHaveLength(0); // nothing recorded as sent
    h.notifications.add = realAdd;
    expect(await runExpiryWarning(NOW)).toEqual({ warned: 1 });
    expect(h.db.table("notification_log")).toHaveLength(1);
  });

  it("the earliest expiry date of the member's tranches is the one announced", async () => {
    const m = seedMember(h.db, { points_balance: 200 });
    tranche(m.id, "late", "2026-12-12T00:00:00Z");
    tranche(m.id, "early", "2026-11-20T00:00:00Z");
    await runExpiryWarning(NOW);
    expect(h.notifications.named("points_expiring")[0].data).toMatchObject({ expiringPoints: 200, expiresAt: "2026-11-20T00:00:00Z" });
  });
});

describe("storefront config job", () => {
  beforeEach(() => sync.mockReset().mockResolvedValue({ ok: true }));
  const campaign = (starts: string, ends: string) => h.db.seed("bonus_campaigns", { name: "c", multiplier: 2, starts_at: starts, ends_at: ends });

  it("publishes once a day regardless (the 00:05 Pakistan-time run)", async () => {
    expect(await runStorefrontConfig(new Date("2026-11-16T19:05:00Z"))).toEqual({ synced: true }); // 00:05 PKT
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("otherwise only when a campaign started or ended in the last hour", async () => {
    campaign("2026-11-20T00:00:00Z", "2026-11-25T00:00:00Z");
    expect(await runStorefrontConfig(new Date("2026-11-16T10:05:00Z"))).toEqual({ synced: false, reason: "nothing_changed" });
    expect(sync).not.toHaveBeenCalled();
    campaign("2026-11-16T09:30:00Z", "2026-11-18T00:00:00Z"); // started 35 minutes ago, no admin save since
    expect(await runStorefrontConfig(new Date("2026-11-16T10:05:00Z"))).toEqual({ synced: true });
  });

  it("back-to-back campaigns: the hour the first one ends, the config is republished so the next moves up", async () => {
    campaign("2026-11-10T00:00:00Z", "2026-11-16T10:00:00Z");
    campaign("2026-11-16T10:00:00Z", "2026-11-18T00:00:00Z");
    expect(await runStorefrontConfig(new Date("2026-11-16T10:05:00Z"))).toEqual({ synced: true });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("a failed publish fails the job so it is retried", async () => {
    sync.mockResolvedValue({ ok: false, reason: "no_app_installation" });
    await expect(runStorefrontConfig(new Date("2026-11-16T19:05:00Z"))).rejects.toThrow(/no_app_installation/);
  });
});

describe("rule 20: the program switch only pauses redeeming", () => {
  it("the birthday run queues codes while the program is off; the birthday rule's own switch still stops it", async () => {
    seedMember(h.db, { birthday_month: 11, birthday_day: 20, birthday_set_at: "2026-06-01T00:00:00Z" });
    h.db.table("app_settings")[0].program_enabled = false;
    h.db.table("app_settings")[0].earn_rules = { birthday: { enabled: false } };
    bustSettingsCache();
    expect(await runBirthday(new Date("2026-11-01T04:00:00Z"))).toMatchObject({ queued: 0, reason: "disabled" });
    h.db.table("app_settings")[0].earn_rules = {};
    bustSettingsCache();
    expect(await runBirthday(new Date("2026-11-01T04:00:00Z"))).toEqual({ queued: 1 });
  });
});
