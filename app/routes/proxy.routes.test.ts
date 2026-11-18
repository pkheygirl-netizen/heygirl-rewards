// Unit tests for every storefront proxy route (contract section 4).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { args, signedRequest, TEST_SECRET, TEST_SHOP } from "./proxy.test-helpers";

process.env.SHOPIFY_API_SECRET = TEST_SECRET;

const h = vi.hoisted(() => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "eq", "insert", "delete"]) c[m] = vi.fn(() => c);
    c.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    c.single = vi.fn(async () => ({ data: { id: "sa1" }, error: null }));
    return c as Record<string, ReturnType<typeof vi.fn>>;
  };
  return {
    social: chain(),
    getSettings: vi.fn(),
    enrolFromSignin: vi.fn(),
    setBirthday: vi.fn(),
    redeemPoints: vi.fn(),
    claimReview: vi.fn(),
    recordReferralVisit: vi.fn(),
    effectiveReferralPoints: vi.fn(),
    getMemberByCustomerId: vi.fn(),
    getCustomerPayload: vi.fn(),
    getPointsHistory: vi.fn(),
    getReferralSummary: vi.fn(),
    publicReferralOutcome: vi.fn(),
    queueAdd: vi.fn(),
  };
});

vi.mock("../db.server", () => ({ db: { from: vi.fn(() => h.social) } }));
vi.mock("../lib/settings.server", () => ({ getSettings: h.getSettings }));
vi.mock("../lib/points.service", () => ({ enrolFromSignin: h.enrolFromSignin, setBirthday: h.setBirthday }));
vi.mock("../lib/redemption.service", () => ({ redeemPoints: h.redeemPoints }));
vi.mock("../lib/review-claims.service", () => ({ claimReview: h.claimReview }));
vi.mock("../lib/referrals.service", () => ({ recordReferralVisit: h.recordReferralVisit }));
vi.mock("../lib/influencer.service", () => ({ effectiveReferralPoints: h.effectiveReferralPoints }));
vi.mock("../lib/queue.server", () => ({ socialQueue: { add: h.queueAdd } }));
vi.mock("../lib/widget-data.server", async (importOriginal) => ({
  // Pure helpers and constants come from the real module.
  SOCIAL_AWARD_DELAY_HOURS: (await importOriginal<typeof import("../lib/widget-data.server")>()).SOCIAL_AWARD_DELAY_HOURS,
  isValidBirthday: (await importOriginal<typeof import("../lib/widget-data.server")>()).isValidBirthday,
  SOCIAL_PLATFORMS: ["instagram", "facebook", "youtube"],
  getMemberByCustomerId: h.getMemberByCustomerId,
  getCustomerPayload: h.getCustomerPayload,
  getPointsHistory: h.getPointsHistory,
  getReferralSummary: h.getReferralSummary,
  publicReferralOutcome: (r: Record<string, unknown>) => h.publicReferralOutcome(r),
  parseHistoryFilter: (v: string | null) => (v === "earned" || v === "redeemed" || v === "referral" || v === "other" ? v : "all"),
}));

import { resetRateLimits } from "../lib/proxy-auth.server";
import { loader as customerLoader } from "./proxy.customer";
import { loader as historyLoader } from "./proxy.history";
import { action as redeemAction } from "./proxy.redeem";
import { action as socialAction } from "./proxy.social";
import { action as reviewAction } from "./proxy.review";
import { action as birthdayAction } from "./proxy.birthday";
import { isValidBirthday, SOCIAL_AWARD_DELAY_HOURS } from "../lib/widget-data.server";
import { action as referralAction, loader as referralLoader } from "./proxy.referral";

const MEMBER = {
  id: "m1",
  shopify_customer_id: "42",
  email: "a@example.com",
  first_name: "Aisha",
  tier: "silver",
  referral_slug: "aisha-1234",
  is_blocked: false,
  opted_out: false,
  is_influencer: false,
};
const SETTINGS = {
  program_enabled: true,
  referral_points: 6000,
  social_points_instagram: 1000,
  social_points_youtube: 1000,
  social_url_instagram: "https://instagram.com/heygirl.pk",
  social_url_facebook: "https://facebook.com/heygirl.pk",
  earn_rules: { instagram: { enabled: true }, facebook: { enabled: false } },
};
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimits();
  h.getSettings.mockResolvedValue(SETTINGS);
  h.getMemberByCustomerId.mockResolvedValue(MEMBER);
  h.enrolFromSignin.mockResolvedValue({ memberId: "m1", welcomeQueued: false });
  h.social.maybeSingle.mockResolvedValue({ data: null, error: null });
  h.social.single.mockResolvedValue({ data: { id: "sa1" }, error: null });
  h.queueAdd.mockResolvedValue(undefined);
  h.publicReferralOutcome.mockImplementation((r: Record<string, unknown>) => (r.recorded ? { ok: true, status: "recorded" } : { ok: false, status: "not_eligible" }));
});

