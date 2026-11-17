import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  awardSignup,
  awardSocial,
  checkAndUpgradeTier,
  computePurchasePoints,
  enrolFromOrder,
  enrolFromSignin,
  enrolMember,
  expireSilverPoints,
  expiresAtForTier,
  generateSlug,
  isValidBirthday,
  recordShopRedactRequest,
  redactCustomer,
  selectMultiplier,
  setBirthday,
  setOptOut,
  tierForSpend,
} from "./points.service";

const customerReply = (over: Record<string, unknown> = {}) => ({
  customer: {
    firstName: "Aisha",
    lastName: "Khan",
    defaultEmailAddress: { emailAddress: "aisha@example.com" },
    defaultPhoneNumber: null,
    ...over,
  },
});

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pure rules", () => {
  it("purchase points = floor(basis x rate x multiplier)", () => {
    expect(computePurchasePoints(1999.99, 1, 1)).toBe(1999);
    expect(computePurchasePoints(1000, 1, 1.2)).toBe(1200); // no float loss
    expect(computePurchasePoints(1000, 2, 2)).toBe(4000);
    expect(computePurchasePoints(1000, 0.5, 1)).toBe(500);
    expect(computePurchasePoints(0, 1, 2)).toBe(0);
    expect(computePurchasePoints(-50, 1, 1)).toBe(0);
  });

  it("multiplier: campaign wins, else Diamond birthday month 1.2x, else 1", () => {
    expect(selectMultiplier(2, { tier: "diamond", birthday_month: 6 }, 6)).toBe(2);
    expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 6)).toBe(1.2);
    expect(selectMultiplier(null, { tier: "gold", birthday_month: 6 }, 6)).toBe(1); // Diamond only
    expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 7)).toBe(1);
  });

  it("tierForSpend uses the thresholds it is given (settings), not constants", () => {
    const s = { gold: 50000, diamond: 100000 };
    expect(tierForSpend(49999.99, s)).toBe("silver");
    expect(tierForSpend(50000, s)).toBe("gold");
    expect(tierForSpend(100000, s)).toBe("diamond");
    expect(tierForSpend(30000, { gold: 20000, diamond: 40000 })).toBe("gold");
  });

  it("only Silver points expire, after silver_expiry_days", () => {
    const at = new Date("2026-01-01T00:00:00Z");
    expect(expiresAtForTier("silver", { silver_expiry_days: 365 }, at)).toBe("2027-01-01T00:00:00.000Z");
    expect(expiresAtForTier("silver", { silver_expiry_days: 30 }, at)).toBe("2026-01-31T00:00:00.000Z");
    expect(expiresAtForTier("gold", { silver_expiry_days: 365 }, at)).toBeNull();
    expect(expiresAtForTier("diamond", { silver_expiry_days: 365 }, at)).toBeNull();
  });

  it("generateSlug is URL-safe with a 4-digit suffix", () => {
    expect(generateSlug("Aisha", "Khan")).toMatch(/^aisha-khan-\d{4}$/);
    expect(generateSlug(null, null)).toMatch(/^member-\d{4}$/);
  });

  it("isValidBirthday", () => {
    expect(isValidBirthday(2, 29)).toBe(true);
    expect(isValidBirthday(2, 30)).toBe(false);
    expect(isValidBirthday(4, 31)).toBe(false);
    expect(isValidBirthday(13, 1)).toBe(false);
    expect(isValidBirthday(1.5, 1)).toBe(false);
  });
});

