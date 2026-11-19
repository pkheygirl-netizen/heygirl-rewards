import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { issueReferralFriendCode } from "./referral-bonus.service";
import { ShopifyRateLimitError } from "./shopify-graphql.server";
import {
  approveReferral,
  checkReferralOrder,
  ORDER_CHECK_FAILED_FLAG,
  orderCheckFailure,
  completeReferralForCustomer,
  HELD_CHECK_RETRY_MS,
  REFERRAL_ORDER_TAG,
  resetHeldCheckAttempts,
  resetTagScopeLog,
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
  const referrer = seedMember(h.db, { shopify_customer_id: "REF", referral_slug: "aisha-1234", email: "aisha@example.com", ...referrerOver });
  const friend = seedMember(h.db, { shopify_customer_id: "FR", email: "friend@example.com", ...friendOver });
  return { referrer, friend };
};
const visit = (over = {}) =>
  recordReferralVisit({ referralSlug: "aisha-1234", referredShopifyCustomerId: "FR", referredEmail: "friend@example.com", shop: "s", ...over });
/** A referral held at sign-in: friend and referrer have the same full name. */
const heldSetup = () => setup({ first_name: "Aisha", last_name: "Khan" }, { first_name: "aisha ", last_name: "KHAN" });
const referral = () => h.db.table("referrals")[0];
const awardedOrder = (id = "O1", over = {}) =>
  h.db.seed("order_webhook_state", { shopify_order_id: id, shopify_customer_id: "FR", points_awarded: true, earning_basis_pkr: 2000, placed_at: "2026-11-10T00:00:00Z", ...over });

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  orders = 0;
  h.graphql = shopify;
  resetHeldCheckAttempts();
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
      referred_ip: null, referrer_ip: null, // no network address is written any more (19 Nov 2026)
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

  it("the network address is not compared any more: a referrer who once had the friend's old address is NOT held", async () => {
    // The old rule held these; on the dev store the forwarded address was a proxy's, so it caught nobody real.
    setup({ last_seen_ip: "10.0.0.1" });
    const r = await visit();
    expect(r).toMatchObject({ ok: true, status: "pending" });
    expect(referral().fraud_flags).toEqual([]);
  });

  it("same email as the referrer: blocked, and the referrer loses the right to refer", async () => {
    const { referrer } = setup({}, { email: "AISHA@example.com" });
    const r = await visit();
    expect(r).toMatchObject({ ok: false, recorded: true, blocked: true, status: "blocked" });
    expect(referrer.referrals_blocked).toBe(true);
    expect(referral()).toMatchObject({ fraud_flags: ["same_email"], block_reason: "The friend's email is the referrer's email" });
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("same Gmail mailbox written differently (dots, +tag, googlemail.com) is the same email: blocked", async () => {
    const { referrer } = setup({ email: "Ayesha.Khan@gmail.com" }, { email: "ayeshakhan+shop@googlemail.com" });
    const r = await visit({ referredEmail: null });
    expect(r).toMatchObject({ blocked: true, status: "blocked" });
    expect(referrer.referrals_blocked).toBe(true);
    expect(referral().fraud_flags).toEqual(["same_email"]);
  });

  it("same phone (different formatting) counts as the same person", async () => {
    setup({ phone: "+92 300 1234567" }, { email: null, phone: "03001234567" });
    expect((await visit({ referredEmail: null })).status).toBe("blocked");
    expect(referral().fraud_flags).toEqual(["same_phone"]);
  });

  it("similar email (same name part, any domain, trailing digits ignored): held, no code yet", async () => {
    const { referrer } = setup({ email: "ayeshakhan@gmail.com" }, { email: "ayesha.khan1@yahoo.com" });
    const r = await visit({ referredEmail: null });
    expect(r).toMatchObject({ ok: true, recorded: true, blocked: false, status: "flagged" });
    expect(r.friendCode).toBeUndefined();
    expect(referral()).toMatchObject({ status: "flagged", fraud_flags: ["similar_email"], block_reason: "The friend's email looks like the referrer's" });
    expect(referrer.referrals_blocked).toBe(false); // a hold never removes the right to refer
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("same first and last name: held, no code yet", async () => {
    heldSetup();
    const r = await visit();
    expect(r).toMatchObject({ ok: true, status: "flagged" });
    expect(r.friendCode).toBeUndefined();
    expect(referral()).toMatchObject({ status: "flagged", fraud_flags: ["same_name"] });
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("a short email name part (under 6 letters) or a first name alone is not enough to hold", async () => {
    setup({ email: "sara@gmail.com", first_name: "Sara", last_name: null }, { email: "sara1@yahoo.com", first_name: "Sara", last_name: "Ali" });
    expect((await visit({ referredEmail: null })).status).toBe("pending");
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
    const { referrer } = heldSetup();
    await visit();
    awardedOrder();
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referrer.points_balance).toBe(0);
    expect(referral()).toMatchObject({ status: "flagged", shopify_order_id: "O1" });
  });

  it("approve when the order already qualifies: paid immediately (L5), friend code queued", async () => {
    const { referrer } = heldSetup();
    await visit();
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
    const { referrer } = heldSetup();
    await visit();
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
    const { referrer } = heldSetup();
    await visit();
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
    heldSetup();
    await visit();
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

describe("rule 20: the program switch only pauses redeeming", () => {
  it("a referral visit is recorded and the friend's code issued while the program is off", async () => {
    setup();
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    const r = await visit();
    expect(r).toMatchObject({ ok: true, recorded: true, status: "pending" });
    expect(r.friendCode).toMatch(/^WELCOME-/);
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
  });
});

describe("order-time check: the friend's order that used her free-shipping code", () => {
  const HOME = { address1: "House 12, Street 5, DHA Phase 6", city: "Karachi", phone: null };
  type Ship = { address1?: string | null; city?: string | null; phone?: string | null } | null;
  let ship: Ship = null;
  let theirs: { phone?: string | null; addresses?: Ship[]; orders?: Ship[]; defaultAddress?: Ship } = {};
  const checkReply = () => ({
    order: { shippingAddress: ship },
    customer: {
      defaultPhoneNumber: theirs.phone === undefined ? null : { phoneNumber: theirs.phone },
      defaultAddress: theirs.defaultAddress ?? null,
      addressesV2: { nodes: theirs.addresses ?? [] },
      orders: { nodes: (theirs.orders ?? []).map((a) => ({ shippingAddress: a })) },
    },
  });
  let tagReply: () => unknown = () => ({ tagsAdd: { node: { id: "gid://shopify/Order/O1" }, userErrors: [] } });
  const withCheck = (q: string) =>
    opName(q) === "HgReferralOrderCheck" ? checkReply() : opName(q) === "HgTagReferralOrder" ? tagReply() : shopify(q);
  const tagCalls = () => h.graphqlCalls.filter((c) => opName(c.query) === "HgTagReferralOrder");
  const checkCalls = () => h.graphqlCalls.filter((c) => opName(c.query) === "HgReferralOrderCheck");
  const codeText = () => String(h.db.table("loyalty_codes")[0].code);
  /** The friend's first order, stored as the order worker stores it. */
  const friendOrder = (over = {}) => awardedOrder("O1", { order_name: "#1007", discount_codes: [codeText()], ...over });
  const run = (codes = [codeText()]) => checkReferralOrder({ shopifyOrderId: "O1", shopifyCustomerId: "FR", discountCodes: codes, shop: "s" });

  beforeEach(() => {
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "+92 311 7654321" };
    theirs = { phone: "+923001234567", defaultAddress: HOME, addresses: [HOME], orders: [] };
    tagReply = () => ({ tagsAdd: { node: { id: "gid://shopify/Order/O1" }, userErrors: [] } });
    h.graphql = withCheck;
    resetTagScopeLog();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("a match tags the order \"Rewards: check referral\" once (tagsAdd, nothing else changed); replays do not tag again", async () => {
    setup();
    await visit();
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "0300-1234567" };
    await run();
    expect(REFERRAL_ORDER_TAG).toBe("Rewards: check referral");
    expect(tagCalls()).toHaveLength(1);
    expect(tagCalls()[0].query).toMatch(/mutation HgTagReferralOrder\(\$id: ID!, \$tags: \[String!\]!\)/);
    expect(tagCalls()[0].query).toContain("tagsAdd(id: $id, tags: $tags)");
    expect(tagCalls()[0].query).toContain("userErrors { field message }");
    expect(tagCalls()[0].variables).toEqual({ id: "gid://shopify/Order/O1", tags: ["Rewards: check referral"] });
    expect(referral()).toMatchObject({ status: "blocked", order_tag: "tagged" });
    await run();
    friendOrder();
    await completeReferralForCustomer("FR", "s");
    expect(tagCalls()).toHaveLength(1);
    // the only mutation ever sent for the order is the tag
    const mutations = h.graphqlCalls.filter((c) => /^\s*(#[^\n]*\n\s*)*mutation\b/.test(c.query) && !/DiscountCode/.test(c.query));
    expect(mutations.map((c) => opName(c.query))).toEqual(["HgTagReferralOrder"]);
  });

  it("an address match is tagged too; a clear order is never tagged", async () => {
    setup();
    await visit();
    await run(); // clear
    expect(tagCalls()).toHaveLength(0);
    expect(referral().order_tag).toBeNull();
    resetHarness(); bustSettingsCache(); h.graphql = withCheck;
    setup();
    await visit();
    ship = { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: null };
    await run();
    expect(referral()).toMatchObject({ status: "flagged", order_tag: "tagged" });
  });

  it("without the write_orders permission: not tagged ('failed'), logged once, the referral is still blocked and nothing crashes", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tagReply = () => { throw new Error("Access denied for tagsAdd field. Required access: `write_orders` access scope."); };
    setup();
    await visit();
    ship = { address1: "Flat 3", city: "Lahore", phone: "03001234567" };
    expect(await run()).toMatchObject({ checked: true, result: "same_phone" });
    expect(referral()).toMatchObject({ status: "blocked", order_tag: "failed" });
    // a second matching order (another friend) logs nothing new
    referral().order_checked_order_id = null;
    referral().status = "pending";
    await run();
    expect(err.mock.calls.filter((c) => String(c[0]).includes("write_orders"))).toHaveLength(1);
  });

  it("userErrors from tagsAdd: 'failed', and the message is logged", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    tagReply = () => ({ tagsAdd: { node: null, userErrors: [{ field: ["tags"], message: "Tags are invalid" }] } });
    setup();
    await visit();
    ship = { address1: "Flat 3", city: "Lahore", phone: "03001234567" };
    await run();
    expect(referral().order_tag).toBe("failed");
    expect(err.mock.calls.some((c) => String(c[0]).includes("Tags are invalid"))).toBe(true);
  });

  it("asks Shopify for the order's shipping details and the referrer's phone, saved addresses and last 5 orders", async () => {
    setup({ phone: null });
    await visit();
    await run();
    const call = checkCalls()[0];
    expect(call.variables).toEqual({ orderId: "gid://shopify/Order/O1", customerId: "gid://shopify/Customer/REF" });
    for (const f of ["shippingAddress { address1 address2 city phone }", "defaultPhoneNumber { phoneNumber }", "defaultAddress { address1 address2 city phone }",
      "addressesV2(first: 10)", "orders(first: 5, sortKey: CREATED_AT, reverse: true)"]) {
      expect(call.query).toContain(f);
    }
  });

  it("same shipping phone as the referrer (option A): blocked, no points, the referrer may still refer, Home alert raised", async () => {
    const { referrer } = setup();
    await visit();
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "0300-1234567" };
    expect(await run()).toMatchObject({ checked: true, result: "same_phone" });
    expect(referral()).toMatchObject({
      status: "blocked", fraud_flags: ["same_phone_on_order"], block_reason: "The friend's order uses the referrer's phone number",
      order_check: "same_phone", order_checked_order_id: "O1", alert_resolved_at: null,
    });
    expect(referrer.referrals_blocked).toBe(false); // staff decide from the alert
    friendOrder();
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "no_open_referral" });
    expect(referrer.points_balance).toBe(0);
    // nothing about the phone or address is written anywhere
    expect(JSON.stringify(h.db.table("referrals"))).not.toMatch(/1234567|Gulberg|Lahore/);
  });

  it("the referrer's phone can come from her member row, her Shopify default phone, a saved address or a recent order", async () => {
    for (const where of ["member", "default", "address", "order"] as const) {
      resetHarness(); bustSettingsCache(); h.graphql = withCheck;
      setup({ phone: where === "member" ? "+923009990000" : null });
      await visit();
      theirs = {
        phone: where === "default" ? "03009990000" : undefined,
        addresses: where === "address" ? [{ ...HOME, phone: "0300 9990000" }] : [HOME],
        orders: where === "order" ? [{ address1: "x", city: "y", phone: "+92-300-9990000" }] : [],
      };
      ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03009990000" };
      const r = await run();
      expect(r.checked && referral().order_check, where).toBe("same_phone");
      // her own account phones block; a phone only on a saved address or a recent order holds (gift orders, owner 19 Nov 2026)
      const own = where === "member" || where === "default";
      expect(r.checked && r.result, where).toBe(own ? "same_phone" : "same_order_phone");
      expect(referral().status, where).toBe(own ? "blocked" : "flagged");
      expect(referral().fraud_flags, where).toEqual([own ? "same_phone_on_order" : "same_order_phone_on_order"]);
    }
  });

  it("gift order (owner, 19 Nov 2026): her order goes to a phone the referrer used on an earlier order: held, tagged, Home alert; Approve pays, Block refuses", async () => {
    const { referrer } = setup();
    await visit();
    theirs = { ...theirs, orders: [{ address1: "Flat 9, Clifton", city: "Karachi", phone: "+92 333 7654321" }] };
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03337654321" };
    friendOrder({ discount_codes: [] });
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({
      status: "flagged", order_check: "same_phone", order_checked_order_id: "O1", order_tag: "tagged", alert_resolved_at: null,
      fraud_flags: ["same_order_phone_on_order"],
    });
    expect(String(referral().block_reason)).toContain("could be a gift");
    expect(referrer.referrals_blocked).toBe(false);
    expect(tagCalls()).toHaveLength(1);
    expect(JSON.stringify(h.db.table("referrals"))).not.toMatch(/7654321|Gulberg|Clifton/);
    const n = checkCalls().length;
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(checkCalls()).toHaveLength(n); // staff have looked: not asked again
    expect(referrer.points_balance).toBe(6000);
  });

  it("same address (strict) without the phone: held for staff; approve pays when the order qualifies", async () => {
    const { referrer } = setup();
    await visit();
    ship = { address1: "H# 12 St 5 DHA Phase 6", city: "karachi", phone: "03117654321" };
    expect(await run()).toMatchObject({ checked: true, result: "same_address" });
    expect(referral()).toMatchObject({ status: "flagged", fraud_flags: ["same_address_on_order"], order_check: "same_address" });
    friendOrder();
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referrer.points_balance).toBe(0);
    const r = await approveReferral(String(referral().id), "staff", "s");
    expect(r).toMatchObject({ ok: true, paid: true });
    expect(referrer.points_balance).toBe(6000);
    expect(referral().alert_resolved_at).not.toBeNull(); // the decision closes the Home alert
    expect(checkCalls()).toHaveLength(1); // the approval did not check the same order again
  });

  it("an address match on a referral already held at sign-in keeps both reasons", async () => {
    heldSetup();
    await visit();
    // a held referral has no code yet; approve-less test: give it one directly
    h.db.seed("loyalty_codes", { id: "code-1", code: "WELCOME-HELD", member_id: "x", kind: "referral_friend" });
    referral().friend_code_id = "code-1";
    ship = { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: null };
    expect((await run(["welcome-held"])).checked).toBe(true);
    expect(referral()).toMatchObject({ status: "flagged", fraud_flags: ["same_name", "same_address_on_order"] });
    expect(referral().block_reason).toBe("The friend has the same first and last name as the referrer; The friend's order delivers to the referrer's address");
  });

  it("nothing in common: clear, and the referrer is paid as before", async () => {
    const { referrer } = setup();
    await visit();
    friendOrder();
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: true });
    expect(referral()).toMatchObject({ status: "completed", order_check: "clear", order_checked_order_id: "O1" });
    expect(referrer.points_balance).toBe(6000);
  });

  it("an order without the friend's code: no early check at orders/create, but it IS checked when it becomes her qualifying order", async () => {
    const { referrer } = setup();
    await visit();
    expect(await run(["SOMEOTHERCODE"])).toEqual({ checked: false, reason: "code_not_used" });
    expect(checkCalls()).toHaveLength(0);
    friendOrder({ discount_codes: ["SOMEOTHERCODE"] });
    expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true); // innocent friend: paid
    expect(checkCalls()).toHaveLength(1);
    expect(referral()).toMatchObject({ status: "completed", order_check: "clear", order_checked_order_id: "O1" });
    expect(referrer.points_balance).toBe(6000);
  });

  it("self-referral with NO code at all, shipped to the referrer's phone: blocked on the qualifying order, no points, tagged, alert", async () => {
    const { referrer } = setup();
    await visit();
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "0300-1234567" };
    friendOrder({ discount_codes: [] });
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "blocked_by_order_check", orderId: "O1" });
    expect(referral()).toMatchObject({
      status: "blocked", order_check: "same_phone", order_checked_order_id: "O1", order_tag: "tagged", alert_resolved_at: null,
      fraud_flags: ["same_phone_on_order"],
    });
    expect(referrer.points_balance).toBe(0);
    expect(tagCalls()).toHaveLength(1);
    expect(JSON.stringify(h.db.table("referrals"))).not.toMatch(/1234567|Gulberg|Lahore/);
  });

  it("self-referral with NO code, shipped to the referrer's address: held, tagged, not paid", async () => {
    const { referrer } = setup();
    await visit();
    ship = { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: "03117654321" };
    friendOrder({ discount_codes: [] });
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "same_address", order_tag: "tagged", fraud_flags: ["same_address_on_order"] });
    expect(referrer.points_balance).toBe(0);
  });

  it("held at sign-in, approved BEFORE she orders: code issued; the order check still runs on her qualifying order (clean -> paid)", async () => {
    const { referrer } = heldSetup();
    await visit();
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: false, reason: "no_order" });
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ kind: "referral_friend", status: "active" });
    friendOrder({ discount_codes: [] }); // she did not even use the code
    expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true);
    expect(checkCalls()).toHaveLength(1);
    expect(referral()).toMatchObject({ status: "completed", order_check: "clear", order_checked_order_id: "O1" });
    expect(referrer.points_balance).toBe(6000);
  });

  it("held at sign-in, approved BEFORE she orders, then her order ships to the referrer's phone: blocked, not paid", async () => {
    const { referrer } = heldSetup();
    await visit();
    await approveReferral(String(referral().id), "staff", "s");
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "+92 300 1234567" };
    friendOrder({ discount_codes: [codeText()] }); // orders/create was missed: first seen when it qualifies
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "blocked_by_order_check" });
    expect(referral()).toMatchObject({ status: "blocked", order_check: "same_phone" });
    expect(referrer.points_balance).toBe(0);
  });

  it("held at sign-in, her (code-less) order ships to the referrer's phone and qualifies: blocked at once; staff Approve then pays nothing", async () => {
    const { referrer } = heldSetup();
    await visit();
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03001234567" };
    awardedOrder("O1", { order_name: "#1007", discount_codes: [] }); // a held referral has no code yet
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "blocked_by_order_check" });
    expect(referral()).toMatchObject({ status: "blocked", order_check: "same_phone", fraud_flags: ["same_name", "same_phone_on_order"] });
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: false, paid: false, reason: "not_flagged" });
    expect(referrer.points_balance).toBe(0);
    expect(h.db.table("loyalty_codes")).toHaveLength(0); // no code released either
  });

  it("held at sign-in, Shopify down while her order qualifies: stays held (no throw); Approve runs the check -> same phone -> not paid", async () => {
    const { referrer } = heldSetup();
    await visit();
    awardedOrder("O1", { order_name: "#1007", discount_codes: [] });
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: null, order_checked_order_id: null });
    h.graphql = withCheck;
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03001234567" };
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: false, reason: "blocked_by_order_check" });
    expect(referral()).toMatchObject({ status: "blocked", order_check: "same_phone" });
    expect(referrer.points_balance).toBe(0);
  });

  it("held at sign-in, her qualifying order already checked clean while held: Approve pays without asking Shopify again", async () => {
    const { referrer } = heldSetup();
    await visit();
    awardedOrder("O1", { order_name: "#1007", discount_codes: [] });
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "clear", order_checked_order_id: "O1" });
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(checkCalls()).toHaveLength(1);
    expect(referrer.points_balance).toBe(6000);
  });

  it("a match on her code order is not overwritten when a different, earlier order becomes the qualifying one and is clean", async () => {
    const { referrer } = setup();
    await visit();
    // order O2 used her code and delivers to the referrer's address: held at orders/create
    ship = { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: "03117654321" };
    await checkReferralOrder({ shopifyOrderId: "O2", shopifyCustomerId: "FR", discountCodes: [codeText()], shop: "s" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "same_address", order_checked_order_id: "O2" });
    // her earlier order O1 (no code, elsewhere) is delivered and paid first
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03117654321" };
    awardedOrder("O1", { discount_codes: [], placed_at: "2026-11-09T00:00:00Z" });
    h.db.seed("order_webhook_state", { shopify_order_id: "O2", shopify_customer_id: "FR", points_awarded: false, earning_basis_pkr: 2000, placed_at: "2026-11-10T00:00:00Z", discount_codes: [codeText()] });
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review", orderId: "O1" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "same_address", order_checked_order_id: "O2", alert_resolved_at: null });
    expect(referrer.points_balance).toBe(0);
    // staff look at the alert and approve: O1 (the qualifying order) is checked, clean, paid
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(referrer.points_balance).toBe(6000);
  });

  it("runs once per order: replays do not ask Shopify again", async () => {
    setup();
    await visit();
    await run();
    expect(await run()).toEqual({ checked: false, reason: "already_checked" });
    expect(checkCalls()).toHaveLength(1);
  });

  it("no shipping details (protected customer data not granted, or no shipping line): 'not checked', logged once, never crashes, paid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { referrer } = setup();
    await visit();
    ship = null;
    expect(await run()).toMatchObject({ checked: true, result: "not_checked" });
    expect(referral()).toMatchObject({ status: "pending", order_check: "not_checked", order_checked_order_id: "O1" });
    await run();
    friendOrder();
    expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true);
    expect(referrer.points_balance).toBe(6000);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("[referral-check]"))).toHaveLength(1);
    expect(String(warn.mock.calls[0][0])).not.toMatch(/Gulberg|1234567/);
  });

  it("Shopify answers with errors for fields the app may not read: the fields that came back are still compared", async () => {
    const { referrer } = setup({ phone: null });
    await visit();
    // shape of @shopify/shopify-api's GraphqlQueryError: the whole answer is in `body`
    h.graphql = (q) => {
      if (opName(q) !== "HgReferralOrderCheck") return shopify(q);
      const err = Object.assign(new Error("This app is not approved to access the phone field"), {
        body: { data: { order: { shippingAddress: { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: null } }, customer: { defaultPhoneNumber: null, defaultAddress: HOME, addressesV2: { nodes: [] }, orders: { nodes: [] } } } },
      });
      throw err;
    };
    expect(await run()).toMatchObject({ checked: true, result: "same_address" });
    expect(referrer.points_balance).toBe(0);
  });

  it("Shopify down when the order is paid: nothing is paid until the check has run, then it pays", async () => {
    const { referrer } = setup();
    await visit();
    friendOrder();
    h.graphql = (q) => {
      if (opName(q) === "HgReferralOrderCheck") throw Object.assign(new Error("502"), { response: { code: 502 } });
      return shopify(q);
    };
    await expect(completeReferralForCustomer("FR", "s")).rejects.toThrow();
    expect(referrer.points_balance).toBe(0);
    expect(referral()).toMatchObject({ status: "pending", order_check: null });
    h.graphql = withCheck; // Shopify is back: the retried job checks, then pays
    expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true);
    expect(referrer.points_balance).toBe(6000);
  });

  // ── fix round 8: what counts as "Shopify did not answer" ──
  /** @shopify/shopify-api GraphqlQueryError: HTTP 200 with GraphQL errors, the whole answer in `body`. */
  const gqlError = (messages: Array<string | { message: string; code?: string }>, data: unknown) =>
    Object.assign(new Error(typeof messages[0] === "string" ? messages[0] : messages[0].message), {
      response: { code: 200 },
      body: {
        data,
        errors: { graphQLErrors: messages.map((m) => (typeof m === "string" ? { message: m } : { message: m.message, extensions: { code: m.code } })) },
      },
    });
  const failCheckWith = (make: () => unknown) => {
    h.graphql = (q) => {
      if (opName(q) === "HgReferralOrderCheck") throw make();
      return withCheck(q);
    };
  };

  it("orderCheckFailure: retry for everything except 'Shopify answered but withheld fields'", () => {
    expect(orderCheckFailure(new ShopifyRateLimitError()).retry).toBe(true);
    expect(orderCheckFailure(Object.assign(new Error("502"), { response: { code: 502 } })).retry).toBe(true);
    expect(orderCheckFailure(Object.assign(new Error("400"), { response: { code: 400 } })).retry).toBe(true);
    expect(orderCheckFailure(Object.assign(new Error("401"), { response: { code: 401 } })).retry).toBe(true);
    expect(orderCheckFailure(new Error("something odd")).retry).toBe(true);
    expect(orderCheckFailure("a string").retry).toBe(true);
    expect(orderCheckFailure(new Error("Shopify GraphQL returned no data: {}")).retry).toBe(true);
    expect(orderCheckFailure(gqlError(["Internal error. Looks like something went wrong on our end."], null)).retry).toBe(true);
    // one access error beside one other error: not only access, so retry
    expect(orderCheckFailure(gqlError(["This app is not approved to use the phoneNumber field.", "Field 'x' doesn't exist"], { order: null })).retry).toBe(true);
    // answered: 403, or only access errors (with or without data)
    expect(orderCheckFailure(Object.assign(new Error("403"), { response: { code: 403 } }))).toMatchObject({ retry: false, data: null });
    expect(orderCheckFailure(gqlError([{ message: "Access denied for customer field.", code: "ACCESS_DENIED" }], null))).toMatchObject({ retry: false, data: null });
    expect(orderCheckFailure(gqlError(["This app is not approved to use the phoneNumber field."], { order: { shippingAddress: null } })))
      .toMatchObject({ retry: false, data: { order: { shippingAddress: null } } });
  });

  it("unknown error, GraphQL errors with no data, a 400, or an answer without data: nothing decided, the job retries, nothing paid", async () => {
    for (const make of [
      () => new Error("something odd"),
      () => gqlError(["Internal error. Looks like something went wrong on our end."], null),
      () => Object.assign(new Error("Bad Request"), { response: { code: 400 } }),
    ]) {
      resetHarness(); bustSettingsCache(); h.graphql = withCheck;
      const { referrer } = setup();
      await visit();
      friendOrder();
      failCheckWith(make);
      await expect(run()).rejects.toThrow();
      await expect(completeReferralForCustomer("FR", "s")).rejects.toThrow();
      expect(referral()).toMatchObject({ status: "pending", order_check: null, order_checked_order_id: null });
      expect(referrer.points_balance).toBe(0);
    }
    // Shopify answers with no data at all ({ data: null } from the client): also retried
    resetHarness(); bustSettingsCache(); h.graphql = withCheck;
    setup();
    await visit();
    h.graphql = (q) => (opName(q) === "HgReferralOrderCheck" ? null : withCheck(q));
    await expect(run()).rejects.toThrow(/no data/);
    expect(referral().order_check).toBeNull();
  });

  it("Shopify's real error shape for withheld fields: the fields that came back are compared", async () => {
    const { referrer } = setup({ phone: null });
    await visit();
    failCheckWith(() => gqlError(["This app is not approved to use the phoneNumber field."], {
      order: { shippingAddress: { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: null } },
      customer: { defaultPhoneNumber: null, defaultAddress: HOME, addressesV2: { nodes: [] }, orders: { nodes: [] } },
    }));
    expect(await run()).toMatchObject({ checked: true, result: "same_address" });
    expect(referrer.points_balance).toBe(0);
  });

  it("missing access (ACCESS_DENIED, no data, or HTTP 403): 'not checked' and the referral proceeds, as the contract says", async () => {
    for (const make of [
      () => gqlError([{ message: "Access denied for order field.", code: "ACCESS_DENIED" }], null),
      () => Object.assign(new Error("Forbidden"), { response: { code: 403 } }),
    ]) {
      resetHarness(); bustSettingsCache(); h.graphql = withCheck;
      const { referrer } = setup();
      await visit();
      failCheckWith(make);
      expect(await run()).toMatchObject({ checked: true, result: "not_checked" });
      expect(referral()).toMatchObject({ status: "pending", order_check: "not_checked", alert_resolved_at: null });
      friendOrder();
      expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true);
      expect(referrer.points_balance).toBe(6000);
    }
  });

  it("the job's final attempt: a check Shopify still cannot answer holds the referral (visible, not paid); approval then pays without asking again", async () => {
    const { referrer } = setup();
    await visit();
    friendOrder();
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    await expect(completeReferralForCustomer("FR", "s", { finalAttempt: false })).rejects.toThrow();
    expect(referral().status).toBe("pending");
    const last = await completeReferralForCustomer("FR", "s", { finalAttempt: true });
    expect(last).toMatchObject({ paid: false, reason: "held_for_review", orderId: "O1" });
    expect(referral()).toMatchObject({
      status: "flagged", order_check: "not_checked", order_checked_order_id: "O1", fraud_flags: [ORDER_CHECK_FAILED_FLAG], alert_resolved_at: null,
    });
    expect(String(referral().block_reason)).toContain("could not be checked");
    expect(referrer.points_balance).toBe(0);
    expect(tagCalls()).toHaveLength(0); // nothing matched: no tag
    const checksSoFar = checkCalls().length;
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(referrer.points_balance).toBe(6000);
    expect(checkCalls()).toHaveLength(checksSoFar);
  });

  it("an unknown error on the final attempt also holds (never pays silently)", async () => {
    const { referrer } = setup();
    await visit();
    friendOrder();
    failCheckWith(() => new Error("something odd"));
    expect(await completeReferralForCustomer("FR", "s", { finalAttempt: true })).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "not_checked" });
    expect(referrer.points_balance).toBe(0);
  });

  it("approval while Shopify cannot answer the check: the approval stands and a background job finishes it", async () => {
    const { referrer } = setup({ first_name: "Aisha", last_name: "Khan" }, { first_name: "Aisha", last_name: "Khan" });
    await visit();
    expect(referral().status).toBe("flagged");
    // her code already exists (issued earlier), so approval does not issue another
    h.db.seed("loyalty_codes", { id: "code-held", code: "HELDCODE", member_id: "x", kind: "referral_friend", status: "active", issue_key: `referral_friend:${String(referral().id)}` });
    referral().friend_code_id = "code-held";
    friendOrder({ discount_codes: ["HELDCODE"] });
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    const r = await approveReferral(String(referral().id), "staff", "s");
    expect(r).toMatchObject({ ok: true, paid: false, reason: "queued" });
    expect(h.points.named("complete_referral")[0].data).toEqual({ shopifyCustomerId: "FR", shop: "s" });
    expect(referrer.points_balance).toBe(0);
    h.graphql = withCheck; // the job runs once Shopify is back
    expect((await completeReferralForCustomer("FR", "s")).paid).toBe(true);
    expect(referrer.points_balance).toBe(6000);
  });

  it("tagsAdd throttled: nothing stored (no false 'may not have permission'), the referral is still blocked, the next event tags it", async () => {
    tagReply = () => { throw new ShopifyRateLimitError(); };
    setup();
    await visit();
    ship = { address1: "Flat 3", city: "Lahore", phone: "03001234567" };
    expect(await run()).toMatchObject({ checked: true, result: "same_phone" });
    expect(referral()).toMatchObject({ status: "blocked", order_tag: null });
    tagReply = () => ({ tagsAdd: { node: { id: "gid://shopify/Order/O1" }, userErrors: [] } });
    // a later event for the same order (the check itself does not run again)
    expect(await run()).toEqual({ checked: false, reason: "no_open_referral" });
    expect(referral().order_tag).toBe("tagged");
    expect(checkCalls()).toHaveLength(1);
    await run();
    expect(tagCalls()).toHaveLength(2); // tagged once successfully, never again
  });

  it("tagsAdd 5xx is repeated (adding the same tag twice is harmless); a THROTTLED GraphQL error is not 'failed'", async () => {
    let n = 0;
    tagReply = () => {
      n++;
      if (n === 1) throw Object.assign(new Error("502"), { response: { code: 502 } });
      return { tagsAdd: { node: { id: "gid://shopify/Order/O1" }, userErrors: [] } };
    };
    setup();
    await visit();
    ship = { address1: "Flat 3", city: "Lahore", phone: "03001234567" };
    await run();
    expect(tagCalls()).toHaveLength(2);
    expect(referral().order_tag).toBe("tagged");
  });

  // ── review 9 (items 3 and 4) ──
  it("item 3: held at sign-in, the check fails on the job's last try: the order is NOT recorded as checked, so Approve runs the check (same phone -> not paid)", async () => {
    const { referrer } = heldSetup();
    await visit();
    awardedOrder("O1", { order_name: "#1007", discount_codes: [] });
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    expect(await completeReferralForCustomer("FR", "s", { finalAttempt: true })).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(referral()).toMatchObject({
      status: "flagged", order_check: "not_checked", order_checked_order_id: null, fraud_flags: ["same_name", ORDER_CHECK_FAILED_FLAG], alert_resolved_at: null,
    });
    expect(String(referral().block_reason)).toContain("same first and last name");
    expect(String(referral().block_reason)).toContain("could not be checked");
    h.graphql = withCheck; // Shopify answers again
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03001234567" }; // the referrer's phone
    const checksBefore = checkCalls().length;
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: false, reason: "blocked_by_order_check" });
    expect(checkCalls()).toHaveLength(checksBefore + 1);
    expect(referral()).toMatchObject({ status: "blocked", order_check: "same_phone", order_checked_order_id: "O1" });
    expect(referrer.points_balance).toBe(0);
  });

  it("item 3: an order-check hold (not a sign-in hold) still records the order, and Approve pays without asking again", async () => {
    const { referrer } = setup();
    await visit();
    friendOrder();
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    await completeReferralForCustomer("FR", "s", { finalAttempt: true });
    expect(referral()).toMatchObject({ status: "flagged", order_checked_order_id: "O1" });
    const n = checkCalls().length;
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(checkCalls()).toHaveLength(n);
    expect(referrer.points_balance).toBe(6000);
  });

  it("item 4: a held referral whose check threw is tried at most once an hour, not on every event; Approve always checks", async () => {
    const { referrer } = heldSetup();
    await visit();
    awardedOrder("O1", { order_name: "#1007", discount_codes: [] });
    failCheckWith(() => Object.assign(new Error("Bad Request"), { response: { code: 400 } }));
    await completeReferralForCustomer("FR", "s");
    const n = checkCalls().length;
    expect(n).toBeGreaterThan(0);
    await completeReferralForCustomer("FR", "s"); // later events within the hour
    await completeReferralForCustomer("FR", "s", { finalAttempt: true });
    expect(checkCalls()).toHaveLength(n);
    expect(referral()).toMatchObject({ status: "flagged", order_check: null, order_checked_order_id: null });
    const later = Date.now() + HELD_CHECK_RETRY_MS + 1000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    h.graphql = withCheck; // an hour later Shopify answers: clean, recorded, still held for the sign-in reason
    expect(await completeReferralForCustomer("FR", "s")).toMatchObject({ paid: false, reason: "held_for_review" });
    expect(checkCalls()).toHaveLength(n + 1);
    expect(referral()).toMatchObject({ status: "flagged", order_check: "clear", order_checked_order_id: "O1" });
    clock.mockRestore();
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true });
    expect(checkCalls()).toHaveLength(n + 1);
    expect(referrer.points_balance).toBe(6000);
  });

  it("item 4: after an earlier match on another order is kept, the held referral's clean qualifying order is not re-checked on every event", async () => {
    const { referrer } = setup();
    await visit();
    ship = { address1: "House 12 Street 5 DHA Phase 6", city: "Karachi", phone: "03117654321" };
    await checkReferralOrder({ shopifyOrderId: "O2", shopifyCustomerId: "FR", discountCodes: [codeText()], shop: "s" });
    expect(referral()).toMatchObject({ status: "flagged", order_check: "same_address", order_checked_order_id: "O2" });
    ship = { address1: "Flat 3, Gulberg III", city: "Lahore", phone: "03117654321" };
    awardedOrder("O1", { discount_codes: [], placed_at: "2026-11-09T00:00:00Z" });
    await completeReferralForCustomer("FR", "s");
    const n = checkCalls().length;
    await completeReferralForCustomer("FR", "s");
    await completeReferralForCustomer("FR", "s");
    expect(checkCalls()).toHaveLength(n);
    expect(referral()).toMatchObject({ status: "flagged", order_check: "same_address", order_checked_order_id: "O2" });
    expect(await approveReferral(String(referral().id), "staff", "s")).toMatchObject({ ok: true, paid: true }); // Approve checks O1 once more
    expect(checkCalls()).toHaveLength(n + 1);
    expect(referrer.points_balance).toBe(6000);
  });

  it("the friend's code matches without regard to case", async () => {
    setup();
    await visit();
    expect((await run([codeText().toLowerCase()])).checked).toBe(true);
  });
});