describe("every route: HMAC first, shop from the verified query, no-store", () => {
  const calls: Array<[string, () => Promise<Response>]> = [
    ["customer", () => customerLoader(args(signedRequest("customer", { customerId: "42", tamper: true })))],
    ["history", () => historyLoader(args(signedRequest("history", { customerId: "42", tamper: true })))],
    ["redeem", () => redeemAction(args(signedRequest("redeem", { customerId: "42", tamper: true, body: { points: 3000 } })))],
    ["social", () => socialAction(args(signedRequest("social", { customerId: "42", tamper: true, body: { platform: "instagram" } })))],
    ["review", () => reviewAction(args(signedRequest("review", { customerId: "42", tamper: true, body: {} })))],
    ["birthday", () => birthdayAction(args(signedRequest("birthday", { customerId: "42", tamper: true, body: { month: 3, day: 12 } })))],
    ["referral", () => referralAction(args(signedRequest("referral", { customerId: "42", tamper: true, body: { slug: "sara-9999" } })))],
  ];
  it.each(calls)("%s rejects a tampered signature before touching any data", async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ ok: false, error: "unauthorized" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(h.getSettings).not.toHaveBeenCalled();
    expect(h.getMemberByCustomerId).not.toHaveBeenCalled();
  });

  it("rejects a signed request with no shop, and guests with 403", async () => {
    expect((await customerLoader(args(signedRequest("customer", { customerId: "42", shop: null })))).status).toBe(401);
    const guest = await customerLoader(args(signedRequest("customer", { customerId: null })));
    expect(guest.status).toBe(403);
    expect(await json(guest)).toEqual({ ok: false, error: "not_signed_in" });
    expect(h.enrolFromSignin).not.toHaveBeenCalled();
  });

  it("rate limits per customer and route", async () => {
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) last = await reviewAction(args(signedRequest("review", { customerId: "77", body: {} })));
    expect(last!.status).toBe(429);
    expect(await json(last!)).toEqual({ ok: false, error: "rate_limited" });
    expect(last!.headers.get("Retry-After")).toBeTruthy();
    // another customer is unaffected
    h.claimReview.mockResolvedValue({ ok: true, releaseAt: "2026-11-19T10:00:00Z" });
    expect((await reviewAction(args(signedRequest("review", { customerId: "78", body: {} })))).status).toBe(200);
  });
});

describe("GET /proxy/customer", () => {
  const PAYLOAD = { member: { firstName: "Aisha", optedOut: false, blocked: false }, codes: [], social: {}, review: {}, nextExpiry: null };

  it("enrols on sign-in with the verified shop and forwarded address, then returns the payload", async () => {
    h.getCustomerPayload.mockResolvedValue(PAYLOAD);
    h.enrolFromSignin.mockResolvedValue({ memberId: "m1", welcomeQueued: true });
    const res = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(res.status).toBe(200);
    expect(h.enrolFromSignin).toHaveBeenCalledWith({ shopifyCustomerId: "42", shop: TEST_SHOP, ip: "203.0.113.7" });
    expect(await json(res)).toMatchObject({ enabled: true, member: { firstName: "Aisha" }, welcomeQueued: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("still serves an existing member when enrolment throws", async () => {
    h.enrolFromSignin.mockRejectedValue(new Error("boom"));
    h.getCustomerPayload.mockResolvedValue(PAYLOAD);
    const res = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ member: { firstName: "Aisha" } });
  });

  it("rule 20: with the program switched off the customer is still enrolled and gets her payload", async () => {
    h.getSettings.mockResolvedValue({ ...SETTINGS, program_enabled: false });
    h.getCustomerPayload.mockResolvedValue(PAYLOAD);
    h.enrolFromSignin.mockResolvedValue({ memberId: "m1", welcomeQueued: true });
    const res = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(h.enrolFromSignin).toHaveBeenCalledWith({ shopifyCustomerId: "42", shop: TEST_SHOP, ip: "203.0.113.7" });
    const body = await json(res);
    expect(body).toMatchObject({ enabled: true, member: { firstName: "Aisha" }, welcomeQueued: true });
    expect(body).not.toHaveProperty("state");
  });

  it("returns a clear state for a customer with no member row", async () => {
    h.getMemberByCustomerId.mockResolvedValueOnce(null);
    expect(await json(await customerLoader(args(signedRequest("customer", { customerId: "42" }))))).toEqual({ enabled: true, member: null, state: "not_enrolled" });
  });

  it("opted-out and blocked members get their state inside a 200, not an error", async () => {
    h.getCustomerPayload.mockResolvedValue({ ...PAYLOAD, member: { firstName: "Aisha", optedOut: true, blocked: false } });
    const res = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ member: { optedOut: true } });
  });
});