describe("enrolFromSignin (auto-consent + welcome bonus at first sign-in)", () => {
  it("new customer: enrolled with consent 'signin', address stored, welcome bonus queued", async () => {
    h.graphql = () => customerReply();
    const r = await enrolFromSignin({ shopifyCustomerId: "501", shop: "s.myshopify.com", ip: "1.2.3.4" });
    expect(r.welcomeQueued).toBe(true);
    const m = h.db.table("members")[0];
    expect(m).toMatchObject({
      shopify_customer_id: "501", email: "aisha@example.com", first_name: "Aisha",
      consent_given: true, consent_source: "signin", last_seen_ip: "1.2.3.4",
    });
    expect(r.memberId).toBe(m.id);
    expect(h.points.named("award_signup_points")[0].data).toEqual({ memberId: m.id });
    // current customer fields, not the removed Customer.email
    expect(h.graphqlCalls[0].query).toContain("defaultEmailAddress { emailAddress }");
  });

  it("phone-only customer is enrolled (no email)", async () => {
    h.graphql = () => customerReply({ defaultEmailAddress: null, defaultPhoneNumber: { phoneNumber: "+923001234567" } });
    const r = await enrolFromSignin({ shopifyCustomerId: "502", shop: "s" });
    expect(r.memberId).not.toBeNull();
    expect(h.db.table("members")[0]).toMatchObject({ email: null, phone: "+923001234567", consent_given: true });
  });

  it("member row created earlier by a webhook (no consent, zero points) gets consent AND the bonus", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "503", consent_given: false });
    const r = await enrolFromSignin({ shopifyCustomerId: "503", shop: "s", ip: "9.9.9.9" });
    expect(r).toMatchObject({ memberId: m.id, welcomeQueued: true });
    expect(m).toMatchObject({ consent_given: true, consent_source: "signin", last_seen_ip: "9.9.9.9" });
    expect(h.graphqlCalls).toHaveLength(0); // no Shopify call for an existing member
  });

  it("member enrolled by an order (consent 'order') still gets the bonus at first sign-in, source unchanged", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "504", consent_given: true, consent_source: "order" });
    const r = await enrolFromSignin({ shopifyCustomerId: "504", shop: "s" });
    expect(r.welcomeQueued).toBe(true);
    expect(m.consent_source).toBe("order");
  });

  it("bonus is never queued twice: an existing signup row stops it", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "505" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "505", points: 1000, balance_after: 1000 });
    const r = await enrolFromSignin({ shopifyCustomerId: "505", shop: "s" });
    expect(r.welcomeQueued).toBe(false);
    expect(h.points.jobs).toHaveLength(0);
  });

  it("imported with a Smile balance: no bonus; imported with zero: bonus", async () => {
    const rich = seedMember(h.db, { shopify_customer_id: "506", imported_from_smile: true });
    h.db.seed("points_ledger", { member_id: rich.id, action_type: "import", reference_id: "smile", points: 12500, balance_after: 12500 });
    expect((await enrolFromSignin({ shopifyCustomerId: "506", shop: "s" })).welcomeQueued).toBe(false);
    seedMember(h.db, { shopify_customer_id: "507", imported_from_smile: true });
    expect((await enrolFromSignin({ shopifyCustomerId: "507", shop: "s" })).welcomeQueued).toBe(true);
  });

  it("opted-out member: nothing changes, nothing queued", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "508", opted_out: true, consent_given: false });
    const r = await enrolFromSignin({ shopifyCustomerId: "508", shop: "s", ip: "1.1.1.1" });
    expect(r).toMatchObject({ welcomeQueued: false, reason: "opted_out" });
    expect(m).toMatchObject({ consent_given: false, last_seen_ip: null });
  });

  it("blocked member: no bonus", async () => {
    seedMember(h.db, { shopify_customer_id: "509", is_blocked: true });
    expect(await enrolFromSignin({ shopifyCustomerId: "509", shop: "s" })).toMatchObject({ welcomeQueued: false, reason: "blocked" });
  });

  it("signup rule switched off: enrolled, no bonus", async () => {
    h.db.table("app_settings")[0].earn_rules = { signup: { enabled: false } };
    seedMember(h.db, { shopify_customer_id: "510" });
    expect(await enrolFromSignin({ shopifyCustomerId: "510", shop: "s" })).toMatchObject({ welcomeQueued: false, reason: "signup_rule_off" });
  });

  it("still enrols when the Shopify customer lookup fails", async () => {
    h.adminUnavailable = true;
    const r = await enrolFromSignin({ shopifyCustomerId: "511", shop: "s" });
    expect(r.memberId).not.toBeNull();
    expect(h.db.table("members")[0]).toMatchObject({ shopify_customer_id: "511", email: null });
  });

  it("repeat page load writes nothing", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "512", last_seen_ip: "1.2.3.4" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "512", points: 1000, balance_after: 1000 });
    h.db.failNext("members", "update", { code: "X", message: "should not be called" });
    const r = await enrolFromSignin({ shopifyCustomerId: "512", shop: "s", ip: "1.2.3.4" });
    expect(r).toEqual({ memberId: m.id, welcomeQueued: false });
  });
});

