import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  cancelRewardCode,
  findTier,
  generateCodeValue,
  getActiveLoyaltyCodes,
  redeemPoints,
  returnRedemptionsForCancelledOrder,
  validateRedemption,
} from "./redemption.service";

const NODE = "gid://shopify/DiscountCodeNode/5";
const created = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
const codes = () => h.db.table("loyalty_codes");
const rich = (over = {}) => {
  const m = seedMember(h.db, { points_balance: 0, ...over });
  h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "seed", points: 7000, points_remaining: 7000, balance_after: 7000 });
  m.points_balance = 7000;
  return m;
};

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  h.graphql = created;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("helpers", () => {
  const tiers = [{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250 }];
  it("validateRedemption uses the settings table only", () => {
    expect(validateRedemption(10000, 6000, tiers)).toEqual({ valid: true });
    expect(validateRedemption(10000, 5000, tiers)).toEqual({ valid: false, reason: "invalid_tier" });
    expect(validateRedemption(2999, 3000, tiers)).toEqual({ valid: false, reason: "insufficient_balance" });
    expect(validateRedemption(10000, 0, tiers).valid).toBe(false);
    expect(validateRedemption(10000, 500, [{ points: 500, discount_pkr: 20 }])).toEqual({ valid: true }); // no hard-coded 3,000 minimum
    expect(findTier(tiers, 6000)).toEqual({ points: 6000, discount_pkr: 250 });
  });
  it("codes are unguessable and unambiguous", () => {
    const a = generateCodeValue();
    expect(a).toMatch(/^REWARD-[A-HJ-NP-Z2-9]{10}$/);
    expect(generateCodeValue()).not.toBe(a);
  });
});

