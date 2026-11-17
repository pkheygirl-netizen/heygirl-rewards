import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  computeEarningBasis,
  fetchGiftCardAmount,
  isAwardable,
  parseOrderPayload,
  parseRefundPayload,
  pendingPointsForCustomer,
  processOrderCancelled,
  processOrderEvent,
  processRefundEvent,
  type OrderEvent,
} from "./orders.server";

const order = (over: Partial<OrderEvent> = {}): OrderEvent => ({
  id: "O1",
  name: "#1001",
  customer: { id: "C1", email: "c1@example.com", first_name: "Sara" },
  placedAt: "2026-11-10T10:00:00Z",
  merchandisePkr: 3000,
  fulfillmentStatus: null,
  financialStatus: "pending",
  cancelledAt: null,
  discountCodes: [],
  hasGiftCard: false,
  ...over,
});
const state = (id = "O1") => h.db.table("order_webhook_state").find((o) => o.shopify_order_id === id)!;
const member = (cust = "C1") => h.db.table("members").find((m) => m.shopify_customer_id === cust)!;
const ledger = (action: string) => h.db.table("points_ledger").filter((l) => l.action_type === action);

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.graphql = (q) => (opName(q) === "HgCustomerOrderCount" ? { customer: { numberOfOrders: "1" } } : {});
});

describe("payload parsing", () => {
  it("order: basis = total - shipping - tax from the current figures; codes, gift card, phone-only customer", () => {
    const ev = parseOrderPayload({
      id: 5001,
      name: "#1001",
      created_at: "2026-11-10T10:00:00+05:00",
      total_price: "5000.00",
      current_total_price: "4500.00",
      total_shipping_price_set: { shop_money: { amount: "250.00" } },
      current_shipping_price_set: { shop_money: { amount: "250.00" } },
      total_tax: "0.00",
      current_total_tax: "100.00",
      fulfillment_status: null,
      financial_status: "pending",
      cancelled_at: null,
      discount_codes: [{ code: "reward-abc", amount: "100.00", type: "fixed_amount" }],
      payment_gateway_names: ["gift_card", "Cash on Delivery (COD)"],
      phone: "+923001234567",
      customer: { id: 42, email: null, phone: null, first_name: "Hina", last_name: null },
    })!;
    expect(ev.merchandisePkr).toBe(4150); // 4500 - 250 - 100
    expect(ev.discountCodes).toEqual(["reward-abc"]);
    expect(ev.hasGiftCard).toBe(true);
    expect(ev.customer).toMatchObject({ id: "42", email: null, phone: "+923001234567", first_name: "Hina" });
    expect(ev.placedAt).toBe("2026-11-10T10:00:00+05:00");
  });

  it("order without a customer or id", () => {
    expect(parseOrderPayload({ id: 1, total_price: "10" })!.customer).toBeNull();
    expect(parseOrderPayload({})).toBeNull();
    expect(parseOrderPayload(null)).toBeNull();
  });

  it("refund: order id comes from the payload, the customer is not needed; value is discount-adjusted", () => {
    const ev = parseRefundPayload({
      id: 9001,
      order_id: 7001,
      refund_line_items: [
        {
          quantity: 1,
          subtotal: 1000, // pre-discount
          line_item: { quantity: 2, price: "1000.00", discount_allocations: [{ amount: "400.00" }] }, // paid 800 each
        },
        { quantity: 1, subtotal: 500, line_item: { quantity: 1, price: "500.00", discount_allocations: [] } },
      ],
    })!;
    expect(ev).toEqual({ refundId: "9001", orderId: "7001", refundedMerchandisePkr: 1300 });
    expect(parseRefundPayload({ id: 1 })).toBeNull(); // no order id
  });

  it("refund with only shipping refunded has no merchandise value", () => {
    expect(parseRefundPayload({ id: 1, order_id: 2, refund_line_items: [] })!.refundedMerchandisePkr).toBe(0);
  });

  it("earning basis excludes the gift-card part; awardable = fulfilled AND paid AND not cancelled", () => {
    expect(computeEarningBasis(3000, 1000)).toBe(2000);
    expect(computeEarningBasis(3000, 5000)).toBe(0);
    expect(isAwardable({ fulfillmentStatus: "fulfilled", financialStatus: "paid", cancelledAt: null })).toBe(true);
    expect(isAwardable({ fulfillmentStatus: "fulfilled", financialStatus: "partially_refunded", cancelledAt: null })).toBe(true);
    expect(isAwardable({ fulfillmentStatus: "fulfilled", financialStatus: "pending", cancelledAt: null })).toBe(false); // COD not yet paid
    expect(isAwardable({ fulfillmentStatus: "partial", financialStatus: "paid", cancelledAt: null })).toBe(false);
    expect(isAwardable({ fulfillmentStatus: "fulfilled", financialStatus: "paid", cancelledAt: "2026-11-11" })).toBe(false);
  });
});

