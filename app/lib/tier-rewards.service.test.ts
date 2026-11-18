import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { issueTierRewards } from "./tier-rewards.service";
import { issueReferralFriendCode } from "./referral-bonus.service";

const NODE = "gid://shopify/DiscountCodeNode/2";
const shopify = (q: string) =>
  opName(q) === "HgDiscountCodeFreeShippingCreate"
    ? { discountCodeFreeShippingCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } }
    : { discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } };
const codes = () => h.db.table("loyalty_codes");

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  h.graphql = shopify;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("tier rewards (rule 9)", () => {
  it("Gold: one free-shipping code, once", async () => {
    const m = seedMember(h.db, { tier: "gold" });
    const r = await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "gold", shop: "s" });
    expect(r.issued).toHaveLength(1);
    expect(r.issued[0]).toMatchObject({ kind: "tier_gold", freeShipping: true });
    expect(codes()[0]).toMatchObject({ kind: "tier_gold", issue_key: `tier_gold:${m.id}`, status: "active", points_spent: 0 });
    await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "gold", shop: "s" });
    expect(codes()).toHaveLength(1);
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("Diamond: a Rs. tier_reward_diamond_pkr code from settings", async () => {
    h.db.table("app_settings")[0].tier_reward_diamond_pkr = 750;
    const m = seedMember(h.db, { tier: "diamond" });
    const r = await issueTierRewards({ memberId: String(m.id), fromTier: "gold", toTier: "diamond", shop: "s" });
    expect(r.issued).toEqual([expect.objectContaining({ kind: "tier_diamond", discountPkr: 750, freeShipping: false })]);
    expect((h.graphqlCalls[0].variables.basicCodeDiscount as Record<string, any>).customerGets.value.discountAmount.amount).toBe("750.00");
  });

  it("Silver straight to Diamond receives both rewards", async () => {
    const m = seedMember(h.db, { tier: "diamond" });
    const r = await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "diamond", shop: "s" });
    expect(r.issued.map((c) => c.kind)).toEqual(["tier_gold", "tier_diamond"]);
  });

  it("switched off in settings, blocked or opted-out: nothing", async () => {
    Object.assign(h.db.table("app_settings")[0], { tier_reward_gold_free_shipping: false, tier_reward_diamond_pkr: 0 });
    const m = seedMember(h.db, { tier: "diamond" });
    expect((await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "diamond" })).issued).toEqual([]);
    bustSettingsCache();
    Object.assign(h.db.table("app_settings")[0], { tier_reward_gold_free_shipping: true });
    const b = seedMember(h.db, { is_blocked: true });
    expect((await issueTierRewards({ memberId: String(b.id), fromTier: "silver", toTier: "gold" })).reason).toBe("blocked");
    expect(codes()).toHaveLength(0);
  });

  it("a Shopify failure throws so the job retries; the retry finishes without duplicates", async () => {
    const m = seedMember(h.db, { tier: "gold" });
    h.graphql = () => { throw new Error("503"); };
    await expect(issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "gold" })).rejects.toThrow(/retry/);
    expect(codes()[0].status).toBe("pending");
    h.graphql = shopify;
    expect((await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "gold" })).issued).toHaveLength(1);
    expect(codes()).toHaveLength(1);
  });
});

describe("referral friend code", () => {
  const setup = (over = {}) => {
    const referrer = seedMember(h.db);
    const friend = seedMember(h.db, { shopify_customer_id: "FR" });
    const referral = h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "FR", status: "pending", ...over });
    return { friend, referral };
  };

  it("free shipping, locked to the friend, keyed by the referral, and emailed", async () => {
    const { friend, referral } = setup();
    const r = await issueReferralFriendCode(String(referral.id), "s");
    expect(r.issued).toBe(true);
    expect(codes()[0]).toMatchObject({ member_id: friend.id, kind: "referral_friend", issue_key: `referral_friend:${referral.id}`, status: "active" });
    expect(referral.friend_code_id).toBe(codes()[0].id);
    expect((h.graphqlCalls[0].variables.freeShippingCodeDiscount as Record<string, any>).context).toEqual({ customers: { add: ["gid://shopify/Customer/FR"] } });
    expect(h.notifications.named("reward_code_issued")[0].data).toMatchObject({ memberId: friend.id, kind: "referral_friend", freeShipping: true });
    expect(await issueReferralFriendCode(String(referral.id), "s")).toMatchObject({ issued: false, reason: "already_issued" });
    expect(codes()).toHaveLength(1);
  });

  it("not issued for closed referrals, blocked friends, or when switched off", async () => {
    expect((await issueReferralFriendCode(String(setup({ status: "rejected" }).referral.id))).reason).toBe("referral_closed");
    resetHarness(); bustSettingsCache(); h.graphql = shopify;
    const s = setup();
    s.friend.is_blocked = true;
    expect((await issueReferralFriendCode(String(s.referral.id))).reason).toBe("blocked");
    resetHarness(); bustSettingsCache(); h.graphql = shopify;
    h.db.table("app_settings")[0].referral_friend_free_shipping = false;
    expect((await issueReferralFriendCode(String(setup().referral.id))).reason).toBe("disabled");
    expect(codes()).toHaveLength(0);
  });
});

describe("rule 20: the program switch only pauses redeeming", () => {
  it("a tier code and a referral friend code are issued while the program is off", async () => {
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    const m = seedMember(h.db, { tier: "gold" });
    const r = await issueTierRewards({ memberId: String(m.id), fromTier: "silver", toTier: "gold", shop: "s" });
    expect(r.issued.map((c) => c.kind)).toEqual(["tier_gold"]);

    const friend = seedMember(h.db, { shopify_customer_id: "FR" });
    const referral = h.db.seed("referrals", { referrer_member_id: m.id, referred_shopify_customer_id: "FR", status: "pending" });
    const f = await issueReferralFriendCode(String(referral.id), "s");
    expect(f.issued).toBe(true);
    expect(codes().map((c) => [c.member_id, c.kind])).toEqual([[m.id, "tier_gold"], [friend.id, "referral_friend"]]);
  });
});
