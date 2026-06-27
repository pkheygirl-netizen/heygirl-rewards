import { describe, it, expect } from "vitest";
import { bucketFlowByDay, parseRange } from "./admin-analytics.server";

describe("bucketFlowByDay", () => {
  it("splits issued/redeemed/expired per day", () => {
    const out = bucketFlowByDay([
      { points: 1000, action_type: "purchase", earned_at: "2026-06-01T00:00:00Z" },
      { points: -250, action_type: "redemption", earned_at: "2026-06-01T01:00:00Z" },
      { points: -100, action_type: "expiry", earned_at: "2026-06-01T02:00:00Z" },
      { points: 500, action_type: "signup", earned_at: "2026-06-02T00:00:00Z" },
    ]);
    expect(out).toEqual([
      { date: "2026-06-01", issued: 1000, redeemed: 250, expired: 100 },
      { date: "2026-06-02", issued: 500, redeemed: 0, expired: 0 },
    ]);
  });
});

describe("parseRange", () => {
  it("defaults to 30 days", () => {
    const { from, to } = parseRange(new URLSearchParams());
    const days = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(days).toBe(30);
  });
  it("honours range=7d", () => {
    const { from, to } = parseRange(new URLSearchParams("range=7d"));
    const days = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(days).toBe(7);
  });
});