describe("order placed (orders/create)", () => {
  it("enrols the customer with consent 'order', stores pending points, awards nothing, queues no welcome bonus", async () => {
    const r = await processOrderEvent(order(), "s");
    expect(r).toMatchObject({ status: "recorded", pendingPoints: 3000 });
    expect(member()).toMatchObject({ consent_given: true, consent_source: "order", points_balance: 0 });
    expect(state()).toMatchObject({
      order_name: "#1001", pending_points: 3000, earning_basis_pkr: 3000, multiplier_used: 1, points_awarded: false,
      shopify_customer_id: "C1",
    });
    expect(h.points.named("award_signup_points")).toHaveLength(0);
    expect(await pendingPointsForCustomer("C1")).toBe(3000);
  });

  it("customer who existed before install (no member row) still earns: R11", async () => {
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(member().points_balance).toBe(3000);
  });

  it("uses the campaign multiplier in force when the order was PLACED, even if the campaign is off by award time", async () => {
    const campaign = h.db.seed("bonus_campaigns", { name: "2x", multiplier: 2, starts_at: "2026-11-09T00:00:00Z", ends_at: "2026-11-11T00:00:00Z", is_active: true });
    await processOrderEvent(order(), "s");
    expect(state()).toMatchObject({ multiplier_used: 2, campaign_id: campaign.id, pending_points: 6000 });

    campaign.is_active = false; // ended / switched off before the COD order is paid
    const r = await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(r).toMatchObject({ status: "awarded", pointsAwarded: 6000 });
    expect(member().points_balance).toBe(6000);
    expect(member().lifetime_spend_pkr).toBe(3000); // spend is not multiplied
  });

  it("a campaign that starts after the order was placed does not apply", async () => {
    h.db.seed("bonus_campaigns", { name: "later", multiplier: 3, starts_at: "2026-11-12T00:00:00Z", ends_at: "2026-11-20T00:00:00Z", is_active: true });
    await processOrderEvent(order(), "s");
    expect(state().multiplier_used).toBe(1);
  });

  it("Diamond member in her birthday month (Pakistan time) earns 1.2x when no campaign runs", async () => {
    seedMember(h.db, { shopify_customer_id: "C1", tier: "diamond", birthday_month: 11 });
    // 31 Oct 20:00 UTC is 1 Nov in Karachi
    await processOrderEvent(order({ placedAt: "2026-10-31T20:00:00Z", merchandisePkr: 1000 }), "s");
    expect(state()).toMatchObject({ multiplier_used: 1.2, pending_points: 1200 });
  });

  it("purchase_points_rate comes from settings", async () => {
    h.db.table("app_settings")[0].purchase_points_rate = 0.5;
    await processOrderEvent(order(), "s");
    expect(state().pending_points).toBe(1500);
  });

  it("gift-card part earns nothing", async () => {
    h.graphql = (q) =>
      opName(q) === "HgOrderGiftCard"
        ? { order: { transactions: [
            { gateway: "gift_card", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "1000.00" } } },
            { gateway: "gift_card", kind: "SALE", status: "FAILURE", amountSet: { shopMoney: { amount: "999.00" } } },
            { gateway: "cash_on_delivery", kind: "SALE", status: "PENDING", amountSet: { shopMoney: { amount: "2000.00" } } },
          ] } }
        : {};
    expect(await fetchGiftCardAmount("O1", "s")).toBe(1000);
    await processOrderEvent(order({ hasGiftCard: true }), "s");
    expect(state()).toMatchObject({ gift_card_amount_pkr: 1000, earning_basis_pkr: 2000, pending_points: 2000, order_total_pkr: 3000 });
  });

  it("blocked member: order recorded, no pending points, never awarded", async () => {
    seedMember(h.db, { shopify_customer_id: "C1", is_blocked: true });
    await processOrderEvent(order(), "s");
    expect(state().pending_points).toBe(0);
    const r = await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(r).toMatchObject({ status: "skipped", reason: "blocked" });
    expect(member().points_balance).toBe(0);
  });

  it("opted-out member: no consent recorded, no points", async () => {
    seedMember(h.db, { shopify_customer_id: "C1", opted_out: true, consent_given: false });
    const r = await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(r).toMatchObject({ status: "skipped", reason: "opted_out" });
    expect(member()).toMatchObject({ consent_given: false, points_balance: 0 });
  });

  it("purchase rule switched off: no points, but the spend still counts towards the tier", async () => {
    h.db.table("app_settings")[0].earn_rules = { purchase: { enabled: false } };
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(member()).toMatchObject({ points_balance: 0, lifetime_spend_pkr: 3000 });
    expect(state().points_awarded).toBe(true);
  });

  it("order without a customer is skipped", async () => {
    expect(await processOrderEvent(order({ customer: null }), "s")).toEqual({ status: "skipped", reason: "no_customer" });
  });
});

