import { describe, it, expect, vi, beforeEach } from "vitest";

// Each table gets its own queue of results; every chain method returns the
// same thenable so any call order used by the module resolves to that result.
const h = vi.hoisted(() => {
  const results: Record<string, Array<{ data?: unknown; error?: unknown; count?: number | null }>> = {};
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const result = (results[table] ?? []).shift() ?? { data: [], error: null, count: 0 };
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gt", "not", "or", "order", "limit", "range"]) {
      c[m] = (...args: unknown[]) => {
        calls.push({ table, method: m, args });
        return c;
      };
    }
    c.maybeSingle = async () => result;
    c.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
    return c;
  };
  return { results, calls, from };
});
vi.mock("../db.server", () => ({ db: { from: h.from } }));

import {
  buildInfluencer,
  buildReferralLink,
  computeNextExpiry,
  getCustomerPayload,
  getPointsHistory,
  getReferralSummary,
  historyLabel,
  isValidBirthday,
  parseHistoryFilter,
  publicReferralOutcome,
  publicReferralStatus,
  SOCIAL_AWARD_DELAY_HOURS,
  type MemberRow,
} from "./widget-data.server";

const NOW = new Date("2026-11-16T10:00:00Z");
const MEMBER: MemberRow = {
  id: "m1",
  shopify_customer_id: "42",
  email: null,
  first_name: "Aisha",
  tier: "silver",
  points_balance: 4500,
  lifetime_spend_pkr: "20000.50",
  referral_slug: "aisha-1234",
  birthday_month: null,
  birthday_day: null,
  birthday_set_at: null,
  is_influencer: false,
  influencer_paused: false,
  influencer_multiplier: null,
  influencer_referral_rate: null,
  influencer_rate_starts_at: null,
  influencer_rate_ends_at: null,
  is_blocked: false,
  opted_out: false,
};

beforeEach(() => {
  for (const k of Object.keys(h.results)) delete h.results[k];
  h.calls.length = 0;
});

describe("pure helpers", () => {
  it("isValidBirthday accepts real day/month pairs only (29 Feb allowed)", () => {
    expect(isValidBirthday(2, 29)).toBe(true);
    expect(isValidBirthday(12, 31)).toBe(true);
    expect(isValidBirthday(2, 30)).toBe(false);
    expect(isValidBirthday(4, 31)).toBe(false);
    expect(isValidBirthday(0, 1)).toBe(false);
    expect(isValidBirthday(13, 1)).toBe(false);
    expect(isValidBirthday(1, 0)).toBe(false);
    expect(isValidBirthday(1.5, 1)).toBe(false);
    expect(isValidBirthday(NaN, 1)).toBe(false);
  });

  it("the social award delay is one shared constant", () => {
    expect(SOCIAL_AWARD_DELAY_HOURS).toBe(24);
  });

  it("labels every ledger type in the contract, with a safe fallback", () => {
    const types = ["signup", "purchase", "social_youtube", "social_facebook", "social_instagram", "review", "referral_earned", "referral_bonus", "redemption", "expiry", "adjustment", "birthday", "campaign_bonus", "refund_deduction", "order_cancelled", "referral_reversal", "redemption_return", "tier_reward", "influencer_sale", "import"];
    for (const t of types) {
      expect(historyLabel(t)).not.toBe("Points update");
      expect(historyLabel(t)).not.toContain("_");
    }
    expect(historyLabel("something_new")).toBe("Points update");
  });

  it("whitelists history filters", () => {
    expect(parseHistoryFilter("referral")).toBe("referral");
    expect(parseHistoryFilter("purchase")).toBe("all");
    expect(parseHistoryFilter(null)).toBe("all");
  });

  it("builds the referral link without a hard-coded domain", () => {
    expect(buildReferralLink("aisha-1234", undefined)).toBe("/?ref=aisha-1234");
    expect(buildReferralLink("aisha-1234", "https://shop.example/")).toBe("https://shop.example/?ref=aisha-1234");
    expect(buildReferralLink("aisha-1234", "javascript:alert(1)")).toBe("/?ref=aisha-1234");
    expect(buildReferralLink(null, "https://shop.example")).toBe("");
  });

  it("next expiry sums what lapses on the earliest Karachi day", () => {
    const rows = [
      { points_remaining: 300, expires_at: "2026-12-01T20:00:00Z" }, // 2 Dec in Karachi
      { points_remaining: 500, expires_at: "2026-12-01T10:00:00Z" }, // 1 Dec
      { points_remaining: 200, expires_at: "2026-12-01T18:30:00Z" }, // 1 Dec 23:30
      { points_remaining: 0, expires_at: "2026-11-20T00:00:00Z" },
      { points_remaining: 900, expires_at: "2026-11-01T00:00:00Z" }, // already past
      { points_remaining: 50, expires_at: null },
    ];
    expect(computeNextExpiry(rows, NOW)).toEqual({ points: 700, at: "2026-12-01T10:00:00Z" });
    expect(computeNextExpiry([], NOW)).toBeNull();
  });

  it("hides internal referral statuses", () => {
    expect(publicReferralStatus("flagged")).toBe("pending");
    expect(publicReferralStatus("completed")).toBe("completed");
    expect(publicReferralStatus("blocked")).toBe("not_eligible");
    expect(publicReferralStatus("rejected")).toBe("not_eligible");
  });
});

