import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./admin-test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";
const approveReferral = vi.fn();
const rejectReferral = vi.fn();
const setReferralsBlocked = vi.fn();

beforeEach(() => {
  vi.resetModules();
  approveReferral.mockReset();
  rejectReferral.mockReset();
  setReferralsBlocked.mockReset();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("./referrals.service", () => ({ approveReferral, rejectReferral }));
  vi.doMock("./admin-members.server", () => ({ setReferralsBlocked }));
  const mod = await import("./admin-referrals.server");
  return { fake, mod };
}

describe("referral reason", () => {
  it("explains why a referral is held, from fraud_flags", async () => {
    const { mod } = await load();
    // current rules (19 Nov 2026)
    expect(mod.referralReason({ status: "blocked", fraud_flags: ["same_email"] })).toBe("The friend's email is the referrer's email");
    expect(mod.referralReason({ status: "blocked", fraud_flags: ["same_phone"] })).toBe("The friend's phone number is the referrer's");
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["similar_email", "same_name"] }))
      .toBe("The friend's email looks like the referrer's; The friend has the same first and last name as the referrer");
    expect(mod.referralReason({ status: "blocked", fraud_flags: ["same_phone_on_order"] })).toBe("The friend's order uses the referrer's phone number");
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["same_address_on_order"] })).toBe("The friend's order delivers to the referrer's address");
    // older rows keep a readable reason
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["same_network"] }))
      .toBe("Friend signed in from the same network address as the referrer (old rule, no longer used)");
    expect(mod.referralReason({ status: "blocked", fraud_flags: ["same_contact"] }))
      .toBe("Friend has the same email or phone as the referrer");
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["same_ip", "same_network"] }))
      .toBe("Friend signed in from the same network address as the referrer (old rule, no longer used)");
    expect(mod.orderCheckNote({ order_check: "not_checked" })).toContain("was not checked");
    expect(mod.orderCheckNote({ order_check: "clear" })).toBe("");
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["new_rule"] })).toBe("new rule");
  });

  it("falls back to the stored reason, and shows nothing for referrals that are not held", async () => {
    const { mod } = await load();
    expect(mod.referralReason({ status: "flagged", fraud_flags: [], block_reason: "Manual hold" })).toBe("Manual hold");
    expect(mod.referralReason({ status: "flagged", fraud_flags: [] })).toBe("No reason was recorded");
    expect(mod.referralReason({ status: "pending", fraud_flags: ["same_network"] })).toBe("");
    expect(mod.referralReason({ status: "completed" })).toBe("");
  });
});

describe("listReferrals", () => {
  it("filters by status, pages in the database and has no IP-match field (R5)", async () => {
    const { fake, mod } = await load({
      from: () => ({
        count: 3,
        data: [{
          id: ID, referrer_member_id: "m1", referred_email: "friend@x.com", referred_shopify_customer_id: "C9",
          status: "flagged", block_reason: null, fraud_flags: ["same_address_on_order"], reward_points: null,
          order_check: "same_address", alert_resolved_at: null,
          created_at: "2026-11-10T00:00:00Z", completed_at: null, reviewed_note: null,
          members: { first_name: "Sara", last_name: "K", is_influencer: true },
        }],
      }),
    });
    const res = await mod.listReferrals({ status: "flagged", page: 1, pageSize: 25 });
    expect(res.total).toBe(3);
    expect(res.rows[0]).toMatchObject({
      referrerName: "Sara K", referrerIsInfluencer: true, friend: "friend@x.com", statusLabel: "Held for review",
      reason: "The friend's order delivers to the referrer's address", rewardPoints: null,
      alertOpen: true, orderCheckNote: "", referrerReferralsBlocked: false,
    });
    expect(res.rows[0]).not.toHaveProperty("ipMatch");
    const chain = fake.tableCalls("referrals")[0].chain;
    expect(chain).toContainEqual(["eq", ["status", "flagged"]]);
    expect(chain).toContainEqual(["range", [25, 49]]);
    expect(String(chain[0][1][0])).not.toContain("referred_ip");
  });

  it("names a friend with no email by her customer number", async () => {
    const { mod } = await load({
      from: () => ({ count: 1, data: [{ id: ID, referrer_member_id: "m1", referred_email: null, referred_shopify_customer_id: "777", status: "pending", members: null }] }),
    });
    const res = await mod.listReferrals({});
    expect(res.rows[0].friend).toBe("Customer 777");
    expect(res.rows[0].referrerName).toBe("Customer");
  });

  it("accepts only known statuses", async () => {
    const { mod } = await load();
    expect(mod.parseReferralStatus("rejected")).toBe("rejected");
    expect(mod.parseReferralStatus("all")).toBeNull();
    expect(mod.parseReferralStatus("x' or 1=1")).toBeNull();
  });
});