describe("redeemPoints", () => {
  it("deducts, creates a customer-locked single-use code and returns { ok, code, discountPkr, expiresAt }", async () => {
    const m = rich({ shopify_customer_id: "777" });
    const r = await redeemPoints({ memberId: String(m.id), points: 6000, shop: "s" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.discountPkr).toBe(250);
    expect(m.points_balance).toBe(1000);
    expect(codes()[0]).toMatchObject({ code: r.code, kind: "reward", status: "active", points_spent: 6000, discount_amount_pkr: 250, shopify_discount_id: NODE });
    const input = h.graphqlCalls[0].variables.basicCodeDiscount as Record<string, any>;
    expect(input.context).toEqual({ customers: { add: ["gid://shopify/Customer/777"] } });
    expect(input.usageLimit).toBe(1);
    expect(input.customerGets.value.discountAmount.amount).toBe("250.00");
    // 30-day expiry from settings
    const days = (Date.parse(r.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(input.endsAt).toBe(r.expiresAt);
    expect(h.notifications.named("reward_code_issued")[0].data).toMatchObject({ code: r.code, discountPkr: 250 });
    // the deduction is tied to the code row
    expect(h.db.table("points_ledger").find((l) => l.action_type === "redemption")).toMatchObject({ reference_id: codes()[0].id, points: -6000 });
  });

  it("reward table and expiry days come from settings", async () => {
    Object.assign(h.db.table("app_settings")[0], { redemption_tiers: [{ points: 5000, discount_pkr: 400 }], reward_code_expiry_days: 10 });
    const m = rich();
    const r = await redeemPoints({ memberId: String(m.id), points: 5000, shop: "s" });
    expect(r).toMatchObject({ ok: true, discountPkr: 400 });
    if (r.ok) expect((Date.parse(r.expiresAt) - Date.now()) / 86_400_000).toBeLessThan(10.1);
    expect(await redeemPoints({ memberId: String(m.id), points: 6000, shop: "s" })).toEqual({ ok: false, reason: "invalid_tier" });
  });

  it("refusals leave the balance and Shopify untouched", async () => {
    const m = rich();
    expect(await redeemPoints({ memberId: String(m.id), points: 11500, shop: "s" })).toEqual({ ok: false, reason: "insufficient_balance" });
    expect(await redeemPoints({ memberId: "missing", points: 3000, shop: "s" })).toEqual({ ok: false, reason: "member_not_found" });
    m.is_blocked = true;
    expect(await redeemPoints({ memberId: String(m.id), points: 3000, shop: "s" })).toEqual({ ok: false, reason: "blocked" });
    m.is_blocked = false;
    m.opted_out = true;
    expect(await redeemPoints({ memberId: String(m.id), points: 3000, shop: "s" })).toEqual({ ok: false, reason: "opted_out" });
    m.opted_out = false;
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    expect(await redeemPoints({ memberId: String(m.id), points: 3000, shop: "s" })).toEqual({ ok: false, reason: "program_disabled" });
    expect(m.points_balance).toBe(7000);
    expect(codes()).toHaveLength(0);
    expect(h.graphqlCalls).toHaveLength(0);
  });

  it("the database refusing the deduction (a concurrent redeem drained the balance) issues no code", async () => {
    const m = rich();
    // balance read says 7000, but by the time the deduction runs only 1000 is left
    const realRpc = h.db.rpc.bind(h.db);
    vi.spyOn(h.db, "rpc").mockImplementationOnce(async (fn, args) => {
      m.points_balance = 1000;
      return realRpc(fn, args);
    });
    expect(await redeemPoints({ memberId: String(m.id), points: 6000, shop: "s" })).toEqual({ ok: false, reason: "insufficient_balance" });
    expect(codes()).toHaveLength(0);
    expect(h.graphqlCalls).toHaveLength(0);
  });

  it("Shopify rejects the discount: points are returned and the row is cancelled, never left active", async () => {
    const m = rich();
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "nope", code: "INVALID" }] } });
    expect(await redeemPoints({ memberId: String(m.id), points: 6000, shop: "s" })).toEqual({ ok: false, reason: "shopify_error" });
    expect(m.points_balance).toBe(7000);
    expect(codes()[0].status).toBe("cancelled");
    expect(h.db.table("points_ledger").find((l) => l.action_type === "redemption_return")).toMatchObject({ points: 6000, reference_id: codes()[0].id });
    expect(h.notifications.jobs).toHaveLength(0);
  });

  it("no admin client: fails before touching the balance", async () => {
    const m = rich();
    h.adminUnavailable = true;
    expect(await redeemPoints({ memberId: String(m.id), points: 3000, shop: "s" })).toEqual({ ok: false, reason: "shopify_unavailable" });
    expect(m.points_balance).toBe(7000);
    expect(codes()).toHaveLength(0);
  });
});

