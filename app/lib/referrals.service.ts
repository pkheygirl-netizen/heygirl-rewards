// app/lib/referrals.service.ts
// Referral programme (rules 10 and 11).
//   record   - at the friend's first sign-in with a stored ?ref=slug
//   complete - when the friend's first order is fulfilled and paid
//   review   - same-network referrals are held (flagged) for approve / reject
//   reverse  - when the qualifying order is fully refunded or cancelled
import { db } from "../db.server";
import type { Database } from "../database.types";
import { notificationQueue, pointsQueue } from "./queue.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";
import { getAdminForShop } from "./worker-admin.server";
import { getSettings, isEarnRuleEnabled } from "./settings.server";
import { effectiveReferralPoints } from "./influencer.service";
import { issueReferralFriendCode } from "./referral-bonus.service";
import { expiresAtForTier } from "./points.service";

type ReferralRow = Database["public"]["Tables"]["referrals"]["Row"];
type MemberRow = Database["public"]["Tables"]["members"]["Row"];

export type ReferralRecordResult = {
  ok: boolean;
  recorded: boolean;
  blocked: boolean;
  status: string;
  reason?: string;
  friendCode?: string;
};

export async function resolveReferrer(slug: string): Promise<{ memberId: string } | null> {
  const { data } = await db
    .from("members")
    .select("id")
    .eq("referral_slug", String(slug).trim().toLowerCase())
    .maybeSingle();
  return data ? { memberId: data.id } : null;
}

const CUSTOMER_ORDER_COUNT = `#graphql
  query HgCustomerOrderCount($id: ID!) {
    customer(id: $id) { numberOfOrders }
  }`;

/** How many orders Shopify has for a customer (covers orders from before the app was installed). */
export async function shopifyOrderCount(shopifyCustomerId: string, shop?: string | null): Promise<number> {
  const admin = await getAdminForShop(shop ?? undefined);
  const data = await shopifyGraphqlWithRetry<{ customer: { numberOfOrders: string | number } | null }>(
    admin,
    CUSTOMER_ORDER_COUNT,
    { id: `gid://shopify/Customer/${shopifyCustomerId}` },
  );
  const n = Number(data.customer?.numberOfOrders ?? 0); // UnsignedInt64 arrives as a string
  return Number.isFinite(n) ? n : 0;
}

const sameText = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const digits = (v: string | null | undefined): string => (v ?? "").replace(/\D/g, "");
const samePhone = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const x = digits(a);
  const y = digits(b);
  // Compare the last 10 digits so +92 300... and 0300... match.
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
};

async function friendCodeText(codeId: string | null): Promise<string | undefined> {
  if (!codeId) return undefined;
  const { data } = await db.from("loyalty_codes").select("code, status").eq("id", codeId).maybeSingle();
  return data && data.status === "active" ? data.code : undefined;
}

/**
 * Record a referral when a signed-in friend arrives with a stored ?ref=slug.
 * The friend's address and email are taken server-side by the caller.
 */
