import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./admin-test-helpers";

beforeEach(() => {
  vi.resetModules();
});

async function load(script: Parameters<typeof fakeDb>[0]) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  const mod = await import("./admin-data.server");
  return { fake, mod };
}

describe("period stats", () => {
  it("maps the SQL result and computes redemption rate as redeemed ÷ earned", async () => {
    const { fake, mod } = await load({
      rpc: () => ({
        data: {
          members_total: 1912, members_new: 96, points_earned: 842300, points_redeemed: 117922,
          points_expired: 500, points_reversed: 1800, points_pending: 118000, redemptions: 31,
          reward_orders: 12, reward_sales_pkr: "386000.00", reward_cost_pkr: 21500,
        },
      }),
    });
    const s = await mod.getPeriodStats("2026-10-17T19:00:00.000Z", "2026-11-16T19:00:00.000Z");
    expect(s.membersTotal).toBe(1912);
    expect(s.rewardSalesPkr).toBe(386000);
    expect(s.redemptionRate).toBeCloseTo(0.14, 2);
    expect(s.redemptions).toBe(31);
    expect(fake.rpcCalls("admin_period_stats")[0].args).toEqual({
      p_from: "2026-10-17T19:00:00.000Z", p_to: "2026-11-16T19:00:00.000Z",
    });
    // no table is read to build these numbers (R1)
    expect(fake.db.from).not.toHaveBeenCalled();
  });

  it("redemption rate is 0 when nothing was earned, never a division by zero", async () => {
    const { mod } = await load({});
    expect(mod.redemptionRate(500, 0)).toBe(0);
    expect(mod.redemptionRate(0, 500)).toBe(0);
    expect(mod.toPeriodStats({}).redemptionRate).toBe(0);
    expect(mod.toPeriodStats({}).membersTotal).toBe(0);
  });

  it("surfaces a database error instead of showing zeros", async () => {
    const { mod } = await load({ rpc: () => ({ error: { message: "function missing" } }) });
    await expect(mod.getPeriodStats("a", "b")).rejects.toThrow("admin_period_stats failed: function missing");
  });
});

describe("series", () => {
  it("returns one point per day from the database", async () => {
    const { mod } = await load({
      rpc: () => ({ data: [{ day: "2026-11-15", earned: "100", redeemed: 0, expired: 0 }, { day: "2026-11-16", earned: 50, redeemed: 30, expired: 5 }] }),
    });
    expect(await mod.getPointsSeries("a", "b")).toEqual([
      { day: "2026-11-15", earned: 100, redeemed: 0, expired: 0 },
      { day: "2026-11-16", earned: 50, redeemed: 30, expired: 5 },
    ]);
  });

  it("groups a long series into weeks without losing points", async () => {
    const { mod } = await load({});
    const days = Array.from({ length: 90 }, (_, i) => ({ day: `d${i}`, earned: 10, redeemed: 1, expired: 0 }));
    const grouped = mod.groupSeries(days);
    expect(grouped).toHaveLength(13);
    expect(grouped.reduce((s, p) => s + p.earned, 0)).toBe(900);
    expect(grouped[0].day).toBe("d0");
    expect(mod.groupSeries(days.slice(0, 30))).toHaveLength(30);
  });
});

