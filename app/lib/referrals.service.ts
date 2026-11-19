// app/lib/referrals.service.ts
// Referral programme (rules 10 and 11).
//   record   - at the friend's first sign-in with a stored ?ref=slug; same
//              email/phone is blocked, similar email or same full name is held
//   check    - the friend's order that used her free-shipping code is compared
//              with the referrer's phone and addresses BEFORE anything is paid
//   complete - when the friend's first order is fulfilled and paid
//   review   - held (flagged) referrals wait for staff approve / reject
//   reverse  - when the qualifying order is fully refunded or cancelled
// No network address is compared anywhere: behind Shopify's proxy and
// Railway's edge the app does not see the shopper's address (19 Nov 2026).
import { db } from "../db.server";
import type { Database } from "../database.types";
import { notificationQueue, pointsQueue } from "./queue.server";
import { classifyShopifyError, shopifyGraphqlWithRetry, ShopifyRateLimitError } from "./shopify-graphql.server";
import { getAdminForShop } from "./worker-admin.server";
import { getSettings, isEarnRuleEnabled } from "./settings.server";
import { effectiveReferralPoints } from "./influencer.service";
import { issueReferralFriendCode } from "./referral-bonus.service";
import { expiresAtForTier } from "./points.service";
import { ORDER_FLAGS, orderVerdict, REFERRAL_ORDER_TAG, signInVerdict, type AddressLike, type OrderCheckResult } from "./referral-checks.server";

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

async function friendCodeText(codeId: string | null): Promise<string | undefined> {
  if (!codeId) return undefined;
  const { data } = await db.from("loyalty_codes").select("code, status").eq("id", codeId).maybeSingle();
  return data && data.status === "active" ? data.code : undefined;
}

/**
 * Record a referral when a signed-in friend arrives with a stored ?ref=slug.
 * The friend's email is taken server-side by the caller. Same email or phone
 * as the referrer: blocked. Similar email or the same full name: held
 * (flagged), and the friend's free-shipping code waits for staff approval.
 */