export async function recordReferralVisit(input: {
  referralSlug: string;
  referredShopifyCustomerId: string;
  referredEmail?: string | null;
  referredIp?: string | null;
  shop?: string | null;
}): Promise<ReferralRecordResult> {
  const no = (status: string, reason?: string): ReferralRecordResult => ({
    ok: false,
    recorded: false,
    blocked: false,
    status,
    reason: reason ?? status,
  });

  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "referral")) return no("disabled");

  const friendCustomerId = String(input.referredShopifyCustomerId ?? "").trim();
  if (!friendCustomerId) return no("not_a_member");

  const { data: referrer } = await db
    .from("members")
    .select("id, email, phone, shopify_customer_id, last_seen_ip, is_blocked, opted_out, referrals_blocked")
    .eq("referral_slug", String(input.referralSlug ?? "").trim().toLowerCase())
    .maybeSingle();
  if (!referrer) return no("invalid_slug");

  const { data: friend } = await db
    .from("members")
    .select("id, email, phone, is_blocked, opted_out, referred_by_member_id")
    .eq("shopify_customer_id", friendCustomerId)
    .maybeSingle();
  if (!friend) return no("not_a_member");
  if (friend.id === referrer.id) return no("self_referral");
  if (friend.is_blocked || friend.opted_out) return no("not_eligible", "friend_not_eligible");
  if (referrer.is_blocked || referrer.opted_out || referrer.referrals_blocked) return no("not_eligible", "referrer_not_eligible");

  // Already referred (by anyone, in any state): one referral per friend, ever.
  const { data: existing, error: existingErr } = await db
    .from("referrals")
    .select("id, referrer_member_id, status, friend_code_id")
    .eq("referred_shopify_customer_id", friendCustomerId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (existingErr) throw new Error(`referral lookup failed: ${existingErr.message}`);
  const prior = existing?.[0];
  if (prior || friend.referred_by_member_id) {
    if (prior && prior.referrer_member_id === referrer.id) {
      return {
        ok: prior.status === "pending" || prior.status === "completed",
        recorded: false,
        blocked: prior.status === "blocked",
        status: prior.status,
        reason: "duplicate",
        friendCode: await friendCodeText(prior.friend_code_id),
      };
    }
    return no("already_referred");
  }

  // The friend must be new: zero earlier orders, here or in Shopify.
  const { data: localOrders, error: ordersErr } = await db
    .from("order_webhook_state")
    .select("id")
    .eq("shopify_customer_id", friendCustomerId)
    .limit(1);
  if (ordersErr) throw new Error(`order lookup failed: ${ordersErr.message}`);
  if ((localOrders ?? []).length > 0) return no("not_eligible", "has_orders");
  let orderCount: number;
  try {
    orderCount = await shopifyOrderCount(friendCustomerId, input.shop);
  } catch (err) {
    // Without the count we cannot tell a new customer from an old one.
    console.error("[recordReferralVisit] order count lookup failed:", err instanceof Error ? err.message : err);
    return no("try_again", "order_count_unavailable");
  }
  if (orderCount > 0) return no("not_eligible", "has_orders");

  const friendEmail = friend.email ?? input.referredEmail ?? null;
  const friendIp = typeof input.referredIp === "string" && input.referredIp.trim() && input.referredIp !== "unknown"
    ? input.referredIp.trim()
    : null;

  let status: "pending" | "flagged" | "blocked" = "pending";
  const flags: string[] = [];
  let blockReason: string | null = null;
  if (sameText(friendEmail, referrer.email) || samePhone(friend.phone, referrer.phone)) {
    status = "blocked";
    flags.push("same_contact");
    blockReason = "Same email or phone as the referrer";
  } else if (friendIp && referrer.last_seen_ip && friendIp === referrer.last_seen_ip) {
    status = "flagged";
    flags.push("same_network");
    blockReason = "Friend signed in from the referrer's network address";
  }

  const { data: inserted, error: insertErr } = await db
    .from("referrals")
    .insert({
      referrer_member_id: referrer.id,
      referred_shopify_customer_id: friendCustomerId,
      referred_email: friendEmail,
      referred_ip: friendIp,
      referrer_ip: referrer.last_seen_ip, // the referrer's own address, not a copy of the friend's
      status,
      block_reason: blockReason,
      fraud_flags: flags,
    })
    .select("id")
    .single();
  if (insertErr || !inserted) {
    if (insertErr?.code === "23505") return no("already_referred", "duplicate");
    throw new Error(`referral insert failed: ${insertErr?.message ?? "no row"}`);
  }

  await db.from("members").update({ referred_by_member_id: referrer.id }).eq("id", friend.id);

  if (status === "blocked") {
    // Confirmed self-referral: the referrer loses the right to refer.
    await db.from("members").update({ referrals_blocked: true }).eq("id", referrer.id);
    return { ok: false, recorded: true, blocked: true, status, reason: "self_referral" };
  }
  if (status === "flagged") {
    // Held for review; the friend's code is issued if an admin approves.
    return { ok: true, recorded: true, blocked: false, status };
  }

  // Free shipping for the friend's first order, straight away (rule 10).
  let friendCode: string | undefined;
  if (settings.referral_friend_free_shipping) {
    try {
      const issued = await issueReferralFriendCode(inserted.id, input.shop);
      friendCode = issued.code;
      if (!issued.issued && issued.reason !== "already_issued" && issued.reason !== "disabled") {
        throw new Error(issued.reason ?? "not issued");
      }
    } catch (err) {
      console.error("[recordReferralVisit] friend code not issued yet, queued:", err instanceof Error ? err.message : err);
      await pointsQueue
        .add("issue_referral_friend_code", { referralId: inserted.id, shop: input.shop ?? null }, { jobId: `friend-code-${inserted.id}` })
        .catch((e) => console.error("[recordReferralVisit] friend code enqueue failed:", e));
    }
  }
  return { ok: true, recorded: true, blocked: false, status, friendCode };
}

