// Review 12, item 2: the reviewer's race reproductions (/tmp/review12/vt/race.test.ts),
// ported with the outcome each must now have. Since migration 017 a referral is paid
// in one database call (pay_referral) under the referral's row lock, so the
// interleavings the reviewer used (between the order re-read and the award)
// now land right before or right after that call. The real locking is tested
// against Postgres in supabase/tests/010_v3_core.pgtest.mjs, section [18].
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { completeReferralForCustomer, finishClaimedReferrals, resetHeldCheckAttempts, resetTagScopeLog, reverseReferralForOrder } from "./referrals.service";

let orders = 0;
const NODE = "gid://shopify/DiscountCodeNode/9";
function shopify(q: string) {
  switch (opName(q)) {
    case "HgCustomerOrderCount": return { customer: { numberOfOrders: String(orders) } };
    case "HgDiscountCodeFreeShippingCreate": return { discountCodeFreeShippingCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } };
    default: return {};
  }
}
const referral = () => h.db.table("referrals")[0];
const ledgerOf = (a: string) => h.db.table("points_ledger").filter((l) => l.action_type === a);
const NOW = new Date(Date.now() + 60_000);
/** A payment half-done by the code before 017, claimed a day ago (older than the 10-minute grace for both the cron and an order event). */
function seedClaimed(referrerId: unknown) {
  return h.db.seed("referrals", {
    referrer_member_id: referrerId, referred_shopify_customer_id: "FR", status: "completed", points_awarded: false,
    reward_points: 6000, shopify_order_id: "O1", completed_at: new Date(Date.now() - 24 * 3_600_000).toISOString(), order_checked_order_id: "O1",
  });
}
const seedOrder = () => h.db.seed("order_webhook_state", { shopify_order_id: "O1", shopify_customer_id: "FR", points_awarded: true, earning_basis_pkr: 2000, placed_at: "2026-11-10T00:00:00Z" });

