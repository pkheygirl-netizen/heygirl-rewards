import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  approveReferral,
  completeReferralForCustomer,
  recordReferralVisit,
  rejectReferral,
  resolveReferrer,
  reverseReferralForOrder,
} from "./referrals.service";

const NODE = "gid://shopify/DiscountCodeNode/9";
let orders = 0;

function shopify(q: string) {
  switch (opName(q)) {
    case "HgCustomerOrderCount":
      return { customer: { numberOfOrders: String(orders) } };
    case "HgDiscountCodeFreeShippingCreate":
      return { discountCodeFreeShippingCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } };
    default:
      return {};
  }
}

const setup = (referrerOver = {}, friendOver = {}) => {
  const referrer = seedMember(h.db, { shopify_customer_id: "REF", referral_slug: "aisha-1234", email: "aisha@example.com", last_seen_ip: "10.0.0.1", ...referrerOver });
  const friend = seedMember(h.db, { shopify_customer_id: "FR", email: "friend@example.com", ...friendOver });
  return { referrer, friend };
};
const visit = (over = {}) =>
  recordReferralVisit({ referralSlug: "aisha-1234", referredShopifyCustomerId: "FR", referredEmail: "friend@example.com", referredIp: "20.0.0.2", shop: "s", ...over });
const referral = () => h.db.table("referrals")[0];
const awardedOrder = (id = "O1", over = {}) =>
  h.db.seed("order_webhook_state", { shopify_order_id: id, shopify_customer_id: "FR", points_awarded: true, earning_basis_pkr: 2000, placed_at: "2026-11-10T00:00:00Z", ...over });

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  orders = 0;
  h.graphql = shopify;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("recordReferralVisit (friend's first sign-in with a stored ref)", () => {
  it("records a pending referral and issues the friend's free-shipping code straight away", async () => {
    const { referrer, friend } = setup();
    const r = await visit();
    expect(r).toMatchObject({ ok: true, recorded: true, blocked: false, status: "pending" });
    expect(r.friendCode).toMatch(/^WELCOME-/);
    expect(referral()).toMatchObject({
      referrer_member_id: referrer.id, referred_shopify_customer_id: "FR", status: "pending",
      referred_ip: "20.0.0.2", referrer_ip: "10.0.0.1", // R5: the referrer's own address
    });
    expect(friend.referred_by_member_id).toBe(referrer.id);
    const code = h.db.table("loyalty_codes")[0];
    expect(code).toMatchObject({ member_id: friend.id, kind: "referral_friend", status: "active", issue_key: `referral_friend:${referral().id}`, points_spent: 0 });
    expect(referral().friend_code_id).toBe(code.id);
    expect(referrer.points_balance).toBe(0); // referrer is paid later, on the first order
  });

  it("friend with an earlier order (Shopify count) is not eligible", async () => {
    setup();
    orders = 2;
    expect(await visit()).toMatchObject({ ok: false, status: "not_eligible", reason: "has_orders" });
    expect(h.db.table("referrals")).toHaveLength(0);
  });

  it("friend with an order already stored locally is not eligible (no Shopify call needed)", async () => {
    setup();
    h.db.seed("order_webhook_state", { shopify_order_id: "OLD", shopify_customer_id: "FR" });
    expect(await visit()).toMatchObject({ ok: false, reason: "has_orders" });
    expect(h.graphqlCalls).toHaveLength(0);
  });

  it("order count unavailable: nothing recorded, the storefront may try again", async () => {
    setup();
    h.adminUnavailable = true;
    expect(await visit()).toMatchObject({ ok: false, status: "try_again" });
    expect(h.db.table("referrals")).toHaveLength(0);
  });

  it("same network address as the referrer's last_seen_ip: flagged and held, no code yet", async () => {
    setup();
    const r = await visit({ referredIp: "10.0.0.1" });
    expect(r).toMatchObject({ ok: true, recorded: true, status: "flagged" });
    expect(r.friendCode).toBeUndefined();
    expect(referral()).toMatchObject({ status: "flagged", fraud_flags: ["same_network"] });
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("a different address is NOT held, even if another friend used it before (L8)", async () => {
    const { referrer } = setup();
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "OTHER", referred_ip: "20.0.0.2", status: "completed" });
    expect((await visit()).status).toBe("pending");
  });

  it("same email as the referrer: blocked, and the referrer loses the right to refer", async () => {
    const { referrer } = setup({}, { email: "AISHA@example.com" });
    const r = await visit();
    expect(r).toMatchObject({ ok: false, recorded: true, blocked: true, status: "blocked" });
    expect(referrer.referrals_blocked).toBe(true);
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("same phone (different formatting) counts as the same person", async () => {
    setup({ phone: "+92 300 1234567" }, { email: null, phone: "03001234567" });
    expect((await visit({ referredEmail: null })).status).toBe("blocked");
  });

  it("a friend can be referred only once, by anyone", async () => {
    setup();
    seedMember(h.db, { shopify_customer_id: "REF2", referral_slug: "other-9999" });
    await visit();
    const again = await visit();
    expect(again).toMatchObject({ recorded: false, status: "pending", reason: "duplicate" });
    expect(again.friendCode).toMatch(/^WELCOME-/); // same referrer: the widget can show the code again
    expect(await visit({ referralSlug: "other-9999" })).toMatchObject({ ok: false, status: "already_referred" });
    expect(h.db.table("referrals")).toHaveLength(1);
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
  });

  it("refusals: unknown slug, own link, blocked referrer, referrals_blocked referrer, blocked friend, rule off", async () => {
    setup();
    expect((await visit({ referralSlug: "nobody-0000" })).status).toBe("invalid_slug");
    expect((await visit({ referredShopifyCustomerId: "REF" })).status).toBe("self_referral");

    resetHarness(); bustSettingsCache(); h.graphql = shopify;
    setup({ referrals_blocked: true });
    expect(await visit()).toMatchObject({ status: "not_eligible", reason: "referrer_not_eligible" });

    resetHarness(); bustSettingsCache(); h.graphql = shopify;
    setup({}, { is_blocked: true });
    expect(await visit()).toMatchObject({ status: "not_eligible", reason: "friend_not_eligible" });

    resetHarness(); bustSettingsCache(); h.graphql = shopify;
    h.db.table("app_settings")[0].earn_rules = { referral: { enabled: false } };
    setup();
    expect((await visit()).status).toBe("disabled");
  });

  it("free shipping switched off: referral recorded, no code", async () => {
    h.db.table("app_settings")[0].referral_friend_free_shipping = false;
    setup();
    const r = await visit();
    expect(r).toMatchObject({ ok: true, status: "pending" });
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("Shopify failure while issuing the code: referral still recorded and the code is queued for retry", async () => {
    setup();
    h.graphql = (q) => (opName(q) === "HgCustomerOrderCount" ? { customer: { numberOfOrders: "0" } } : (() => { throw new Error("502"); })());
    const r = await visit();
    expect(r).toMatchObject({ ok: true, recorded: true, status: "pending" });
    expect(h.points.named("issue_referral_friend_code")[0].data).toMatchObject({ referralId: referral().id });
    expect(h.db.table("loyalty_codes")[0].status).toBe("pending"); // not lost
  });

  it("resolveReferrer", async () => {
    const { referrer } = setup();
    expect(await resolveReferrer("Aisha-1234")).toEqual({ memberId: referrer.id });
    expect(await resolveReferrer("zzz")).toBeNull();
  });
});

describe("completion: the friend's FIRST order, fulfilled and paid", () => {
  it("pays the standard points once and writes the completion fields (R4)", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    const r = await completeReferralForCustomer("FR");
    expect(r).toMatchObject({ paid: true, points: 6000, orderId: "O1" });
    expect(referrer.points_balance).toBe(6000);
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true, shopify_order_id: "O1", reward_points: 6000 });
    expect(referral().completed_at).not.toBeNull();
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
    expect((await completeReferralForCustomer("FR")).paid).toBe(false); // nothing open any more
    expect(referrer.points_balance).toBe(6000);
  });

  it("does not pay while the first order is not yet fulfilled and paid, even if a later one is", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder("O1", { points_awarded: false, placed_at: "2026-11-10T00:00:00Z" }); // first: COD, unpaid
    awardedOrder("O2", { placed_at: "2026-11-12T00:00:00Z" }); // second: paid
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "first_order_not_delivered_and_paid" });
    expect(referrer.points_balance).toBe(0);
  });

  it("if the first order was cancelled, the next one counts as first", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder("O1", { points_awarded: false, cancelled_at: "2026-11-11T00:00:00Z" });
    awardedOrder("O2", { placed_at: "2026-11-12T00:00:00Z" });
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: true, orderId: "O2" });
    expect(referrer.points_balance).toBe(6000);
  });

  it("no referral, no order: nothing happens", async () => {
    setup();
    expect((await completeReferralForCustomer("FR")).reason).toBe("no_open_referral");
    await visit();
    expect((await completeReferralForCustomer("FR")).reason).toBe("no_order");
  });

  it("influencer multiplier is applied (L4); paused influencers get the standard points", async () => {
    const { referrer } = setup({ is_influencer: true, influencer_multiplier: 2.5 });
    await visit();
    awardedOrder();
    expect((await completeReferralForCustomer("FR")).points).toBe(15000);
    expect(referrer.points_balance).toBe(15000);
  });

  it("referral_points comes from settings", async () => {
    h.db.table("app_settings")[0].referral_points = 4000;
    const { referrer } = setup();
    await visit();
    awardedOrder();
    await completeReferralForCustomer("FR");
    expect(referrer.points_balance).toBe(4000);
  });

  it("a referrer blocked after the referral was recorded is not paid", async () => {
    const { referrer } = setup();
    await visit();
    referrer.is_blocked = true;
    awardedOrder();
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "referrer_not_eligible" });
  });
});