// ── Completion ────────────────────────────────────────────────────────────

type OrderLite = {
  shopify_order_id: string;
  points_awarded: boolean;
  cancelled_at: string | null;
  placed_at: string | null;
  created_at: string;
  earning_basis_pkr: number | null;
  refunded_basis_pkr: number;
};

/**
 * The friend's first order = her earliest order that was not cancelled. The
 * referral was only recorded because she had no orders at all, so every order
 * of hers is in order_webhook_state.
 */
export async function firstQualifyingOrder(shopifyCustomerId: string): Promise<OrderLite | null> {
  const { data, error } = await db
    .from("order_webhook_state")
    .select("shopify_order_id, points_awarded, cancelled_at, placed_at, created_at, earning_basis_pkr, refunded_basis_pkr")
    .eq("shopify_customer_id", shopifyCustomerId)
    .is("cancelled_at", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`order lookup failed: ${error.message}`);
  const rows = (data ?? []) as OrderLite[];
  if (rows.length === 0) return null;
  const when = (o: OrderLite) => Date.parse(o.placed_at ?? o.created_at);
  return rows.slice().sort((a, b) => when(a) - when(b))[0];
}

const fullyRefunded = (o: OrderLite): boolean =>
  Number(o.earning_basis_pkr ?? 0) > 0 && Number(o.refunded_basis_pkr ?? 0) >= Number(o.earning_basis_pkr ?? 0);

async function payReferral(
  referral: ReferralRow,
  shopifyOrderId: string,
): Promise<{ paid: boolean; points?: number; reason?: string }> {
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "referral")) return { paid: false, reason: "disabled" };

  const { data: referrer } = await db.from("members").select("*").eq("id", referral.referrer_member_id).maybeSingle();
  if (!referrer) return { paid: false, reason: "referrer_not_found" };
  const r = referrer as MemberRow;
  if (r.is_blocked || r.opted_out || r.referrals_blocked) return { paid: false, reason: "referrer_not_eligible" };

  const points = effectiveReferralPoints(r, settings.referral_points);
  if (points <= 0) return { paid: false, reason: "zero_points" };

  const { data, error } = await db.rpc("award_points", {
    p_member_id: r.id,
    p_action_type: "referral_earned",
    p_reference_id: String(referral.id),
    p_points: points,
    p_expires_at: expiresAtForTier(r.tier, settings),
    p_shopify_order_id: shopifyOrderId,
    p_reason_note: `referral ${referral.id} completed by customer ${referral.referred_shopify_customer_id}`,
    p_customer_note: "Your friend's first order",
  });
  if (error) throw new Error(`award_points(referral) failed: ${error.message}`);
  const awarded = data?.[0]?.awarded ?? false;

  // Written on a replay too, so a crash after the award cannot leave it open.
  const { error: updErr } = await db
    .from("referrals")
    .update({
      status: "completed",
      points_awarded: true,
      completed_at: new Date().toISOString(),
      shopify_order_id: shopifyOrderId,
      reward_points: points,
    })
    .eq("id", referral.id)
    .eq("status", "pending");
  if (updErr) throw new Error(`referral update failed: ${updErr.message}`);

  if (awarded) {
    await notificationQueue
      .add("referral_completed", { memberId: r.id, points })
      .catch((err) => console.error("[payReferral] notification enqueue failed:", err));
  }
  return { paid: awarded, points, reason: awarded ? undefined : "already_paid" };
}

/**
 * Pay the referrer if this customer was referred and her first order is now
 * fulfilled and paid. Safe to call after every award and every cancellation.
 * A flagged referral is not paid; it remembers the order and waits for review.
 */
export async function completeReferralForCustomer(
  shopifyCustomerId: string,
): Promise<{ paid: boolean; points?: number; reason?: string; orderId?: string }> {
  const customerId = String(shopifyCustomerId);
  const { data: open, error } = await db
    .from("referrals")
    .select("*")
    .eq("referred_shopify_customer_id", customerId)
    .in("status", ["pending", "flagged"])
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  const referral = open?.[0] as ReferralRow | undefined;
  if (!referral) return { paid: false, reason: "no_open_referral" };

  const order = await firstQualifyingOrder(customerId);
  if (!order) return { paid: false, reason: "no_order" };
  if (!order.points_awarded) return { paid: false, reason: "first_order_not_delivered_and_paid" };
  if (fullyRefunded(order)) return { paid: false, reason: "first_order_refunded" };

  if (referral.status === "flagged") {
    if (referral.shopify_order_id !== order.shopify_order_id) {
      await db.from("referrals").update({ shopify_order_id: order.shopify_order_id }).eq("id", referral.id);
    }
    return { paid: false, reason: "held_for_review", orderId: order.shopify_order_id };
  }
  const result = await payReferral(referral, order.shopify_order_id);
  return { ...result, orderId: order.shopify_order_id };
}

