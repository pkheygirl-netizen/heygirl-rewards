// app/lib/referrals.service.ts
// Referral programme (rules 10 and 11).
//   record   - at the friend's first sign-in with a stored ?ref=slug; same
//              email/phone is blocked, similar email or same full name is held
//   check    - the friend's first qualifying order (fulfilled + paid, not
//              cancelled) is compared with the referrer's phone and addresses
//              BEFORE anything is paid, whether or not she used her
//              free-shipping code; an order that used the code is also
//              checked as soon as it is seen (orders/create), once per order
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
import {
  ORDER_CHECK_FAILED_FLAG, ORDER_CHECK_FAILED_REASON, ORDER_FLAGS, orderVerdict, REFERRAL_ORDER_TAG, signInVerdict,
  type AddressLike, type OrderCheckResult,
} from "./referral-checks.server";

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

// ── Order-time check (her first qualifying order; earlier when it used her code) ──

/** What referrals.order_check can hold (016's check constraint). */
type StoredCheck = Exclude<OrderCheckResult, "same_order_phone">;

type ShippingLite = { address1?: string | null; address2?: string | null; city?: string | null; phone?: string | null } | null;

const REFERRAL_ORDER_CHECK = `#graphql
  query HgReferralOrderCheck($orderId: ID!, $customerId: ID!) {
    order(id: $orderId) {
      shippingAddress { address1 address2 city phone }
    }
    customer(id: $customerId) {
      defaultPhoneNumber { phoneNumber }
      defaultAddress { address1 address2 city phone }
      addressesV2(first: 10) { nodes { address1 address2 city phone } }
      orders(first: 5, sortKey: CREATED_AT, reverse: true) { nodes { shippingAddress { address1 address2 city phone } } }
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

/** Shopify withheld data the app may not read (protected customer data, a missing scope): asking again will not help. */
const ACCESS_ERROR_RE = /not approved to (use|access)|access denied|protected customer data|required access/i;

type GraphqlErrorLike = { message?: unknown; extensions?: { code?: unknown } | null } | null | undefined;

/**
 * What a failed order-check request means (contract rule 10):
 *   retry        throttled, 5xx, no response, a 4xx other than 403, GraphQL
 *                errors that are not about access, an answer without data, or
 *                an error of unknown kind: nothing is decided, the caller
 *                throws so the job is retried (and nothing is paid meanwhile)
 *   answered     Shopify answered but withheld fields the app may not read
 *                (HTTP 200 with "not approved to access/use ..." or
 *                ACCESS_DENIED errors only), or HTTP 403: whatever data came
 *                back is used and missing fields are simply missing
 *                ("not_checked" when nothing comparable is left)
 */
export function orderCheckFailure(err: unknown): { retry: true; note: string } | { retry: false; data: unknown; note: string } {
  const note = err instanceof Error ? err.message.slice(0, 300) : "unknown error";
  if (err instanceof ShopifyRateLimitError) return { retry: true, note };
  const kind = classifyShopifyError(err).kind;
  if (kind === "transient" || kind === "throttled") return { retry: true, note };
  if (!err || typeof err !== "object") return { retry: true, note };
  const e = err as {
    response?: { code?: unknown; status?: unknown } | null;
    body?: { data?: unknown; errors?: { graphQLErrors?: GraphqlErrorLike[] } | GraphqlErrorLike[] } | null;
  };
  const status = typeof Response !== "undefined" && err instanceof Response ? err.status : Number(e.response?.code ?? e.response?.status);
  if (status === 403) return { retry: false, data: null, note };
  // @shopify/shopify-api throws GraphqlQueryError for HTTP 200 with GraphQL
  // errors, carrying the whole answer in `body` (body.data, body.errors.graphQLErrors).
  const body = e.body;
  if (body && typeof body === "object") {
    const raw = Array.isArray(body.errors) ? body.errors : body.errors?.graphQLErrors;
    const list: GraphqlErrorLike[] = Array.isArray(raw) && raw.length > 0 ? raw : [{ message: note }];
    const onlyAccess = list.every((g) => g?.extensions?.code === "ACCESS_DENIED" || ACCESS_ERROR_RE.test(String(g?.message ?? "")));
    if (onlyAccess) return { retry: false, data: body.data && typeof body.data === "object" ? body.data : null, note };
  }
  return { retry: true, note };
}

/**
 * The friend's shipping details and the referrer's phones and addresses, read
 * from Shopify for an in-memory comparison only (never stored or logged).
 * Without protected customer data access Shopify returns null for the
 * address and phone fields with an error beside them: whatever did come back
 * is used, and a field that did not is simply missing. Every other failure
 * (throttled, 5xx, unknown, an answer without data) throws so the caller can
 * try again later (orderCheckFailure).
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
    const failure = orderCheckFailure(err);
    if (failure.retry) throw err;
    return { data: failure.data as OrderCheckData | null, note: failure.note };
  }
}

export { ORDER_CHECK_FAILED_FLAG, ORDER_CHECK_FAILED_REASON, REFERRAL_ORDER_TAG };

const TAG_ORDER = `#graphql
  mutation HgTagReferralOrder($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }`;

let missingScopeLogged = false;

const MISSING_SCOPE_RE = /write_orders|access denied|not approved|scope/i;

/**
 * Add REFERRAL_ORDER_TAG to the order (Admin GraphQL tagsAdd; needs the
 * write_orders scope). The only write the app ever makes to an order: no
 * cancel, no edit, no other field. Adding the same tag twice is harmless, so
 * a 5xx is repeated (retryTransient). Never throws:
 *   "tagged"  done
 *   "failed"  a permission error or userErrors: the Home alert says the app
 *             may not have permission
 *   null      throttled, 5xx or anything else: nothing is stored, and the next
 *             event for the order tries again (retryOrderTag)
 */
async function tagOrderForReview(shopifyOrderId: string, shop?: string | null): Promise<"tagged" | "failed" | null> {
  try {
    const admin = await getAdminForShop(shop ?? undefined);
    const data = await shopifyGraphqlWithRetry<{
      tagsAdd: { node: { id: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } | null;
    }>(admin, TAG_ORDER, { id: `gid://shopify/Order/${shopifyOrderId}`, tags: [REFERRAL_ORDER_TAG] }, 3, { retryTransient: true });
    const errors = data.tagsAdd?.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`[referral-check] order ${shopifyOrderId} not tagged: ${errors.map((e) => e.message).join("; ")}`);
      return "failed";
    }
    if (!data.tagsAdd) {
      console.error(`[referral-check] order ${shopifyOrderId} not tagged yet: no answer; will try again`);
      return null;
    }
    return "tagged";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = Number((err as { response?: { code?: unknown } } | null)?.response?.code);
    const kind = err instanceof ShopifyRateLimitError ? "throttled" : classifyShopifyError(err).kind;
    if (kind !== "throttled" && kind !== "transient" && (status === 403 || MISSING_SCOPE_RE.test(msg))) {
      // Logged once per process: every order would hit the same missing permission.
      if (!missingScopeLogged) {
        missingScopeLogged = true;
        console.error(`[referral-check] orders cannot be tagged: the app needs the write_orders permission (${msg.slice(0, 200)})`);
      }
      return "failed";
    }
    console.error(`[referral-check] order ${shopifyOrderId} not tagged yet (${kind}); will try again:`, msg.slice(0, 300));
    return null;
  }
}