describe("award: fulfilled AND paid AND not cancelled", () => {
  it("cash on delivery: fulfilled but unpaid stays pending; marking it paid awards once", async () => {
    await processOrderEvent(order(), "s");
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled" }), "s"); // delivered, payment still pending
    expect(member().points_balance).toBe(0);
    expect(state().pending_points).toBe(3000);

    const paid = order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" });
    expect(await processOrderEvent(paid, "s")).toMatchObject({ status: "awarded", pointsAwarded: 3000 });
    expect(member()).toMatchObject({ points_balance: 3000, lifetime_spend_pkr: 3000 });
    expect(state()).toMatchObject({ points_awarded: true, points_awarded_amount: 3000, pending_points: 0 });
    expect(await pendingPointsForCustomer("C1")).toBe(0);
    expect(h.notifications.named("points_earned")).toHaveLength(1);

    // duplicate webhooks (orders/updated + orders/fulfilled) do not award twice
    await processOrderEvent(paid, "s");
    await processOrderEvent(paid, "s");
    expect(member().points_balance).toBe(3000);
    expect(ledger("purchase")).toHaveLength(1);
    expect(h.notifications.named("points_earned")).toHaveLength(1);
  });

  it("paid but not yet fulfilled does not award", async () => {
    await processOrderEvent(order({ financialStatus: "paid" }), "s");
    expect(member().points_balance).toBe(0);
  });

  it("an order edit before delivery changes the pending points (multiplier unchanged)", async () => {
    h.db.seed("bonus_campaigns", { name: "2x", multiplier: 2, starts_at: "2026-11-09T00:00:00Z", ends_at: "2026-11-11T00:00:00Z" });
    await processOrderEvent(order(), "s");
    await processOrderEvent(order({ merchandisePkr: 2000 }), "s"); // an item removed
    expect(state()).toMatchObject({ pending_points: 4000, earning_basis_pkr: 2000, multiplier_used: 2 });
  });

  it("crossing the Gold threshold upgrades the tier and queues the tier reward", async () => {
    h.db.table("app_settings")[0].tier_gold_threshold_pkr = 2500;
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(member().tier).toBe("gold");
    expect(h.db.table("tier_history")[0]).toMatchObject({ from_tier: "silver", to_tier: "gold", shopify_order_id: "O1" });
    expect(h.points.named("issue_tier_reward")).toHaveLength(1);
  });

  it("the member's own loyalty code is marked used (case-insensitive) and tied to the order", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "C1" });
    const code = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-ABC", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01" });
    const other = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-ZZZ", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01" });
    await processOrderEvent(order({ discountCodes: ["reward-abc"] }), "s");
    expect(code).toMatchObject({ status: "used", shopify_order_id: "O1" });
    expect(other.status).toBe("active");
  });
});

