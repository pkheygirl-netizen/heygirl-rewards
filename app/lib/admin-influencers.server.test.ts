import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, formOf } from "./admin-test-helpers";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

// Same rule as contract section 1, rule 11, so list rows can be checked end to end.
function effectiveReferralPoints(
  m: { is_influencer: boolean; influencer_paused: boolean; influencer_multiplier: number | null; influencer_referral_rate: number | null; influencer_rate_starts_at: string | null; influencer_rate_ends_at: string | null },
  standard: number, at: Date = new Date(),
): number {
  if (!m.is_influencer || m.influencer_paused) return standard;
  if (m.influencer_rate_starts_at && at < new Date(m.influencer_rate_starts_at)) return standard;
  if (m.influencer_rate_ends_at && at >= new Date(m.influencer_rate_ends_at)) return standard;
  if (m.influencer_multiplier !== null) return Math.round(standard * m.influencer_multiplier);
  return m.influencer_referral_rate ?? standard;
}

const setInfluencer = vi.fn();
const removeInfluencerCode = vi.fn();

beforeEach(() => {
  vi.resetModules();
  setInfluencer.mockReset();
  removeInfluencerCode.mockReset();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("./influencer.service", () => ({ effectiveReferralPoints, setInfluencer, removeInfluencerCode }));
  const mod = await import("./admin-influencers.server");
  return { fake, mod };
}

const member = (over: Record<string, unknown>) => ({
  id: A, first_name: "Sana", last_name: "A", email: "sana@x.com", phone: null, referral_slug: "sana",
  is_influencer: true, influencer_paused: false, influencer_multiplier: "2.00", influencer_referral_rate: null,
  influencer_campaign: "Winter Glow", influencer_rate_starts_at: null, influencer_rate_ends_at: null,
  influencer_code: "SANA10", influencer_code_percent: 10, ...over,
});
const stat = (over: Record<string, unknown>) => ({
  member_id: A, friends: 54, completed: 27, pending: 20, held: 1, orders: 30, sales_pkr: "181000.00", code_orders: 3, points_paid: 270000, ...over,
});

describe("listInfluencers", () => {
  const now = new Date("2026-11-16T10:00:00Z");
  const script = {
    from: () => ({ data: [member({}), member({ id: B, first_name: "Hira", influencer_multiplier: null, influencer_campaign: null, influencer_paused: true, influencer_code: null, influencer_code_percent: null })] }),
    rpc: () => ({ data: [stat({})] }),
  };

  it("joins each influencer with her results and her current points per referral", async () => {
    const { fake, mod } = await load(script);
    const res = await mod.listInfluencers({ standardPoints: 6000, now, from: "f", to: "t" });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      name: "Sana A", campaign: "Winter Glow", multiplier: 2, pointsPerReferral: 12000, rateActive: true,
      code: "SANA10", codePercent: 10, friends: 54, completed: 27, orders: 30, codeOrders: 3, salesPkr: 181000, pointsPaid: 270000,
    });
    // no stats row and paused: zeros and the standard reward
    expect(res.rows[1]).toMatchObject({ name: "Hira A", pointsPerReferral: 6000, rateActive: false, paused: true, friends: 0, salesPkr: 0 });
    expect(res.campaigns).toEqual(["Winter Glow"]);
    expect(fake.rpcCalls("admin_influencer_stats")[0].args).toEqual({ p_from: "f", p_to: "t" });
    expect(fake.tableCalls("members")[0].chain).toContainEqual(["eq", ["is_influencer", true]]);
  });

  it("filters by campaign label, with 'none' meaning no label, and keeps the full label list", async () => {
    const { mod } = await load(script);
    const winter = await mod.listInfluencers({ standardPoints: 6000, now, campaign: "Winter Glow" });
    expect(winter.rows.map((r) => r.id)).toEqual([A]);
    const none = await mod.listInfluencers({ standardPoints: 6000, now, campaign: "none" });
    expect(none.rows.map((r) => r.id)).toEqual([B]);
    expect(none.campaigns).toEqual(["Winter Glow"]);
  });

  it("a rate outside its dates falls back to the standard reward", async () => {
    const { mod } = await load({
      from: () => ({ data: [member({ influencer_rate_ends_at: "2026-11-01T19:00:00Z" })] }),
      rpc: () => ({ data: [] }),
    });
    const res = await mod.listInfluencers({ standardPoints: 6000, now });
    expect(res.rows[0]).toMatchObject({ pointsPerReferral: 6000, rateActive: false, multiplier: 2 });
  });

  it("totals the visible rows", async () => {
    const { mod } = await load(script);
    const { rows } = await mod.listInfluencers({ standardPoints: 6000, now });
    expect(mod.totalsOf(rows)).toEqual({
      active: 1, paused: 1, friends: 54, completed: 27, orders: 30, salesPkr: 181000, pointsPaid: 270000, averagePerCompleted: 10000,
    });
    expect(mod.totalsOf([]).averagePerCompleted).toBe(0);
  });
});