/**
 * A matched order whose tag could not be added yet (throttled, 5xx): try
 * again. Called on every later event for the friend's order, whatever the
 * referral's status (a same-phone match is already blocked).
 */
async function retryOrderTag(shopifyOrderId: string, shopifyCustomerId: string, shop?: string | null): Promise<void> {
  const { data, error } = await db
    .from("referrals")
    .select("id")
    .eq("referred_shopify_customer_id", shopifyCustomerId)
    .eq("order_checked_order_id", shopifyOrderId)
    .in("order_check", ["same_phone", "same_address"])
    .is("order_tag", null)
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  const row = data?.[0];
  if (!row) return;
  const tag = await tagOrderForReview(shopifyOrderId, shop);
  if (!tag) return;
  const { error: updErr } = await db.from("referrals").update({ order_tag: tag }).eq("id", row.id).is("order_tag", null);
  if (updErr) throw new Error(`referral tag update failed: ${updErr.message}`);
}

/**
 * retryOrderTag for any event of a referred friend's order (review 9, item 1):
 * a qualifying order without a discount code never reaches checkReferralOrder
 * again once it has been checked, so the tag retry must not depend on it.
 * One indexed database read; Shopify is called only when this order matched
 * and its tag is still missing. Never throws.
 */
export async function retryReferralOrderTag(shopifyOrderId: string, shopifyCustomerId: string, shop?: string | null): Promise<void> {
  const orderId = String(shopifyOrderId);
  await retryOrderTag(orderId, String(shopifyCustomerId), shop).catch((err) =>
    console.error(`[referral-check] tag retry for order ${orderId} failed:`, err instanceof Error ? err.message : err),
  );
}

/** Test hook. */
export function resetTagScopeLog(): void {
  missingScopeLogged = false;
}

/**
 * A HELD referral whose check on an order ended without recording that order
 * (Shopify did not answer, the referral was held at sign-in, or an earlier
 * match on another order is kept): every later event for the order would ask
 * Shopify again. So the check is tried at most once an hour per referral and
 * order (review 9, item 4). Kept in memory (no database column): a restart
 * only allows one extra try. A pending referral is never throttled (it is
 * paid only after the check), so Approve (which makes it pending) always
 * checks.
 */
export const HELD_CHECK_RETRY_MS = 60 * 60 * 1000;
const heldCheckAttempts = new Map<string, number>();
const attemptKey = (referralId: unknown, orderId: string) => `${String(referralId)}:${orderId}`;

function triedRecently(referralId: unknown, orderId: string): boolean {
  const at = heldCheckAttempts.get(attemptKey(referralId, orderId));
  return at !== undefined && Date.now() - at < HELD_CHECK_RETRY_MS;
}

function noteHeldAttempt(referralId: unknown, orderId: string): void {
  const now = Date.now();
  if (heldCheckAttempts.size > 1000) {
    for (const [k, at] of heldCheckAttempts) if (now - at >= HELD_CHECK_RETRY_MS) heldCheckAttempts.delete(k);
  }
  heldCheckAttempts.set(attemptKey(referralId, orderId), now);
}

/** Test hook. */
export function resetHeldCheckAttempts(): void {
  heldCheckAttempts.clear();
}

/** Reasons set by an order check (this module): every other reason was given at sign-in or by older rules. */
const ORDER_CHECK_FLAGS: ReadonlySet<string> = new Set([
  "same_phone_on_order", "same_order_phone_on_order", "same_address_on_order", ORDER_CHECK_FAILED_FLAG,
]);
/**
 * Held (now or before an Approve) for a reason that is NOT an order check:
 * similar email or same full name at sign-in (rule 10), or a reason from older
 * rules (same_ip, same_network, ...), or a held row with no reason at all.
 * Staff approving such a referral judge that reason, not an order, so an
 * order check Shopify never answered must not record the order id
 * (review 10, L1/L2): the flags decide, whatever the status (an approved
 * referral is pending again and still carries its sign-in flags).
 */
export function heldAtSignIn(r: { status?: unknown; fraud_flags?: unknown }): boolean {
  const flags = Array.isArray(r.fraud_flags) ? r.fraud_flags.map(String) : [];
  if (flags.some((f) => !ORDER_CHECK_FLAGS.has(f))) return true;
  return r.status === "flagged" && flags.length === 0;
}

/** The referral columns the order check reads. */
type OpenReferral = Pick<
  ReferralRow,
  "id" | "referrer_member_id" | "status" | "friend_code_id" | "fraud_flags" | "block_reason" | "order_check" | "order_checked_order_id"
>;

export type ReferralOrderCheck =
  | { checked: false; reason: "no_open_referral" | "no_friend_code" | "code_not_used" | "already_checked" | "referrer_not_found" | "tried_recently" }
  | { checked: true; result: OrderCheckResult; referralId: string };

const appendUnique = (list: unknown, item: string): string[] => {
  const arr = Array.isArray(list) ? list.map(String) : [];
  return arr.includes(item) ? arr : [...arr, item];
};

/**
 * The referral already records a match (same phone / same address) on ANOTHER
 * order of the friend, e.g. her code order matched the referrer's address and
 * a different, earlier order then became her qualifying order. A clean or
 * unreadable result for this order must not overwrite that earlier finding
 * (it carries the Home alert and the order link), so nothing is written: the
 * referral keeps its status and reasons. Possible only since the check also
 * runs on orders that did not use the code (owner decision, 19 Nov 2026).
 */
