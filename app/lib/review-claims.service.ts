// app/lib/review-claims.service.ts
// Rule 14: "I posted a review". One claim per delivered-and-paid order (an
// order whose purchase points were awarded: fulfilled AND paid AND not
// cancelled). A claim waits as `pending` until staff approve or reject it in
// the admin; nothing is ever released automatically (owner decision, 18 Nov
// 2026). `release_at` is no longer written (column kept, nullable since 015).
import { db } from "../db.server";
import { notificationQueue } from "./queue.server";
import { getSettings, isEarnRuleEnabled } from "./settings.server";
import { expiresAtForTier } from "./points.service";
import { isFullyRefunded } from "./orders.server";

export async function claimReview(
  memberId: string,
): Promise<{ ok: true } | { ok: false; reason: "no_eligible_order" | "disabled" | "blocked" }> {
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "review") || settings.review_points <= 0) return { ok: false, reason: "disabled" };

  const { data: member, error } = await db
    .from("members")
    .select("id, shopify_customer_id, is_blocked, opted_out")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  if (!member || member.is_blocked || member.opted_out) return { ok: false, reason: "blocked" };

  const { data: orders, error: ordersErr } = await db
    .from("order_webhook_state")
    .select("shopify_order_id, placed_at, created_at")
    .eq("shopify_customer_id", member.shopify_customer_id)
    .eq("points_awarded", true)
    .is("cancelled_at", null)
    .order("created_at", { ascending: true })
    .limit(500);
  if (ordersErr) throw new Error(`order lookup failed: ${ordersErr.message}`);

  const { data: claims, error: claimsErr } = await db
    .from("review_claims")
    .select("shopify_order_id, status")
    .eq("member_id", member.id)
    .neq("status", "rejected")
    .limit(1000);
  if (claimsErr) throw new Error(`claim lookup failed: ${claimsErr.message}`);

  const claimed = new Set((claims ?? []).map((c) => c.shopify_order_id).filter(Boolean));
  // Claims with no order attached still use up an order each.
  let unassigned = (claims ?? []).filter((c) => !c.shopify_order_id).length;
  const free = (orders ?? []).filter((o) => !claimed.has(o.shopify_order_id));
  const candidates = free.slice(Math.min(unassigned, free.length));
  unassigned = 0;

  for (const order of candidates) {
    const { error: insErr } = await db.from("review_claims").insert({
      member_id: member.id,
      shopify_order_id: order.shopify_order_id,
      status: "pending",
      points: settings.review_points,
      release_at: null,
    });
    if (!insErr) return { ok: true };
    // 23505: a second tap claimed this order a moment ago. Try the next one.
    if (insErr.code !== "23505") throw new Error(`claim insert failed: ${insErr.message}`);
  }
  return { ok: false, reason: "no_eligible_order" };
}

export async function rejectReviewClaim(claimId: string, actor: string): Promise<{ ok: boolean }> {
  const { data, error } = await db
    .from("review_claims")
    .update({ status: "rejected", resolved_at: new Date().toISOString() })
    .eq("id", claimId)
    .eq("status", "pending") // only while pending
    .select("id, member_id");
  if (error) throw new Error(`could not reject claim: ${error.message}`);
  if (!data || data.length === 0) return { ok: false };
  await db.from("staff_notes").insert({
    member_id: data[0].member_id,
    note: `Review claim ${claimId} rejected`,
    author: actor || "admin",
  });
  return { ok: true };
}

export type ApproveReviewResult =
  | { ok: true; points: number; alreadyPaid: boolean }
  | { ok: false; reason: "not_found" | "already_resolved" | "disabled" | "blocked" | "order_gone" };

/**
 * Staff approve one pending claim: the review points are awarded through
 * award_points with the same idempotency key as before (action `review`,
 * reference = claim id), so a double click or a retry pays once.
 *
 * Checked at approval time: the review rule's own switch, the member (not
 * blocked, not opted out) and the order the claim stands on (not cancelled,
 * not refunded in full). A refused approval changes nothing: the claim stays
 * pending, so staff can reject it or approve it later. A claim already
 * approved or rejected is refused.
 *
 * The claim is marked `awarded` before the points are written (only while it
 * is still pending), so a rejection made at the same moment cannot end up
 * paid; if writing the points fails, the claim goes back to pending.
 */
export async function approveReviewClaim(claimId: string, actor: string): Promise<ApproveReviewResult> {
  const { data: claim, error } = await db
    .from("review_claims")
    .select("id, member_id, points, shopify_order_id, status")
    .eq("id", claimId)
    .maybeSingle();
  if (error) throw new Error(`claim lookup failed: ${error.message}`);
  if (!claim) return { ok: false, reason: "not_found" };
  if (claim.status !== "pending") return { ok: false, reason: "already_resolved" };

  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "review")) return { ok: false, reason: "disabled" };

  const { data: member, error: memberErr } = await db
    .from("members")
    .select("id, tier, is_blocked, opted_out")
    .eq("id", claim.member_id)
    .maybeSingle();
  if (memberErr) throw new Error(`member lookup failed: ${memberErr.message}`);
  if (!member || member.is_blocked || member.opted_out) return { ok: false, reason: "blocked" };

  if (claim.shopify_order_id) {
    const { data: order, error: orderErr } = await db
      .from("order_webhook_state")
      .select("*")
      .eq("shopify_order_id", claim.shopify_order_id)
      .maybeSingle();
    if (orderErr) throw new Error(`order lookup failed: ${orderErr.message}`);
    if (!order || !order.points_awarded || order.cancelled_at || isFullyRefunded(order)) return { ok: false, reason: "order_gone" };
  }

  const resolvedAt = new Date().toISOString();
  const { data: taken, error: takeErr } = await db
    .from("review_claims")
    .update({ status: "awarded", resolved_at: resolvedAt })
    .eq("id", claim.id)
    .eq("status", "pending")
    .select("id");
  if (takeErr) throw new Error(`could not approve claim: ${takeErr.message}`);
  if (!taken || taken.length === 0) return { ok: false, reason: "already_resolved" };

  const who = (actor || "").replace(/[\r\n]/g, " ").trim().slice(0, 80) || "Store staff";
  const { data, error: rpcErr } = await db.rpc("award_points", {
    p_member_id: claim.member_id,
    p_action_type: "review",
    p_reference_id: String(claim.id),
    p_points: claim.points,
    p_expires_at: expiresAtForTier(member.tier, settings),
    p_shopify_order_id: claim.shopify_order_id,
    p_reason_note: `Review claim approved by ${who}`,
    p_customer_note: "Thanks for your review",
  });
  if (rpcErr) {
    // Nothing was paid: put the claim back so it can be approved again.
    await db.from("review_claims").update({ status: "pending", resolved_at: null }).eq("id", claim.id).eq("status", "awarded");
    throw new Error(`award_points(review) failed: ${rpcErr.message}`);
  }
  const paidNow = !!data?.[0]?.awarded;
  const { error: noteErr } = await db.from("staff_notes").insert({
    member_id: claim.member_id,
    note: `Review claim approved: ${claim.points} points`,
    author: who,
  });
  if (noteErr) console.error(`[approveReviewClaim] audit note not written for ${claim.id}: ${noteErr.message}`);
  if (paidNow) {
    await notificationQueue
      .add("review_released", { memberId: claim.member_id, points: claim.points })
      .catch((err) => console.error("[approveReviewClaim] notification enqueue failed:", err));
  }
  return { ok: true, points: claim.points, alreadyPaid: !paidNow };
}