describe("refunds (found through the stored order)", () => {
  const awarded = async (over: Partial<OrderEvent> = {}) =>
    processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid", ...over }), "s");

  it("part refund reverses in proportion; a second part refund and replays never exceed the award", async () => {
    await awarded();
    expect(await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 })).toEqual({ reversed: 1000 });
    expect(member()).toMatchObject({ points_balance: 2000, lifetime_spend_pkr: 2000 });
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 })).reversed).toBe(0); // replay
    expect((await processRefundEvent({ refundId: "R2", orderId: "O1", refundedMerchandisePkr: 5000 })).reversed).toBe(2000); // capped
    expect(member().points_balance).toBe(0);
    expect(state()).toMatchObject({ points_awarded_amount: 3000, points_reversed_amount: 3000 });
  });

  it("with a campaign multiplier the reversal is of the points actually awarded", async () => {
    h.db.seed("bonus_campaigns", { name: "2x", multiplier: 2, starts_at: "2026-11-09T00:00:00Z", ends_at: "2026-11-11T00:00:00Z" });
    await awarded();
    expect(member().points_balance).toBe(6000);
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1500 })).reversed).toBe(3000);
  });

  it("gift-card orders: the refund is scaled to the earning basis", async () => {
    h.graphql = (q) =>
      opName(q) === "HgOrderGiftCard"
        ? { order: { transactions: [{ gateway: "gift_card", kind: "SALE", status: "SUCCESS", amountSet: { shopMoney: { amount: "1000.00" } } }] } }
        : {};
    await awarded({ hasGiftCard: true }); // merchandise 3000, basis 2000, 2000 points
    expect(member().points_balance).toBe(2000);
    // half the merchandise refunded -> half the points
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1500 })).reversed).toBe(1000);
  });

  it("refund for an unknown order or before the award reverses nothing", async () => {
    expect(await processRefundEvent({ refundId: "R1", orderId: "NOPE", refundedMerchandisePkr: 100 })).toEqual({ reversed: 0, reason: "no_order_row" });
    await processOrderEvent(order(), "s");
    expect(await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 100 })).toEqual({ reversed: 0, reason: "not_awarded" });
  });

  it("points already spent: reverses what it can, balance never negative", async () => {
    await awarded();
    await h.db.rpc("award_points", { p_member_id: member().id, p_action_type: "redemption", p_reference_id: "code", p_points: -3000 });
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 3000 })).reversed).toBe(0);
    expect(member().points_balance).toBe(0);
  });
});

describe("cancellations", () => {
  it("cancelled before the award: nothing to reverse, and the order can never be awarded later", async () => {
    await processOrderEvent(order(), "s");
    const r = await processOrderCancelled(order({ cancelledAt: "2026-11-11T00:00:00Z" }), "s");
    expect(r).toMatchObject({ reversed: 0 });
    expect(state().cancelled_at).not.toBeNull();
    expect(state().pending_points).toBe(0);
    // a late "fulfilled + paid" update must not award
    const late = await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(late.status).toBe("skipped");
    expect(member().points_balance).toBe(0);
  });

  it("cancelled after the award: the remainder is reversed once (refund + cancel for the same order)", async () => {
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 });
    const r = await processOrderCancelled(order({ fulfillmentStatus: "fulfilled", cancelledAt: "2026-11-12T00:00:00Z" }), "s");
    expect(r.reversed).toBe(2000);
    expect((await processOrderCancelled(order({ cancelledAt: "2026-11-12T00:00:00Z" }), "s")).reversed).toBe(0);
    expect(member()).toMatchObject({ points_balance: 0, lifetime_spend_pkr: 0 });
  });

  it("orders/updated carrying cancelled_at is treated as a cancellation", async () => {
    await processOrderEvent(order(), "s");
    expect(await processOrderEvent(order({ cancelledAt: "2026-11-11T00:00:00Z" }), "s")).toEqual({ status: "cancelled" });
    expect(state().cancelled_at).not.toBeNull();
  });

  it("cancellation of an order never seen before is recorded as cancelled and never awarded", async () => {
    const r = await processOrderCancelled(order({ cancelledAt: "2026-11-11T00:00:00Z", fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(r.reason).toBe("recorded_as_cancelled");
    expect(state()).toMatchObject({ points_awarded: false, pending_points: 0 });
    expect(state().cancelled_at).not.toBeNull();
    expect(member().points_balance).toBe(0);
  });

  it("rule 7: reward code used on an order cancelled BEFORE fulfilment: points come back, code stays used", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "C1", points_balance: 0 });
    const code = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-ABC", kind: "reward", discount_amount: 250, points_spent: 6000, expires_at: "2027-01-01" });
    await processOrderEvent(order({ discountCodes: ["REWARD-ABC"] }), "s");
    const r = await processOrderCancelled(order({ discountCodes: ["REWARD-ABC"], cancelledAt: "2026-11-11T00:00:00Z" }), "s");
    expect(r.redemptionReturned).toBe(6000);
    expect(m.points_balance).toBe(6000);
    expect(code.status).toBe("used");
    expect(ledger("redemption_return")[0]).toMatchObject({ reference_id: code.id, points: 6000, shopify_order_id: "O1" });
    // replay returns nothing more
    expect((await processOrderCancelled(order({ discountCodes: ["REWARD-ABC"], cancelledAt: "2026-11-11T00:00:00Z" }), "s")).redemptionReturned).toBe(0);
    expect(m.points_balance).toBe(6000);
  });

  it("rule 7: no return when the order was already fulfilled", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-ABC", kind: "reward", discount_amount: 250, points_spent: 6000, expires_at: "2027-01-01" });
    await processOrderEvent(order({ discountCodes: ["REWARD-ABC"], fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    const before = Number(m.points_balance);
    const r = await processOrderCancelled(order({ discountCodes: ["REWARD-ABC"], fulfillmentStatus: "fulfilled", cancelledAt: "2026-11-12T00:00:00Z" }), "s");
    expect(r.redemptionReturned).toBe(0);
    expect(ledger("redemption_return")).toHaveLength(0);
    expect(Number(m.points_balance)).toBe(before - 3000); // only the purchase points were reversed
  });

  it("birthday / free-shipping codes are never 'returned' (they cost no points)", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "BDAY-1", kind: "birthday", discount_amount: 250, points_spent: 0, expires_at: "2027-01-01" });
    await processOrderEvent(order({ discountCodes: ["BDAY-1"] }), "s");
    expect((await processOrderCancelled(order({ discountCodes: ["BDAY-1"], cancelledAt: "2026-11-11T00:00:00Z" }), "s")).redemptionReturned).toBe(0);
  });
});