function keepsEarlierMatch(
  referral: { order_check?: unknown; order_checked_order_id?: unknown },
  orderId: string,
  result: OrderCheckResult,
): boolean {
  const earlier = referral.order_check === "same_phone" || referral.order_check === "same_address";
  const other = !!referral.order_checked_order_id && String(referral.order_checked_order_id) !== orderId;
  return earlier && other && (result === "clear" || result === "not_checked");
}


/**
 * Options for the order-time check. `finalAttempt` is true on the background
 * job's last try (points worker: attemptsMade + 1 >= attempts): a check that
 * still cannot get an answer from Shopify then holds the referral for staff
 * instead of throwing again.
 */
export type ReferralCheckOptions = { finalAttempt?: boolean };

/**
 * Rule 10, order-time check (owner decision 19 Nov 2026). Runs on:
 *   - the friend's FIRST QUALIFYING order (the one that would pay the
 *     referrer: fulfilled + paid, not cancelled), whether or not she used her
 *     free-shipping code: `qualifyingOrder: true`, called by
 *     completeReferralForCustomer before anything is paid, also for a referral
 *     held at sign-in (so a later Approve still cannot pay a self-referral);
 *   - any order that USED her referral free-shipping code, as soon as it is
 *     seen (orders/create, or the first event if that was missed), so the tag
 *     and the Home alert come early (`qualifyingOrder` absent).
 * The order's shipping phone and address are compared with the referrer's
 * (her phone, default and saved addresses, and the shipping details of her
 * last 5 orders):
 *   her own phone (members.phone, Shopify default phone)
 *                -> referral blocked (flag same_phone_on_order); the referrer
 *                   gets nothing; her right to refer is NOT removed (staff can)
 *   a phone only on her saved addresses or recent orders (could be a gift)
 *                -> referral held (flag same_order_phone_on_order; stored as
 *                   order_check same_phone with status flagged)
 *   same address -> referral held (flag same_address_on_order) for staff
 *   either way the order gets the tag "Rewards: check referral" in Shopify
 *   (tagsAdd; the only change ever made to an order) and a Home alert is
 *   raised (order_check, alert_resolved_at null).
 * Runs once per order (order_checked_order_id), so webhook replays repeat
 * nothing, and an order already checked when it was placed is not checked
 * again when it qualifies; only a tag that could not be added yet
 * (throttled) is tried again. A match already recorded on another order of
 * hers is never overwritten by a clean result (keepsEarlierMatch).
 * If Shopify cannot answer (throttled, 5xx, unknown error, no data) this
 * throws and the job is retried; on the job's final attempt the referral is
 * held instead (order_check not_checked, flag order_check_failed), so it is
 * never paid without a check and never left waiting unseen.
 */