describe("enrolFromOrder (auto-consent at order time)", () => {
  it("creates the member with consent 'order' and queues NO welcome bonus", async () => {
    const m = await enrolFromOrder({ id: 601, email: "x@example.com", first_name: "Sara" });
    expect(m).toMatchObject({ shopify_customer_id: "601", consent_given: true, consent_source: "order" });
    expect(h.points.jobs).toHaveLength(0);
  });

  it("phone-only customer", async () => {
    const m = await enrolFromOrder({ id: 602, phone: "+923331112222" });
    expect(m).toMatchObject({ email: null, phone: "+923331112222", consent_given: true });
  });

  it("existing row without consent is updated, and missing details are filled in", async () => {
    const existing = seedMember(h.db, { shopify_customer_id: "603", consent_given: false, email: null });
    await enrolFromOrder({ id: "603", email: "new@example.com", phone: "0300" });
    expect(existing).toMatchObject({ consent_given: true, consent_source: "order", email: "new@example.com", phone: "0300" });
  });

  it("opted-out member is not re-enrolled by her next order", async () => {
    const existing = seedMember(h.db, { shopify_customer_id: "604", consent_given: false, opted_out: true });
    await enrolFromOrder({ id: "604", email: existing.email as string });
    expect(existing.consent_given).toBe(false);
  });

  it("enrolMember (customers/create) keeps a row without consent", async () => {
    expect(await enrolMember({ id: 605, phone: "+92300" })).toEqual({ enrolled: true });
    expect(h.db.table("members")[0]).toMatchObject({ consent_given: false, consent_source: null });
    expect(await enrolMember({ id: 605 })).toMatchObject({ enrolled: false, reason: "already_member" });
  });
});

describe("awardSignup", () => {
  it("awards signup_points from settings once, with a customer-facing note and an expiry for Silver", async () => {
    h.db.table("app_settings")[0].signup_points = 1500;
    const m = seedMember(h.db, { shopify_customer_id: "701" });
    expect(await awardSignup(String(m.id))).toEqual({ awarded: true });
    expect(m.points_balance).toBe(1500);
    const row = h.db.table("points_ledger")[0];
    expect(row).toMatchObject({ action_type: "signup", reference_id: "701", points: 1500, customer_note: "Welcome bonus" });
    expect(row.expires_at).not.toBeNull();
    expect(h.notifications.named("welcome")).toHaveLength(1);
    expect(await awardSignup(String(m.id))).toMatchObject({ awarded: false });
    expect(m.points_balance).toBe(1500);
  });

  it("does not require consent_given (finding B4) but refuses blocked and opted-out members", async () => {
    const noConsent = seedMember(h.db, { consent_given: false });
    expect((await awardSignup(String(noConsent.id))).awarded).toBe(true);
    const blocked = seedMember(h.db, { is_blocked: true });
    expect(await awardSignup(String(blocked.id))).toMatchObject({ awarded: false, reason: "blocked" });
    const out = seedMember(h.db, { opted_out: true });
    expect(await awardSignup(String(out.id))).toMatchObject({ awarded: false, reason: "opted_out" });
  });
});