export async function recordReferralVisit(input: {
  referralSlug: string;
  referredShopifyCustomerId: string;
  referredEmail?: string | null;
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
    .select("id, email, phone, first_name, last_name, shopify_customer_id, is_blocked, opted_out, referrals_blocked")
    .eq("referral_slug", String(input.referralSlug ?? "").trim().toLowerCase())
    .maybeSingle();
  if (!referrer) return no("invalid_slug");

  const { data: friend } = await db
    .from("members")
    .select("id, email, phone, first_name, last_name, is_blocked, opted_out, referred_by_member_id")
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
  const { status, flags, blockReason } = signInVerdict(
    { email: friendEmail, phone: friend.phone, first_name: friend.first_name, last_name: friend.last_name },
    referrer,
  );

  const { data: inserted, error: insertErr } = await db
    .from("referrals")
    .insert({
      referrer_member_id: referrer.id,
      referred_shopify_customer_id: friendCustomerId,
      referred_email: friendEmail,
      // referred_ip / referrer_ip are no longer written (see the file header).
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
        .add("issue_referral_friend_code", { referralId: inserted.id, shop: input.shop ?? null })
        .catch((e) => console.error("[recordReferralVisit] friend code enqueue failed:", e));
    }
  }
  return { ok: true, recorded: true, blocked: false, status, friendCode };
}

// ── Order-time check (the friend's order that used her free-shipping code) ──

type ShippingLite = { address1?: string | null; city?: string | null; phone?: string | null } | null;

const REFERRAL_ORDER_CHECK = `#graphql
  query HgReferralOrderCheck($orderId: ID!, $customerId: ID!) {
    order(id: $orderId) {
      shippingAddress { address1 city phone }
    }
    customer(id: $customerId) {
      defaultPhoneNumber { phoneNumber }
      defaultAddress { address1 city phone }
      addressesV2(first: 10) { nodes { address1 city phone } }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { shippingAddress { address1 city phone } } }
    }
  }`;

type OrderCheckData = {
  order?: { shippingAddress?: ShippingLite } | null;
  customer?: {
    defaultPhoneNumber?: { phoneNumber?: string | null } | null;
    defaultAddress?: ShippingLite;
    addressesV2?: { nodes?: ShippingLite[] | null } | null;
    orders?: { nodes?: Array<{ shippingAddress?: ShippingLite } | null> | null } | null;
  } | null;
};

/**
 * The friend's shipping details and the referrer's phones and addresses, read
 * from Shopify for an in-memory comparison only (never stored or logged).
 * Without protected customer data access Shopify returns null for the
 * address and phone fields with an error beside them: whatever did come back
 * is used, and a field that did not is simply missing. A throttled or failed
 * request (5xx, network) throws so the caller can try again later.
 */
async function fetchOrderCheckData(
  shopifyOrderId: string,
  referrerCustomerId: string,
  shop?: string | null,
): Promise<{ data: OrderCheckData | null; note?: string }> {
  const admin = await getAdminForShop(shop ?? undefined);
  try {
    const data = await shopifyGraphqlWithRetry<OrderCheckData>(admin, REFERRAL_ORDER_CHECK, {
      orderId: `gid://shopify/Order/${shopifyOrderId}`,
      customerId: `gid://shopify/Customer/${referrerCustomerId}`,
    });
    return { data };
  } catch (err) {
    if (err instanceof ShopifyRateLimitError) throw err;
    const kind = classifyShopifyError(err).kind;
    if (kind === "transient" || kind === "throttled") throw err;
    // HTTP 200 with GraphQL errors (for example fields the app may not read):
    // @shopify/shopify-api throws GraphqlQueryError carrying the whole answer
    // in `body`, so the fields that were allowed are still in body.data.
    const partial = (err as { body?: { data?: unknown } } | null)?.body?.data;
    const note = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
    return { data: partial && typeof partial === "object" ? (partial as OrderCheckData) : null, note };
  }
}

export { REFERRAL_ORDER_TAG };

const TAG_ORDER = `#graphql
  mutation HgTagReferralOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

let missingScopeLogged = false;

/**
 * Add REFERRAL_ORDER_TAG to the order (Admin GraphQL tagsAdd; needs the
 * write_orders scope). The only write the app ever makes to an order: no
 * cancel, no edit, no other field. Never throws: a tag that could not be added
 * is reported as "failed" and the Home alert says so.
 */
async function tagOrderForReview(shopifyOrderId: string, shop?: string | null): Promise<"tagged" | "failed"> {
  try {
    const admin = await getAdminForShop(shop ?? undefined);
    const data = await shopifyGraphqlWithRetry<{
      tagsAdd: { node: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } | null;
    }>(admin, TAG_ORDER, { id: `gid://shopify/Order/${shopifyOrderId}`, tags: [REFERRAL_ORDER_TAG] });
    const errors = data.tagsAdd?.userErrors ?? [];
    if (!data.tagsAdd || errors.length > 0) {
      console.error(`[referral-check] order ${shopifyOrderId} not tagged: ${errors.map((e) => e.message).join("; ") || "no answer"}`);
      return "failed";
    }
    return "tagged";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/write_orders|access denied|not approved|scope/i.test(msg)) {
      // Logged once per process: every order would hit the same missing permission.
      if (!missingScopeLogged) {
        missingScopeLogged = true;
        console.error(`[referral-check] orders cannot be tagged: the app needs the write_orders permission (${msg.slice(0, 200)})`);
      }
    } else {
      console.error(`[referral-check] order ${shopifyOrderId} not tagged:`, msg.slice(0, 300));
    }
    return "failed";
  }
}

/** Test hook. */
export function resetTagScopeLog(): void {
  missingScopeLogged = false;
}

export type ReferralOrderCheck =
  | { checked: false; reason: "no_open_referral" | "no_friend_code" | "code_not_used" | "already_checked" | "referrer_not_found" }
  | { checked: true; result: OrderCheckResult; referralId: string };

const appendUnique = (list: unknown, item: string): string[] => {
  const arr = Array.isArray(list) ? list.map(String) : [];
  return arr.includes(item) ? arr : [...arr, item];
};

/**
 * Rule 10, order-time check. For an order of a referred friend that USED her
 * referral free-shipping code, compare the order's shipping phone and address
 * with the referrer's (her phone, default and saved addresses, and the
 * shipping details of her last 5 orders):
 *   same phone   -> referral blocked (flag same_phone_on_order); the referrer
 *                   gets nothing; her right to refer is NOT removed (staff can)
 *   same address -> referral held (flag same_address_on_order) for staff
 *   either way the order gets the tag "Rewards: check referral" in Shopify
 *   (tagsAdd; the only change ever made to an order) and a Home alert is
 *   raised (order_check, alert_resolved_at null).
 * Runs once per order (order_checked_order_id), so webhook replays repeat
 * nothing, the tag included.
 */
