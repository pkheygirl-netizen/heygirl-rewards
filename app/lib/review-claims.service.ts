// app/lib/review-claims.service.ts
// Rule 14: "I posted a review". One claim per delivered-and-paid order, held
// for `review_release_hours`, then paid automatically unless an admin rejects it.
import { db } from "../db.server";
import { notificationQueue } from "./queue.server";
import { getSettings, isEarnRuleEnabled } from "./settings.server";
import { expiresAtForTier } from "./points.service";
import { isFullyRefunded } from "./orders.server";

export async function claimReview(
  memberId: string,
): Promise<{ ok: true; releaseAt: string } | { ok: false; reason: "no_eligible_order" | "disabled" | "blocked" }> {
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

  const releaseAt = new Date(Date.now() + settings.review_release_hours * 3_600_000).toISOString();
  for (const order of candidates) {
    const { error: insErr } = await db.from("review_claims").insert({
      member_id: member.id,
      shopify_order_id: order.shopify_order_id,
      status: "pending",
      points: settings.review_points,
      release_at: releaseAt,
    });
    if (!insErr) return { ok: true, releaseAt };
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

/** Cron: pay every pending claim whose hold time has passed. */
export async function releaseDueReviewClaims(
  now: Date = new Date(),
  batchSize = 200,
): Promise<{ released: number; rejected: number; reason?: string }> {
  // Checked again at release time: while the rule is switched off nothing is
  // paid, and the claims simply wait.
  const settingsNow = await getSettings();
  if (!isEarnRuleEnabled(settingsNow, "review")) return { released: 0, rejected: 0, reason: "disabled" };

  const { data: due, error } = await db
    .from("review_claims")
    .select("id, member_id, points, shopify_order_id")
    .eq("status", "pending")
    .lte("release_at", now.toISOString())
    .order("release_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(`release query failed: ${error.message}`);

  const settings = await getSettings();
  let released = 0;
  let rejected = 0;
  for (const claim of due ?? []) {
    const { data: member } = await db
      .from("members")
      .select("id, tier, is_blocked, opted_out")
      .eq("id", claim.member_id)
      .maybeSingle();
    const resolvedAt = new Date().toISOString();
    // The order the claim stands on must still stand: not cancelled, not refunded in full.
    let orderGone = false;
    if (claim.shopify_order_id) {
      const { data: order } = await db
        .from("order_webhook_state")
        .select("*")
        .eq("shopify_order_id", claim.shopify_order_id)
        .maybeSingle();
      orderGone = !order || !!order.cancelled_at || isFullyRefunded(order);
    }
    if (!member || member.is_blocked || member.opted_out || orderGone) {
      await db.from("review_claims").update({ status: "rejected", resolved_at: resolvedAt }).eq("id", claim.id).eq("status", "pending");
      rejected++;
      continue;
    }
    const { data, error: rpcErr } = await db.rpc("award_points", {
      p_member_id: claim.member_id,
      p_action_type: "review",
      p_reference_id: String(claim.id),
      p_points: claim.points,
      p_expires_at: expiresAtForTier(member.tier, settings),
      p_shopify_order_id: claim.shopify_order_id,
      p_customer_note: "Thanks for your review",
    });
    if (rpcErr) throw new Error(`award_points(review) failed: ${rpcErr.message}`);
    await db.from("review_claims").update({ status: "awarded", resolved_at: resolvedAt }).eq("id", claim.id).eq("status", "pending");
    if (data?.[0]?.awarded) {
      released++;
      await notificationQueue
        .add("review_released", { memberId: claim.member_id, points: claim.points })
        .catch((err) => console.error("[releaseDueReviewClaims] notification enqueue failed:", err));
    }
  }
  return { released, rejected };
}