describe("opt-out and birthday", () => {
  it("setOptOut flips only opted_out (is_blocked is separate)", async () => {
    const m = seedMember(h.db);
    await setOptOut(String(m.id), true);
    expect(m).toMatchObject({ opted_out: true, is_blocked: false });
    await setOptOut(String(m.id), false);
    expect(m.opted_out).toBe(false);
  });

  it("customer can set her birthday once; a second attempt is refused", async () => {
    const m = seedMember(h.db);
    expect(await setBirthday(String(m.id), 3, 14, { byAdmin: false })).toEqual({ ok: true });
    expect(m).toMatchObject({ birthday_month: 3, birthday_day: 14 });
    expect(m.birthday_set_at).not.toBeNull();
    expect(await setBirthday(String(m.id), 4, 1, { byAdmin: false })).toEqual({ ok: false, reason: "already_set" });
    expect(m.birthday_month).toBe(3);
  });

  it("admin can change it afterwards", async () => {
    const m = seedMember(h.db, { birthday_month: 3, birthday_day: 14, birthday_set_at: "2026-01-01T00:00:00Z" });
    expect(await setBirthday(String(m.id), 7, 9, { byAdmin: true })).toEqual({ ok: true });
    expect(m).toMatchObject({ birthday_month: 7, birthday_day: 9 });
  });

  it("invalid dates are refused before any write", async () => {
    const m = seedMember(h.db);
    expect(await setBirthday(String(m.id), 2, 31, { byAdmin: false })).toEqual({ ok: false, reason: "invalid_date" });
    expect(m.birthday_month).toBeNull();
  });
});

describe("checkAndUpgradeTier", () => {
  it("upgrades at the settings threshold, writes tier_history, clears expiry, queues the tier reward", async () => {
    h.db.table("app_settings")[0].tier_gold_threshold_pkr = 20000;
    const m = seedMember(h.db);
    const row = h.db.seed("points_ledger", { member_id: m.id, action_type: "purchase", reference_id: "o", points: 10, balance_after: 10, expires_at: "2027-01-01T00:00:00Z" });
    expect(await checkAndUpgradeTier(String(m.id), 25000, "silver", { shopifyOrderId: "O1", shop: "s" })).toBe("gold");
    expect(m.tier).toBe("gold");
    expect(h.db.table("tier_history")[0]).toMatchObject({ member_id: m.id, from_tier: "silver", to_tier: "gold", shopify_order_id: "O1" });
    expect(row.expires_at).toBeNull();
    expect(h.points.named("issue_tier_reward")[0].data).toMatchObject({ memberId: m.id, fromTier: "silver", toTier: "gold", shop: "s" });
  });

  it("never downgrades and does nothing below the threshold", async () => {
    const m = seedMember(h.db, { tier: "diamond" });
    expect(await checkAndUpgradeTier(String(m.id), 10, "diamond")).toBe("diamond");
    const s = seedMember(h.db);
    expect(await checkAndUpgradeTier(String(s.id), 49999, "silver")).toBe("silver");
    expect(h.db.table("tier_history")).toHaveLength(0);
    expect(h.points.jobs).toHaveLength(0);
  });

  it("two jobs cannot both record the same upgrade", async () => {
    const m = seedMember(h.db);
    await checkAndUpgradeTier(String(m.id), 60000, "silver");
    // a second job that read the member before the first one finished
    expect(await checkAndUpgradeTier(String(m.id), 60000, "silver")).toBe("gold");
    expect(h.db.table("tier_history")).toHaveLength(1);
  });
});