describe("held referrals: approve / reject", () => {
  it("flagged referral is not paid when the order qualifies; it remembers the order and waits", async () => {
    const { referrer } = setup();
    await visit({ referredIp: "10.0.0.1" });
    awardedOrder();
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referrer.points_balance).toBe(0);
    expect(referral()).toMatchObject({ status: "flagged", shopify_order_id: "O1" });
  });

  it("approve when the order already qualifies: paid immediately (L5), friend code queued", async () => {
    const { referrer } = setup();
    await visit({ referredIp: "10.0.0.1" });
    awardedOrder();
    const r = await approveReferral(String(referral().id), "staff@heygirl.pk", "s");
    expect(r).toMatchObject({ ok: true, paid: true });
    expect(referrer.points_balance).toBe(6000);
    expect(referral()).toMatchObject({ status: "completed", reviewed_note: "approved by staff@heygirl.pk" });
    // the friend's code is issued there and then (the row is written first, so the sweep can finish it)
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ kind: "referral_friend", status: "active" });
    expect(h.points.named("issue_referral_friend_code")).toHaveLength(0);
  });

  it("approve before any qualifying order: back to pending, paid later when the order qualifies", async () => {
    const { referrer } = setup();
    await visit({ referredIp: "10.0.0.1" });
    const r = await approveReferral(String(referral().id), "staff", "s");
    expect(r).toMatchObject({ ok: true, paid: false });
    expect(referral().status).toBe("pending");
    expect(referrer.points_balance).toBe(0);
    awardedOrder();
    expect((await completeReferralForCustomer("FR")).paid).toBe(true);
    expect(referrer.points_balance).toBe(6000);
  });

  it("approve only works on a flagged referral", async () => {
    setup();
    await visit();
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: false, paid: false, reason: "not_flagged" });
  });

  it("reject closes it for good with the note; a rejected referral never pays", async () => {
    const { referrer } = setup();
    await visit({ referredIp: "10.0.0.1" });
    expect(await rejectReferral(String(referral().id), "staff", "same household")).toEqual({ ok: true });
    expect(referral()).toMatchObject({ status: "rejected", reviewed_note: "rejected by staff: same household" });
    awardedOrder();
    expect((await completeReferralForCustomer("FR")).paid).toBe(false);
    expect(referrer.points_balance).toBe(0);
    expect(await rejectReferral(String(referral().id), "staff")).toEqual({ ok: false }); // already closed
  });
});