// ── Admin review ──────────────────────────────────────────────────────────

/**
 * Approve a held referral: back to `pending`, the friend gets her code, and the
 * referrer is paid at once if the friend's first order already qualifies.
 */
export async function approveReferral(
  referralId: string,
  actor: string,
  shop: string,
): Promise<{ ok: boolean; paid: boolean; reason?: string }> {
  const { data: updated, error } = await db
    .from("referrals")
    .update({
      status: "pending",
      reviewed_at: new Date().toISOString(),
      reviewed_note: `approved by ${actor || "admin"}`,
    })
    .eq("id", referralId)
    .eq("status", "flagged")
    .select("*");
  if (error) throw new Error(`could not approve referral: ${error.message}`);
  const referral = updated?.[0] as ReferralRow | undefined;
  if (!referral) return { ok: false, paid: false, reason: "not_flagged" };

  await pointsQueue
    .add("issue_referral_friend_code", { referralId: referral.id, shop: shop || null }, { jobId: `friend-code-${referral.id}` })
    .catch((err) => console.error("[approveReferral] friend code enqueue failed:", err));

  if (!referral.referred_shopify_customer_id) return { ok: true, paid: false };
  const result = await completeReferralForCustomer(referral.referred_shopify_customer_id);
  return { ok: true, paid: result.paid, reason: result.paid ? undefined : result.reason };
}

export async function rejectReferral(referralId: string, actor: string, note?: string): Promise<{ ok: boolean }> {
  const { data, error } = await db
    .from("referrals")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewed_note: `rejected by ${actor || "admin"}${note && note.trim() ? `: ${note.trim().slice(0, 500)}` : ""}`,
    })
    .eq("id", referralId)
    .in("status", ["flagged", "pending"])
    .select("id");
  if (error) throw new Error(`could not reject referral: ${error.message}`);
  return { ok: !!data && data.length > 0 };
}

// ── Reversal ──────────────────────────────────────────────────────────────

/**
 * The qualifying order was refunded in full or cancelled after the referrer
 * was paid: take the points back (floored at zero by the database).
 */
export async function reverseReferralForOrder(
  shopifyOrderId: string,
  why: "refunded" | "cancelled",
): Promise<{ reversed: boolean; points?: number }> {
  const { data, error } = await db
    .from("referrals")
    .select("*")
    .eq("shopify_order_id", String(shopifyOrderId))
    .eq("status", "completed")
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  const referral = data?.[0] as ReferralRow | undefined;
  if (!referral || !referral.points_awarded) return { reversed: false };

  let points = Number(referral.reward_points ?? 0);
  if (points <= 0) {
    // Completed before reward_points was stored: read it from the ledger.
    const { data: row } = await db
      .from("points_ledger")
      .select("points")
      .eq("member_id", referral.referrer_member_id)
      .eq("action_type", "referral_earned")
      .eq("reference_id", String(referral.id))
      .maybeSingle();
    points = Number(row?.points ?? 0);
  }
  if (points > 0) {
    const { error: rpcErr } = await db.rpc("award_points", {
      p_member_id: referral.referrer_member_id,
      p_action_type: "referral_reversal",
      p_reference_id: String(referral.id),
      p_points: -points,
      p_shopify_order_id: String(shopifyOrderId),
      p_reason_note: `qualifying order ${shopifyOrderId} ${why}`,
      p_customer_note: `Referral reversed: your friend's order was ${why}`,
    });
    if (rpcErr) throw new Error(`award_points(referral_reversal) failed: ${rpcErr.message}`);
  }
  await db
    .from("referrals")
    .update({
      status: "rejected",
      points_awarded: false,
      reviewed_at: new Date().toISOString(),
      reviewed_note: `reversed automatically: qualifying order ${why}`,
    })
    .eq("id", referral.id)
    .eq("status", "completed");
  return { reversed: points > 0, points };
}
