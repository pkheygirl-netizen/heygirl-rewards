import { beforeEach, expect, it, vi } from "vitest";

const made = vi.hoisted(() => [] as Array<{ name: string; opts: { defaultJobOptions: Record<string, unknown> } }>);
vi.mock("bullmq", () => ({
  Queue: class {
    constructor(public name: string, opts: { defaultJobOptions: Record<string, unknown> }) {
      made.push({ name, opts });
    }
    async getFailedCount() {
      if (this.name === "cron") throw new Error("redis down");
      return this.name === "points" ? 3 : 0;
    }
  },
}));
vi.mock("ioredis", () => ({ default: class { on() { return this; } } }));

beforeEach(() => {
  process.env.REDIS_URL = "redis://localhost:6379";
});

it("every queue removes finished jobs and keeps a bounded number of failed ones", async () => {
  const { DEFAULT_JOB_OPTIONS } = await import("./queue.server");
  expect(made.map((q) => q.name).sort()).toEqual(["cron", "notifications", "points", "social-actions"]);
  for (const q of made) {
    const o = q.opts.defaultJobOptions as typeof DEFAULT_JOB_OPTIONS;
    expect(o.removeOnComplete).toEqual({ age: 3600, count: 1000 });
    expect(o.removeOnFail).toEqual({ age: 14 * 24 * 3600, count: 5000 });
    expect(o.attempts).toBeGreaterThan(1);
  }
});

it("failedJobCounts reports per queue and survives a Redis error", async () => {
  const { failedJobCounts } = await import("./queue.server");
  expect(await failedJobCounts()).toEqual({ points: 3, social: 0, notifications: 0, cron: -1 });
});
