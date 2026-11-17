import { beforeEach, describe, expect, it, vi } from "vitest";

const readHeartbeats = vi.fn();
const now = new Date("2026-11-16T10:00:00Z");
const minsAgo = (m: number) => new Date(now.getTime() - m * 60000).toISOString();

beforeEach(() => {
  vi.resetModules();
  readHeartbeats.mockReset();
});

async function load(queue?: Record<string, unknown> | "throws") {
  vi.resetModules();
  vi.doMock("./heartbeat.server", () => ({ readHeartbeats }));
  vi.doMock("./queue.server", () => {
    if (queue === "throws") throw new Error("REDIS_URL is required");
    return queue ?? {};
  });
  return import("./admin-health.server");
}
const q = (failed: number) => ({ getFailedCount: () => Promise.resolve(failed) });

describe("classifyHeartbeats", () => {
  it("separates alerts, worker signals and other signals, and marks a quiet worker stale", async () => {
    const mod = await load();
    const rows = mod.classifyHeartbeats([
      { key: "worker", at: minsAgo(2), detail: { jobs: 4 } },
      { key: "worker:cron", at: minsAgo(40), detail: {} },
      { key: "cron_failed:expiry", at: minsAgo(5), detail: { error: "boom" } },
      { key: "cron:expiry", at: minsAgo(600), detail: {} },
      { key: "alert:shop_redact", at: minsAgo(60), detail: { shop: "x.myshopify.com", nested: { a: 1 } } },
      { key: "cron:birthday", at: minsAgo(60 * 24 * 10), detail: {} },
    ], now);
    expect(rows.map((r) => [r.kind, r.stale])).toEqual([
      ["worker", false], ["worker", true], ["alert", false], ["signal", false], ["alert", false], ["signal", false],
    ]);
    expect(rows[0].detail).toBe("jobs: 4");
    expect(rows[2].detail).toBe("error: boom");
    expect(rows[4].detail).toBe("shop: x.myshopify.com"); // nested values are not echoed
  });
});

describe("summariseHealth", () => {
  it("is healthy when the worker reported recently and nothing failed", async () => {
    const mod = await load();
    const hb = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(2), detail: {} }], now);
    expect(mod.summariseHealth(hb, 0)).toEqual({ status: "healthy", summary: "Points worker last reported 2 minutes ago. No failed jobs." });
  });

  it("needs attention for a stale worker, failed jobs or a recent alert", async () => {
    const mod = await load();
    const stale = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(90), detail: {} }], now);
    expect(mod.summariseHealth(stale, 0).status).toBe("attention");
    const fresh = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(1), detail: {} }], now);
    expect(mod.summariseHealth(fresh, 3)).toMatchObject({ status: "attention" });
    expect(mod.summariseHealth(fresh, 3).summary).toContain("3 failed jobs.");
    const alert = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(1), detail: {} }, { key: "alert:shop_redact", at: minsAgo(30), detail: {} }], now);
    expect(mod.summariseHealth(alert, 0).status).toBe("attention");
    const oldAlert = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(1), detail: {} }, { key: "alert:shop_redact", at: minsAgo(60 * 24 * 30), detail: {} }], now);
    expect(mod.summariseHealth(oldAlert, 0).status).toBe("healthy");
  });

  it("a failed job that has run successfully since is no longer an alert", async () => {
    const mod = await load();
    const w = { key: "worker", at: minsAgo(1), detail: {} };
    const stillFailing = mod.classifyHeartbeats([w, { key: "cron_failed:expiry", at: minsAgo(30), detail: {} }, { key: "cron:expiry", at: minsAgo(600), detail: {} }], now);
    expect(mod.summariseHealth(stillFailing, 0).status).toBe("attention");
    const recovered = mod.classifyHeartbeats([w, { key: "cron_failed:expiry", at: minsAgo(600), detail: {} }, { key: "cron:expiry", at: minsAgo(30), detail: {} }], now);
    expect(mod.summariseHealth(recovered, 0).status).toBe("healthy");
  });

  it("is unknown, not healthy, when the worker has never reported or the count is unavailable", async () => {
    const mod = await load();
    expect(mod.summariseHealth([], 0).status).toBe("unknown");
    const fresh = mod.classifyHeartbeats([{ key: "worker:points", at: minsAgo(1), detail: {} }], now);
    expect(mod.summariseHealth(fresh, null).summary).toContain("Failed-job count unavailable.");
  });
});

describe("countFailedJobs", () => {
  it("adds up failed jobs across the queues", async () => {
    const mod = await load({ pointsQueue: q(2), socialQueue: q(0), notificationQueue: q(1), cronQueue: q(0) });
    expect(await mod.countFailedJobs()).toBe(3);
  });

  it("returns null when the queue module cannot load or a queue errors", async () => {
    expect(await (await load("throws")).countFailedJobs()).toBeNull();
    const broken = await load({ pointsQueue: { getFailedCount: () => Promise.reject(new Error("ECONNREFUSED")) }, socialQueue: q(0), notificationQueue: q(0), cronQueue: q(0) });
    expect(await broken.countFailedJobs()).toBeNull();
  });

  it("gives up after the timeout instead of holding the page", async () => {
    const mod = await load({ pointsQueue: { getFailedCount: () => new Promise(() => undefined) }, socialQueue: q(0), notificationQueue: q(0), cronQueue: q(0) });
    expect(await mod.countFailedJobs(20)).toBeNull();
  });
});

describe("getSystemHealth", () => {
  it("combines heartbeats and the failed-job count", async () => {
    const mod = await load({ pointsQueue: q(0), socialQueue: q(0), notificationQueue: q(0), cronQueue: q(0) });
    readHeartbeats.mockResolvedValueOnce([{ key: "worker:points", at: minsAgo(3), detail: {} }]);
    const h = await mod.getSystemHealth(now);
    expect(h.status).toBe("healthy");
    expect(h.failedJobs).toBe(0);
    expect(h.heartbeats).toHaveLength(1);
  });

  it("falls back to the worker's own failed-job counts when Redis cannot be asked", async () => {
    const mod = await load("throws");
    readHeartbeats.mockResolvedValueOnce([{ key: "worker", at: minsAgo(1), detail: { failed: { points: 2, notifications: 1 } } }]);
    const h = await mod.getSystemHealth(now);
    expect(h.failedJobs).toBe(3);
    expect(h.status).toBe("attention");
    expect(mod.failedFromHeartbeat([{ key: "worker", detail: {} }])).toBeNull();
    expect(mod.failedFromHeartbeat([{ key: "worker", detail: { failed: 0 } }])).toBe(0);
    expect(mod.failedFromHeartbeat([{ key: "cron:expiry", detail: { failed: 9 } }])).toBeNull();
  });

  it("reports unknown when heartbeats cannot be read, without throwing", async () => {
    const mod = await load({ pointsQueue: q(0), socialQueue: q(0), notificationQueue: q(0), cronQueue: q(0) });
    readHeartbeats.mockRejectedValueOnce(new Error("relation does not exist"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await mod.getSystemHealth(now);
    spy.mockRestore();
    expect(h).toMatchObject({ status: "unknown", summary: "System health could not be read.", heartbeats: [] });
  });
});