describe("getCustomerPayload", () => {
  it("assembles the contract payload", async () => {
    h.results.loyalty_codes = [{ data: [{ id: "c1", code: "REWARD-AB12", kind: null, discount_amount_pkr: "250.00", expires_at: "2026-12-10T00:00:00Z" }], error: null }];
    h.results.social_actions = [{ data: [{ action_type: "facebook" }], error: null }];
    h.results.order_webhook_state = [
      {
        data: [
          { pending_points: 1200, points_awarded: false, cancelled_at: null },
          { pending_points: 800, points_awarded: false, cancelled_at: "2026-11-01T00:00:00Z" }, // cancelled: not pending
          { pending_points: 0, points_awarded: true, cancelled_at: null },
          { pending_points: 0, points_awarded: true, cancelled_at: null },
        ],
        error: null,
      },
    ];
    h.results.review_claims = [{ data: [{ status: "pending" }, { status: "rejected" }], error: null }];
    h.results.points_ledger = [{ data: [{ points_remaining: 400, expires_at: "2026-12-01T10:00:00Z" }], error: null }];

    const p = await getCustomerPayload(MEMBER, NOW);
    expect(p.member).toEqual({
      firstName: "Aisha",
      tier: "silver",
      pointsBalance: 4500,
      pendingPoints: 1200,
      lifetimeSpendPkr: 20000,
      referralLink: "/?ref=aisha-1234",
      birthday: null,
      canSetBirthday: true,
      isInfluencer: false,
      optedOut: false,
      blocked: false,
    });
    expect(p.codes).toEqual([{ id: "c1", code: "REWARD-AB12", kind: "reward", discountPkr: 250, expiresAt: "2026-12-10T00:00:00Z" }]);
    expect(p.social).toEqual({ instagram: "available", facebook: "claimed", youtube: "available" });
    expect(p.review).toEqual({ eligible: true, pending: 1 }); // 2 awarded orders > 1 live claim
    expect(p.nextExpiry).toEqual({ points: 400, at: "2026-12-01T10:00:00Z" });
  });

  it("locks birthday entry once set, and blocked or opted-out members cannot act", async () => {
    const set = await getCustomerPayload({ ...MEMBER, birthday_month: 3, birthday_day: 12, birthday_set_at: "2026-01-01T00:00:00Z" }, NOW);
    expect(set.member.birthday).toEqual({ month: 3, day: 12 });
    expect(set.member.canSetBirthday).toBe(false);

    h.results.order_webhook_state = [{ data: [{ pending_points: 0, points_awarded: true, cancelled_at: null }], error: null }];
    const blocked = await getCustomerPayload({ ...MEMBER, is_blocked: true }, NOW);
    expect(blocked.member.blocked).toBe(true);
    expect(blocked.member.canSetBirthday).toBe(false);
    expect(blocked.review.eligible).toBe(false);

    const out = await getCustomerPayload({ ...MEMBER, opted_out: true, tier: "platinum" }, NOW);
    expect(out.member.optedOut).toBe(true);
    expect(out.member.tier).toBe("silver");
  });

  it("throws when a query fails, so the route answers 500 instead of wrong data", async () => {
    h.results.loyalty_codes = [{ data: null, error: { message: "boom" } }];
    await expect(getCustomerPayload(MEMBER, NOW)).rejects.toThrow("customer_payload_failed: boom");
  });
});

