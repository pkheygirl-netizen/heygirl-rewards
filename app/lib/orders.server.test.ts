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
  shippingLinesTotal,
  type OrderEvent,
} from "./orders.server";

const order = (over: Partial<OrderEvent> = {}): OrderEvent => {
  const merchandisePkr = over.merchandisePkr ?? 3000;
  return {
    id: "O1",
    name: "#1001",
    customer: { id: "C1", email: "c1@example.com", first_name: "Sara" },
    placedAt: "2026-11-10T10:00:00Z",
    merchandisePkr,
    // original figures: unchanged by later refunds or removals
    grossMerchandisePkr: Math.max(3000, merchandisePkr),
    updatedAt: null,
    taxesIncluded: false,
    fulfillmentStatus: null,
    financialStatus: "pending",
    cancelledAt: null,
    discountCodes: [],
    hasGiftCard: false,
    ...over,
  };
};
/** Shopify updated_at for the n-th version of the order payload. */
const at = (n: number) => new Date(Date.UTC(2026, 10, 10, 10, n)).toISOString();
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

  describe("shipping taken off the basis is the shipping actually charged (review item 2)", () => {
    const sm = (amount: string) => ({ shop_money: { amount, currency_code: "PKR" } });
    // Rs. 3,000 of goods, Rs. 250 shipping made free by a code: the customer paid 3,000.
    const freeShippingOrder = (over: Record<string, unknown> = {}) => ({
      id: 5002,
      total_price: "3000.00",
      current_total_price: "3000.00",
      total_tax: "0.00",
      current_total_tax: "0.00",
      total_shipping_price_set: sm("250.00"), // undiscounted
      discount_codes: [{ code: "WELCOME-AAAA", amount: "250.00", type: "shipping" }],
      shipping_lines: [
        { price: "250.00", price_set: sm("250.00"), discounted_price: "0.00", discounted_price_set: sm("0.00"), current_discounted_price_set: sm("0.00"), is_removed: false },
      ],
      customer: { id: 42 },
      ...over,
    });

    it("free-shipping code: the full Rs. 3,000 earns, whatever the order-level shipping field says", () => {
      // order-level current field absent (older payloads) or itself undiscounted
      expect(parseOrderPayload(freeShippingOrder())!.merchandisePkr).toBe(3000);
      expect(parseOrderPayload(freeShippingOrder({ current_shipping_price_set: sm("250.00") }))!.merchandisePkr).toBe(3000);
      expect(parseOrderPayload(freeShippingOrder())!.grossMerchandisePkr).toBe(3000);
    });

    it("a line with only the plain discounted_price string is read too", () => {
      const ev = parseOrderPayload(freeShippingOrder({ shipping_lines: [{ price: "250.00", discounted_price: "0.00" }] }))!;
      expect(ev.merchandisePkr).toBe(3000);
    });

    it("paid shipping is still taken off, summed over several lines", () => {
      const ev = parseOrderPayload(
        freeShippingOrder({
          total_price: "3400.00",
          current_total_price: "3400.00",
          total_shipping_price_set: sm("400.00"),
          shipping_lines: [
            { price: "250.00", discounted_price_set: sm("250.00"), current_discounted_price_set: sm("250.00") },
            { price: "150.00", discounted_price_set: sm("150.00"), current_discounted_price_set: sm("150.00") },
          ],
        }),
      )!;
      expect(ev.merchandisePkr).toBe(3000);
      expect(ev.grossMerchandisePkr).toBe(3000);
    });

    it("shipping refunded later: the current line price follows the current total", () => {
      const ev = parseOrderPayload(
        freeShippingOrder({
          total_price: "3250.00",
          current_total_price: "3000.00", // the Rs. 250 shipping was refunded
          total_shipping_price_set: sm("250.00"),
          shipping_lines: [{ price: "250.00", discounted_price_set: sm("250.00"), current_discounted_price_set: sm("0.00") }],
        }),
      )!;
      expect(ev.merchandisePkr).toBe(3000);
      expect(ev.grossMerchandisePkr).toBe(3000);
    });

    it("no shipping lines, or a line without a discounted price: falls back to the order-level fields as before", () => {
      expect(parseOrderPayload(freeShippingOrder({ shipping_lines: [], total_price: "3250.00", current_total_price: "3250.00" }))!.merchandisePkr).toBe(3000);
      expect(parseOrderPayload(freeShippingOrder({ shipping_lines: undefined, total_price: "3250.00", current_total_price: "3250.00" }))!.merchandisePkr).toBe(3000);
      expect(
        parseOrderPayload(freeShippingOrder({ shipping_lines: [{ price: "250.00" }], total_price: "3250.00", current_total_price: "3250.00", current_shipping_price_set: sm("250.00") }))!
          .merchandisePkr,
      ).toBe(3000);
    });

    it("shippingLinesTotal", () => {
      expect(shippingLinesTotal(undefined, "original")).toBeNull();
      expect(shippingLinesTotal([], "current")).toBeNull();
      expect(shippingLinesTotal([{ discounted_price_set: sm("100.00") }, { discounted_price: "50.50" }], "original")).toBe(150.5);
      expect(shippingLinesTotal([{ discounted_price_set: sm("100.00") }], "current")).toBeNull();
      expect(shippingLinesTotal([{ current_discounted_price_set: sm("0.00") }], "current")).toBe(0);
    });
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
    expect(ev).toEqual({ refundId: "9001", orderId: "7001", refundedMerchandisePkr: 1300, refundedTaxPkr: 0, amountOnly: false });
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

  it("a code used while its row is still pending is marked used, so the sweep cannot show it as unused later (review item 5)", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "C1" });
    const stuck = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-PEND", status: "pending", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01" });
    const cancelled = h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-GONE", status: "cancelled", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01" });
    await processOrderEvent(order({ discountCodes: ["REWARD-PEND", "REWARD-GONE"] }), "s");
    expect(stuck).toMatchObject({ status: "used", shopify_order_id: "O1" });
    expect(cancelled.status).toBe("cancelled"); // other states are never touched
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

  it("refund for an unknown order reverses nothing; before the award it is remembered and lowers the pending points", async () => {
    expect(await processRefundEvent({ refundId: "R1", orderId: "NOPE", refundedMerchandisePkr: 100 })).toEqual({ reversed: 0, reason: "no_order_row" });
    await processOrderEvent(order(), "s");
    expect(await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 100 })).toEqual({ reversed: 0, reason: "recorded_before_award" });
    expect(state()).toMatchObject({ pending_points: 2900, refunded_basis_pkr: 100 });
    expect(member().points_balance).toBe(0);
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

  it("M6: a paused influencer earns the STANDARD amount on a code sale; her own order with her code is not attributed", async () => {
    const inf = influencer({ influencer_paused: true }); // multiplier 1.5 is ignored while paused
    await processOrderEvent(paid(), "s");
    expect(inf.points_balance).toBe(6000);

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

describe("H1: refunds, order updates and retries in any order (reconcile on totals)", () => {
  const paidFull = (n: number) => order({ fulfillmentStatus: "fulfilled", financialStatus: "paid", updatedAt: at(n) });
  const refunded = (n: number) =>
    order({ fulfillmentStatus: "fulfilled", financialStatus: "partially_refunded", merchandisePkr: 2000, updatedAt: at(n) });

  it("refund processed BEFORE the award, then a stale pre-refund payload triggers the award: awarded net", async () => {
    await processOrderEvent(order({ updatedAt: at(1) }), "s");
    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 });
    // built before the refund, so its figures are still the full 3000
    const r = await processOrderEvent(paidFull(2), "s");
    expect(r).toMatchObject({ status: "awarded", pointsAwarded: 2000 });
    expect(member()).toMatchObject({ points_balance: 2000, lifetime_spend_pkr: 2000 });
    expect(h.notifications.named("points_earned")[0].data).toMatchObject({ points: 2000 });
    // the fresh payload and a redelivered refund change nothing
    await processOrderEvent(refunded(3), "s");
    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 });
    expect(member().points_balance).toBe(2000);
    expect(ledger("refund_deduction")).toHaveLength(0);
  });

  it("award first, then the refund event, then the fresh order update: reversed once", async () => {
    await processOrderEvent(paidFull(1), "s");
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 })).reversed).toBe(1000);
    await processOrderEvent(refunded(2), "s");
    expect(member()).toMatchObject({ points_balance: 2000, lifetime_spend_pkr: 2000 });
    expect(ledger("refund_deduction")).toHaveLength(1);
  });

  it("award first, then the fresh order update BEFORE the refund event: reversed once", async () => {
    await processOrderEvent(paidFull(1), "s");
    await processOrderEvent(refunded(2), "s"); // the update alone already reverses the difference
    expect(member().points_balance).toBe(2000);
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1000 })).reversed).toBe(0);
    expect(member()).toMatchObject({ points_balance: 2000, lifetime_spend_pkr: 2000 });
    expect(ledger("refund_deduction")).toHaveLength(1);
  });

  it("stale retry: an older payload cannot overwrite a newer, lower basis or newer statuses", async () => {
    await processOrderEvent(order({ updatedAt: at(1) }), "s");
    await processOrderEvent(order({ merchandisePkr: 2000, updatedAt: at(5), fulfillmentStatus: "fulfilled" }), "s"); // item removed, shipped
    await processOrderEvent(order({ updatedAt: at(2) }), "s"); // retried old job: 3000, unfulfilled
    expect(state()).toMatchObject({ pending_points: 2000, earning_basis_pkr: 2000, fulfillment_status: "fulfilled" });
  });

  it("a stale payload that says 'fulfilled and paid' does not award an order whose newer state is unpaid", async () => {
    await processOrderEvent(order({ updatedAt: at(5), fulfillmentStatus: "fulfilled", financialStatus: "pending" }), "s");
    const r = await processOrderEvent(order({ updatedAt: at(2), fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(r.status).toBe("recorded");
    expect(member().points_balance).toBe(0);
  });

  it("an older payload still triggers the award when the stored, newer state is awardable (retry after a failed award)", async () => {
    await processOrderEvent(order({ updatedAt: at(1) }), "s");
    Object.assign(state(), { fulfillment_status: "fulfilled", financial_status: "paid", source_updated_at: at(9) });
    const r = await processOrderEvent(order({ updatedAt: at(3) }), "s");
    expect(r.status).toBe("awarded");
    expect(member().points_balance).toBe(3000);
  });

  it("L7: part refunds that add up to the whole order count as refunded in full despite rounding", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(order({ merchandisePkr: 999.99, grossMerchandisePkr: 999.99, fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(referrer.points_balance).toBe(6000);
    for (const id of ["a", "b"]) await processRefundEvent({ refundId: id, orderId: "O1", refundedMerchandisePkr: 333.33 });
    expect(referrer.points_balance).toBe(6000); // not yet in full
    await processRefundEvent({ refundId: "c", orderId: "O1", refundedMerchandisePkr: 333.33 }); // 999.99 in all
    expect(member().points_balance).toBe(0);
    expect(referrer.points_balance).toBe(0);
  });

  it("an order update that shows the order refunded in full reverses the referral too", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(paidFull(1), "s");
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "refunded", merchandisePkr: 0, updatedAt: at(2) }), "s");
    expect(member().points_balance).toBe(0);
    expect(referrer.points_balance).toBe(0);
  });
});