export async function checkReferralOrder(input: {
  shopifyOrderId: string;
  shopifyCustomerId: string;
  discountCodes: string[];
  shop?: string | null;
}): Promise<ReferralOrderCheck> {
  const orderId = String(input.shopifyOrderId);
  const { data: open, error } = await db
    .from("referrals")
    .select("id, referrer_member_id, status, friend_code_id, fraud_flags, block_reason, order_checked_order_id")
    .eq("referred_shopify_customer_id", String(input.shopifyCustomerId))
    .in("status", ["pending", "flagged"])
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  const referral = open?.[0];
  if (!referral) return { checked: false, reason: "no_open_referral" };
  if (referral.order_checked_order_id === orderId) return { checked: false, reason: "already_checked" };
  if (!referral.friend_code_id) return { checked: false, reason: "no_friend_code" };

  const { data: code, error: codeErr } = await db
    .from("loyalty_codes")
    .select("code")
    .eq("id", referral.friend_code_id)
    .maybeSingle();
  if (codeErr) throw new Error(`friend code lookup failed: ${codeErr.message}`);
  const friendCode = code?.code ? String(code.code).toUpperCase() : null;
  const used = !!friendCode && input.discountCodes.some((c) => String(c).trim().toUpperCase() === friendCode);
  if (!used) return { checked: false, reason: "code_not_used" };

  const { data: referrer, error: refErr } = await db
    .from("members")
    .select("id, phone, shopify_customer_id")
    .eq("id", referral.referrer_member_id)
    .maybeSingle();
  if (refErr) throw new Error(`referrer lookup failed: ${refErr.message}`);
  if (!referrer) return { checked: false, reason: "referrer_not_found" };

  const fetched = referrer.shopify_customer_id
    ? await fetchOrderCheckData(orderId, String(referrer.shopify_customer_id), input.shop)
    : { data: null, note: "referrer has no Shopify customer id" };
  const d = fetched.data;
  const ship = d?.order?.shippingAddress ?? null;
  const c = d?.customer ?? null;
  const theirAddresses: Array<ShippingLite> = [
    c?.defaultAddress ?? null,
    ...(c?.addressesV2?.nodes ?? []),
    ...(c?.orders?.nodes ?? []).map((o) => o?.shippingAddress ?? null),
  ];
  const result = orderVerdict(
    ship ? { phone: ship.phone, address: ship as AddressLike } : null,
    {
      phones: [referrer.phone, c?.defaultPhoneNumber?.phoneNumber, ...theirAddresses.map((a) => a?.phone)],
      addresses: theirAddresses,
    },
  );

  // A match tags the order for staff BEFORE the referral row is written: if the
  // process stops in between, the check (and the tag) simply runs again.
  const orderTag = result === "same_phone" || result === "same_address" ? await tagOrderForReview(orderId, input.shop) : null;

  const now = new Date().toISOString();
  const base = { order_check: result, order_checked_order_id: orderId, order_checked_at: now, ...(orderTag ? { order_tag: orderTag } : {}) };
  let patch: Database["public"]["Tables"]["referrals"]["Update"] = base;
  if (result === "same_phone") {
    patch = {
      ...base,
      status: "blocked",
      fraud_flags: appendUnique(referral.fraud_flags, "same_phone_on_order"),
      block_reason: ORDER_FLAGS.same_phone_on_order,
      alert_resolved_at: null,
    };
  } else if (result === "same_address") {
    const earlier = referral.status === "flagged" && referral.block_reason ? `${referral.block_reason}; ` : "";
    patch = {
      ...base,
      status: "flagged",
      fraud_flags: appendUnique(referral.fraud_flags, "same_address_on_order"),
      block_reason: `${earlier}${ORDER_FLAGS.same_address_on_order}`,
      alert_resolved_at: null,
    };
  } else if (result === "not_checked") {
    // Logged once: the order id is recorded, so later events for it skip the check.
    console.warn(
      `[referral-check] order ${orderId}, referral ${referral.id}: delivery details not available, not checked` +
        (fetched.note ? ` (${fetched.note})` : ""),
    );
  }
  const { error: updErr } = await db
    .from("referrals")
    .update(patch)
    .eq("id", referral.id)
    .in("status", ["pending", "flagged"]);
  if (updErr) throw new Error(`referral check update failed: ${updErr.message}`);
  return { checked: true, result, referralId: String(referral.id) };
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
  refund_basis_at_award_pkr: number;
  points_awarded_amount: number;
  points_reversed_amount: number;
  discount_codes: string[] | null;
};

/**
 * The friend's first order = her earliest order that was not cancelled. The
 * referral was only recorded because she had no orders at all, so every order
 * of hers is in order_webhook_state.
 */