export async function checkReferralOrder(input: {
  shopifyOrderId: string;
  shopifyCustomerId: string;
  /** The order's discount codes; only read when `qualifyingOrder` is not set. */
  discountCodes?: string[];
  shop?: string | null;
  finalAttempt?: boolean;
  /** The friend's first qualifying order: checked whether or not she used her code. */
  qualifyingOrder?: boolean;
  /**
   * Her open (pending or held) referral when the caller has just read it
   * (completeReferralForCustomer), so it is not read twice in one event.
   */
  openReferral?: OpenReferral;
}): Promise<ReferralOrderCheck> {
  const orderId = String(input.shopifyOrderId);
  await retryReferralOrderTag(orderId, String(input.shopifyCustomerId), input.shop);
  let referral = input.openReferral;
  if (!referral) {
    const { data: open, error } = await db
      .from("referrals")
      .select("id, referrer_member_id, status, friend_code_id, fraud_flags, block_reason, order_check, order_checked_order_id")
      .eq("referred_shopify_customer_id", String(input.shopifyCustomerId))
      .in("status", ["pending", "flagged"])
      .limit(1);
    if (error) throw new Error(`referral lookup failed: ${error.message}`);
    referral = open?.[0];
  }
  if (!referral) return { checked: false, reason: "no_open_referral" };
  if (referral.order_checked_order_id === orderId) return { checked: false, reason: "already_checked" };
  const held = referral.status === "flagged";
  if (held && triedRecently(referral.id, orderId)) return { checked: false, reason: "tried_recently" };

  if (!input.qualifyingOrder) {
    // Early check at orders/create: only for the order that used her code.
    if (!referral.friend_code_id) return { checked: false, reason: "no_friend_code" };
    const { data: code, error: codeErr } = await db
      .from("loyalty_codes")
      .select("code")
      .eq("id", referral.friend_code_id)
      .maybeSingle();
    if (codeErr) throw new Error(`friend code lookup failed: ${codeErr.message}`);
    const friendCode = code?.code ? String(code.code).toUpperCase() : null;
    const used = !!friendCode && (input.discountCodes ?? []).some((c) => String(c).trim().toUpperCase() === friendCode);
    if (!used) return { checked: false, reason: "code_not_used" };
  }

  const { data: referrer, error: refErr } = await db
    .from("members")
    .select("id, phone, shopify_customer_id")
    .eq("id", referral.referrer_member_id)
    .maybeSingle();
  if (refErr) throw new Error(`referrer lookup failed: ${refErr.message}`);
  if (!referrer) return { checked: false, reason: "referrer_not_found" };

  let fetched: { data: OrderCheckData | null; note?: string };
  try {
    fetched = referrer.shopify_customer_id
      ? await fetchOrderCheckData(orderId, String(referrer.shopify_customer_id), input.shop)
      : { data: null, note: "referrer has no Shopify customer id" };
  } catch (err) {
    if (!input.finalAttempt) {
      if (held) noteHeldAttempt(referral.id, orderId); // nothing recorded on the row: at most one try an hour
      throw err;
    }
    return holdUncheckedReferral(referral, orderId, err);
  }
  const d = fetched.data;
  const ship = d?.order?.shippingAddress ?? null;
  const c = d?.customer ?? null;
  const theirAddresses: Array<ShippingLite> = [
    c?.defaultAddress ?? null,
    ...(c?.addressesV2?.nodes ?? []),
    ...(c?.orders?.nodes ?? []).map((o) => o?.shippingAddress ?? null),
  ];
  const verdict = orderVerdict(
    ship ? { phone: ship.phone, address: ship as AddressLike } : null,
    {
      // her own account phones block; a phone only on a saved address or a
      // recent order may be a gift she sent the friend: held (owner, 19 Nov 2026)
      ownPhones: [referrer.phone, c?.defaultPhoneNumber?.phoneNumber],
      otherPhones: theirAddresses.map((a) => a?.phone),
      addresses: theirAddresses,
    },
  );
  const giftPhone = verdict === "same_order_phone";
  // Stored as "same_phone" (016's constraint); status flagged + flag tell it from a block.
  const result: StoredCheck = giftPhone ? "same_phone" : verdict;

  if (keepsEarlierMatch(referral, orderId, result)) {
    // Nothing written (the earlier finding stays on the row); a pending
    // (approved) referral is then paid, a held one keeps waiting for staff
    // and is not checked again on every event (at most once an hour; Approve
    // checks again anyway).
    if (held) noteHeldAttempt(referral.id, orderId);
    return { checked: true, result: verdict, referralId: String(referral.id) };
  }

  // A match tags the order for staff BEFORE the referral row is written: if the
  // process stops in between, the check (and the tag) simply runs again.
  const orderTag = result === "same_phone" || result === "same_address" ? await tagOrderForReview(orderId, input.shop) : null;

  const now = new Date().toISOString();
  const base = { order_check: result, order_checked_order_id: orderId, order_checked_at: now, ...(orderTag ? { order_tag: orderTag } : {}) };
  let patch: Database["public"]["Tables"]["referrals"]["Update"] = base;
  if (giftPhone) {
    const earlier = referral.status === "flagged" && referral.block_reason ? `${referral.block_reason}; ` : "";
    patch = {
      ...base,
      status: "flagged",
      fraud_flags: appendUnique(referral.fraud_flags, "same_order_phone_on_order"),
      block_reason: `${earlier}${ORDER_FLAGS.same_order_phone_on_order}`,
      alert_resolved_at: null,
    };
  } else if (result === "same_phone") {
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
    // Shopify answered but gave nothing comparable (fields withheld, no
    // shipping line): the referral proceeds (rule 10), and Home counts it
    // until staff dismiss it.
    patch = { ...base, alert_resolved_at: null };
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
  return { checked: true, result: verdict, referralId: String(referral.id) };
}

/**
 * The job's last try and Shopify still has not answered: hold the referral for
 * staff (safest: the referrer is paid only if someone approves) and record
 * why. order_check = not_checked, so Home counts it; the order id is recorded,
 * so approval pays without asking Shopify again. No tag (nothing matched).
 * Exception (review 9, item 3): a referral already held at sign-in (similar
 * email, same name) does NOT get the order id, because staff approving it
 * would be judging the sign-in reason, not this order: Approve (or a later
 * event, at most once an hour) then runs the check before anything is paid.
 */
async function holdUncheckedReferral(
  referral: { id: unknown; status: unknown; fraud_flags: unknown; block_reason: unknown; order_check?: unknown; order_checked_order_id?: unknown },
  orderId: string,
  err: unknown,
): Promise<ReferralOrderCheck> {
  console.error(
    `[referral-check] order ${orderId}, referral ${String(referral.id)}: Shopify did not answer on the last try; referral held for staff:`,
    err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
  );
  // Already held because another order of hers matched the referrer: it stays
  // held with that finding (and its alert); nothing to add.
  if (referral.status === "flagged" && keepsEarlierMatch(referral, orderId, "not_checked")) {
    noteHeldAttempt(referral.id, orderId);
    return { checked: true, result: "not_checked", referralId: String(referral.id) };
  }
  const signInHold = heldAtSignIn(referral);
  if (signInHold) noteHeldAttempt(referral.id, orderId);
  const before = referral.status === "flagged" && referral.block_reason ? String(referral.block_reason) : "";
  const blockReason = before.includes(ORDER_CHECK_FAILED_REASON) ? before : before ? `${before}; ${ORDER_CHECK_FAILED_REASON}` : ORDER_CHECK_FAILED_REASON;
  const { error } = await db
    .from("referrals")
    .update({
      status: "flagged",
      order_check: "not_checked",
      ...(signInHold ? {} : { order_checked_order_id: orderId }),
      order_checked_at: new Date().toISOString(),
      fraud_flags: appendUnique(referral.fraud_flags, ORDER_CHECK_FAILED_FLAG),
      block_reason: blockReason,
      alert_resolved_at: null,
    })
    .eq("id", String(referral.id))
    .in("status", ["pending", "flagged"]);
  if (error) throw new Error(`referral check update failed: ${error.message}`);
  return { checked: true, result: "not_checked", referralId: String(referral.id) };
}

// ── Completion ────────────────────────────────────────────────────────────

const ORDER_LITE_COLUMNS =
  "shopify_order_id, points_awarded, cancelled_at, placed_at, created_at, earning_basis_pkr, refunded_basis_pkr, refund_basis_at_award_pkr, points_awarded_amount, points_reversed_amount, discount_codes";

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
    .select(ORDER_LITE_COLUMNS)
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

/**
 * Pay the referrer (review 12, item 2: one database call). pay_referral
 * (migration 017) locks the referral, then the qualifying order row, then the
 * referrer, checks the referral is still pending, the referral rule is on,
 * the referrer may be paid and the order is not cancelled or refunded in
 * full, adds the points (award_points, idempotent on member / referral_earned
 * / referral id) and marks the referral completed with points_awarded=true,
 * all in one transaction. So a Reject (or a block) that lands first wins, a
 * cancellation that lands first wins, and there is no half-done state for a
 * cron run or another event to finish or release.
 *
 * Kept from review 11: the order is read again right before the payment (a
 * cancelled or fully refunded order: nothing added, the referral stays
 * pending, a later qualifying order of hers can still pay it) and right after
 * it (cancelled or refunded in full meanwhile: reverse_referral, rejected).
 */
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

  const before = await orderStillQualifies(shopifyOrderId);
  if (before !== "ok") return { paid: false, reason: `qualifying_order_${before}_before_award` };

  const out = await callPayReferral(referral, r, points, shopifyOrderId, settings, false);
  return { paid: out.paid, points: out.points, reason: out.reason };
}

type PayOutcome = { paid: boolean; points?: number; reason?: string; outcome: string };

/** pay_referral outcomes that changed nothing because a check refused (from a claim: the claim was put back to pending in the same transaction). */
const PAY_REFUSALS = new Set(["disabled", "referrer_not_found", "referrer_not_eligible", "zero_points", "order_cancelled", "order_refunded"]);

/**
 * pay_referral, then the post-payment order re-read and the email. The
 * "referral completed" email is queued only by the call whose pay_referral
 * set points_awarded ("paid", or "recorded" for points found in the ledger),
 * under the fixed job id, and not when the re-read reverses it.
 */
