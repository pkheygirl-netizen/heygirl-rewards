import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  createInfluencerCode,
  effectiveReferralPoints,
  findInfluencerByCodes,
  removeInfluencerCode,
  setInfluencer,
} from "./influencer.service";

const NODE = "gid://shopify/DiscountCodeNode/7";
const base = {
  is_influencer: true, influencer_paused: false, influencer_multiplier: null as number | null,
  influencer_referral_rate: null as number | null, influencer_rate_starts_at: null as string | null,
  influencer_rate_ends_at: null as string | null,
};

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("effectiveReferralPoints (rule 11)", () => {
  const at = new Date("2026-11-16T00:00:00Z");
  it("standard for non-influencers and paused influencers", () => {
    expect(effectiveReferralPoints({ ...base, is_influencer: false, influencer_multiplier: 3 }, 6000, at)).toBe(6000);
    expect(effectiveReferralPoints({ ...base, influencer_paused: true, influencer_multiplier: 3 }, 6000, at)).toBe(6000);
  });
  it("round(standard x multiplier)", () => {
    expect(effectiveReferralPoints({ ...base, influencer_multiplier: 1.5 }, 6000, at)).toBe(9000);
    expect(effectiveReferralPoints({ ...base, influencer_multiplier: 1.33 }, 1000, at)).toBe(1330);
    expect(effectiveReferralPoints({ ...base, influencer_multiplier: 0.25 }, 6001, at)).toBe(1500); // 1500.25 rounds
  });
  it("legacy fixed rate when no multiplier; multiplier wins when both are set", () => {
    expect(effectiveReferralPoints({ ...base, influencer_referral_rate: 10000 }, 6000, at)).toBe(10000);
    expect(effectiveReferralPoints({ ...base, influencer_multiplier: 2, influencer_referral_rate: 10000 }, 6000, at)).toBe(12000);
    expect(effectiveReferralPoints(base, 6000, at)).toBe(6000);
  });
  it("rate window: outside starts_at..ends_at the standard points apply", () => {
    const windowed = { ...base, influencer_multiplier: 2, influencer_rate_starts_at: "2026-11-10T00:00:00Z", influencer_rate_ends_at: "2026-11-20T00:00:00Z" };
    expect(effectiveReferralPoints(windowed, 6000, at)).toBe(12000);
    expect(effectiveReferralPoints(windowed, 6000, new Date("2026-11-09T23:59:59Z"))).toBe(6000);
    expect(effectiveReferralPoints(windowed, 6000, new Date("2026-11-20T00:00:01Z"))).toBe(6000);
    expect(effectiveReferralPoints({ ...windowed, influencer_rate_ends_at: null }, 6000, new Date("2030-01-01T00:00:00Z"))).toBe(12000);
  });
});

describe("setInfluencer", () => {
  it("saves multiplier, campaign, pause and dates", async () => {
    const m = seedMember(h.db);
    expect(
      await setInfluencer(String(m.id), { isInfluencer: true, multiplier: 1.5, campaign: " Eid 2026 ", paused: false, rateStartsAt: "2026-11-01T00:00:00+05:00", rateEndsAt: null }),
    ).toEqual({ ok: true });
    expect(m).toMatchObject({ is_influencer: true, influencer_multiplier: 1.5, influencer_campaign: "Eid 2026", influencer_paused: false, influencer_rate_starts_at: "2026-10-31T19:00:00.000Z", influencer_rate_ends_at: null });
  });
  it("only touches the fields that were passed", async () => {
    const m = seedMember(h.db, { is_influencer: true, influencer_multiplier: 2, influencer_campaign: "X" });
    await setInfluencer(String(m.id), { isInfluencer: true, paused: true });
    expect(m).toMatchObject({ influencer_multiplier: 2, influencer_campaign: "X", influencer_paused: true });
  });
  it("validation", async () => {
    const m = seedMember(h.db);
    const id = String(m.id);
    expect(await setInfluencer(id, { isInfluencer: true, multiplier: 0 })).toEqual({ ok: false, reason: "invalid_multiplier" });
    expect(await setInfluencer(id, { isInfluencer: true, multiplier: 150 })).toEqual({ ok: false, reason: "invalid_multiplier" });
    expect(await setInfluencer(id, { isInfluencer: true, rateStartsAt: "not a date" })).toEqual({ ok: false, reason: "invalid_date" });
    expect(await setInfluencer(id, { isInfluencer: true, rateStartsAt: "2026-11-10", rateEndsAt: "2026-11-01" })).toEqual({ ok: false, reason: "end_before_start" });
    expect(await setInfluencer("missing", { isInfluencer: true })).toEqual({ ok: false, reason: "member_not_found" });
    expect(m.is_influencer).toBe(false);
  });
});