describe("referral stage", () => {
  it("puts each of her referrals in words", async () => {
    const { mod } = await load();
    const s = mod.referralStage;
    expect(s({ status: "completed" }, null)).toBe("Order delivered and paid");
    expect(s({ status: "flagged" }, null)).toBe("Held for review");
    expect(s({ status: "pending" }, null)).toBe("Signed in, no order yet");
    expect(s({ status: "pending" }, { fulfilled: true, paid: false })).toBe("Order delivered, awaiting payment");
    expect(s({ status: "pending" }, { fulfilled: false, paid: false })).toBe("Order placed, not delivered yet");
    expect(s({ status: "rejected" }, null)).toBe("Rejected");
  });
});

describe("getInfluencerDetail", () => {
  it("returns null for a bad id or a member who is not an influencer", async () => {
    const bad = await load();
    expect(await bad.mod.getInfluencerDetail("nope", { standardPoints: 6000 })).toBeNull();
    expect(bad.fake.calls).toHaveLength(0);
    const { mod } = await load({ from: (t) => (t === "members" ? { data: member({ is_influencer: false }) } : { data: [], count: 0 }), rpc: () => ({ data: [] }) });
    expect(await mod.getInfluencerDetail(A, { standardPoints: 6000 })).toBeNull();
  });

  it("lists her referrals with a stage worked out from the friend's first order", async () => {
    const { fake, mod } = await load({
      from: (t) => {
        if (t === "members") return { data: member({}) };
        if (t === "referrals") {
          return {
            count: 3,
            data: [
              { id: "r1", referred_email: "e@x.com", referred_shopify_customer_id: "C1", status: "completed", reward_points: 12000, created_at: "t1" },
              { id: "r2", referred_email: null, referred_shopify_customer_id: "C2", status: "pending", reward_points: null, created_at: "t2" },
              { id: "r3", referred_email: "g@x.com", referred_shopify_customer_id: "C3", status: "pending", reward_points: null, created_at: "t3" },
            ],
          };
        }
        return { data: [{ shopify_customer_id: "C2", fulfillment_status: "fulfilled", financial_status: "pending", created_at: "t" }] };
      },
      rpc: () => ({ data: [stat({})] }),
    });
    const d = await mod.getInfluencerDetail(A, { standardPoints: 6000, page: 0, pageSize: 25, now: new Date("2026-11-16T10:00:00Z") });
    expect(d!.row.pointsPerReferral).toBe(12000);
    expect(d!.referralsTotal).toBe(3);
    expect(d!.referrals.map((r) => r.stage)).toEqual([
      "Order delivered and paid", "Order delivered, awaiting payment", "Signed in, no order yet",
    ]);
    expect(d!.referrals[1].friend).toBe("Customer C2");
    // orders are looked up only for friends still pending, never the whole table
    const orders = fake.tableCalls("order_webhook_state")[0].chain;
    expect(orders).toContainEqual(["in", ["shopify_customer_id", ["C2", "C3"]]]);
  });
});