async function callPayReferral(
  referral: Pick<ReferralRow, "id" | "referred_shopify_customer_id" | "referrer_member_id">,
  r: MemberRow,
  points: number,
  shopifyOrderId: string | null,
  settings: Awaited<ReturnType<typeof getSettings>>,
  fromClaim: boolean,
): Promise<PayOutcome> {
  const { data, error } = await db.rpc("pay_referral", {
    p_referral_id: String(referral.id),
    p_points: points,
    p_shopify_order_id: shopifyOrderId as string,
    p_expires_at: expiresAtForTier(r.tier, settings),
    p_reason_note: `referral ${referral.id} completed by customer ${referral.referred_shopify_customer_id}`,
    p_customer_note: "Your friend's first order",
    p_from_claim: fromClaim,
  });
  if (error) throw new Error(`pay_referral failed: ${error.message}`);
  const row = data?.[0];
  const outcome = String(row?.outcome ?? "unknown");
  if (outcome === "order_not_found") {
    // Review 13: the database has no row for the qualifying order (or the
    // claim names none), so it refused to pay and changed nothing. Not paid;
    // thrown so a live event or complete_referral job is retried later and
    // the cron sweep counts it as failed (alert:referral_payments).
    throw new Error(`referral ${referral.id} not paid yet: pay_referral found no row for the qualifying order; will retry`);
  }
  if (outcome === "paid" || outcome === "recorded") {
    const paidPoints = Number(row?.paid_points ?? points);
    // Review 10, L3: the order may have been cancelled or refunded in full
    // while this call was paying. Read it again now that the points are in;
    // if it is gone, take them back (reverse_referral is idempotent, so the
    // worker doing it too changes nothing).
    const gone = shopifyOrderId ? await reverseIfOrderGone(String(referral.id), shopifyOrderId) : null;
    if (gone) return { paid: false, points: paidPoints, reason: `qualifying_order_${gone}`, outcome };
    await queueReferralCompletedEmail(String(referral.id), r.id, paidPoints);
    return { paid: true, points: paidPoints, outcome };
  }
  if (outcome === "order_cancelled" || outcome === "order_refunded") {
    return { paid: false, reason: `qualifying_order_${outcome.slice("order_".length)}_before_award`, outcome };
  }
  if (outcome === "already_paid") return { paid: false, points: Number(row?.paid_points ?? 0) || points, reason: "already_paid", outcome };
  return { paid: false, reason: outcome, outcome };
}

/** "ok" while the order is there, not cancelled and not refunded in full; null row = "ok" (nothing says otherwise). */
async function orderStillQualifies(shopifyOrderId: string): Promise<"ok" | "cancelled" | "refunded"> {
  const { data, error } = await db
    .from("order_webhook_state")
    .select(ORDER_LITE_COLUMNS)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (error) throw new Error(`order lookup failed: ${error.message}`);
  const o = data as OrderLite | null;
  return o?.cancelled_at ? "cancelled" : o && fullyRefunded(o) ? "refunded" : "ok";
}

/**
 * An older half-done payment (claimed: completed, points_awarded=false,
 * reward_points set) back to `pending`, through release_referral_claim (017):
 * under the referral's row lock and only when no referral_earned ledger row
 * exists for it. "released" | "paid" (the points were added: not released) |
 * "not_claimed" | "conflict" | "not_found".
 */
async function releaseClaim(referralId: string): Promise<string> {
  const { data, error } = await db.rpc("release_referral_claim", { p_referral_id: referralId });
  if (error) throw new Error(`release_referral_claim failed: ${error.message}`);
  return String(data ?? "unknown");
}

/**
 * The claimed order was cancelled or refunded in full: reverse the referral by
 * its id (reverse_referral, idempotent) and say why; null while it still
 * qualifies or when the order row is not found.
 */
async function reverseIfOrderGone(referralId: string, shopifyOrderId: string): Promise<"cancelled" | "refunded" | null> {
  const gone = await orderStillQualifies(shopifyOrderId);
  if (gone === "ok") return null;
  await reverseReferralById(referralId, gone, shopifyOrderId);
  return gone;
}

/**
 * The referrer's "referral completed" email, once per referral: a fixed job id
 * (BullMQ ignores an add whose id is already queued, running or recently
 * finished), queued only after this call set points_awarded (review 11, item
 * 8). The points are already paid by then, so a Redis failure is logged (the
 * referral id only) and does not fail the payment.
 */
export const referralCompletedJobId = (referralId: string) => `referral_completed-${referralId}`;
async function queueReferralCompletedEmail(referralId: string, memberId: string, points: number): Promise<boolean> {
  try {
    await notificationQueue.add("referral_completed", { memberId, points }, { jobId: referralCompletedJobId(referralId) });
  } catch (err) {
    console.error(`[referrals] completed email not queued for referral ${referralId}:`, err instanceof Error ? err.message : err);
    return false;
  }
  // Review 13: remember that it was queued (017's completion_email_queued_at),
  // so the cron sweep only queues the ones lost to a crash or a Redis error.
  // A failed write is logged: the sweep then queues it again under the same
  // job id, which BullMQ drops while the first job is still kept.
  const { error } = await db
    .from("referrals")
    .update({ completion_email_queued_at: new Date().toISOString() })
    .eq("id", referralId)
    .is("completion_email_queued_at", null);
  if (error) console.error(`[referrals] completed email for referral ${referralId} queued but not recorded:`, error.message);
  return true;
}

/**
 * complete_referral jobs carry a fixed id per referral (review 13), so the
 * cron sweeps never queue a second one for the same referral while one is
 * waiting, delayed or running. A job that failed for good is replaced (a
 * dead job must not block recovery). A finished one is kept for 24 hours
 * (removeOnComplete below) and, unless `replaceFinished`, blocks a new one
 * for that long, so a referral that keeps being refused for the same reason
 * is retried at most once a day by the sweep. Approve and a released claim
 * pass `replaceFinished`, since something has changed.
 */