describe("influencer discount codes (rule 12)", () => {
  const influencer = (over = {}) =>
    seedMember(h.db, { shopify_customer_id: "INF", is_influencer: true, influencer_code: "AYESHA10", influencer_multiplier: 1.5, ...over });
  const paid = (over: Partial<OrderEvent> = {}) =>
    order({ discountCodes: ["ayesha10"], fulfillmentStatus: "fulfilled", financialStatus: "paid", ...over });

  it("attributes the order and pays the influencer for a new customer's first order (multiplier applied)", async () => {
    const inf = influencer();
    await processOrderEvent(paid(), "s");
    expect(state()).toMatchObject({ influencer_member_id: inf.id, is_first_order: true });
    expect(inf.points_balance).toBe(9000); // round(6000 x 1.5)
    expect(ledger("influencer_sale")[0]).toMatchObject({ member_id: inf.id, reference_id: "O1" });
    await processOrderEvent(paid(), "s"); // replay
    expect(inf.points_balance).toBe(9000);
  });

  it("repeat customer: attributed for stats, earns nothing", async () => {
    const inf = influencer();
    h.graphql = (q) => (opName(q) === "HgCustomerOrderCount" ? { customer: { numberOfOrders: "4" } } : {});
    await processOrderEvent(paid(), "s");
    expect(state()).toMatchObject({ influencer_member_id: inf.id, is_first_order: false });
    expect(inf.points_balance).toBe(0);
  });

  it("second order from the same customer earns nothing", async () => {
    const inf = influencer();
    await processOrderEvent(paid(), "s");
    await processOrderEvent(paid({ id: "O2", name: "#1002" }), "s");
    expect(state("O2").is_first_order).toBe(false);
    expect(inf.points_balance).toBe(9000);
  });

  it("a link referral wins over the code: the influencer_sale is not paid", async () => {
    const inf = influencer();
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(paid(), "s");
    expect(inf.points_balance).toBe(0);
    expect(referrer.points_balance).toBe(6000);
    expect(ledger("influencer_sale")).toHaveLength(0);
  });

  it("paused influencer earns nothing; her own order with her code is not attributed", async () => {
    const inf = influencer({ influencer_paused: true });
    await processOrderEvent(paid(), "s");
    expect(inf.points_balance).toBe(0);

    resetHarness();
    bustSettingsCache();
    influencer({ shopify_customer_id: "C1" });
    await processOrderEvent(paid(), "s");
    expect(state().influencer_member_id).toBeNull();
  });

  it("the sale is reversed when the order is cancelled after the award", async () => {
    const inf = influencer();
    await processOrderEvent(paid(), "s");
    await processOrderCancelled(paid({ cancelledAt: "2026-11-12T00:00:00Z" }), "s");
    expect(inf.points_balance).toBe(0);
    expect(ledger("referral_reversal")[0]).toMatchObject({ member_id: inf.id, reference_id: "influencer_sale:O1", points: -9000 });
  });
});

describe("referral follow-up", () => {
  it("a full refund of the qualifying order takes the referrer's points back", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    const referral = h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(referrer.points_balance).toBe(6000);
    expect(referral).toMatchObject({ status: "completed", points_awarded: true, shopify_order_id: "O1", reward_points: 6000 });

    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 }); // part refund: referrer keeps it
    expect(referrer.points_balance).toBe(6000);
    await processRefundEvent({ refundId: "R2", orderId: "O1", refundedMerchandisePkr: 2000 }); // now refunded in full
    expect(referrer.points_balance).toBe(0);
    expect(ledger("referral_reversal")[0]).toMatchObject({ member_id: referrer.id, points: -6000 });
  });
});