describe("tiers and attention", () => {
  it("reads tier counts and the nearly-there counts", async () => {
    const { mod } = await load({
      rpc: (name) => name === "admin_tier_counts"
        ? { data: { silver: 1869, gold: 34, diamond: 9, near_gold: 12, near_diamond: 2, near_gold_within_pkr: "5000.00", near_diamond_within_pkr: 10000 } }
        : { data: { referrals_flagged: 3, review_claims_pending: 2, expiring_members: 41, expiring_points: 90000, expiring_overdue_members: 4, gdpr_open: 1 } },
    });
    expect(await mod.getTierCounts()).toEqual({
      silver: 1869, gold: 34, diamond: 9, nearGold: 12, nearDiamond: 2, nearGoldWithinPkr: 5000, nearDiamondWithinPkr: 10000,
    });
    expect(await mod.getAttention(30)).toEqual({
      referralsFlagged: 3, reviewClaimsPending: 2, expiringMembers: 41, expiringPoints: 90000, expiringOverdueMembers: 4, gdprOpen: 1,
    });
  });

  it("lists pending review claims soonest release first, a page at a time", async () => {
    const { fake, mod } = await load({
      from: () => ({
        count: 40,
        data: [{ id: "c1", member_id: "m1", shopify_order_id: "O1", points: 3000, claimed_at: "t1", release_at: "t2", members: { first_name: "Sara", last_name: null, email: "s@x.com" } }],
      }),
    });
    const res = await mod.listPendingReviewClaims(1, 25);
    expect(res.total).toBe(40);
    expect(res.rows[0]).toMatchObject({ id: "c1", memberName: "Sara", points: 3000, releaseAt: "t2" });
    const chain = fake.tableCalls("review_claims")[0].chain;
    expect(chain).toContainEqual(["eq", ["status", "pending"]]);
    expect(chain).toContainEqual(["range", [25, 49]]);
  });

  it("lists members with expiring points with the total from the first row", async () => {
    const { fake, mod } = await load({
      rpc: () => ({ data: [{ member_id: "m1", name: "Sara", email: null, phone: "0300", points: "1500", first_expiry: "t", total_count: 41 }] }),
    });
    const res = await mod.listExpiringMembers(30, 2, 25);
    expect(res.total).toBe(41);
    expect(res.rows[0]).toMatchObject({ memberId: "m1", points: 1500, email: null, phone: "0300" });
    expect(fake.rpcCalls("admin_expiring_members")[0].args).toEqual({ p_days: 30, p_limit: 25, p_offset: 50 });
  });
});

describe("activity", () => {
  it("asks for one extra row to know whether there is another page", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `l${i}`, at: "2026-11-16T05:00:00Z", kind: "points", action: "purchase", points: 100,
      member_id: "m1", member_name: "Sara", order_id: "555", order_name: "#1042",
    }));
    const { fake, mod } = await load({ rpc: () => ({ data: rows }) });
    const res = await mod.getActivity({ filter: "earned", page: 2, pageSize: 10 });
    expect(res.items).toHaveLength(10);
    expect(res.hasMore).toBe(true);
    expect(fake.rpcCalls("admin_activity")[0].args).toEqual({ p_filter: "earned", p_member: null, p_limit: 11, p_offset: 20 });
    expect(res.items[0].title).toBe("Order #1042 delivered and paid");
  });

  it("only accepts known filters", async () => {
    const { mod } = await load({});
    expect(mod.parseActivityFilter("redeemed")).toBe("redeemed");
    expect(mod.parseActivityFilter("'; drop table")).toBe("all");
    expect(mod.parseActivityFilter(null)).toBe("all");
  });

  it("describes each kind of row in plain words", async () => {
    const { mod } = await load({});
    const d = mod.describeActivity;
    expect(d({ kind: "pending", action: "purchase", points: 4250, order_name: "#1042" }))
      .toMatchObject({ title: "Order #1042 waiting", pointsLabel: "Pending 4,250" });
    expect(d({ kind: "tier", action: "gold", reason_note: "silver" })).toMatchObject({ title: "Moved to Gold", detail: "From Silver", pointsLabel: "Tier" });
    expect(d({ kind: "code", action: "birthday", discount_pkr: 500, code: "BDAY-1" }))
      .toMatchObject({ title: "Birthday reward issued", detail: "Rs.500 off · BDAY-1", pointsLabel: "Code" });
    expect(d({ kind: "code", action: "tier_gold", discount_pkr: 0, code: "FS-1" }).detail).toBe("Free shipping · FS-1");
    expect(d({ kind: "points", action: "order_cancelled", order_id: "999" }).title).toBe("Order #999 cancelled, points reversed");
    expect(d({ kind: "points", action: "referral_earned" }).title).toBe("Referral completed");
    expect(d({ kind: "points", action: "redemption_return" }).title).toBe("Reward code cancelled, points returned");
    expect(d({ kind: "points", action: "social_instagram" }).title).toBe("Followed on Instagram");
    expect(d({ kind: "points", action: "import" }).title).toBe("Balance brought over from Smile");
    expect(d({ kind: "points", action: "something_new" }).title).toBe("something_new");
  });

  it("shows the internal reason and the customer note on an adjustment, labelled", async () => {
    const { mod } = await load({});
    const a = mod.describeActivity({ kind: "points", action: "adjustment", reason_note: "goodwill for late parcel", customer_note: "Sorry for the delay" });
    expect(a.title).toBe("Balance adjusted by staff");
    expect(a.detail).toBe("Reason: goodwill for late parcel · Customer sees: Sorry for the delay");
  });
});