describe("GET /proxy/history", () => {
  it("passes the member id, page and a whitelisted filter", async () => {
    h.getPointsHistory.mockResolvedValue({ rows: [], page: 2, total: 0, hasMore: false });
    await historyLoader(args(signedRequest("history", { customerId: "42", query: { filter: "referral", page: "2" } })));
    expect(h.getPointsHistory).toHaveBeenCalledWith("m1", 2, "referral");
    await historyLoader(args(signedRequest("history", { customerId: "42", query: { filter: "purchase'; drop" } })));
    expect(h.getPointsHistory).toHaveBeenLastCalledWith("m1", 1, "all");
  });
});

describe("POST /proxy/redeem", () => {
  it("rule 20: refuses while the program is switched off, without calling the engine", async () => {
    h.getSettings.mockResolvedValueOnce({ program_enabled: false });
    const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(await json(res)).toEqual({ ok: false, error: "program_disabled" });
    expect(h.redeemPoints).not.toHaveBeenCalled();
  });

  it("calls redeemPoints with the contract signature and returns the contract shape", async () => {
    h.redeemPoints.mockResolvedValue({ ok: true, code: "REWARD-AB12", discountPkr: 100, expiresAt: "2026-12-16T00:00:00Z" });
    const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(h.redeemPoints).toHaveBeenCalledWith({ memberId: "m1", points: 3000, shop: TEST_SHOP });
    expect(await json(res)).toEqual({ ok: true, code: "REWARD-AB12", discountPkr: 100, expiresAt: "2026-12-16T00:00:00Z" });
  });

  it("maps the service reason onto the single `error` field", async () => {
    h.redeemPoints.mockResolvedValue({ ok: false, reason: "insufficient_points" });
    const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(await json(res)).toEqual({ ok: false, error: "insufficient_points" });
  });

  it("rejects bad input and non-POST", async () => {
    for (const body of [{}, { points: 0 }, { points: 1.5 }, { points: "abc" }, "not json"]) {
      const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body })));
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ ok: false, error: "invalid_points" });
    }
    resetRateLimits(); // the five bad tries above used up this customer's minute
    expect((await redeemAction(args(signedRequest("redeem", { customerId: "42", method: "PUT", body: { points: 3000 } })))).status).toBe(405);
    expect(h.redeemPoints).not.toHaveBeenCalled();
  });

  it("a hidden reward does not exist: refused before the service is called", async () => {
    h.getSettings.mockResolvedValue({ ...SETTINGS, redemption_tiers: [{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }] });
    const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(await json(res)).toEqual({ ok: false, error: "invalid_tier" });
    expect(h.redeemPoints).not.toHaveBeenCalled();
    // A visible reward in the same table still goes through.
    h.redeemPoints.mockResolvedValue({ ok: true, code: "REWARD-CD34", discountPkr: 250, expiresAt: "2026-12-16T00:00:00Z" });
    expect(await json(await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 6000 } }))))).toMatchObject({ ok: true, code: "REWARD-CD34" });
    expect(h.redeemPoints).toHaveBeenCalledTimes(1);
  });

  it("opted-out and blocked members get a clear state and nothing is redeemed", async () => {
    h.getMemberByCustomerId.mockResolvedValueOnce({ ...MEMBER, opted_out: true });
    const a = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(a.status).toBe(200);
    expect(await json(a)).toEqual({ ok: false, error: "opted_out" });
    h.getMemberByCustomerId.mockResolvedValueOnce({ ...MEMBER, is_blocked: true });
    expect(await json(await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } }))))).toEqual({ ok: false, error: "blocked" });
    expect(h.redeemPoints).not.toHaveBeenCalled();
  });
});