describe("influencerState (A5)", () => {
  it("reads whether she is an influencer now and whether she holds a code", async () => {
    const { fake, mod } = await load({ from: () => ({ data: { id: A, is_influencer: true, influencer_code: "SANA10" } }) });
    expect(await mod.influencerState(A)).toEqual({ isInfluencer: true, code: "SANA10" });
    expect(fake.tableCalls("members")[0].chain).toContainEqual(["eq", ["id", A]]);
    const former = await load({ from: () => ({ data: { id: A, is_influencer: false, influencer_code: null } }) });
    expect(await former.mod.influencerState(A)).toEqual({ isInfluencer: false, code: null });
  });

  it("is null for an unknown member or a malformed id", async () => {
    const { fake, mod } = await load({ from: () => ({ data: null }) });
    expect(await mod.influencerState(A)).toBeNull();
    expect(await mod.influencerState("x' or 1=1")).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });
});

describe("removeInfluencerStatus (A1)", () => {
  const SHOP = "heygirl-pk.myshopify.com";
  const withCode = { from: () => ({ data: { id: A, is_influencer: true, influencer_code: "SANA10" } }) };

  it("deletes her Shopify code first, then removes the status", async () => {
    const { mod } = await load(withCode);
    const order: string[] = [];
    removeInfluencerCode.mockImplementation(async () => { order.push("code"); return { ok: true }; });
    setInfluencer.mockImplementation(async () => { order.push("status"); return { ok: true }; });
    expect(await mod.removeInfluencerStatus(A, SHOP)).toEqual({ ok: true, codeRemoved: "SANA10" });
    expect(order).toEqual(["code", "status"]);
    expect(removeInfluencerCode).toHaveBeenCalledWith({ memberId: A, shop: SHOP });
    expect(setInfluencer).toHaveBeenCalledWith(A, { isInfluencer: false });
  });

  it("when Shopify cannot delete the code she stays an influencer: the status is not touched", async () => {
    const { mod } = await load(withCode);
    removeInfluencerCode.mockResolvedValueOnce({ ok: false, reason: "shopify_unavailable" });
    expect(await mod.removeInfluencerStatus(A, SHOP)).toEqual({ ok: false, reason: "shopify_unavailable", stage: "code" });
    expect(setInfluencer).not.toHaveBeenCalled();
  });

  it("a code that is already gone does not block the removal", async () => {
    const { mod } = await load(withCode);
    removeInfluencerCode.mockResolvedValueOnce({ ok: false, reason: "no_code" });
    setInfluencer.mockResolvedValueOnce({ ok: true });
    expect((await mod.removeInfluencerStatus(A, SHOP)).ok).toBe(true);
  });

  it("with no code it only removes the status, and reports a status failure", async () => {
    const { mod } = await load({ from: () => ({ data: { id: A, is_influencer: true, influencer_code: null } }) });
    setInfluencer.mockResolvedValueOnce({ ok: true });
    expect(await mod.removeInfluencerStatus(A, SHOP)).toEqual({ ok: true, codeRemoved: null });
    expect(removeInfluencerCode).not.toHaveBeenCalled();
    setInfluencer.mockResolvedValueOnce({ ok: false, reason: "db_error" });
    expect(await mod.removeInfluencerStatus(A, SHOP)).toEqual({ ok: false, reason: "db_error", stage: "status" });
  });

  it("an unknown member changes nothing", async () => {
    const { mod } = await load({ from: () => ({ data: null }) });
    expect(await mod.removeInfluencerStatus(A, SHOP)).toEqual({ ok: false, reason: "member_not_found", stage: "lookup" });
    expect(removeInfluencerCode).not.toHaveBeenCalled();
    expect(setInfluencer).not.toHaveBeenCalled();
  });
});

