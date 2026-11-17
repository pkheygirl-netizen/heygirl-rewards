import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./admin-test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";
const approveReferral = vi.fn();
const rejectReferral = vi.fn();

beforeEach(() => {
  vi.resetModules();
  approveReferral.mockReset();
  rejectReferral.mockReset();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("./referrals.service", () => ({ approveReferral, rejectReferral }));
  const mod = await import("./admin-referrals.server");
  return { fake, mod };
}

describe("referral reason", () => {
  it("explains why a referral is held, from fraud_flags", async () => {
    const { mod } = await load();
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["same_network"] }))
      .toBe("Friend signed in from the same network address as the referrer");
    expect(mod.referralReason({ status: "blocked", fraud_flags: ["same_contact"] }))
      .toBe("Friend has the same email or phone as the referrer");
    expect(mod.referralReason({ status: "flagged", fraud_flags: ["same_ip", "same_network"] }))
      .toBe("Friend signed in from the same network address as the referrer");
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
          status: "flagged", block_reason: null, fraud_flags: ["same_network"], reward_points: null,
          created_at: "2026-11-10T00:00:00Z", completed_at: null, reviewed_note: null,
          members: { first_name: "Sara", last_name: "K", is_influencer: true },
        }],
      }),
    });
    const res = await mod.listReferrals({ status: "flagged", page: 1, pageSize: 25 });
    expect(res.total).toBe(3);
    expect(res.rows[0]).toMatchObject({
      referrerName: "Sara K", referrerIsInfluencer: true, friend: "friend@x.com", statusLabel: "Held for review",
      reason: "Friend signed in from the same network address as the referrer", rewardPoints: null,
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