describe("POST /proxy/social", () => {
  it("records the claim once, queues the award and returns points from settings", async () => {
    const res = await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } })));
    expect(await json(res)).toEqual({ ok: true, status: "awarded", points: 1000 });
    expect(h.social.insert).toHaveBeenCalledWith(expect.objectContaining({ member_id: "m1", action_type: "instagram", status: "pending" }));
    // Delayed by the one shared constant, and with no fixed job id (the unique
    // social_actions row is the idempotency guard).
    expect(h.queueAdd).toHaveBeenCalledWith("award_social_points", { socialActionId: "sa1" }, { delay: SOCIAL_AWARD_DELAY_HOURS * 60 * 60 * 1000 });
    expect(h.queueAdd.mock.calls[0][2]).not.toHaveProperty("jobId");
  });

  it("a repeat claim is `already_claimed`, not an error", async () => {
    h.social.maybeSingle.mockResolvedValueOnce({ data: { id: "old" }, error: null });
    const res = await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } })));
    expect(await json(res)).toEqual({ ok: true, status: "already_claimed", points: 0 });
    expect(h.queueAdd).not.toHaveBeenCalled();
    h.social.single.mockResolvedValueOnce({ data: null, error: { code: "23505", message: "dup" } });
    expect(await json(await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } }))))).toMatchObject({ status: "already_claimed" });
  });

  it("refuses unknown platforms and rules switched off in the admin", async () => {
    expect((await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "tiktok" } })))).status).toBe(400);
    expect(await json(await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "facebook" } }))))).toEqual({ ok: false, error: "disabled" });
    expect(h.social.insert).not.toHaveBeenCalled();
  });

  it("rolls the row back when the queue is down", async () => {
    h.queueAdd.mockRejectedValueOnce(new Error("redis"));
    const res = await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } })));
    expect(res.status).toBe(503);
    expect(h.social.delete).toHaveBeenCalled();
  });
});

describe("POST /proxy/review", () => {
  it("returns releaseAt, and the service reason as `error`", async () => {
    h.claimReview.mockResolvedValueOnce({ ok: true, releaseAt: "2026-11-19T10:00:00Z" });
    expect(await json(await reviewAction(args(signedRequest("review", { customerId: "42", body: {} }))))).toEqual({ ok: true, releaseAt: "2026-11-19T10:00:00Z" });
    expect(h.claimReview).toHaveBeenCalledWith("m1");
    h.claimReview.mockResolvedValueOnce({ ok: false, reason: "no_eligible_order" });
    expect(await json(await reviewAction(args(signedRequest("review", { customerId: "42", body: {} }))))).toEqual({ ok: false, error: "no_eligible_order" });
  });
});

describe("POST /proxy/birthday", () => {
  it("validates day and month", () => {
    expect(isValidBirthday(2, 29)).toBe(true);
    expect(isValidBirthday(2, 30)).toBe(false);
    expect(isValidBirthday(4, 31)).toBe(false);
    expect(isValidBirthday(13, 1)).toBe(false);
    expect(isValidBirthday(1.5, 1)).toBe(false);
  });

  it("sets it once as the customer, never as admin", async () => {
    h.setBirthday.mockResolvedValueOnce({ ok: true });
    expect(await json(await birthdayAction(args(signedRequest("birthday", { customerId: "42", body: { month: 3, day: 12 } }))))).toEqual({ ok: true });
    expect(h.setBirthday).toHaveBeenCalledWith("m1", 3, 12, { byAdmin: false });
    h.setBirthday.mockResolvedValueOnce({ ok: false, reason: "already_set" });
    expect(await json(await birthdayAction(args(signedRequest("birthday", { customerId: "42", body: { month: 3, day: 12 } }))))).toEqual({ ok: false, error: "already_set" });
    const bad = await birthdayAction(args(signedRequest("birthday", { customerId: "42", body: { month: 2, day: 31 } })));
    expect(bad.status).toBe(400);
    expect(await json(bad)).toEqual({ ok: false, error: "invalid_date" });
  });
});