beforeEach(() => {
  resetHarness(); bustSettingsCache(); orders = 0; h.graphql = shopify; resetHeldCheckAttempts(); resetTagScopeLog();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("review 12 races", () => {
  it("A: the cron finishing a claim vs the worker's cancellation (cancel + reverse + completeReferral) landing right before the payment: nothing paid, pending", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    const order = seedOrder();
    seedClaimed(referrer.id);
    const realRpc = h.db.rpc.bind(h.db);
    let fired = false;
    vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (!fired && fn === "pay_referral") {
        fired = true;
        // the points worker processes orders/cancelled now
        order.cancelled_at = "2026-11-19T12:00:00Z";
        await reverseReferralForOrder("O1", "cancelled");
        await completeReferralForCustomer("FR");
      }
      return realRpc(fn, args);
    });
    const out = await finishClaimedReferrals(NOW);
    expect(fired).toBe(true);
    expect(out).toMatchObject({ paid: 0, recorded: 0, failed: 0 });
    expect(referral()).toMatchObject({ status: "pending", points_awarded: false });
    expect(referrer.points_balance).toBe(0);
    expect(ledgerOf("referral_earned")).toHaveLength(0);
    expect(h.notifications.named("referral_completed")).toHaveLength(0);
  });

  it("A2: the same cancellation landing right after the cron's payment: reversed once, rejected, no email", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    const order = seedOrder();
    seedClaimed(referrer.id);
    const realRpc = h.db.rpc.bind(h.db);
    let fired = false;
    vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      const res = await realRpc(fn, args);
      if (!fired && fn === "pay_referral") {
        fired = true;
        order.cancelled_at = "2026-11-19T12:00:00Z";
        await reverseReferralForOrder("O1", "cancelled");
        await completeReferralForCustomer("FR");
      }
      return res;
    });
    expect(await finishClaimedReferrals(NOW)).toMatchObject({ reversed: 1, failed: 0 });
    expect(referral()).toMatchObject({ status: "rejected", points_awarded: false });
    expect(referrer.points_balance).toBe(0);
    expect(ledgerOf("referral_earned")).toHaveLength(1);
    expect(ledgerOf("referral_reversal")).toHaveLength(1);
    expect(h.notifications.named("referral_completed")).toHaveLength(0);
  });

  it("B: a payment stalled while the cron runs and the referrer opts out and back in: the cron has nothing to release; a later cancellation reverses the payment", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    const order = seedOrder();
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "FR", status: "pending", points_awarded: false, order_checked_order_id: "O1" });
    const realRpc = h.db.rpc.bind(h.db);
    let fired = false;
    let cron: Awaited<ReturnType<typeof finishClaimedReferrals>> | null = null;
    vi.spyOn(h.db, "rpc").mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (!fired && fn === "pay_referral") {
        fired = true;
        referral().completed_at = "2026-11-19T00:00:00Z";
        referrer.opted_out = true;
        cron = await finishClaimedReferrals(NOW);
        referrer.opted_out = false;
      }
      return realRpc(fn, args);
    });
    expect(await completeReferralForCustomer("FR")).toMatchObject({ paid: true, points: 6000 });
    expect(cron).toMatchObject({ released: 0, paid: 0, recorded: 0 }); // no half-done state to release
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true, shopify_order_id: "O1" });
    expect(referrer.points_balance).toBe(6000);
    order.cancelled_at = "2026-11-20T00:00:00Z";
    expect(await reverseReferralForOrder("O1", "cancelled")).toEqual({ reversed: true, points: 6000 });
    expect(referrer.points_balance).toBe(0);
    expect(ledgerOf("referral_reversal")).toHaveLength(1);
    expect(referral().status).toBe("rejected");
  });

  it("B2: an older referral left pending with its points in the ledger (the old race) is still reversed when the order is cancelled", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    const order = seedOrder();
    const ref = h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: "FR", status: "pending", points_awarded: false, shopify_order_id: null });
    await h.db.rpc("award_points", { p_member_id: referrer.id, p_action_type: "referral_earned", p_reference_id: String(ref.id), p_points: 6000, p_shopify_order_id: "O1" });
    order.cancelled_at = "2026-11-20T00:00:00Z";
    expect(await reverseReferralForOrder("O1", "cancelled")).toEqual({ reversed: true, points: 6000 }); // found through the ledger row
    expect(referrer.points_balance).toBe(0);
    expect(referral().status).toBe("rejected");
  });

  it("C: two cron runs at once on the same claimed row (no ledger row): paid once, one email", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedOrder();
    seedClaimed(referrer.id);
    const [a, b] = await Promise.all([finishClaimedReferrals(NOW), finishClaimedReferrals(NOW)]);
    expect(a.paid + b.paid).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(referrer.points_balance).toBe(6000);
    expect(ledgerOf("referral_earned")).toHaveLength(1);
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
  });

  it("D: the cron and an order event at once, ledger row present: recorded once, one email", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    seedOrder();
    const ref = seedClaimed(referrer.id);
    h.db.seed("points_ledger", { member_id: referrer.id, action_type: "referral_earned", reference_id: String(ref.id), points: 6000, balance_after: 6000, shopify_order_id: "O1" });
    referrer.points_balance = 6000;
    const [a, b] = await Promise.all([finishClaimedReferrals(NOW), completeReferralForCustomer("FR")]);
    expect(a.failed).toBe(0);
    expect(a.recorded + (b.paid ? 1 : 0)).toBe(1);
    expect(referral()).toMatchObject({ status: "completed", points_awarded: true });
    expect(referrer.points_balance).toBe(6000);
    expect(h.notifications.named("referral_completed")).toHaveLength(1);
  });

  it("E: a claimed row with no friend id and no ledger row: released once, then nothing to do (not failed on every run)", async () => {
    const referrer = seedMember(h.db, { shopify_customer_id: "REF" });
    h.db.seed("referrals", { referrer_member_id: referrer.id, referred_shopify_customer_id: null, status: "completed", points_awarded: false, reward_points: 6000, shopify_order_id: "O1", completed_at: "2026-11-01T00:00:00Z" });
    expect(await finishClaimedReferrals(NOW)).toMatchObject({ released: 1, failed: 0 });
    expect(await finishClaimedReferrals(NOW)).toMatchObject({ released: 0, failed: 0 });
    expect(referral().status).toBe("pending");
  });
});