describe("reversal", () => {
  it("takes the points back once, floored at zero, and closes the referral", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    await completeReferralForCustomer("FR");
    await h.db.rpc("award_points", { p_member_id: referrer.id, p_action_type: "redemption", p_reference_id: "spent", p_points: -5000 });
    expect(await reverseReferralForOrder("O1", "cancelled")).toMatchObject({ reversed: true, points: 6000 });
    expect(referrer.points_balance).toBe(0); // had 1000 left: floor at zero
    expect(referral()).toMatchObject({ status: "rejected", points_awarded: false });
    expect(await reverseReferralForOrder("O1", "cancelled")).toEqual({ reversed: false });
  });

  it("an order that did not complete a referral reverses nothing", async () => {
    setup();
    expect(await reverseReferralForOrder("O-OTHER", "refunded")).toEqual({ reversed: false });
  });
});

describe("fix round", () => {
  it("H3: approving while Shopify is down leaves a pending code row and queues a retry; nothing is swallowed", async () => {
    setup();
    await visit({ referredIp: "10.0.0.1" });
    h.graphql = () => { throw new Error("503"); };
    expect((await approveReferral(String(referral().id), "staff", "s")).ok).toBe(true);
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ kind: "referral_friend", status: "pending" });
    expect(h.points.named("issue_referral_friend_code")).toHaveLength(1);
    expect(h.points.named("issue_referral_friend_code")[0].opts).toBeUndefined(); // M4: no fixed job id
  });

  it("a first order refunded before it was awarded (zero basis) does not pay the referrer", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder("O1", { earning_basis_pkr: 0, points_awarded_amount: 0 });
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "first_order_refunded" });
    expect(referrer.points_balance).toBe(0);
  });

  it("M6: a paused influencer earns the standard amount on a link referral", async () => {
    const { referrer } = setup({ is_influencer: true, influencer_multiplier: 2.5, influencer_paused: true });
    await visit();
    awardedOrder();
    expect((await completeReferralForCustomer("FR")).points).toBe(6000);
    expect(referrer.points_balance).toBe(6000);
  });
});