describe("cancelRewardCode (admin)", () => {
  const issue = async () => {
    const m = rich();
    const r = await redeemPoints({ memberId: String(m.id), points: 6000, shop: "s" });
    if (!r.ok) throw new Error("setup failed");
    h.graphqlCalls.length = 0;
    return { m, row: codes()[0] };
  };
  const deactivated = (usage = 0) => () => ({ discountCodeDeactivate: { codeDiscountNode: { id: NODE, codeDiscount: { asyncUsageCount: usage } }, userErrors: [] } });

  it("deactivates in Shopify first, then returns the points", async () => {
    const { m, row } = await issue();
    h.graphql = deactivated(0);
    const r = await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "staff@heygirl.pk" });
    expect(r).toEqual({ ok: true, pointsReturned: 6000 });
    expect(opName(h.graphqlCalls[0].query)).toBe("HgDiscountCodeDeactivate");
    expect(h.graphqlCalls[0].variables).toEqual({ id: NODE });
    expect(m.points_balance).toBe(7000);
    expect(row.status).toBe("cancelled");
    expect(row.cancelled_at).not.toBeNull();
    const ret = h.db.table("points_ledger").find((l) => l.action_type === "redemption_return")!;
    expect(ret.reason_note).toContain("staff@heygirl.pk"); // internal
    expect(ret.customer_note).not.toContain("staff"); // never shown to the customer
  });

  it("if Shopify cannot deactivate, nothing is returned and the code stays active", async () => {
    const { m, row } = await issue();
    h.graphql = () => ({ discountCodeDeactivate: { codeDiscountNode: null, userErrors: [{ message: "err" }] } });
    expect(await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "a" })).toEqual({ ok: false, pointsReturned: 0, reason: "shopify_error" });
    expect(m.points_balance).toBe(1000);
    expect(row.status).toBe("active");
  });

  it("a code Shopify says was already used is marked used; no points returned", async () => {
    const { m, row } = await issue();
    h.graphql = deactivated(1);
    expect(await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "a" })).toEqual({ ok: false, pointsReturned: 0, reason: "already_used" });
    expect(row.status).toBe("used");
    expect(m.points_balance).toBe(1000);
  });

  it("only ACTIVE reward codes can be cancelled; a second cancel returns nothing", async () => {
    const { m, row } = await issue();
    h.graphql = deactivated(0);
    await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "a" });
    expect(await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "a" })).toEqual({ ok: false, pointsReturned: 0, reason: "not_active" });
    expect(m.points_balance).toBe(7000);
    const bday = h.db.seed("loyalty_codes", { member_id: m.id, code: "BDAY-1", kind: "birthday", discount_amount: 250, points_spent: 0, expires_at: "2027-01-01" });
    expect((await cancelRewardCode({ codeId: String(bday.id), shop: "s", actor: "a" })).reason).toBe("not_a_reward_code");
    expect((await cancelRewardCode({ codeId: "nope", shop: "s", actor: "a" })).reason).toBe("not_found");
  });

  it("a pre-v3 row (price-rule id) is looked up by its code", async () => {
    const m = rich();
    const row = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-OLD", kind: "reward", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01", shopify_discount_id: "gid://shopify/PriceRule/1" });
    h.graphql = (q) => (opName(q) === "HgCodeDiscountNodeByCode" ? { codeDiscountNodeByCode: { id: NODE } } : deactivated(0)());
    expect(await cancelRewardCode({ codeId: String(row.id), shop: "s", actor: "a" })).toEqual({ ok: true, pointsReturned: 3000 });
    expect(row.shopify_discount_id).toBe(NODE);
  });
});

describe("returnRedemptionsForCancelledOrder", () => {
  it("returns once per code, and never twice across admin-cancel and order-cancel", async () => {
    const m = seedMember(h.db);
    const used = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-U", kind: "reward", status: "used", shopify_order_id: "O1", discount_amount: 250, points_spent: 6000, expires_at: "2027-01-01" });
    expect(await returnRedemptionsForCancelledOrder("O1")).toEqual({ returned: 6000, codes: 1 });
    expect(await returnRedemptionsForCancelledOrder("O1")).toEqual({ returned: 0, codes: 0 });
    expect(m.points_balance).toBe(6000);
    expect(used.status).toBe("used");
    expect(await returnRedemptionsForCancelledOrder("O-NONE")).toEqual({ returned: 0, codes: 0 });
  });
});

describe("getActiveLoyaltyCodes", () => {
  it("lists only active codes, with their kind", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "55" });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "A", kind: "birthday", discount_amount: 250, discount_amount_pkr: 250, points_spent: 0, expires_at: "2027-01-01" });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "B", status: "used", discount_amount: 1, points_spent: 1, expires_at: "2027-01-01" });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "C", status: "pending", discount_amount: 1, points_spent: 1, expires_at: "2027-01-01" });
    const list = await getActiveLoyaltyCodes("55");
    expect(list.map((c) => c.code)).toEqual(["A"]);
    expect(list[0].kind).toBe("birthday");
    expect(await getActiveLoyaltyCodes("nobody")).toEqual([]);
  });
});
