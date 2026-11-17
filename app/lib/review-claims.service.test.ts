import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { claimReview, rejectReviewClaim, releaseDueReviewClaims } from "./review-claims.service";

const awardedOrder = (cust: unknown, id: string, over = {}) =>
  h.db.seed("order_webhook_state", { shopify_order_id: id, shopify_customer_id: cust, points_awarded: true, ...over });
const claims = () => h.db.table("review_claims");

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("claimReview", () => {
  it("one claim per delivered-and-paid order, held for review_release_hours with review_points", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    const r = await claimReview(String(m.id));
    expect(r.ok).toBe(true);
    if (r.ok) expect((Date.parse(r.releaseAt) - Date.now()) / 3_600_000).toBeCloseTo(72, 1);
    expect(claims()[0]).toMatchObject({ member_id: m.id, shopify_order_id: "O1", status: "pending", points: 3000 });
    expect(m.points_balance).toBe(0); // nothing yet
    expect(await claimReview(String(m.id))).toEqual({ ok: false, reason: "no_eligible_order" }); // one order, one claim
    awardedOrder(m.shopify_customer_id, "O2");
    expect((await claimReview(String(m.id))).ok).toBe(true);
    expect(claims()).toHaveLength(2);
  });

  it("orders that are not awarded, or cancelled, do not count", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1", { points_awarded: false });
    awardedOrder(m.shopify_customer_id, "O2", { cancelled_at: "2026-11-01T00:00:00Z" });
    expect(await claimReview(String(m.id))).toEqual({ ok: false, reason: "no_eligible_order" });
  });

  it("a rejected claim frees the order for another claim", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    await claimReview(String(m.id));
    await rejectReviewClaim(String(claims()[0].id), "staff");
    expect((await claimReview(String(m.id))).ok).toBe(true);
  });

  it("settings: hold time and points", async () => {
    Object.assign(h.db.table("app_settings")[0], { review_release_hours: 24, review_points: 500 });
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1");
    const r = await claimReview(String(m.id));
    if (r.ok) expect((Date.parse(r.releaseAt) - Date.now()) / 3_600_000).toBeCloseTo(24, 1);
    expect(claims()[0].points).toBe(500);
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

describe("release job", () => {
  it("pays due claims once as 'review' points and notifies; claims not yet due are left", async () => {
    const m = seedMember(h.db);
    awardedOrder(m.shopify_customer_id, "O1", { earning_basis_pkr: 2000, points_awarded_amount: 2000 });
    const due = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000, release_at: "2026-11-01T00:00:00Z" });
    const later = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O2", points: 3000, release_at: "2026-12-01T00:00:00Z" });
    const now = new Date("2026-11-10T00:00:00Z");
    expect(await releaseDueReviewClaims(now)).toEqual({ released: 1, rejected: 0 });
    expect(m.points_balance).toBe(3000);
    expect(due.status).toBe("awarded");
    expect(later.status).toBe("pending");
    expect(h.db.table("points_ledger")[0]).toMatchObject({ action_type: "review", reference_id: due.id, points: 3000 });
    expect(h.notifications.named("review_released")).toHaveLength(1);
    expect(await releaseDueReviewClaims(now)).toEqual({ released: 0, rejected: 0 });
    expect(m.points_balance).toBe(3000);
  });

  it("a member blocked during the hold gets nothing", async () => {
    const m = seedMember(h.db, { is_blocked: true });
    const c = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000, release_at: "2026-11-01T00:00:00Z" });
    expect(await releaseDueReviewClaims(new Date("2026-11-10T00:00:00Z"))).toEqual({ released: 0, rejected: 1 });
    expect(c.status).toBe("rejected");
    expect(m.points_balance).toBe(0);
  });
});

describe("rejectReviewClaim", () => {
  it("only while pending; a rejected claim is never released", async () => {
    const m = seedMember(h.db);
    const c = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000, release_at: "2026-11-01T00:00:00Z" });
    expect(await rejectReviewClaim(String(c.id), "staff")).toEqual({ ok: true });
    expect(c.status).toBe("rejected");
    expect(await rejectReviewClaim(String(c.id), "staff")).toEqual({ ok: false });
    expect(await releaseDueReviewClaims(new Date("2026-11-10T00:00:00Z"))).toEqual({ released: 0, rejected: 0 });
    const paid = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O2", points: 1, release_at: "2026-11-01T00:00:00Z", status: "awarded" });
    expect(await rejectReviewClaim(String(paid.id), "staff")).toEqual({ ok: false });
  });
});

describe("L4: release re-checks the rule and the order", () => {
  const NOW = new Date("2026-11-10T00:00:00Z");
  const claimFor = (over = {}) => {
    const m = seedMember(h.db);
    const order = awardedOrder(m.shopify_customer_id, "O1", { earning_basis_pkr: 2000, points_awarded_amount: 2000, ...over });
    const claim = h.db.seed("review_claims", { member_id: m.id, shopify_order_id: "O1", points: 3000, release_at: "2026-11-01T00:00:00Z" });
    return { m, order, claim };
  };

  it("rule switched off after the claim: nothing is paid and the claim waits", async () => {
    const { m, claim } = claimFor();
    h.db.table("app_settings")[0].earn_rules = { review: { enabled: false } };
    bustSettingsCache();
    expect(await releaseDueReviewClaims(NOW)).toMatchObject({ released: 0, rejected: 0, reason: "disabled" });
    expect(claim.status).toBe("pending");
    expect(m.points_balance).toBe(0);
    h.db.table("app_settings")[0].earn_rules = {};
    bustSettingsCache();
    expect(await releaseDueReviewClaims(NOW)).toMatchObject({ released: 1 });
  });

  it("order cancelled during the hold: rejected, no points", async () => {
    const { m, claim } = claimFor({ cancelled_at: "2026-11-05T00:00:00Z" });
    expect(await releaseDueReviewClaims(NOW)).toMatchObject({ released: 0, rejected: 1 });
    expect(claim.status).toBe("rejected");
    expect(m.points_balance).toBe(0);
  });

  it("order refunded in full during the hold: rejected; a part refund still pays", async () => {
    const full = claimFor({ refunded_basis_pkr: 2000, points_reversed_amount: 2000 });
    expect(await releaseDueReviewClaims(NOW)).toMatchObject({ released: 0, rejected: 1 });
    expect(full.claim.status).toBe("rejected");

    resetHarness(); bustSettingsCache();
    const part = claimFor({ refunded_basis_pkr: 500, points_reversed_amount: 500 });
    expect(await releaseDueReviewClaims(NOW)).toMatchObject({ released: 1, rejected: 0 });
    expect(part.m.points_balance).toBe(3000);
  });
});