describe("rate form", () => {
  it("accepts presets, standard and a custom multiplier", async () => {
    const { mod } = await load();
    const preset = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "1.5", campaign: " Winter Glow " }));
    expect(preset).toEqual({ ok: true, value: { multiplier: 1.5, campaign: "Winter Glow", rateStartsAt: null, rateEndsAt: null } });
    const standard = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "standard" }));
    expect(standard.ok && standard.value.multiplier).toBeNull();
    const custom = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "custom", multiplier_custom: "2.25" }));
    expect(custom.ok && custom.value.multiplier).toBe(2.25);
  });

  it("rejects a blank, tiny, huge or over-precise custom multiplier and an unknown choice", async () => {
    const { mod } = await load();
    for (const v of ["", "0.5", "10.5", "2.255", "two"]) {
      expect(mod.parseInfluencerRateForm(formOf({ multiplier_choice: "custom", multiplier_custom: v })).ok, v).toBe(false);
    }
    expect(mod.parseInfluencerRateForm(formOf({ multiplier_choice: "7" })).ok).toBe(false);
    expect(mod.parseInfluencerRateForm(formOf({})).ok).toBe(false);
  });

  it("reads rate dates as Karachi days: start of the first, end of the last", async () => {
    const { mod } = await load();
    const res = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "2", rate_starts: "2026-12-01", rate_ends: "2026-12-31" }));
    expect(res.ok && res.value).toMatchObject({ rateStartsAt: "2026-11-30T19:00:00.000Z", rateEndsAt: "2026-12-31T19:00:00.000Z" });
    const sameDay = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "2", rate_starts: "2026-12-01", rate_ends: "2026-12-01" }));
    expect(sameDay.ok).toBe(true);
    const backwards = mod.parseInfluencerRateForm(formOf({ multiplier_choice: "2", rate_starts: "2026-12-10", rate_ends: "2026-12-01" }));
    expect(!backwards.ok && backwards.errors.rate_ends).toContain("on or after the start");
    expect(mod.parseInfluencerRateForm(formOf({ multiplier_choice: "2", rate_starts: "next week" })).ok).toBe(false);
    expect(mod.parseInfluencerRateForm(formOf({ multiplier_choice: "2", campaign: "x".repeat(61) })).ok).toBe(false);
  });
});

describe("discount code form", () => {
  it("upper-cases the code and validates the percent", async () => {
    const { mod } = await load();
    expect(mod.parseInfluencerCodeForm(formOf({ code: " sana10 ", percent_off: "10" }))).toEqual({ ok: true, value: { code: "SANA10", percentOff: 10 } });
    for (const code of ["", "AB", "SANA 10", "SANA%10", "-SANA", "X".repeat(33)]) {
      expect(mod.parseInfluencerCodeForm(formOf({ code, percent_off: "10" })).ok, code).toBe(false);
    }
    for (const p of ["", "0", "91", "12.5"]) {
      expect(mod.parseInfluencerCodeForm(formOf({ code: "SANA10", percent_off: p })).ok, p).toBe(false);
    }
  });
});

describe("export rows", () => {
  it("writes one row per influencer with her link", async () => {
    const { mod } = await load({ from: () => ({ data: [member({})] }), rpc: () => ({ data: [stat({})] }) });
    const { rows } = await mod.listInfluencers({ standardPoints: 6000, now: new Date("2026-11-16T10:00:00Z") });
    const out = mod.influencerCsvRows(rows, (slug) => `https://heygirl.pk/?ref=${slug}`);
    expect(out[0]).toMatchObject({ name: "Sana A", status: "Active", multiplier: 2, pointsPerReferral: 12000, code: "SANA10", salesPkr: 181000, link: "https://heygirl.pk/?ref=sana" });
    expect(mod.INFLUENCER_CSV_COLUMNS.every((c) => c.key in out[0])).toBe(true);
  });
});