describe("awardSocial", () => {
  const action = (memberId: unknown, platform = "instagram") =>
    h.db.seed("social_actions", { member_id: memberId, action_type: platform, pending_until: new Date().toISOString() });

  it("awards the per-platform points from settings once", async () => {
    h.db.table("app_settings")[0].social_points_instagram = 750;
    const m = seedMember(h.db);
    const a = action(m.id);
    expect(await awardSocial(String(a.id))).toEqual({ awarded: true });
    expect(m.points_balance).toBe(750);
    expect(a).toMatchObject({ status: "awarded", points_awarded: 750 });
    expect(await awardSocial(String(a.id))).toMatchObject({ awarded: false });
    expect(m.points_balance).toBe(750);
  });

  it("blocked, opted-out and switched-off rules void the claim", async () => {
    const blocked = seedMember(h.db, { is_blocked: true });
    const a1 = action(blocked.id);
    expect(await awardSocial(String(a1.id))).toMatchObject({ awarded: false, reason: "blocked" });
    expect(a1.status).toBe("voided");

    h.db.table("app_settings")[0].earn_rules = { youtube: { enabled: false } };
    bustSettingsCache();
    const ok = seedMember(h.db);
    const a2 = action(ok.id, "youtube");
    expect(await awardSocial(String(a2.id))).toMatchObject({ awarded: false, reason: "rule_off" });
    expect(ok.points_balance).toBe(0);
  });
  it("a failed member read is not 'no member': the claim stays pending instead of being voided", async () => {
    const m = seedMember(h.db);
    const a = action(m.id);
    h.db.failNext("members", "select", { code: "57014", message: "timeout" });
    await expect(awardSocial(String(a.id))).rejects.toThrow(/member lookup failed/);
    expect(a.status).toBe("pending");
    expect(await awardSocial(String(a.id))).toEqual({ awarded: true });
  });
});

describe("expireSilverPoints", () => {
  it("expires overdue tranches of ANY action type for Silver members only, and only what is left", async () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const past = "2026-11-01T00:00:00Z";
    const silver = seedMember(h.db, { points_balance: 1600 });
    const gold = seedMember(h.db, { tier: "gold", points_balance: 500 });
    h.db.seed("points_ledger", { member_id: silver.id, action_type: "signup", reference_id: "a", points: 1000, points_remaining: 600, balance_after: 1000, expires_at: past });
    h.db.seed("points_ledger", { member_id: silver.id, action_type: "social_instagram", reference_id: "b", points: 1000, points_remaining: 1000, balance_after: 2000, expires_at: "2027-06-01T00:00:00Z" });
    h.db.seed("points_ledger", { member_id: gold.id, action_type: "purchase", reference_id: "c", points: 500, points_remaining: 500, balance_after: 500, expires_at: past });

    const r = await expireSilverPoints(now);
    expect(r).toMatchObject({ membersAffected: 1, pointsExpired: 600 });
    expect(silver.points_balance).toBe(1000); // only the 600 left in the overdue tranche
    expect(gold.points_balance).toBe(500); // Gold never expires
    const call = h.db.rpcCalls.find((c) => c.args.p_action_type === "expiry")!;
    expect(call.args.p_customer_note).toBe("Points expired");
    // running again finds nothing
    expect((await expireSilverPoints(now)).pointsExpired).toBe(0);
  });
});

describe("privacy webhooks", () => {
  it("redactCustomer strips personal details and keeps the points history", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "901", phone: "0300", first_name: "A", last_seen_ip: "1.1.1.1", birthday_month: 2 });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "901", points: 1000, balance_after: 1000 });
    expect(await redactCustomer("901")).toEqual({ redacted: true });
    expect(m).toMatchObject({ phone: null, first_name: null, last_seen_ip: null, birthday_month: null, opted_out: true });
    expect(String(m.email)).toMatch(/@redacted\.invalid$/);
    expect(h.db.table("points_ledger")).toHaveLength(1);
  });

  it("shop/redact deletes NOTHING: it records the request and raises an alert heartbeat", async () => {
    const m = seedMember(h.db, { points_balance: 5000 });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "x", points: 5000, balance_after: 5000 });
    h.db.seed("order_webhook_state", { shopify_order_id: "O1", shopify_customer_id: m.shopify_customer_id });
    h.db.seed("loyalty_codes", { member_id: m.id, code: "REWARD-1", discount_amount: 100, points_spent: 3000, expires_at: "2027-01-01" });

    expect(await recordShopRedactRequest("store.myshopify.com", { shop_id: 1 })).toEqual({ recorded: true });

    expect(h.db.table("members")).toHaveLength(1);
    expect(h.db.table("points_ledger")).toHaveLength(1);
    expect(h.db.table("order_webhook_state")).toHaveLength(1);
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
    expect(m.points_balance).toBe(5000);
    expect(h.db.table("gdpr_requests")[0]).toMatchObject({ type: "shop_redact", status: "open" });
    expect(h.db.table("system_heartbeat")[0]).toMatchObject({ key: "alert:shop_redact" });
  });
});