export async function firstQualifyingOrder(shopifyCustomerId: string): Promise<OrderLite | null> {
  const { data, error } = await db
    .from("order_webhook_state")
    .select("shopify_order_id, points_awarded, cancelled_at, placed_at, created_at, earning_basis_pkr, refunded_basis_pkr, refund_basis_at_award_pkr, points_awarded_amount, points_reversed_amount, discount_codes")
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

/**
 * Nothing left of the order: it was refunded before the award (awarded on a
 * zero basis), every awarded point has been reversed, or less than one paisa
 * of the awarded basis remains. Compared on the stored remaining amount, not
 * on rounded sums.
 */
const fullyRefunded = (o: OrderLite): boolean => {
  const basis = Number(o.earning_basis_pkr ?? 0);
  if (basis <= 0) return true;
  if (o.points_awarded_amount > 0 && o.points_reversed_amount >= o.points_awarded_amount) return true;
  const since = Math.max(0, Number(o.refunded_basis_pkr ?? 0) - Number(o.refund_basis_at_award_pkr ?? 0));
  return basis - since < 0.01;
};

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

async function openReferralFor(customerId: string): Promise<ReferralRow | undefined> {
  const { data: open, error } = await db
    .from("referrals")
    .select("*")
    .eq("referred_shopify_customer_id", customerId)
    .in("status", ["pending", "flagged"])
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  return open?.[0] as ReferralRow | undefined;
}

/**
 * Pay the referrer if this customer was referred and her first order is now
 * fulfilled and paid. Safe to call after every award and every cancellation.
 * A flagged referral is not paid; it remembers the order and waits for review.
 * Before paying, the order-time check runs for the qualifying order if it has
 * not run yet (orders/create missed, or Shopify was down then); if Shopify
 * cannot answer now, this throws and nothing is paid (the job is retried).
 */
export async function completeReferralForCustomer(
  shopifyCustomerId: string,
  shop?: string | null,
): Promise<{ paid: boolean; points?: number; reason?: string; orderId?: string }> {
  const customerId = String(shopifyCustomerId);
  const found = await openReferralFor(customerId);
  if (!found) return { paid: false, reason: "no_open_referral" };
  let referral: ReferralRow = found;

  const order = await firstQualifyingOrder(customerId);
  if (!order) return { paid: false, reason: "no_order" };
  if (!order.points_awarded) return { paid: false, reason: "first_order_not_delivered_and_paid" };
  if (fullyRefunded(order)) return { paid: false, reason: "first_order_refunded" };

  if (referral.order_checked_order_id !== order.shopify_order_id && (order.discount_codes ?? []).length > 0) {
    try {
      const check = await checkReferralOrder({
        shopifyOrderId: order.shopify_order_id,
        shopifyCustomerId: customerId,
        discountCodes: order.discount_codes ?? [],
        shop,
      });
      if (check.checked) {
        const after = await openReferralFor(customerId);
        if (!after) return { paid: false, reason: "blocked_by_order_check", orderId: order.shopify_order_id };
        referral = after;
      }
    } catch (err) {
      // Never pay a referral whose order could not be checked yet.
      if (referral.status === "pending") throw err;
      console.error("[completeReferralForCustomer] order check not done yet:", err instanceof Error ? err.message : err);
    }
  }

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
      alert_resolved_at: new Date().toISOString(), // staff have decided: the Home alert is done
    })
    .eq("id", referralId)
    .eq("status", "flagged")
    .select("*");
  if (error) throw new Error(`could not approve referral: ${error.message}`);
  const referral = updated?.[0] as ReferralRow | undefined;
  if (!referral) return { ok: false, paid: false, reason: "not_flagged" };

  // Issue the friend's code now. This writes the code row first (pending),
  // so even if Shopify is down the pending-code sweep finishes it later.
  try {
    const issued = await issueReferralFriendCode(referral.id, shop || null);
    if (!issued.issued && issued.reason === "shopify_error") throw new Error("shopify_error");
  } catch (err) {
    console.error("[approveReferral] friend code not issued yet:", err instanceof Error ? err.message : err);
    await pointsQueue.add("issue_referral_friend_code", { referralId: referral.id, shop: shop || null });
  }

  if (!referral.referred_shopify_customer_id) return { ok: true, paid: false };
  const result = await completeReferralForCustomer(referral.referred_shopify_customer_id, shop || null);
  return { ok: true, paid: result.paid, reason: result.paid ? undefined : result.reason };
}

export async function rejectReferral(referralId: string, actor: string, note?: string): Promise<{ ok: boolean }> {
  const { data, error } = await db
    .from("referrals")
    .update({
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewed_note: `rejected by ${actor || "admin"}${note && note.trim() ? `: ${note.trim().slice(0, 500)}` : ""}`,
      alert_resolved_at: new Date().toISOString(),
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