export const completeReferralJobId = (referralId: string) => `complete_referral-${referralId}`;
export const COMPLETE_REFERRAL_KEEP_SECONDS = 24 * 60 * 60;
export async function queueCompleteReferral(
  referralId: string,
  shopifyCustomerId: string,
  shop: string | null,
  opts: { replaceFinished: boolean },
): Promise<"queued" | "open" | "recent"> {
  const jobId = completeReferralJobId(referralId);
  const existing = await pointsQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || (state === "completed" && opts.replaceFinished)) await existing.remove();
    else if (state === "completed") return "recent";
    else if (state !== "unknown") return "open";
  }
  await pointsQueue.add(
    "complete_referral",
    { shopifyCustomerId, shop },
    { jobId, removeOnComplete: { age: COMPLETE_REFERRAL_KEEP_SECONDS, count: 5000 } },
  );
  return "queued";
}

/**
 * The referrer's `referral_earned` ledger row for this referral (the key
 * award_points is idempotent on: member / referral_earned / referral id), or
 * null when the points were never added. The ledger, not points_awarded, says
 * whether she was paid (review 9, item 2).
 */
async function earnedReferralPoints(referral: Pick<ReferralRow, "id" | "referrer_member_id">): Promise<number | null> {
  const { data, error } = await db
    .from("points_ledger")
    .select("points")
    .eq("member_id", referral.referrer_member_id)
    .eq("action_type", "referral_earned")
    .eq("reference_id", String(referral.id))
    .maybeSingle();
  if (error) throw new Error(`referral ledger lookup failed: ${error.message}`);
  return data ? Number(data.points ?? 0) : null;
}

/** Claims older than this are finished by the cron sweep or an order event (a payment in flight is left alone). */
export const CLAIMED_REFERRAL_GRACE_MS = 10 * 60 * 1000;

/**
 * An older half-done payment (completed, points_awarded=false, reward_points
 * set by the pre-017 payReferral) for this friend whose claim is older than
 * CLAIMED_REFERRAL_GRACE_MS (review 12: a claim in flight is left alone, as
 * the cron sweep does). Since 017 a payment is one transaction and makes no
 * such row; they can only be left by the earlier code. Older rows marked
 * completed without payment by the pre-v3 admin button have no reward_points
 * and are never picked up here.
 */
async function claimedUnpaidReferralFor(customerId: string, now: Date = new Date()): Promise<{ row?: ReferralRow; inFlight: boolean }> {
  const { data, error } = await db
    .from("referrals")
    .select("*")
    .eq("referred_shopify_customer_id", customerId)
    .eq("status", "completed")
    .eq("points_awarded", false)
    .not("reward_points", "is", null)
    .limit(5);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  const rows = (data ?? []) as ReferralRow[];
  const cutoff = now.getTime() - CLAIMED_REFERRAL_GRACE_MS;
  const settled = rows.find((x) => !x.completed_at || Date.parse(String(x.completed_at)) < cutoff);
  return { row: settled, inFlight: !settled && rows.length > 0 };
}

/**
 * Finish an older half-done payment. Without a ledger row: if the claimed
 * order still qualifies and the referrer may still be paid, pay_referral
 * (from the claim) pays it; otherwise release_referral_claim puts it back to
 * pending (only while no ledger row exists) and null is returned, so the
 * normal rules decide again (a later order may be her first now). With a
 * ledger row: pay_referral records it (points_awarded), and the post-payment
 * re-read reverses it if the claimed order is gone.
 */
async function resumeClaimedReferral(
  referral: ReferralRow,
  customerId: string,
): Promise<{ paid: boolean; points?: number; reason?: string; orderId?: string } | null> {
  const claimedOrderId = referral.shopify_order_id ? String(referral.shopify_order_id) : null;
  const settings = await getSettings();
  const { data: referrer } = await db.from("members").select("*").eq("id", referral.referrer_member_id).maybeSingle();
  const r = referrer as MemberRow | null;
  const points = Number(referral.reward_points ?? 0);

  if ((await earnedReferralPoints(referral)) === null) {
    const order = customerId ? await firstQualifyingOrder(customerId) : null;
    // The same eligibility payReferral checks (review 9, item 5): a referrer
    // blocked or opted out since, or the rule switched off, is not paid.
    const eligible = !!r && !r.is_blocked && !r.opted_out && !r.referrals_blocked && isEarnRuleEnabled(settings, "referral");
    const qualifies = !!order && eligible && points > 0 && order.shopify_order_id === claimedOrderId && order.points_awarded && !fullyRefunded(order);
    if (!qualifies) {
      const released = await releaseClaim(String(referral.id));
      if (released === "released") return null; // decide again from pending
      if (released !== "paid") return { paid: false, reason: `claim_${released}`, orderId: claimedOrderId ?? undefined };
      // "paid": the points went in meanwhile; record them below.
    }
  }
  if (!r) return { paid: false, reason: "referrer_not_found", orderId: claimedOrderId ?? undefined };
  const out = await callPayReferral(referral, r, points, claimedOrderId, settings, true);
  // A check refused inside the transaction: pay_referral put the claim back to pending.
  if (PAY_REFUSALS.has(out.outcome)) return null;
  return { paid: out.paid, points: out.points, reason: out.reason, orderId: claimedOrderId ?? undefined };
}

/**
 * Review 11, item 10 (cron, every 10 minutes with the pending-code sweep):
 * finish older half-done payments (completed, points_awarded=false,
 * reward_points set) claimed more than 10 minutes ago, through
 * resumeClaimedReferral: ledger row present -> points_awarded set and the
 * email queued (fixed job id), or reversed if the claimed order was cancelled
 * or refunded in full since; absent -> paid if the order still qualifies,
 * otherwise back to `pending` and a complete_referral job decides again. A
 * claimed row with no friend id and no ledger row is put back to pending
 * (review 12: it used to count as failed on every run). `failed` > 0 is
 * reported by the cron run (alert heartbeat, review 12 item 3).
 */