describe("/proxy/referral", () => {
  it("POST records with server-side email and address, and returns only the public outcome", async () => {
    const raw = { ok: true, recorded: true, blocked: false, status: "pending", friendCode: "FRIEND-XY12" };
    h.recordReferralVisit.mockResolvedValueOnce(raw);
    h.publicReferralOutcome.mockReturnValueOnce({ ok: true, status: "recorded", friendCode: "FRIEND-XY12" });
    const res = await referralAction(args(signedRequest("referral", { customerId: "42", body: { slug: "sara-9999", email: "evil@x.com", ip: "1.1.1.1" } })));
    expect(h.recordReferralVisit).toHaveBeenCalledWith({ referralSlug: "sara-9999", referredShopifyCustomerId: "42", referredEmail: "a@example.com", referredIp: "203.0.113.7", shop: TEST_SHOP });
    expect(h.publicReferralOutcome).toHaveBeenCalledWith(raw);
    expect(await json(res)).toEqual({ ok: true, status: "recorded", friendCode: "FRIEND-XY12" });
  });

  it("POST refuses self-referral and malformed slugs", async () => {
    expect(await json(await referralAction(args(signedRequest("referral", { customerId: "42", body: { slug: "AISHA-1234" } }))))).toEqual({ ok: false, error: "self_referral" });
    expect((await referralAction(args(signedRequest("referral", { customerId: "42", body: { slug: "<script>" } })))).status).toBe(400);
    expect(h.recordReferralVisit).not.toHaveBeenCalled();
  });

  it("GET returns the summary with the influencer-aware reward", async () => {
    h.effectiveReferralPoints.mockReturnValue(9000);
    h.getReferralSummary.mockResolvedValue({ total: 2, completed: 1, pointsEarned: 9000, rows: [] });
    h.getMemberByCustomerId.mockResolvedValueOnce({ ...MEMBER, is_influencer: true, influencer_multiplier: 1.5 });
    const res = await referralLoader(args(signedRequest("referral", { customerId: "42" })));
    expect(await json(res)).toEqual({ ok: true, rewardPoints: 9000, total: 2, completed: 1, pointsEarned: 9000, rows: [] });
    expect(h.effectiveReferralPoints).toHaveBeenCalledWith(expect.objectContaining({ is_influencer: true, influencer_multiplier: 1.5, influencer_paused: false }), 6000);
  });
});

describe("rule 20: with the program switched off only redeeming is refused", () => {
  beforeEach(() => h.getSettings.mockResolvedValue({ ...SETTINGS, program_enabled: false }));

  it("social claims still go through", async () => {
    expect(await json(await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } }))))).toEqual({ ok: true, status: "awarded", points: 1000 });
    expect(h.queueAdd).toHaveBeenCalledTimes(1);
  });

  it("review claims still go through", async () => {
    h.claimReview.mockResolvedValueOnce({ ok: true, releaseAt: "2026-11-19T10:00:00Z" });
    expect(await json(await reviewAction(args(signedRequest("review", { customerId: "42", body: {} }))))).toEqual({ ok: true, releaseAt: "2026-11-19T10:00:00Z" });
    expect(h.claimReview).toHaveBeenCalledWith("m1");
  });

  it("the birthday can still be saved", async () => {
    h.setBirthday.mockResolvedValueOnce({ ok: true });
    expect(await json(await birthdayAction(args(signedRequest("birthday", { customerId: "42", body: { month: 3, day: 12 } }))))).toEqual({ ok: true });
    expect(h.setBirthday).toHaveBeenCalledTimes(1);
  });

  it("a referral is still recorded", async () => {
    h.recordReferralVisit.mockResolvedValueOnce({ ok: true, recorded: true, blocked: false, status: "pending" });
    expect(await json(await referralAction(args(signedRequest("referral", { customerId: "42", body: { slug: "sara-9999" } }))))).toEqual({ ok: true, status: "recorded" });
    expect(h.recordReferralVisit).toHaveBeenCalledTimes(1);
  });

  it("redeeming is refused with program_disabled, before the member lookup and the engine", async () => {
    const res = await redeemAction(args(signedRequest("redeem", { customerId: "42", body: { points: 3000 } })));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: false, error: "program_disabled" });
    expect(h.redeemPoints).not.toHaveBeenCalled();
    expect(h.getMemberByCustomerId).not.toHaveBeenCalled();
  });
});