describe("influencer discount code (rule 12)", () => {
  it("creates one public percentage code and stores it", async () => {
    const m = seedMember(h.db, { is_influencer: true, first_name: "Ayesha" });
    expect(await createInfluencerCode({ memberId: String(m.id), code: " ayesha10 ", percentOff: 10, shop: "s" })).toEqual({ ok: true });
    expect(m).toMatchObject({ influencer_code: "AYESHA10", influencer_code_percent: 10, influencer_code_discount_id: NODE });
    const input = h.graphqlCalls[0].variables.basicCodeDiscount as Record<string, any>;
    expect(input).toMatchObject({ code: "AYESHA10", context: { all: "ALL" } });
    expect(input.customerGets.value.percentage).toBe(0.1);
  });

  it("refusals: not an influencer, already has a code, bad code, bad percent, code taken", async () => {
    const plain = seedMember(h.db);
    expect((await createInfluencerCode({ memberId: String(plain.id), code: "ABC10", percentOff: 10, shop: "s" })).reason).toBe("not_an_influencer");
    const inf = seedMember(h.db, { is_influencer: true, influencer_code: "HAS1" });
    expect((await createInfluencerCode({ memberId: String(inf.id), code: "ABC10", percentOff: 10, shop: "s" })).reason).toBe("code_exists");
    const free = seedMember(h.db, { is_influencer: true });
    expect((await createInfluencerCode({ memberId: String(free.id), code: "a b", percentOff: 10, shop: "s" })).reason).toBe("invalid_code");
    expect((await createInfluencerCode({ memberId: String(free.id), code: "ABC10", percentOff: 0, shop: "s" })).reason).toBe("invalid_percent");
    expect((await createInfluencerCode({ memberId: String(free.id), code: "ABC10", percentOff: 95, shop: "s" })).reason).toBe("invalid_percent");
    expect((await createInfluencerCode({ memberId: String(free.id), code: "has1", percentOff: 10, shop: "s" })).reason).toBe("code_taken");
    h.db.seed("loyalty_codes", { member_id: plain.id, code: "REWARD-1", discount_amount: 1, points_spent: 1, expires_at: "2027-01-01" });
    expect((await createInfluencerCode({ memberId: String(free.id), code: "reward-1", percentOff: 10, shop: "s" })).reason).toBe("code_taken");
    expect(h.graphqlCalls).toHaveLength(0);
  });

  it("Shopify rejection is reported and nothing is stored", async () => {
    const m = seedMember(h.db, { is_influencer: true });
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "taken", code: "TAKEN" }] } });
    expect(await createInfluencerCode({ memberId: String(m.id), code: "ABC10", percentOff: 10, shop: "s" })).toEqual({ ok: false, reason: "code_taken" });
    expect(m.influencer_code).toBeNull();
  });

  it("if saving fails after Shopify created the code, the Shopify code is removed again", async () => {
    const m = seedMember(h.db, { is_influencer: true });
    h.graphql = (q) =>
      opName(q) === "HgDiscountCodeDelete"
        ? { discountCodeDelete: { deletedCodeDiscountId: NODE, userErrors: [] } }
        : { discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } };
    h.db.failNext("members", "update", { code: "XX000", message: "db down" });
    expect((await createInfluencerCode({ memberId: String(m.id), code: "ABC10", percentOff: 10, shop: "s" })).ok).toBe(false);
    expect(h.graphqlCalls.map((c) => opName(c.query))).toEqual(["HgDiscountCodeBasicCreate", "HgDiscountCodeDelete"]);
  });

  it("remove: deletes in Shopify first, then clears the member", async () => {
    const m = seedMember(h.db, { is_influencer: true, influencer_code: "AYESHA10", influencer_code_percent: 10, influencer_code_discount_id: NODE });
    h.graphql = () => ({ discountCodeDelete: { deletedCodeDiscountId: NODE, userErrors: [] } });
    expect(await removeInfluencerCode({ memberId: String(m.id), shop: "s" })).toEqual({ ok: true });
    expect(h.graphqlCalls[0].variables).toEqual({ id: NODE });
    expect(m).toMatchObject({ influencer_code: null, influencer_code_percent: null, influencer_code_discount_id: null });
  });

  it("remove: if Shopify still has the code, the member keeps it", async () => {
    const m = seedMember(h.db, { is_influencer: true, influencer_code: "AYESHA10", influencer_code_discount_id: NODE });
    h.graphql = (q) =>
      opName(q) === "HgCodeDiscountNodeByCode"
        ? { codeDiscountNodeByCode: { id: NODE } }
        : { discountCodeDelete: { deletedCodeDiscountId: null, userErrors: [{ message: "err" }] } };
    expect(await removeInfluencerCode({ memberId: String(m.id), shop: "s" })).toEqual({ ok: false, reason: "shopify_error" });
    expect(m.influencer_code).toBe("AYESHA10");
    expect((await removeInfluencerCode({ memberId: String(seedMember(h.db).id), shop: "s" })).reason).toBe("no_code");
  });

  it("findInfluencerByCodes matches without regard to case, influencers only", async () => {
    const inf = seedMember(h.db, { is_influencer: true, influencer_code: "AYESHA10" });
    seedMember(h.db, { is_influencer: false, influencer_code: "OLD5" });
    expect(await findInfluencerByCodes(["welcome", "ayesha10"])).toEqual({ id: inf.id, shopify_customer_id: inf.shopify_customer_id });
    expect(await findInfluencerByCodes(["old5"])).toBeNull();
    expect(await findInfluencerByCodes([])).toBeNull();
  });
});
