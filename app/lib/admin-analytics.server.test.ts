import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./admin-test-helpers";
import { periodRange } from "../components/karachi";

beforeEach(() => {
  vi.resetModules();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("./referrals.service", () => ({ approveReferral: vi.fn(), rejectReferral: vi.fn() }));
  vi.doMock("./influencer.service", () => ({ effectiveReferralPoints: (_m: unknown, standard: number) => standard }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache: vi.fn() }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig: vi.fn() }));
  const mod = await import("./admin-analytics.server");
  return { fake, mod };
}

describe("top members", () => {
  it("asks the database for the top earners or redeemers of the period", async () => {
    const { fake, mod } = await load({ rpc: () => ({ data: [{ member_id: "m1", name: "Sara", email: null, points: "12000" }] }) });
    expect(await mod.getTopMembers("f", "t", "redeemed", 5)).toEqual([{ memberId: "m1", name: "Sara", email: null, points: 12000 }]);
    expect(fake.rpcCalls("admin_top_members")[0].args).toEqual({ p_from: "f", p_to: "t", p_kind: "redeemed", p_limit: 5 });
    expect(fake.db.from).not.toHaveBeenCalled();
  });
});

describe("outstanding points", () => {
  it("values them at the base rate, which is the lowest reward", async () => {
    const { mod } = await load();
    const o = mod.outstandingFrom(600000, 420, [{ points: 6000, discount_pkr: 250 }, { points: 3000, discount_pkr: 100 }]);
    expect(o).toEqual({ points: 600000, members: 420, baseTier: { points: 3000, discount_pkr: 100 }, valuePkr: 20000 });
  });

  it("gives no rupee value when there are no rewards", async () => {
    const { mod } = await load();
    expect(mod.outstandingFrom(600000, 420, [])).toMatchObject({ baseTier: null, valuePkr: 0 });
  });

  it("reads the total from the database and the reward table from settings", async () => {
    const { mod } = await load({
      rpc: () => ({ data: { points: 9000, members: 3 } }),
      from: () => ({ data: { redemption_tiers: [{ points: 3000, discount_pkr: 100 }], whatsapp_api_key: "secret" } }),
    });
    expect(await mod.getOutstanding()).toMatchObject({ points: 9000, members: 3, valuePkr: 300 });
  });
});

describe("getAnalytics", () => {
  it("gathers the period, the previous period and the comparisons without reading whole tables", async () => {
    const period = periodRange("30d", new Date("2026-11-16T10:00:00Z"));
    const { fake, mod } = await load({
      rpc: (name, args) => {
        if (name === "admin_period_stats") {
          return { data: args.p_from === period.from ? { points_earned: 1000, points_redeemed: 250 } : { points_earned: 800, points_redeemed: 80 } };
        }
        if (name === "admin_points_series") return { data: [{ day: "2026-11-16", earned: 1000, redeemed: 250, expired: 0 }] };
        if (name === "admin_outstanding_points") return { data: { points: 30000, members: 10 } };
        if (name === "admin_top_members") return { data: [] };
        if (name === "admin_referral_funnel") return { data: { recorded: 10, completed: 4 } };
        if (name === "admin_influencer_stats") return { data: [{ member_id: "i2", sales_pkr: 9000, completed: 1 }, { member_id: "i1", sales_pkr: 500, completed: 3 }] };
        return {};
      },
      from: (t) => (t === "app_settings"
        ? { data: { referral_points: 6000, redemption_tiers: [{ points: 3000, discount_pkr: 100 }] } }
        : { data: [{ id: "i1", first_name: "A", is_influencer: true }, { id: "i2", first_name: "B", is_influencer: true }] }),
    });
    const a = await mod.getAnalytics(period);
    expect(a.stats.redemptionRate).toBe(0.25);
    expect(a.previous.redemptionRate).toBe(0.1);
    expect(a.outstanding.valuePkr).toBe(1000);
    expect(a.funnel).toMatchObject({ recorded: 10, completed: 4 });
    expect(a.influencers.map((i) => i.id)).toEqual(["i2", "i1"]); // by sales
    expect(a.standardReferralPoints).toBe(6000);
    const stats = fake.rpcCalls("admin_period_stats").map((c) => c.args);
    expect(stats).toContainEqual({ p_from: period.from, p_to: period.to });
    expect(stats).toContainEqual({ p_from: period.prevFrom, p_to: period.prevTo });
    // only settings and the (small) influencer list are read as rows
    expect([...new Set(fake.calls.filter((c) => c.table).map((c) => c.table))].sort()).toEqual(["app_settings", "members"]);
  });
});