describe("review fixes: routes", () => {
  const posts: Array<[string, (r: Request) => Promise<Response>]> = [
    ["redeem", (r) => redeemAction(args(r))],
    ["social", (r) => socialAction(args(r))],
    ["review", (r) => reviewAction(args(r))],
    ["birthday", (r) => birthdayAction(args(r))],
    ["referral", (r) => referralAction(args(r))],
  ];
  it.each(posts)("item 8: %s checks the signature before the method", async (name, call) => {
    // Unsigned, wrong method: must be 401, never 405.
    const unsigned = await call(signedRequest(name, { customerId: "42", method: "PUT", body: {}, unsigned: true }));
    expect(unsigned.status).toBe(401);
    const tampered = await call(signedRequest(name, { customerId: "42", method: "DELETE", tamper: true }));
    expect(tampered.status).toBe(401);
    // Signed, wrong method: 405.
    const signed = await call(signedRequest(name, { customerId: "42", method: "PUT", body: {} }));
    expect(signed.status).toBe(405);
    expect(await json(signed)).toEqual({ ok: false, error: "method_not_allowed" });
  });

  it("item 3: the customer payload is built with the influencer's own reward", async () => {
    h.effectiveReferralPoints.mockReturnValue(9000);
    h.getMemberByCustomerId.mockResolvedValueOnce({ ...MEMBER, is_influencer: true, influencer_multiplier: 1.5 });
    h.getCustomerPayload.mockResolvedValue({ member: { firstName: "Aisha", isInfluencer: true }, influencer: { code: "SARA10", percent: 10, rewardPoints: 9000 } });
    const res = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(h.effectiveReferralPoints).toHaveBeenCalledWith(expect.objectContaining({ is_influencer: true, influencer_multiplier: 1.5 }), 6000);
    expect(h.getCustomerPayload).toHaveBeenCalledWith(expect.objectContaining({ id: "m1" }), expect.any(Date), 9000);
    expect(await json(res)).toMatchObject({ influencer: { code: "SARA10", percent: 10, rewardPoints: 9000 } });
    // ordinary members: no rate lookup, zero passed
    h.effectiveReferralPoints.mockClear();
    await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(h.effectiveReferralPoints).not.toHaveBeenCalled();
    expect(h.getCustomerPayload).toHaveBeenLastCalledWith(expect.anything(), expect.any(Date), 0);
  });

  it("item 4: not-enrolled is an explicit state with HTTP 200", async () => {
    h.getMemberByCustomerId.mockResolvedValueOnce(null);
    const none = await customerLoader(args(signedRequest("customer", { customerId: "42" })));
    expect(none.status).toBe(200);
    expect(await json(none)).toEqual({ enabled: true, member: null, state: "not_enrolled" });
  });

  it("item 9: the referral reply never carries the service's internal status or reason", async () => {
    h.recordReferralVisit.mockResolvedValueOnce({ ok: false, recorded: true, blocked: true, status: "flagged", reason: "same_ip" });
    const body = await json(await referralAction(args(signedRequest("referral", { customerId: "42", body: { slug: "sara-9999" } }))));
    expect(body).toEqual({ ok: true, status: "recorded" });
    expect(JSON.stringify(body)).not.toMatch(/flagged|blocked|same_ip|reason/);
  });

  it("item 10: a platform with no profile URL in settings is never awarded", async () => {
    const res = await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "youtube" } })));
    expect(await json(res)).toEqual({ ok: false, error: "disabled" });
    h.getSettings.mockResolvedValueOnce({ ...SETTINGS, social_url_instagram: "javascript:alert(1)" });
    expect(await json(await socialAction(args(signedRequest("social", { customerId: "42", body: { platform: "instagram" } }))))).toEqual({ ok: false, error: "disabled" });
    expect(h.social.insert).not.toHaveBeenCalled();
    expect(h.queueAdd).not.toHaveBeenCalled();
  });
});

describe("route modules export only Remix route exports", () => {
  it("no helper or constant is exported from a proxy route file", async () => {
    const { readdirSync } = await import("node:fs");
    const allowed = ["loader", "action", "headers", "default", "meta", "links", "handle", "shouldRevalidate", "ErrorBoundary"];
    const files = readdirSync("app/routes").filter((f) => /^proxy\.[a-z]+\.tsx$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const mod = (await import(/* @vite-ignore */ `./${f.replace(/\.tsx$/, "")}`)) as Record<string, unknown>;
      for (const name of Object.keys(mod)) expect(allowed, `${f} exports ${name}`).toContain(name);
    }
  });
});