describe("fix round", () => {
  it("M4: the welcome-bonus job has no fixed id, so an old failed job cannot block it", async () => {
    seedMember(h.db, { shopify_customer_id: "800" });
    expect((await enrolFromSignin({ shopifyCustomerId: "800", shop: "s" })).welcomeQueued).toBe(true);
    expect(h.points.named("award_signup_points")[0].opts).toBeUndefined();
  });

  it("M4: if the job cannot be queued, welcomeQueued is false (not a false promise)", async () => {
    seedMember(h.db, { shopify_customer_id: "801" });
    h.points.add = async () => { throw new Error("redis down"); };
    expect(await enrolFromSignin({ shopifyCustomerId: "801", shop: "s" })).toMatchObject({ welcomeQueued: false, reason: "enqueue_failed" });
  });

  it("L3: a redacted, opted-out member who orders again does not get her name, phone or email back", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "802", first_name: "Sara", phone: "0300" });
    await redactCustomer("802");
    await enrolFromOrder({ id: "802", email: "sara@example.com", phone: "03001234567", first_name: "Sara", last_name: "Khan" });
    await enrolMember({ id: "802", email: "sara@example.com", first_name: "Sara" });
    expect(m).toMatchObject({ first_name: null, last_name: null, phone: null, opted_out: true, consent_given: false });
    expect(String(m.email)).toMatch(/@redacted\.invalid$/);
  });

  it("L3: an opted-out (not redacted) member's missing details are not filled in either", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "803", opted_out: true, phone: null });
    await enrolFromOrder({ id: "803", phone: "0300" });
    expect(m.phone).toBeNull();
  });

  it("L6: a unique clash on another column enrols the customer without contact details instead of failing for ever", async () => {
    h.db.failNext("members", "insert", { code: "23505", message: 'duplicate key value violates unique constraint "members_email_key"' });
    const m = await enrolFromOrder({ id: 804, email: "dup@example.com", phone: "0300", first_name: "Hina" });
    expect(m).toMatchObject({ shopify_customer_id: "804", email: null, phone: null, first_name: "Hina", consent_given: true });
  });

  it("L6: a clash that persists gives null, never an exception", async () => {
    h.db.failNext("members", "insert", { code: "23505", message: "members_email_key" });
    h.db.failNext("members", "insert", { code: "23505", message: "members_other_key" });
    await expect(enrolFromOrder({ id: 805, email: "dup@example.com" })).resolves.toBeNull();
  });

  it("L1: an overdue tranche that was spent in full is closed without a 0-point ledger row", async () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const m = seedMember(h.db, { points_balance: 300 });
    const spent = h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "a", points: 1000, points_remaining: 0, balance_after: 1000, expires_at: "2026-11-01T00:00:00Z" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "review", reference_id: "b", points: 300, points_remaining: 300, balance_after: 300, expires_at: "2027-06-01T00:00:00Z" });
    const r = await expireSilverPoints(now);
    expect(r).toMatchObject({ pointsExpired: 0, membersAffected: 0 });
    expect(spent.expired).toBe(true);
    expect(h.db.table("points_ledger").filter((l) => l.action_type === "expiry")).toHaveLength(0);
    expect(h.db.rpcCalls.filter((c) => c.args.p_action_type === "expiry")).toHaveLength(0);
    expect(m.points_balance).toBe(300);
  });
});