describe("H2: amount-only refunds", () => {
  const payload = (amount: string, extra: Record<string, unknown> = {}) => ({
    id: 9100, order_id: 1, refund_line_items: [],
    transactions: [
      { kind: "refund", status: "success", gateway: "manual", amount },
      { kind: "refund", status: "failure", gateway: "manual", amount: "999.00" },
      { kind: "refund", status: "success", gateway: "gift_card", amount: "50.00" },
    ],
    ...extra,
  });

  it("the value is the successful refund transactions, less refunded shipping and gift-card money", () => {
    expect(parseRefundPayload(payload("750.00"))).toEqual({ refundId: "9100", orderId: "1", refundedMerchandisePkr: 750, refundedTaxPkr: 0, amountOnly: true });
    expect(parseRefundPayload(payload("750.00", { refund_shipping_lines: [{ subtotal_amount_set: { shop_money: { amount: "250.00" } } }] }))!.refundedMerchandisePkr).toBe(500);
    expect(parseRefundPayload(payload("750.00", { order_adjustments: [{ kind: "shipping_refund", amount: "-250.00" }] }))!.refundedMerchandisePkr).toBe(500);
    expect(parseRefundPayload(payload("250.00", { order_adjustments: [{ kind: "shipping_refund", amount: "-250.00" }] }))!.refundedMerchandisePkr).toBe(0); // shipping only
  });

  it("reverses points in proportion", async () => {
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 750, amountOnly: true })).reversed).toBe(750);
    expect(member().points_balance).toBe(2250);
    // an order update whose current figures do not show the amount-only refund must not undo or repeat it
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "partially_refunded", updatedAt: at(4) }), "s");
    expect(member().points_balance).toBe(2250);
  });

  it("a full amount-only refund reverses the referral and the influencer sale", async () => {
    const inf = seedMember(h.db, { shopify_customer_id: "INF", is_influencer: true, influencer_code: "AYESHA10" });
    await processOrderEvent(order({ discountCodes: ["AYESHA10"], fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(inf.points_balance).toBe(6000);
    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 3000, amountOnly: true });
    expect(member().points_balance).toBe(0);
    expect(inf.points_balance).toBe(0);

    resetHarness(); bustSettingsCache();
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 3000, amountOnly: true });
    expect(referrer.points_balance).toBe(0);
  });
});