describe("summary", () => {
  it("reads the funnel from the database", async () => {
    const { fake, mod } = await load({
      rpc: () => ({ data: { recorded: 148, with_order: 70, completed: 61, pending: 80, flagged: 3, blocked: 2, rejected: 2, points_paid: 534000 } }),
    });
    expect(await mod.referralSummary("a", "b")).toEqual({
      recorded: 148, withOrder: 70, completed: 61, pending: 80, flagged: 3, blocked: 2, rejected: 2, pointsPaid: 534000,
    });
    expect(fake.rpcCalls("admin_referral_funnel")[0].args).toEqual({ p_from: "a", p_to: "b" });
  });
});

describe("approve and reject", () => {
  it("approve calls the engine and says when the referrer was paid (L5)", async () => {
    const { mod } = await load();
    approveReferral.mockResolvedValueOnce({ ok: true, paid: true });
    expect(await mod.approve(ID, "Ayesha", "heygirl-pk.myshopify.com"))
      .toEqual({ ok: true, message: "Referral approved and the referrer has been paid" });
    expect(approveReferral).toHaveBeenCalledWith(ID, "Ayesha", "heygirl-pk.myshopify.com");
  });

  it("approve explains that payment waits for the friend's first order", async () => {
    const { mod } = await load();
    approveReferral.mockResolvedValueOnce({ ok: true, paid: false });
    const res = await mod.approve(ID, "Ayesha", "s.myshopify.com");
    expect(res.ok && res.message).toContain("pays when the friend's first order is delivered and paid");
  });

  it("approve reports a referral that was already reviewed", async () => {
    const { mod } = await load();
    approveReferral.mockResolvedValueOnce({ ok: false, paid: false, reason: "not_flagged" });
    const res = await mod.approve(ID, "Ayesha", "s.myshopify.com");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain("not flagged");
  });

  it("rejects a malformed id without calling the engine", async () => {
    const { mod } = await load();
    expect((await mod.approve("abc", "A", "s")).ok).toBe(false);
    expect((await mod.reject("abc", "A", "")).ok).toBe(false);
    expect(approveReferral).not.toHaveBeenCalled();
    expect(rejectReferral).not.toHaveBeenCalled();
  });

  it("reject passes a trimmed note, or none, and limits its length", async () => {
    const { mod } = await load();
    rejectReferral.mockResolvedValue({ ok: true });
    await mod.reject(ID, "Ayesha", "  same household  ");
    expect(rejectReferral).toHaveBeenLastCalledWith(ID, "Ayesha", "same household");
    await mod.reject(ID, "Ayesha", "   ");
    expect(rejectReferral).toHaveBeenLastCalledWith(ID, "Ayesha", undefined);
    const tooLong = await mod.reject(ID, "Ayesha", "x".repeat(301));
    expect(tooLong.ok).toBe(false);
    expect(rejectReferral).toHaveBeenCalledTimes(2);
  });

  it("reject reports failure from the engine", async () => {
    const { mod } = await load();
    rejectReferral.mockResolvedValueOnce({ ok: false });
    expect((await mod.reject(ID, "Ayesha", "")).ok).toBe(false);
  });
});