export async function finishClaimedReferrals(now: Date = new Date()): Promise<{
  recorded: number; paid: number; reversed: number; released: number; skipped: number; failed: number;
}> {
  const out = { recorded: 0, paid: 0, reversed: 0, released: 0, skipped: 0, failed: 0 };
  const { data, error } = await db
    .from("referrals")
    .select("*")
    .eq("status", "completed")
    .eq("points_awarded", false)
    .not("reward_points", "is", null)
    .lt("completed_at", new Date(now.getTime() - CLAIMED_REFERRAL_GRACE_MS).toISOString())
    .order("completed_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`claimed referral query failed: ${error.message}`);
  for (const row of (data ?? []) as ReferralRow[]) {
    try {
      const customerId = row.referred_shopify_customer_id ? String(row.referred_shopify_customer_id) : "";
      const hadLedgerRow = (await earnedReferralPoints(row)) !== null;
      const r = await resumeClaimedReferral(row, customerId);
      if (r === null) {
        out.released++;
        if (customerId) await queueCompleteReferral(String(row.id), customerId, null, { replaceFinished: true });
      } else if (r.reason === "claim_conflict" || r.reason === "conflict") {
        // Review 13: another open referral for this friend stops the claim
        // going back to pending. Nothing is queued (it would be refused the
        // same way on every run); counted as failed so the alert shows it.
        out.failed++;
        console.error(`[finishClaimedReferrals] referral ${row.id}: claim cannot go back to pending (another open referral for the same friend); staff must decide`);
      } else if (r.reason?.startsWith("qualifying_order_")) {
        out.reversed++;
      } else if (r.paid) {
        if (hadLedgerRow) out.recorded++;
        else out.paid++;
      } else {
        out.skipped++; // changed meanwhile (paid, released or decided by another call)
      }
    } catch (err) {
      out.failed++;
      console.error(`[finishClaimedReferrals] referral ${row.id} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return out;
}

/** At most this many complete_referral jobs are queued by one sweep run (review 13). */
export const REQUEUE_REFERRALS_PER_RUN = 100;
const REQUEUE_PAGE = 500;
const REQUEUE_MAX_PAGES = 10;

/**
 * Review 13 (cron, every 10 minutes): a pending referral whose friend's first
 * order already qualifies (fulfilled and paid, not cancelled, not refunded in
 * full) but was never paid, because migration 017 landed after the event,
 * or the event's jobs died. Queues complete_referral for it (fixed job id per
 * referral: nothing is queued while one is open, a dead one is replaced, a
 * finished one blocks for 24 hours), at most REQUEUE_REFERRALS_PER_RUN a run.
 * Skipped: the referral rule switched off, a referrer who may not be paid
 * (blocked, opted out, referrals_blocked), and an order that changed in the
 * last 10 minutes (its own event is still handling it). The "first order" is
 * the same as completeReferralForCustomer's: her earliest order not cancelled.
 */
export async function requeueStalledReferrals(now: Date = new Date()): Promise<{
  queued: number; open: number; failed: number; reason?: string;
}> {
  const out = { queued: 0, open: 0, failed: 0 };
  const settings = await getSettings();
  if (!isEarnRuleEnabled(settings, "referral")) return { ...out, reason: "disabled" };
  const settledBefore = now.getTime() - CLAIMED_REFERRAL_GRACE_MS;

  for (let page = 0; page < REQUEUE_MAX_PAGES && out.queued < REQUEUE_REFERRALS_PER_RUN; page++) {
    const { data, error } = await db
      .from("referrals")
      .select("id, referrer_member_id, referred_shopify_customer_id")
      .eq("status", "pending")
      .not("referred_shopify_customer_id", "is", null)
      .order("created_at", { ascending: true })
      .range(page * REQUEUE_PAGE, page * REQUEUE_PAGE + REQUEUE_PAGE - 1);
    if (error) throw new Error(`pending referral query failed: ${error.message}`);
    const rows = (data ?? []) as Array<Pick<ReferralRow, "id" | "referrer_member_id" | "referred_shopify_customer_id">>;
    if (rows.length === 0) break;

    const customers = [...new Set(rows.map((r) => String(r.referred_shopify_customer_id)))];
    const { data: orderRows, error: orderErr } = await db
      .from("order_webhook_state")
      .select(`${ORDER_LITE_COLUMNS}, shopify_customer_id, updated_at`)
      .in("shopify_customer_id", customers)
      .is("cancelled_at", null)
      .limit(5000);
    if (orderErr) throw new Error(`order lookup failed: ${orderErr.message}`);
    const when = (o: OrderLite) => Date.parse(o.placed_at ?? o.created_at);
    const first = new Map<string, OrderLite & { updated_at?: string | null }>();
    for (const o of (orderRows ?? []) as unknown as Array<OrderLite & { shopify_customer_id: string; updated_at?: string | null }>) {
      const cur = first.get(String(o.shopify_customer_id));
      if (!cur || when(o) < when(cur)) first.set(String(o.shopify_customer_id), o);
    }
    const due = rows.filter((r) => {
      const o = first.get(String(r.referred_shopify_customer_id));
      if (!o || !o.points_awarded || fullyRefunded(o)) return false;
      return !o.updated_at || Date.parse(String(o.updated_at)) < settledBefore;
    });
    if (due.length === 0) {
      if (rows.length < REQUEUE_PAGE) break;
      continue;
    }

    const { data: referrers, error: refErr } = await db
      .from("members")
      .select("id, is_blocked, opted_out, referrals_blocked")
      .in("id", [...new Set(due.map((r) => String(r.referrer_member_id)))]);
    if (refErr) throw new Error(`referrer lookup failed: ${refErr.message}`);
    const payable = new Set(
      ((referrers ?? []) as Array<Pick<MemberRow, "id" | "is_blocked" | "opted_out" | "referrals_blocked">>)
        .filter((m) => !m.is_blocked && !m.opted_out && !m.referrals_blocked)
        .map((m) => String(m.id)),
    );

    for (const r of due) {
      if (out.queued >= REQUEUE_REFERRALS_PER_RUN) break;
      if (!payable.has(String(r.referrer_member_id))) continue;
      try {
        const res = await queueCompleteReferral(String(r.id), String(r.referred_shopify_customer_id), null, { replaceFinished: false });
        if (res === "queued") out.queued++;
        else out.open++;
      } catch (err) {
        out.failed++;
        console.error(`[requeueStalledReferrals] referral ${r.id} not queued:`, err instanceof Error ? err.message : err);
      }
    }
    if (rows.length < REQUEUE_PAGE) break;
  }
  return out;
}

/** Lost "referral completed" emails are looked for this far back (review 13). */
export const LOST_EMAIL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Review 13 (cron, every 10 minutes): referrals completed and paid in the
 * last 7 days whose "referral completed" email was never recorded as queued
 * (completion_email_queued_at, migration 017, still null: the process
 * stopped or Redis failed between the payment and the queue). Queued under
 * the fixed job id referral_completed-<id>, at most 100 a run. A payment
 * younger than 10 minutes is left to the call that made it (it may still be
 * re-reading the order and reversing it).
 */
export async function queueLostReferralEmails(now: Date = new Date()): Promise<{ queued: number; failed: number }> {
  const out = { queued: 0, failed: 0 };
  const { data, error } = await db
    .from("referrals")
    .select("id, referrer_member_id, reward_points")
    .eq("status", "completed")
    .eq("points_awarded", true)
    .is("completion_email_queued_at", null)
    .gte("completed_at", new Date(now.getTime() - LOST_EMAIL_WINDOW_MS).toISOString())
    .lt("completed_at", new Date(now.getTime() - CLAIMED_REFERRAL_GRACE_MS).toISOString())
    .order("completed_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`lost referral email query failed: ${error.message}`);
  for (const r of (data ?? []) as Array<Pick<ReferralRow, "id" | "referrer_member_id" | "reward_points">>) {
    const ok = await queueReferralCompletedEmail(String(r.id), String(r.referrer_member_id), Number(r.reward_points ?? 0));
    if (ok) out.queued++;
    else out.failed++;
  }
  return out;
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
 * Before paying, the order-time check runs on the qualifying order if it has
 * not run on that order yet, whether or not she used her free-shipping code
 * (owner decision 19 Nov 2026: a self-referrer cannot dodge it by leaving the
 * code out). It runs for a held referral too, so a referral held at sign-in
 * and approved later is still checked (or already blocked) before payment.
 * If Shopify cannot answer now, a pending referral is not paid: this throws
 * and the job is retried (final attempt: held, see holdUncheckedReferral).
 */
export async function completeReferralForCustomer(
  shopifyCustomerId: string,
  shop?: string | null,
  opts: ReferralCheckOptions = {},
): Promise<{ paid: boolean; points?: number; reason?: string; orderId?: string }> {
  const customerId = String(shopifyCustomerId);
  let found = await openReferralFor(customerId);
  if (!found) {
    // An older half-done payment (claimed before 017). One claimed less than
    // 10 minutes ago may still be in flight: left alone, as the cron does.
    const claimed = await claimedUnpaidReferralFor(customerId);
    if (!claimed.row) return { paid: false, reason: claimed.inFlight ? "claim_in_flight" : "no_open_referral" };
    const resumed = await resumeClaimedReferral(claimed.row, customerId);
    if (resumed) return resumed;
    found = await openReferralFor(customerId);
    if (!found) return { paid: false, reason: "no_open_referral" };
  }
  let referral: ReferralRow = found;

  const order = await firstQualifyingOrder(customerId);
  if (!order) return { paid: false, reason: "no_order" };
  if (!order.points_awarded) return { paid: false, reason: "first_order_not_delivered_and_paid" };
  if (fullyRefunded(order)) return { paid: false, reason: "first_order_refunded" };

  if (referral.order_checked_order_id !== order.shopify_order_id) {
    try {
      const check = await checkReferralOrder({
        shopifyOrderId: order.shopify_order_id,
        shopifyCustomerId: customerId,
        discountCodes: order.discount_codes ?? [],
        shop,
        finalAttempt: opts.finalAttempt,
        qualifyingOrder: true,
        openReferral: referral,
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
 * referrer is paid at once if the friend's first order already qualifies AND
 * the order-time check has run on that order. Approve never skips that check:
 *   - approved before she has ordered: the check runs when her first order
 *     qualifies (completeReferralForCustomer), code or no code;
 *   - the qualifying order was already checked while the referral was held
 *     (a same-phone result blocked it, so it cannot be approved at all; a
 *     clean, unreadable or same-address result, or a check Shopify never
 *     answered, is recorded on the order): paid without asking Shopify again,
 *     because staff have looked;
 *   - not checked yet (Shopify was down): checked now; if Shopify still cannot
 *     answer, a complete_referral job finishes it with retries.
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
  let result: Awaited<ReturnType<typeof completeReferralForCustomer>>;
  try {
    result = await completeReferralForCustomer(referral.referred_shopify_customer_id, shop || null);
  } catch (err) {
    // Shopify could not answer the order check (or the award failed): the
    // approval stands and a background job finishes it, with retries, so the
    // referral cannot be left waiting with no event to drive it.
    console.error("[approveReferral] payment not finished yet, queued:", err instanceof Error ? err.message : err);
    await queueCompleteReferral(String(referral.id), referral.referred_shopify_customer_id, shop || null, { replaceFinished: true });
    return { ok: true, paid: false, reason: "queued" };
  }
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
 * was paid: take the points back (floored at zero by the database). Review
 * 12: found by referral id, whatever the referral's status: every referral
 * naming this order and every referral_earned ledger row written for this
 * order, each reversed through reverse_referral (017: under the referral's
 * row lock, only when a referral_earned row exists for it and no
 * referral_reversal row does yet; idempotent). A referral left pending by an
 * old race with its points in the ledger is reversed too.
 */
export async function reverseReferralForOrder(
  shopifyOrderId: string,
  why: "refunded" | "cancelled",
): Promise<{ reversed: boolean; points?: number }> {
  const orderId = String(shopifyOrderId);
  const [byRow, byLedger] = await Promise.all([
    db.from("referrals").select("id").eq("shopify_order_id", orderId).limit(20),
    db.from("points_ledger").select("reference_id").eq("action_type", "referral_earned").eq("shopify_order_id", orderId).limit(20),
  ]);
  if (byRow.error) throw new Error(`referral lookup failed: ${byRow.error.message}`);
  if (byLedger.error) throw new Error(`referral ledger lookup failed: ${byLedger.error.message}`);
  const ids = new Set<string>();
  for (const x of byRow.data ?? []) ids.add(String(x.id));
  for (const x of byLedger.data ?? []) if (x.reference_id) ids.add(String(x.reference_id));
  let reversed = false;
  let points = 0;
  for (const id of ids) {
    const r = await reverseReferralById(id, why, orderId);
    if (r.outcome === "reversed") {
      reversed = true;
      points += r.points;
    }
  }
  return { reversed, points };
}

/** reverse_referral (017) for one referral: "reversed" | "already_reversed" | "not_paid" | "other_order" | "not_found". */
async function reverseReferralById(
  referralId: string,
  why: "refunded" | "cancelled",
  shopifyOrderId: string,
): Promise<{ outcome: string; points: number }> {
  const { data, error } = await db.rpc("reverse_referral", {
    p_referral_id: referralId,
    p_reason: why,
    p_shopify_order_id: shopifyOrderId,
    p_customer_note: `Referral reversed: your friend's order was ${why}`,
  });
  if (error) throw new Error(`reverse_referral failed: ${error.message}`);
  const row = data?.[0];
  return { outcome: String(row?.outcome ?? "unknown"), points: Number(row?.reversed_points ?? 0) };
}