describe("getPointsHistory", () => {
  it("returns labelled rows with the customer note only", async () => {
    h.results.points_ledger = [
      { data: [{ id: "l1", action_type: "referral_earned", points: 6000, earned_at: "2026-11-01T00:00:00Z", customer_note: null }, { id: "l2", action_type: "adjustment", points: -100, earned_at: "2026-10-01T00:00:00Z", customer_note: "Goodwill" }], count: 45, error: null },
    ];
    const r = await getPointsHistory("m1", 2, "all");
    expect(r).toEqual({
      rows: [
        { id: "l1", type: "referral_earned", label: "Friend referred", points: 6000, at: "2026-11-01T00:00:00Z", note: null },
        { id: "l2", type: "adjustment", label: "Points adjustment", points: -100, at: "2026-10-01T00:00:00Z", note: "Goodwill" },
      ],
      page: 2,
      total: 45,
      hasMore: true,
    });
    const select = h.calls.find((c) => c.table === "points_ledger" && c.method === "select")!;
    expect(String(select.args[0])).toContain("customer_note");
    expect(String(select.args[0])).not.toContain("reason_note");
    expect(h.calls.find((c) => c.method === "range")!.args).toEqual([20, 39]);
  });

  it("the referral filter matches the real ledger types", async () => {
    await getPointsHistory("m1", 1, "referral");
    const inCall = h.calls.find((c) => c.method === "in")!;
    expect(inCall.args[0]).toBe("action_type");
    expect(inCall.args[1]).toEqual(expect.arrayContaining(["referral_earned", "referral_bonus"]));
    h.calls.length = 0;
    await getPointsHistory("m1", NaN, "earned");
    expect(h.calls.find((c) => c.method === "gt")!.args).toEqual(["points", 0]);
    expect(h.calls.find((c) => c.method === "range")!.args).toEqual([0, 19]);
  });
});

describe("getReferralSummary", () => {
  it("counts, sums ledger points and maps statuses", async () => {
    h.results.referrals = [
      { data: [{ status: "flagged", created_at: "2026-11-02T00:00:00Z" }, { status: "completed", created_at: "2026-11-01T00:00:00Z" }], count: 2, error: null },
      { data: null, count: 1, error: null },
    ];
    h.results.points_ledger = [{ data: [{ points: 6000 }, { points: 6000 }, { points: -6000 }], error: null }];
    expect(await getReferralSummary("m1")).toEqual({
      total: 2,
      completed: 1,
      pointsEarned: 6000,
      rows: [
        { status: "pending", at: "2026-11-02T00:00:00Z" },
        { status: "completed", at: "2026-11-01T00:00:00Z" },
      ],
    });
  });
});

describe("review fixes: read models", () => {
  it("item 3: influencer block only for influencers, with code, percent and her reward", async () => {
    expect(buildInfluencer(MEMBER, 9000)).toBeNull();
    const inf = { ...MEMBER, is_influencer: true, influencer_code: " SARA10 ", influencer_code_percent: 10 };
    expect(buildInfluencer(inf, 9000.4)).toEqual({ code: "SARA10", percent: 10, rewardPoints: 9000 });
    expect(buildInfluencer({ ...inf, influencer_code: null }, 9000)).toEqual({ code: null, percent: null, rewardPoints: 9000 });
    const p = await getCustomerPayload(inf, NOW, 9000);
    expect(p.member.isInfluencer).toBe(true);
    expect(p.influencer).toEqual({ code: "SARA10", percent: 10, rewardPoints: 9000 });
    expect((await getCustomerPayload(MEMBER, NOW, 9000)).influencer).toBeNull();
  });

  it("item 9: referral outcomes are public statuses only", () => {
    // recorded: looks the same whether pending, held for review or fraud-blocked
    expect(publicReferralOutcome({ ok: true, recorded: true, blocked: false, status: "pending", friendCode: "FRIEND-1" })).toEqual({ ok: true, status: "recorded", friendCode: "FRIEND-1" });
    expect(publicReferralOutcome({ ok: true, recorded: true, blocked: false, status: "flagged", reason: "same_ip" })).toEqual({ ok: true, status: "recorded" });
    expect(publicReferralOutcome({ ok: false, recorded: true, blocked: true, status: "blocked", reason: "self_referral", friendCode: "X" })).toEqual({ ok: true, status: "recorded" });
    expect(publicReferralOutcome({ ok: false, recorded: false, blocked: false, status: "already_referred", reason: "duplicate" })).toEqual({ ok: true, status: "recorded" });
    // final refusals
    for (const status of ["not_eligible", "already_referred", "self_referral", "invalid_slug", "disabled"]) {
      expect(publicReferralOutcome({ ok: false, recorded: false, blocked: false, status, reason: "has_orders" })).toEqual({ ok: false, status: "not_eligible" });
    }
    // temporary
    expect(publicReferralOutcome({ ok: false, recorded: false, blocked: false, status: "try_again", reason: "order_count_unavailable" })).toEqual({ ok: false, status: "try_again" });
    expect(publicReferralOutcome({ ok: false, recorded: false, blocked: false, status: "not_a_member" })).toEqual({ ok: false, status: "try_again" });
    expect(publicReferralOutcome(null)).toEqual({ ok: false, status: "try_again" });
    // nothing internal survives
    for (const r of [{ recorded: true, status: "flagged", reason: "same_ip" }, { status: "not_eligible", reason: "referrer_not_eligible" }]) {
      expect(JSON.stringify(publicReferralOutcome(r))).not.toMatch(/flagged|blocked|same_ip|referrer|reason/);
    }
  });
});