describe("H3a: tier follow-ups are atomic and state-driven", () => {
  it("the upgrade goes through one database call (tier + history + expiry together)", async () => {
    const m = seedMember(h.db);
    await checkAndUpgradeTier(String(m.id), 60000, "silver", { shopifyOrderId: "O1", shop: "s" });
    expect(h.db.rpcCalls.filter((c) => c.fn === "upgrade_member_tier")).toEqual([
      { fn: "upgrade_member_tier", args: { p_member_id: m.id, p_to_tier: "gold", p_shopify_order_id: "O1" } },
    ]);
  });

  it("a queueing failure is thrown (so the job retries), and the retry still queues the reward", async () => {
    const m = seedMember(h.db);
    const realAdd = h.points.add;
    h.points.add = async () => { throw new Error("redis down"); };
    await expect(checkAndUpgradeTier(String(m.id), 60000, "silver", { shop: "s" })).rejects.toThrow(/redis down/);
    expect(m.tier).toBe("gold"); // the upgrade itself is done

    h.points.add = realAdd;
    // retry: the member is already Gold, so "this call upgraded" is false, yet the code is still owed
    expect(await checkAndUpgradeTier(String(m.id), 60000, "gold", { shop: "s" })).toBe("gold");
    expect(h.points.named("issue_tier_reward")).toHaveLength(1);
    expect(h.points.named("issue_tier_reward")[0].data).toMatchObject({ memberId: m.id, fromTier: "silver", toTier: "gold" });
    expect(h.db.table("tier_history")).toHaveLength(1);
  });

  it("once the code row exists nothing more is queued, however often it runs", async () => {
    const m = seedMember(h.db);
    await checkAndUpgradeTier(String(m.id), 60000, "silver");
    h.db.seed("loyalty_codes", { member_id: m.id, code: "GOLD-1", kind: "tier_gold", issue_key: `tier_gold:${m.id}`, status: "pending", discount_amount: 0, points_spent: 0, expires_at: "2027-01-01" });
    h.points.clear();
    await checkAndUpgradeTier(String(m.id), 61000, "gold");
    await checkAndUpgradeTier(String(m.id), 62000, "gold");
    expect(h.points.jobs).toHaveLength(0);
  });

  it("expiry dates left behind by an interrupted upgrade are cleared on the next run", async () => {
    const m = seedMember(h.db, { tier: "gold" });
    const row = h.db.seed("points_ledger", { member_id: m.id, action_type: "purchase", reference_id: "o", points: 10, points_remaining: 10, balance_after: 10, expires_at: "2027-01-01T00:00:00Z" });
    await checkAndUpgradeTier(String(m.id), 60000, "gold");
    expect(row.expires_at).toBeNull();
  });

  it("Gold then Diamond: only the missing Diamond code is queued; Silver straight to Diamond owes both", async () => {
    const m = seedMember(h.db);
    await checkAndUpgradeTier(String(m.id), 60000, "silver");
    h.db.seed("loyalty_codes", { member_id: m.id, code: "GOLD-1", kind: "tier_gold", issue_key: `tier_gold:${m.id}`, discount_amount: 0, points_spent: 0, expires_at: "2027-01-01" });
    h.points.clear();
    await checkAndUpgradeTier(String(m.id), 120000, "gold");
    expect(h.points.named("issue_tier_reward")[0].data).toMatchObject({ fromTier: "gold", toTier: "diamond" });

    const jump = seedMember(h.db);
    h.points.clear();
    await checkAndUpgradeTier(String(jump.id), 150000, "silver");
    expect(h.points.named("issue_tier_reward")[0].data).toMatchObject({ fromTier: "silver", toTier: "diamond" });
  });

  it("members who were Gold before v3 (no history row), blocked members, and switched-off rewards get nothing", async () => {
    const legacy = seedMember(h.db, { tier: "gold" });
    await checkAndUpgradeTier(String(legacy.id), 60000, "gold");
    const blocked = seedMember(h.db, { is_blocked: true });
    await checkAndUpgradeTier(String(blocked.id), 60000, "silver");
    h.db.table("app_settings")[0].tier_reward_gold_free_shipping = false;
    bustSettingsCache();
    const off = seedMember(h.db);
    await checkAndUpgradeTier(String(off.id), 60000, "silver");
    expect(h.points.jobs).toHaveLength(0);
  });
});