describe("M1: prices that include tax", () => {
  it("line tax is taken off the refund value when the order has taxes_included", async () => {
    const ev = parseRefundPayload({
      id: 1, order_id: 2,
      refund_line_items: [{ quantity: 1, subtotal: 1180, total_tax: 180, line_item: { quantity: 1, price: "1180.00", discount_allocations: [] } }],
    })!;
    expect(ev).toMatchObject({ refundedMerchandisePkr: 1180, refundedTaxPkr: 180 });
    expect(parseOrderPayload({ id: 1, total_price: "10", taxes_included: true })!.taxesIncluded).toBe(true);

    // order: 3540 incl. 540 tax -> basis 3000
    await processOrderEvent(order({ taxesIncluded: true, fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(state().taxes_included).toBe(true);
    expect((await processRefundEvent({ ...ev, orderId: "O1", refundId: "R1" })).reversed).toBe(1000); // not 1180
  });

  it("without taxes_included the line value is used as it is", async () => {
    await processOrderEvent(order({ fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect((await processRefundEvent({ refundId: "R1", orderId: "O1", refundedMerchandisePkr: 1180, refundedTaxPkr: 180 })).reversed).toBe(1180);
  });
});

describe("M5: campaign switched off after the order was placed still counts", () => {
  const campaign = (over = {}) =>
    h.db.seed("bonus_campaigns", { name: "2x", multiplier: 2, starts_at: "2026-11-09T00:00:00Z", ends_at: "2026-11-11T00:00:00Z", ...over });

  it("first seen late (after the switch-off): the campaign applies because it was on at placement", async () => {
    campaign({ is_active: false, deactivated_at: "2026-11-10T18:00:00Z" }); // order placed 10:00
    await processOrderEvent(order(), "s");
    expect(state()).toMatchObject({ multiplier_used: 2, pending_points: 6000 });
  });

  it("switched off BEFORE the order was placed: does not apply", async () => {
    campaign({ is_active: false, deactivated_at: "2026-11-10T09:00:00Z" });
    await processOrderEvent(order(), "s");
    expect(state().multiplier_used).toBe(1);
  });

  it("never switched on (no deactivation time): does not apply; outside the dates: does not apply", async () => {
    campaign({ is_active: false, deactivated_at: null });
    campaign({ name: "later", multiplier: 3, starts_at: "2026-11-12T00:00:00Z", ends_at: "2026-11-20T00:00:00Z", is_active: false, deactivated_at: "2026-11-13T00:00:00Z" });
    await processOrderEvent(order(), "s");
    expect(state().multiplier_used).toBe(1);
  });
});

describe("L5 / L6", () => {
  it("L5: an earlier CANCELLED order does not stop the next one being the first order", async () => {
    const inf = seedMember(h.db, { shopify_customer_id: "INF", is_influencer: true, influencer_code: "AYESHA10" });
    h.db.seed("order_webhook_state", { shopify_order_id: "OLD", shopify_customer_id: "C1", cancelled_at: "2026-11-01T00:00:00Z" });
    h.graphql = (q) => (opName(q) === "HgCustomerOrderCount" ? { customer: { numberOfOrders: "2" } } : {}); // Shopify counts the cancelled one
    await processOrderEvent(order({ discountCodes: ["AYESHA10"], fulfillmentStatus: "fulfilled", financialStatus: "paid" }), "s");
    expect(state().is_first_order).toBe(true);
    expect(inf.points_balance).toBe(6000);
  });

  it("L6: a customer who cannot be enrolled makes the job finish as skipped, not throw for ever", async () => {
    h.db.failNext("members", "insert", { code: "23514", message: "check constraint" });
    await expect(processOrderEvent(order(), "s")).resolves.toEqual({ status: "skipped", reason: "enrol_failed" });
    expect(h.db.table("order_webhook_state")).toHaveLength(0);
  });
});

describe("rule 20: program switched off (owner decision 17 Nov 2026)", () => {
  // History as migration 014 records it: on since January, off 9-12 Nov.
  const pauseHistory = () => {
    h.db.seed("program_switch_history", { enabled: true, changed_at: "2026-01-01T00:00:00Z", source: "baseline" });
    h.db.seed("program_switch_history", { enabled: false, changed_at: "2026-11-09T00:00:00Z" });
    h.db.seed("program_switch_history", { enabled: true, changed_at: "2026-11-12T00:00:00Z" });
  };
  const setProgram = (on: boolean) => {
    h.db.table("app_settings")[0].program_enabled = on;
    bustSettingsCache();
  };
  const DURING = "2026-11-10T10:00:00Z"; // placed while off
  const BEFORE = "2026-11-08T10:00:00Z"; // placed while on
  const delivered = { fulfillmentStatus: "fulfilled", financialStatus: "paid" } as const;

  it("an order PLACED while the program was off earns nothing, even when delivered and paid after it is back on", async () => {
    pauseHistory();
    setProgram(false);
    await processOrderEvent(order({ placedAt: DURING }), "s");
    expect(state()).toMatchObject({ program_on_at_placement: false, pending_points: 0 });
    expect(await pendingPointsForCustomer("C1")).toBe(0);

    setProgram(true); // sale over, program back on
    const r = await processOrderEvent(order({ placedAt: DURING, ...delivered }), "s");
    expect(r).toMatchObject({ status: "awarded", pointsAwarded: 0 });
    expect(member()).toMatchObject({ points_balance: 0, lifetime_spend_pkr: 3000 }); // spend still counts for the tier
    expect(ledger("purchase")).toHaveLength(0);
    expect(h.notifications.named("points_earned")).toHaveLength(0);
  });

  it("an order PLACED while the program was on still earns when it is delivered and paid during a pause", async () => {
    pauseHistory();
    await processOrderEvent(order({ placedAt: BEFORE }), "s");
    expect(state()).toMatchObject({ program_on_at_placement: true, pending_points: 3000 });

    setProgram(false); // switched off before the COD order is delivered and paid
    await processOrderEvent(order({ placedAt: BEFORE, fulfillmentStatus: "fulfilled" }), "s");
    expect(state().pending_points).toBe(3000); // a sync during the pause keeps the promised points
    const r = await processOrderEvent(order({ placedAt: BEFORE, ...delivered }), "s");
    expect(r).toMatchObject({ status: "awarded", pointsAwarded: 3000 });
    expect(member().points_balance).toBe(3000);
  });

  it("orders/create lost or late: the first sight (orders/updated, delivered and paid) uses the order's created_at against the switch history", async () => {
    pauseHistory();
    setProgram(false); // the switch NOW is off ...
    await processOrderEvent(order({ id: "O-ON", placedAt: BEFORE, ...delivered }), "s");
    expect(state("O-ON").program_on_at_placement).toBe(true); // ... but it was on when this order was placed
    expect(member().points_balance).toBe(3000);

    setProgram(true); // the switch NOW is on ...
    await processOrderEvent(order({ id: "O-OFF", placedAt: DURING, ...delivered }), "s");
    expect(state("O-OFF").program_on_at_placement).toBe(false); // ... but it was off when this one was placed
    expect(member().points_balance).toBe(3000);
    expect(h.db.rpcCalls.filter((c) => c.fn === "program_enabled_at").map((c) => c.args.p_at)).toEqual([
      new Date(BEFORE).toISOString(),
      new Date(DURING).toISOString(),
    ]);
  });

  it("the state is fixed at first sight: a later change to the history does not move an order already recorded", async () => {
    pauseHistory();
    await processOrderEvent(order({ placedAt: DURING }), "s");
    h.db.tables.program_switch_history = [];
    await processOrderEvent(order({ placedAt: DURING, ...delivered }), "s");
    expect(member().points_balance).toBe(0);
    expect(h.db.rpcCalls.filter((c) => c.fn === "program_enabled_at")).toHaveLength(1);
  });

  it("influencer code sale: placed while off pays nothing; placed while on is paid even during a pause", async () => {
    pauseHistory();
    const inf = seedMember(h.db, { shopify_customer_id: "INF", is_influencer: true, influencer_code: "AYESHA10" });
    await processOrderEvent(order({ placedAt: DURING, discountCodes: ["ayesha10"], ...delivered }), "s");
    expect(state().influencer_member_id).toBe(inf.id); // still attributed for stats
    expect(ledger("influencer_sale")).toHaveLength(0);

    resetHarness();
    bustSettingsCache();
    pauseHistory();
    const inf2 = seedMember(h.db, { shopify_customer_id: "INF", is_influencer: true, influencer_code: "AYESHA10" });
    await processOrderEvent(order({ placedAt: BEFORE, discountCodes: ["ayesha10"] }), "s");
    setProgram(false);
    await processOrderEvent(order({ placedAt: BEFORE, discountCodes: ["ayesha10"], ...delivered }), "s");
    expect(inf2.points_balance).toBe(6000);
  });

  it("referral: a friend's first order placed while off does not pay the referrer; her next order placed while on does", async () => {
    pauseHistory();
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    const referral = h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(order({ placedAt: DURING, ...delivered }), "s");
    expect(referrer.points_balance).toBe(0);
    expect(referral.status).toBe("pending");

    await processOrderEvent(order({ id: "O2", name: "#1002", placedAt: "2026-11-13T10:00:00Z", ...delivered }), "s");
    expect(referrer.points_balance).toBe(6000);
    expect(referral).toMatchObject({ status: "completed", shopify_order_id: "O2" });
  });

  it("referral: the friend's first order placed while on pays the referrer even when it completes during a pause", async () => {
    pauseHistory();
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "C1", status: "pending" });
    await processOrderEvent(order({ placedAt: BEFORE }), "s");
    setProgram(false);
    await processOrderEvent(order({ placedAt: BEFORE, ...delivered }), "s");
    expect(referrer.points_balance).toBe(6000);
  });

  it("tier: an upgrade reached with an order placed while off keeps the tier but queues no tier code; one placed while on queues it during a pause", async () => {
    pauseHistory();
    h.db.table("app_settings")[0].tier_gold_threshold_pkr = 2500;
    await processOrderEvent(order({ placedAt: DURING, ...delivered }), "s");
    expect(member().tier).toBe("gold");
    expect(h.points.named("issue_tier_reward")).toHaveLength(0);

    resetHarness();
    bustSettingsCache();
    pauseHistory();
    h.db.table("app_settings")[0].tier_gold_threshold_pkr = 2500;
    await processOrderEvent(order({ placedAt: BEFORE }), "s");
    setProgram(false);
    await processOrderEvent(order({ placedAt: BEFORE, ...delivered }), "s");
    expect(member().tier).toBe("gold");
    expect(h.points.named("issue_tier_reward")).toHaveLength(1);
  });

  it("orders seen before migration 014 (no recorded state) keep earning", async () => {
    seedMember(h.db, { shopify_customer_id: "C1" });
    h.db.seed("order_webhook_state", { shopify_order_id: "O1", shopify_customer_id: "C1", placed_at: DURING, multiplier_used: 1 }); // default true
    pauseHistory();
    await processOrderEvent(order({ placedAt: DURING, ...delivered }), "s");
    expect(member().points_balance).toBe(3000);
  });
});
