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

it("H3: retries span about an hour, not 75 seconds", async () => {
  const { DEFAULT_JOB_OPTIONS } = await import("./queue.server");
  const { attempts, backoff } = DEFAULT_JOB_OPTIONS;
  let total = 0;
  for (let i = 0; i < attempts - 1; i++) total += backoff.delay * 2 ** i;
  expect(backoff.type).toBe("exponential");
  expect(total).toBeGreaterThanOrEqual(60 * 60 * 1000);
});

it("M4: addUnique removes a FAILED job with the same id before adding, and leaves a live one alone", async () => {
  const { addUnique } = await import("./queue.server");
  const removed: string[] = [];
  const added: Array<{ name: string; opts?: Record<string, unknown> }> = [];
  const queue = (failed: boolean | null) => ({
    add: async (name: string, _d: Record<string, unknown>, opts?: Record<string, unknown>) => { added.push({ name, opts }); },
    getJob: async (id: string) => (failed === null ? undefined : { isFailed: async () => failed, remove: async () => { removed.push(id); } }),
  });
  await addUnique(queue(true), "tier_upgrade", {}, "mail-1");
  expect(removed).toEqual(["mail-1"]);
  await addUnique(queue(false), "tier_upgrade", {}, "mail-2");
  await addUnique(queue(null), "tier_upgrade", {}, "mail-3");
  expect(removed).toEqual(["mail-1"]);
  expect(added.map((a) => a.opts)).toEqual([{ jobId: "mail-1" }, { jobId: "mail-2" }, { jobId: "mail-3" }]);
});

it("startWorkers starts the Smile import worker with the others, only when WORKER=1", async () => {
  const loaded: string[] = [];
  for (const w of ["points", "social", "cron", "notification", "import"]) {
    vi.doMock(`../workers/${w}.worker`, () => { loaded.push(w); return {}; });
  }
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { startWorkers } = await import("./queue.server");
  delete process.env.WORKER;
  startWorkers();
  await new Promise((r) => setTimeout(r, 20));
  expect(loaded).toEqual([]);
  process.env.WORKER = "1";
  startWorkers();
  await new Promise((r) => setTimeout(r, 50));
  delete process.env.WORKER;
  expect(loaded.sort()).toEqual(["cron", "import", "notification", "points", "social"]);
  log.mockRestore();
});
