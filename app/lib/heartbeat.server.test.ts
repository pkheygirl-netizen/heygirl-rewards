import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());

import { h, resetHarness } from "./testing/harness";
import { readHeartbeats, recordHeartbeat } from "./heartbeat.server";

beforeEach(() => {
  resetHarness();
});

it("writes one row per key and overwrites it on the next beat", async () => {
  await recordHeartbeat("worker", { failed: { points: 0 } });
  const first = String(h.db.table("system_heartbeat")[0].at);
  await new Promise((r) => setTimeout(r, 5));
  await recordHeartbeat("worker", { failed: { points: 2 } });
  await recordHeartbeat("cron:expiry");
  expect(h.db.table("system_heartbeat")).toHaveLength(2);
  const beats = await readHeartbeats();
  expect(beats.map((b) => b.key)).toEqual(["cron:expiry", "worker"]);
  expect(beats[1].detail).toEqual({ failed: { points: 2 } });
  expect(beats[0].detail).toEqual({});
  expect(Date.parse(beats[1].at)).toBeGreaterThan(Date.parse(first));
});

it("never throws: a failed write must not fail the job it reports on", async () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.db.failNext("system_heartbeat", "upsert", { code: "XX000", message: "db down" });
  await expect(recordHeartbeat("worker")).resolves.toBeUndefined();
  expect(err).toHaveBeenCalled();
});

it("readHeartbeats surfaces a read error", async () => {
  h.db.failNext("system_heartbeat", "select", { code: "XX000", message: "db down" });
  await expect(readHeartbeats()).rejects.toThrow(/db down/);
});
