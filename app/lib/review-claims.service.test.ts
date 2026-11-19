import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { approveReviewClaim, claimReview, rejectReviewClaim } from "./review-claims.service";
import * as reviewService from "./review-claims.service";

const awardedOrder = (cust: unknown, id: string, over = {}) =>
  h.db.seed("order_webhook_state", { shopify_order_id: id, shopify_customer_id: cust, points_awarded: true, ...over });
const claims = () => h.db.table("review_claims");

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("claimReview", () => {
  it("one claim per delivered-and-paid order, pending with review_points and no release time", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    expect(await claimReview(String(m.id))).toEqual({ ok: true });
    expect(claims()[0]).toMatchObject({ member_id: m.id, shopify_order_id: "O1", status: "pending", points: 3000, release_at: null });
    expect(m.points_balance).toBe(0); // nothing yet
    expect(await claimReview(String(m.id))).toEqual({ ok: false, reason: "no_eligible_order" }); // one order, one claim
    awardedOrder(m.shopify_customer_id, "O2");
    expect((await claimReview(String(m.id))).ok).toBe(true);
    expect(claims()).toHaveLength(2);
  });

  it("only paying customers: orders not yet awarded (not delivered and paid), or cancelled, do not count", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1", { points_awarded: false });
    awardedOrder(m.shopify_customer_id, "O2", { cancelled_at: "2026-11-01T00:00:00Z" });
    expect(await claimReview(String(m.id))).toEqual({ ok: false, reason: "no_eligible_order" });
    const fresh = seedMember(h.db); // no order at all
    expect(await claimReview(String(fresh.id))).toEqual({ ok: false, reason: "no_eligible_order" });
  });

  it("a rejected claim frees the order for another claim", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    await claimReview(String(m.id));
    await rejectReviewClaim(String(claims()[0].id), "staff");
    expect((await claimReview(String(m.id))).ok).toBe(true);
  });

  it("points come from settings; the old hold time is ignored", async () => {
    Object.assign(h.db.table("app_settings")[0], { review_release_hours: 24, review_points: 500 });
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    expect(await claimReview(String(m.id))).toEqual({ ok: true });
    expect(claims()[0]).toMatchObject({ points: 500, release_at: null });
  });

  it("blocked / opted-out members and a switched-off rule", async () => {
    const b = seedMember(h.db, { is_blocked: true });
    awardedOrder(b.shopify_customer_id, "O1");
    expect(await claimReview(String(b.id))).toEqual({ ok: false, reason: "blocked" });
    const o = seedMember(h.db, { opted_out: true });
    expect(await claimReview(String(o.id))).toEqual({ ok: false, reason: "blocked" });
    h.db.table("app_settings")[0].earn_rules = { review: { enabled: false } };
    bustSettingsCache();
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O9");
    expect(await claimReview(String(m.id))).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("manual approval (owner decision 18 Nov 2026)", () => {
  const pending = (over = {}) => {
    const m = seedMember(h.db);
    const order = awardedOrder(m.shopify_customer_id, "O1", { earning_basis_pkr: 2000, points_awarded_amount: 2000 });
    const claim = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000, release_at: "2026-11-01T00:00:00Z", ...over });
    return { m, order, claim };
  };

  it("nothing is released automatically: the engine has no release function any more", () => {
    expect(Object.keys(reviewService).sort()).toEqual(["approveReviewClaim", "claimReview", "rejectReviewClaim"]);
  });

  it("approve pays once as 'review' points with the claim id as key, records the staff member and notifies", async () => {
    const { m, claim } = pending();
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toEqual({ ok: true, points: 3000, alreadyPaid: false });
    expect(m.points_balance).toBe(3000);
    expect(claim.status).toBe("awarded");
    expect(claim.resolved_at).toBeTruthy();
    const call = h.db.rpcCalls.find((c) => c.fn === "award_points")!;
    expect(call.args).toMatchObject({ p_member_id: m.id, p_action_type: "review", p_reference_id: String(claim.id), p_points: 3000, p_shopify_order_id: "O1", p_reason_note: "Review claim approved by Ayesha", p_customer_note: "Thanks for your review" });
    expect(h.db.table("points_ledger")[0]).toMatchObject({ action_type: "review", reference_id: claim.id, points: 3000 });
    expect(h.db.table("staff_notes")[0]).toMatchObject({ member_id: m.id, author: "Ayesha", note: "Review claim approved: 3000 points" });
    expect(h.notifications.named("review_released")).toHaveLength(1);
  });

  it("idempotent: a second approval is refused and pays nothing more", async () => {
    const { m, claim } = pending();
    await approveReviewClaim(String(claim.id), "Ayesha");
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toEqual({ ok: false, reason: "already_resolved" });
    expect(m.points_balance).toBe(3000);
    expect(h.db.table("points_ledger")).toHaveLength(1);
    expect(h.notifications.named("review_released")).toHaveLength(1);
  });

  it("points already written under the same key (an earlier attempt) are not paid twice", async () => {
    const { m, claim } = pending();
    await h.db.rpc("award_points", { p_member_id: m.id, p_action_type: "review", p_reference_id: String(claim.id), p_points: 3000 });
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toEqual({ ok: true, points: 3000, alreadyPaid: true });
    expect(m.points_balance).toBe(3000);
    expect(claim.status).toBe("awarded");
    expect(h.notifications.named("review_released")).toHaveLength(0);
  });

  it("refuses a rejected claim and an unknown one", async () => {
    const { m, claim } = pending({ status: "rejected" });
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toEqual({ ok: false, reason: "already_resolved" });
    expect(await approveReviewClaim("00000000-0000-4000-8000-000000000000", "Ayesha")).toEqual({ ok: false, reason: "not_found" });
    expect(m.points_balance).toBe(0);
  });

  it("checked at approval time: blocked or opted-out member, switched-off rule, cancelled or fully refunded order; the claim stays pending", async () => {
    for (const setup of [
      (x: ReturnType<typeof pending>) => { x.m.is_blocked = true; },
      (x: ReturnType<typeof pending>) => { x.m.opted_out = true; },
      (x: ReturnType<typeof pending>) => { x.order.cancelled_at = "2026-11-05T00:00:00Z"; },
      (x: ReturnType<typeof pending>) => { Object.assign(x.order, { refunded_basis_pkr: 2000, points_reversed_amount: 2000 }); },
      () => { h.db.table("app_settings")[0].earn_rules = { review: { enabled: false } }; bustSettingsCache(); },
    ]) {
      resetHarness(); bustSettingsCache();
      const x = pending();
      setup(x);
      const r = await approveReviewClaim(String(x.claim.id), "Ayesha");
      expect(r.ok).toBe(false);
      expect(x.claim.status).toBe("pending");
      expect(x.m.points_balance).toBe(0);
      expect(h.db.rpcCalls.filter((c) => c.fn === "award_points")).toHaveLength(0);
    }
    resetHarness(); bustSettingsCache();
    const part = pending();
    Object.assign(part.order, { refunded_basis_pkr: 500, points_reversed_amount: 500 });
    expect(await approveReviewClaim(String(part.claim.id), "Ayesha")).toMatchObject({ ok: true }); // a part refund still counts
  });

  it("the program switch (redeeming paused) does not stop an approval", async () => {
    const { m, claim } = pending();
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toMatchObject({ ok: true });
    expect(m.points_balance).toBe(3000);
  });

  it("if writing the points fails, the claim goes back to pending so it can be approved again", async () => {
    const { m, claim } = pending();
    h.db.failNext("rpc:award_points", "select", { code: "XX000", message: "boom" });
    await expect(approveReviewClaim(String(claim.id), "Ayesha")).rejects.toThrow(/boom/);
    expect(claim.status).toBe("pending");
    expect(await approveReviewClaim(String(claim.id), "Ayesha")).toMatchObject({ ok: true });
    expect(m.points_balance).toBe(3000);
  });
});

describe("rejectReviewClaim", () => {
  it("only while pending; a rejected claim can never be approved", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    const c = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000 });
    expect(await rejectReviewClaim(String(c.id), "staff")).toEqual({ ok: true });
    expect(c.status).toBe("rejected");
    expect(h.db.table("staff_notes")[0]).toMatchObject({ member_id: m.id, author: "staff" });
    expect(await rejectReviewClaim(String(c.id), "staff")).toEqual({ ok: false });
    expect(await approveReviewClaim(String(c.id), "staff")).toEqual({ ok: false, reason: "already_resolved" });
    const paid = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O2", points: 1, status: "awarded" });
    expect(await rejectReviewClaim(String(paid.id), "staff")).toEqual({ ok: false });
  });
});

describe("rule 20: the program switch only pauses redeeming", () => {
  it("a review can be claimed while the program is off", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    expect(await claimReview(String(m.id))).toMatchObject({ ok: true });
    expect(claims().map((c) => c.shopify_order_id)).toEqual(["O1"]);
  });
});