describe("friend's code while a referral is held (safety net)", () => {
  it("issueReferralFriendCode refuses a flagged referral; approval still issues it", async () => {
    heldSetup();
    await visit();
    expect(await issueReferralFriendCode(String(referral().id), "s")).toEqual({ issued: false, reason: "held_for_review" });
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
    await approveReferral(String(referral().id), "staff", "s");
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ kind: "referral_friend", status: "active" });
  });
});

describe("payment claims the referral first (fix round 8, item 5)", () => {
  it("a Reject pressed while the points are being added does not leave her paid with the referral rejected", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    const realRpc = h.db.rpc.bind(h.db);
    let rejected: { ok: boolean } | null = null;
    vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (fn === "award_points" && args.p_action_type === "referral_earned" && !rejected) {
        rejected = await rejectReferral(String(referral().id), "staff"); // staff press Reject in the gap
      }
      return realRpc(fn, args);
    });
    expect((await completeReferralForCustomer("FR")).paid).toBe(true);
    expect(rejected).toEqual({ ok: false }); // too late: the referral was already claimed for payment
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true });
    expect(referrer.points_balance).toBe(6000);
  });

  it("a Reject that lands before the claim wins: nothing is paid", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    // Reject lands after the referral was read but before the claim (when the referrer row is read)
    const realFrom = h.db.from.bind(h.db);
    let done = false;
    vi.spyOn(h.db, "from").mockImplementation((table: string) => {
      if (table === "members" && !done && referral().status === "pending" && h.db.table("order_webhook_state").length > 0 && new Error().stack?.includes("payReferral")) {
        done = true;
        referral().status = "rejected";
      }
      return realFrom(table);
    });
    const r = await completeReferralForCustomer("FR");
    expect(done).toBe(true);
    expect(r).toMatchObject({ paid: false, reason: "not_pending" });
    expect(referral().status).toBe("rejected");
    expect(referrer.points_balance).toBe(0);
  });

  it("the award fails after the claim: the next call finishes it, once", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    const realRpc = h.db.rpc.bind(h.db);
    const spy = vi.spyOn(h.db, "rpc").mockImplementationOnce(async () => ({ data: null, error: { code: "08006", message: "connection reset" } }));
    await expect(completeReferralForCustomer("FR")).rejects.toThrow("connection reset");
    expect(referral()).toMatchObject({ status: "completed", points_awarded: false, reward_points: 6000 });
    expect(referrer.points_balance).toBe(0);
    spy.mockImplementation(realRpc);
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: true, points: 6000, orderId: "O1" });
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true });
    expect(referrer.points_balance).toBe(6000);
    expect((await completeReferralForCustomer("FR")).reason).toBe("no_open_referral");
    expect(referrer.points_balance).toBe(6000);
  });

  it("claimed but the order was cancelled before the award finished: put back to pending, not paid", async () => {
    const { referrer } = setup();
    await visit();
    const order = awardedOrder();
    vi.spyOn(h.db, "rpc").mockImplementationOnce(async () => ({ data: null, error: { code: "08006", message: "connection reset" } }));
    await expect(completeReferralForCustomer("FR")).rejects.toThrow();
    order.cancelled_at = "2026-11-12T00:00:00Z";
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "no_order" });
    expect(referral()).toMatchObject({ status: "pending", points_awarded: false, reward_points: null, shopify_order_id: null });
    expect(referrer.points_balance).toBe(0);
  });

  // ── review 9 (items 2 and 5) ──
  /** award_points(referral_earned) commits, then the process stops before points_awarded is set. */
  const stopAfterAward = () => {
    const realRpc = h.db.rpc.bind(h.db);
    const spy = vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const res = await realRpc(fn, args);
      if (fn === "award_points" && args.p_action_type === "referral_earned") {
        spy.mockImplementation(realRpc);
        throw new Error("process stopped");
      }
      return res;
    });
  };
  const ledgerOf = (action: string) => h.db.table("points_ledger").filter((l) => l.action_type === action);

  it("item 2: points added, process stopped before points_awarded, then the order is cancelled: the points are taken back", async () => {
    const { referrer } = setup();
    await visit();
    const order = awardedOrder();
    stopAfterAward();
    await expect(completeReferralForCustomer("FR")).rejects.toThrow("process stopped");
    expect(referral()).toMatchObject({ status: "completed", points_awarded: false });
    expect(referrer.points_balance).toBe(6000);
    // orders/cancelled: processOrderCancelled reverses, then completes again
    order.cancelled_at = "2026-11-12T00:00:00Z";
    expect(await reverseReferralForOrder("O1", "cancelled")).toEqual({ reversed: true, points: 6000 });
    await completeReferralForCustomer("FR");
    expect(referrer.points_balance).toBe(0);
    expect(ledgerOf("referral_reversal")).toHaveLength(1);
    expect(referral()).toMatchObject({ status: "rejected", points_awarded: false });
    expect(h.notifications.named("referral_completed")).toHaveLength(0);
  });

  it("item 2: the same, when only the resume path sees it (refunded in full): taken back, not put back to pending with the points kept", async () => {
    const { referrer } = setup();
    await visit();
    const order = awardedOrder();
    stopAfterAward();
    await expect(completeReferralForCustomer("FR")).rejects.toThrow();
    Object.assign(order, { refunded_basis_pkr: 2000 }); // refunded in full since
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "qualifying_order_refunded", orderId: "O1" });
    expect(referrer.points_balance).toBe(0);
    expect(ledgerOf("referral_reversal")).toHaveLength(1);
    expect(referral()).toMatchObject({ status: "rejected" });
  });

  it("item 2: points added, process stopped, order still qualifies: the next call records the payment and sends the email once", async () => {
    const { referrer } = setup();
    await visit();
    awardedOrder();
    stopAfterAward();
    await expect(completeReferralForCustomer("FR")).rejects.toThrow();
    expect(h.notifications.named("referral_completed")).toHaveLength(0);
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: true, points: 6000, orderId: "O1" });
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true, reward_points: 6000 });
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
    expect(h.notifications.named("referral_completed")[0].data).toEqual({ memberId: referrer.id, points: 6000 });
    await completeReferralForCustomer("FR");
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
    expect(referrer.points_balance).toBe(6000);
    expect(ledgerOf("referral_earned")).toHaveLength(1);
  });

  it("item 2: a normal payment still sends the email once", async () => {
    setup();
    await visit();
    awardedOrder();
    expect((await completeReferralForCustomer("FR")).paid).toBe(true);
    await completeReferralForCustomer("FR");
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
  });

  it.each([["referrals_blocked"], ["is_blocked"], ["opted_out"]])(
    "item 5: claimed, award failed, then the referrer was marked %s: the resume does not pay, the referral is pending again",
    async (field) => {
      const { referrer } = setup();
      await visit();
      awardedOrder();
      vi.spyOn(h.db, "rpc").mockImplementationOnce(async () => ({ data: null, error: { code: "08006", message: "connection reset" } }));
      await expect(completeReferralForCustomer("FR")).rejects.toThrow("connection reset");
      referrer[field] = true;
      expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "referrer_not_eligible" });
      expect(referral()).toMatchObject({ status: "pending", points_awarded: false, reward_points: null });
      expect(referrer.points_balance).toBe(0);
      expect(ledgerOf("referral_earned")).toHaveLength(0);
    },
  );

  it("an old row completed without payment by the pre-v3 button (no reward_points) is never paid", async () => {
    const { referrer } = setup();
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "FR", status: "completed", points_awarded: false, reward_points: null });
    awardedOrder();
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: false, reason: "no_open_referral" });
    expect(referrer.points_balance).toBe(0);
  });
});