describe("one referral, and Home alerts from the order-time check (016)", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";

  it("listReferrals with a referral id shows only that referral; a bad id is ignored", async () => {
    const { fake, mod } = await load({ from: () => ({ count: 1, data: [] }) });
    await mod.listReferrals({ status: "flagged", referralId: ID });
    expect(fake.tableCalls("referrals")[0].chain).toContainEqual(["eq", ["id", ID]]);
    expect(fake.tableCalls("referrals")[0].chain).not.toContainEqual(["eq", ["status", "flagged"]]);
    await mod.listReferrals({ status: "flagged", referralId: "1 or 1=1" });
    expect(fake.tableCalls("referrals")[1].chain).toContainEqual(["eq", ["status", "flagged"]]);
  });

  it("lists open alerts with the order number, newest first, and never any phone or address", async () => {
    const { fake, mod } = await load({
      from: (table) => table === "referrals"
        ? { data: [
            { id: ID, referrer_member_id: "m1", status: "blocked", order_check: "same_phone", order_checked_order_id: "5", order_tag: "tagged", members: { first_name: "Sara", last_name: "K", referrals_blocked: false } },
            { id: OTHER, referrer_member_id: "m2", status: "flagged", order_check: "same_address", order_checked_order_id: "6", order_tag: "failed", members: { first_name: "Hina", last_name: null, referrals_blocked: true } },
          ] }
        : { data: [{ shopify_order_id: "5", order_name: "#1007" }] },
    });
    const alerts = await mod.listReferralOrderAlerts(10);
    expect(alerts[0]).toMatchObject({
      referralId: ID, kind: "phone", orderName: "#1007", referrerName: "Sara K", referrerReferralsBlocked: false,
      title: "Order #1007 used a referral free-shipping code but delivers to the referrer's phone number",
    });
    expect(alerts[1]).toMatchObject({ kind: "address", orderName: null, referrerReferralsBlocked: true, title: "An order used a referral free-shipping code but delivers to the referrer's address" });
    expect(alerts[1].detail).toContain("held");
    // the alert says whether the order carries the review tag in Shopify
    expect(alerts[0].detail).toContain('The order is tagged "Rewards: check referral" in Shopify.');
    expect(alerts[1].detail).toContain('The order could not be tagged "Rewards: check referral" in Shopify');
    const chain = fake.tableCalls("referrals")[0].chain;
    expect(chain).toContainEqual(["in", ["order_check", ["same_phone", "same_address"]]]);
    expect(chain).toContainEqual(["is", ["alert_resolved_at", null]]);
    expect(fake.tableCalls("order_webhook_state")[0].chain).toContainEqual(["in", ["shopify_order_id", ["5", "6"]]]);
  });

  it("order link in Shopify admin", async () => {
    const { mod } = await load();
    expect(mod.shopifyOrderUrl("heygirl-pk.myshopify.com", "5550001")).toBe("https://heygirl-pk.myshopify.com/admin/orders/5550001");
    expect(mod.shopifyOrderUrl("evil.com", "1")).toBeNull();
  });

  it("dismiss closes the alert once", async () => {
    let n = 0;
    const { fake, mod } = await load({ from: () => ({ data: n++ === 0 ? [{ id: ID }] : [] }) });
    expect(await mod.dismissReferralAlert(ID)).toEqual({ ok: true, message: "Alert dismissed" });
    expect(Object.keys(fake.firstArg("referrals", "update") as object)).toEqual(["alert_resolved_at"]);
    expect((await mod.dismissReferralAlert(ID)).ok).toBe(false);
    expect((await mod.dismissReferralAlert("nope")).ok).toBe(false);
  });

  it("block this referrer: sets referrals_blocked on the referrer (with who did it) and closes the alert", async () => {
    setReferralsBlocked.mockResolvedValue(true);
    const { fake, mod } = await load({ from: (_t, chain) => (chain.some(([m]) => m === "maybeSingle") ? { data: { id: ID, referrer_member_id: "m1" } } : { data: null }) });
    expect(await mod.blockReferrer(ID, "Ayesha")).toEqual({ ok: true, message: "Referrer blocked. Her referral link no longer earns" });
    expect(setReferralsBlocked).toHaveBeenCalledWith("m1", true, "Ayesha");
    expect(fake.firstArg("referrals", "update")).toHaveProperty("alert_resolved_at");
  });

  it("block this referrer refuses an unknown referral", async () => {
    const { mod } = await load({ from: () => ({ data: null }) });
    expect((await mod.blockReferrer(ID, "A")).ok).toBe(false);
    expect(setReferralsBlocked).not.toHaveBeenCalled();
  });
});
