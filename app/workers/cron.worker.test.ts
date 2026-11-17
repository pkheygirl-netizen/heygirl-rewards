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

import { h, resetHarness, seedMember } from "../lib/testing/harness";
import { bustSettingsCache } from "../lib/settings.server";
import { registerCronJobs, runBirthday, runCronJob, runExpiry, runExpiryWarning } from "./cron.worker";

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
    expect(jobs.map((j) => j.name).sort()).toEqual(["cron_birthday", "cron_expiry", "cron_expiry_warning", "cron_heartbeat", "cron_review_release"]);
    for (const j of jobs) expect((j.opts as { repeat: { tz: string } }).repeat.tz).toBe("Asia/Karachi");
    const pattern = (n: string) => (jobs.find((j) => j.name === n)!.opts as { repeat: { pattern: string } }).repeat.pattern;
    expect(pattern("cron_heartbeat")).toBe("* * * * *");
    expect(pattern("cron_birthday")).toBe("0 9 1 * *");
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
    h.db.table("app_settings")[0].earn_rules = { birthday: { enabled: false } };
    bustSettingsCache();
    expect(await runBirthday(now)).toMatchObject({ queued: 0, reason: "disabled" });
  });
});

it("unknown cron job names are ignored, not thrown", async () => {
  expect(await runCronJob("cron_nonsense")).toEqual({ ignored: "cron_nonsense" });
});
