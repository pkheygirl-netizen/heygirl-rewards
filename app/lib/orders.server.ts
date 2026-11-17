// app/lib/orders.server.ts
// Everything that happens to points because of an order:
//   orders/create | orders/updated | orders/fulfilled  -> processOrderEvent
//   refunds/create                                     -> processRefundEvent
//   orders/cancelled                                   -> processOrderCancelled
// Webhook routes only parse and enqueue; the points worker runs these one job
// at a time. Every step is safe to repeat.
import { db } from "../db.server";
import type { Database } from "../database.types";
import { notificationQueue } from "./queue.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";
import { getAdminForShop } from "./worker-admin.server";
import { getSettings, isEarnRuleSwitchedOn, karachiParts } from "./settings.server";
import {
  checkAndUpgradeTier,
  computePurchasePoints,
  enrolFromOrder,
  expiresAtForTier,
  selectMultiplier,
  type CustomerInput,
} from "./points.service";
import { completeReferralForCustomer, reverseReferralForOrder, shopifyOrderCount } from "./referrals.service";
import { effectiveReferralPoints, findInfluencerByCodes } from "./influencer.service";
import { returnRedemptionsForCancelledOrder } from "./redemption.service";

type OrderState = Database["public"]["Tables"]["order_webhook_state"]["Row"];
type MemberRow = Database["public"]["Tables"]["members"]["Row"];

// ── Parsing (pure) ────────────────────────────────────────────────────────

export type OrderEvent = {
  id: string;
  name: string | null;
  customer: CustomerInput | null;
  placedAt: string | null;
  /** total - shipping - tax, using the order's current figures (rule 1, before gift cards) */
  merchandisePkr: number;
  /** the same from the order's ORIGINAL figures: what it was worth before any refund or removal */
  grossMerchandisePkr: number;
  /** Shopify's updated_at for this payload: an older payload never overwrites a newer one */
  updatedAt: string | null;
  /** prices include tax (refund line values then include tax too) */
  taxesIncluded: boolean;
  fulfillmentStatus: string | null;
  financialStatus: string | null;
  cancelledAt: string | null;
  discountCodes: string[];
  hasGiftCard: boolean;
};

type Loose = Record<string, unknown>;
const obj = (v: unknown): Loose | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const money2 = (n: number): number => Math.round(n * 100) / 100;
const shopMoney = (set: unknown): number | null => {
  const amount = obj(obj(set)?.shop_money)?.amount;
  return amount === undefined || amount === null ? null : num(amount);
};

/**
 * Sum of the order's shipping lines after discounts, or null when the payload
 * cannot answer (no lines, or a line without a discounted price) so the caller
 * falls back to the order-level field.
 *   "original": discounted_price_set / discounted_price (as the order was placed)
 *   "current":  current_discounted_price_set (also after shipping refunds and
 *               removed lines); null when any line lacks it
 */
export function shippingLinesTotal(lines: unknown, which: "original" | "current"): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let sum = 0;
  for (const raw of lines) {
    const line = obj(raw);
    if (!line) return null;
    let amount: number | null;
    if (which === "current") {
      amount = shopMoney(line.current_discounted_price_set);
    } else {
      amount = shopMoney(line.discounted_price_set);
      if (amount === null && line.discounted_price != null && line.discounted_price !== "") amount = num(line.discounted_price);
    }
    if (amount === null) return null;
    sum += Math.max(0, amount);
  }
  return money2(sum);
}

/** Reduce an orders/* webhook payload to what the engine needs. Null when it is not an order. */
export function parseOrderPayload(payload: unknown): OrderEvent | null {
  const o = obj(payload);
  const id = str(o?.id);
  if (!o || !id) return null;

  const c = obj(o.customer);
  const customerId = str(c?.id);
  const customer: CustomerInput | null = customerId
    ? {
        id: customerId,
        email: str(c?.email) ?? str(o.email) ?? str(o.contact_email),
        phone: str(c?.phone) ?? str(o.phone),
        first_name: str(c?.first_name),
        last_name: str(c?.last_name),
      }
    : null;

  // Current figures follow order edits and pre-delivery refunds.
  const total = o.current_total_price != null ? num(o.current_total_price) : num(o.total_price);
  // Shipping the customer was actually charged, i.e. AFTER a free-shipping
  // code or any other shipping discount: the order total only contains that
  // much shipping, so taking off the undiscounted price would under-award.
  // The per-line discounted prices say so explicitly; the order-level fields
  // are the fallback for a payload without shipping lines.
  const shipping =
    shippingLinesTotal(o.shipping_lines, "current") ??
    shopMoney(o.current_shipping_price_set) ??
    shippingLinesTotal(o.shipping_lines, "original") ??
    shopMoney(o.total_shipping_price_set) ??
    0;
  const tax = o.current_total_tax != null ? num(o.current_total_tax) : num(o.total_tax);
  const grossShipping = shippingLinesTotal(o.shipping_lines, "original") ?? shopMoney(o.total_shipping_price_set) ?? shipping;
  const gross = o.total_price != null ? num(o.total_price) - grossShipping - num(o.total_tax) : total - shipping - tax;

  const codes = Array.isArray(o.discount_codes)
    ? (o.discount_codes as unknown[]).map((d) => str(obj(d)?.code)).filter((x): x is string => !!x)
    : [];
  const gateways = Array.isArray(o.payment_gateway_names) ? (o.payment_gateway_names as unknown[]).map((g) => String(g)) : [];

  return {
    id,
    name: str(o.name),
    customer,
    placedAt: str(o.created_at) ?? str(o.processed_at),
    merchandisePkr: money2(Math.max(0, total - shipping - tax)),
    grossMerchandisePkr: money2(Math.max(0, gross, total - shipping - tax)),
    updatedAt: str(o.updated_at),
    taxesIncluded: o.taxes_included === true,
    fulfillmentStatus: str(o.fulfillment_status),
    financialStatus: str(o.financial_status),
    cancelledAt: str(o.cancelled_at),
    discountCodes: codes,
    hasGiftCard: gateways.some((g) => g.toLowerCase() === "gift_card"),
  };
}

export type RefundEvent = {
  refundId: string;
  orderId: string;
  /** discount-adjusted value of the refunded items; for an amount-only refund, the money refunded */
  refundedMerchandisePkr: number;
  /** tax inside that value when the order's prices include tax */
  refundedTaxPkr?: number;
  /** true when the refund lists no items: the value is money, not merchandise */
  amountOnly?: boolean;
};

/**
 * Value of a refund.
 * With line items: for each line the smaller of Shopify's refund subtotal and
 * (line price x qty - the line's discount allocations, pro rata), so an order
 * that used a code never reverses more than was paid for those items.
 * Without line items (an amount-only refund): the successful refund
 * transactions, less refunded shipping and anything returned to a gift card.
 */
export function parseRefundPayload(payload: unknown): RefundEvent | null {
  const r = obj(payload);
  const refundId = str(r?.id);
  const orderId = str(r?.order_id);
  if (!r || !refundId || !orderId) return null;

  let total = 0;
  let taxTotal = 0;
  const lines = Array.isArray(r.refund_line_items) ? (r.refund_line_items as unknown[]) : [];
  for (const raw of lines) {
    const li = obj(raw);
    if (!li) continue;
    const qty = num(li.quantity);
    const subtotal = shopMoney(li.subtotal_set) ?? num(li.subtotal);
    const item = obj(li.line_item);
    const lineQty = num(item?.quantity);
    let value = subtotal;
    if (item && lineQty > 0 && qty > 0) {
      const allocations = Array.isArray(item.discount_allocations) ? (item.discount_allocations as unknown[]) : [];
      const discount = allocations.reduce<number>((s, a) => s + num(obj(a)?.amount), 0);
      const paidPerUnit = Math.max(0, (num(item.price) * lineQty - discount) / lineQty);
      value = Math.min(subtotal, paidPerUnit * qty);
    }
    total += Math.max(0, value);
    taxTotal += Math.max(0, shopMoney(li.total_tax_set) ?? num(li.total_tax));
  }
  if (total > 0) {
    return { refundId, orderId, refundedMerchandisePkr: money2(total), refundedTaxPkr: money2(taxTotal), amountOnly: false };
  }

  // Amount-only refund.
  let money = 0;
  const transactions = Array.isArray(r.transactions) ? (r.transactions as unknown[]) : [];
  for (const raw of transactions) {
    const t = obj(raw);
    if (!t) continue;
    if (String(t.kind ?? "").toLowerCase() !== "refund") continue;
    if (String(t.status ?? "").toLowerCase() !== "success") continue;
    if (String(t.gateway ?? "").toLowerCase() === "gift_card") continue; // the gift-card part never earned
    money += Math.max(0, num(t.amount));
  }
  let shippingRefund = 0;
  const shippingLines = Array.isArray(r.refund_shipping_lines) ? (r.refund_shipping_lines as unknown[]) : [];
  for (const raw of shippingLines) {
    const sl = obj(raw);
    shippingRefund += Math.max(0, shopMoney(sl?.subtotal_amount_set) ?? num(sl?.subtotal_amount));
  }
  if (shippingRefund === 0) {
    const adjustments = Array.isArray(r.order_adjustments) ? (r.order_adjustments as unknown[]) : [];
    for (const raw of adjustments) {
      const adj = obj(raw);
      if (String(adj?.kind ?? "") === "shipping_refund") shippingRefund += Math.abs(num(adj?.amount));
    }
  }
  return {
    refundId,
    orderId,
    refundedMerchandisePkr: money2(Math.max(0, money - shippingRefund)),
    refundedTaxPkr: 0,
    amountOnly: true,
  };
}

/** Rule 1: money actually paid for merchandise. */
export function computeEarningBasis(merchandisePkr: number, giftCardPkr: number): number {
  return money2(Math.max(0, Number(merchandisePkr) - Math.max(0, Number(giftCardPkr) || 0)));
}

const PAID_STATUSES = new Set(["paid", "partially_refunded"]);
/** Rule 1: fulfilled AND paid AND not cancelled. */
export function isAwardable(ev: Pick<OrderEvent, "fulfillmentStatus" | "financialStatus" | "cancelledAt">): boolean {
  return !ev.cancelledAt && ev.fulfillmentStatus === "fulfilled" && PAID_STATUSES.has(ev.financialStatus ?? "");
}

// ── Shopify lookups ───────────────────────────────────────────────────────

const ORDER_GIFT_CARD = `#graphql
  query HgOrderGiftCard($id: ID!) {
    order(id: $id) {
      transactions {
        gateway
        kind
        status
        amountSet { shopMoney { amount } }
      }
    }
  }`;

/** Amount of the order paid by gift card (rule 1). Only called when the order lists the gift_card gateway. */
export async function fetchGiftCardAmount(shopifyOrderId: string, shop?: string | null): Promise<number> {
  const admin = await getAdminForShop(shop ?? undefined);
  const data = await shopifyGraphqlWithRetry<{
    order: {
      transactions: Array<{ gateway: string | null; kind: string; status: string; amountSet: { shopMoney: { amount: string } } }>;
    } | null;
  }>(admin, ORDER_GIFT_CARD, { id: `gid://shopify/Order/${shopifyOrderId}` });
  let total = 0;
  for (const t of data.order?.transactions ?? []) {
    if ((t.gateway ?? "").toLowerCase() !== "gift_card") continue;
    if (t.status !== "SUCCESS") continue;
    if (t.kind === "SALE" || t.kind === "CAPTURE") total += num(t.amountSet?.shopMoney?.amount);
  }
  return money2(total);
}

// ── State helpers ─────────────────────────────────────────────────────────

async function readState(shopifyOrderId: string): Promise<OrderState | null> {
  const { data, error } = await db
    .from("order_webhook_state")
    .select("*")
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();
  if (error) throw new Error(`order state lookup failed: ${error.message}`);
  return data;
}

async function readMemberByCustomer(shopifyCustomerId: string): Promise<MemberRow | null> {
  const { data, error } = await db.from("members").select("*").eq("shopify_customer_id", shopifyCustomerId).maybeSingle();
  if (error) throw new Error(`member lookup failed: ${error.message}`);
  return data;
}

/**
 * Rule 2: the multiplier in force when the order was PLACED. A campaign counts
 * when the order falls inside its dates and it was switched on at that moment:
 * it is on now, or it was switched off only afterwards (deactivated_at is
 * stamped by the database). It is worked out once and stored with the order.
 */
export async function multiplierAtPlacement(
  member: Pick<MemberRow, "tier" | "birthday_month">,
  placedAt: Date,
): Promise<{ multiplier: number; campaignId: string | null }> {
  const iso = placedAt.toISOString();
  const { data, error } = await db
    .from("bonus_campaigns")
    .select("id, multiplier, is_active, deactivated_at")
    .lte("starts_at", iso)
    .gte("ends_at", iso)
    .order("multiplier", { ascending: false })
    .limit(50);
  if (error) throw new Error(`campaign lookup failed: ${error.message}`);
  const placed = placedAt.getTime();
  const campaign =
    (data ?? []).find((c) => c.is_active || (!!c.deactivated_at && Date.parse(c.deactivated_at) > placed)) ?? null;
  const multiplier = selectMultiplier(campaign ? Number(campaign.multiplier) : null, member, karachiParts(placedAt).month);
  return { multiplier, campaignId: campaign?.id ?? null };
}

/**
 * Rule 20: was the program switched on when the order was PLACED? Answered by
 * the database from the recorded history of the switch (migration 014), not by
 * the switch as it is now, so an order first seen late (orders/create lost or
 * delayed, first sight is orders/updated or orders/paid) still gets the state
 * at its own created_at. Worked out once and stored with the order.
 */
export async function programOnAtPlacement(placedAt: Date): Promise<boolean> {
  const { data, error } = await db.rpc("program_enabled_at", { p_at: placedAt.toISOString() });
  if (error) throw new Error(`program_enabled_at failed: ${error.message}`);
  return data !== false;
}

/**
 * Mark the member's own loyalty codes used by this order (codes are matched
 * without regard to case). A row still `pending` counts too: the discount
 * exists in Shopify (it was just used) and only the app's last step, flipping
 * the row to active, was missed. Left pending, the sweep would later activate
 * it and show a spent code as available.
 */
const USABLE_CODE_STATUSES = ["active", "pending"];

async function markCodesUsed(memberId: string, ev: OrderEvent): Promise<void> {
  if (ev.discountCodes.length === 0) return;
  const wanted = new Set(ev.discountCodes.map((c) => c.toUpperCase()));
  const { data, error } = await db.from("loyalty_codes").select("id, code").eq("member_id", memberId).in("status", USABLE_CODE_STATUSES);
  if (error) throw new Error(`loyalty code lookup failed: ${error.message}`);
  const ids = (data ?? []).filter((c) => wanted.has(String(c.code).toUpperCase())).map((c) => c.id);
  if (ids.length === 0) return;
  const { error: updErr } = await db
    .from("loyalty_codes")
    .update({ status: "used", used_at: new Date().toISOString(), shopify_order_id: ev.id })
    .in("id", ids)
    .in("status", USABLE_CODE_STATUSES);
  if (updErr) throw new Error(`could not mark codes used: ${updErr.message}`);
}

// ── Order events ──────────────────────────────────────────────────────────

export type OrderEventResult = {
  status: "skipped" | "recorded" | "awarded" | "cancelled";
  reason?: string;
  pendingPoints?: number;
  pointsAwarded?: number;
};

export async function processOrderEvent(ev: OrderEvent, shop?: string | null): Promise<OrderEventResult> {
  if (!ev.customer) return { status: "skipped", reason: "no_customer" };
  const customerId = String(ev.customer.id);

  // Placing an order enrols the customer (rule 3); phone-only customers too (rule 5).
  const member = await enrolFromOrder(ev.customer);
  if (!member) {
    // Not retried for ever: the next webhook for this order tries again.
    console.error(`[processOrderEvent] could not enrol customer ${customerId}; order ${ev.id} not recorded`);
    return { status: "skipped", reason: "enrol_failed" };
  }

  const settings = await getSettings();

  let state = await readState(ev.id);
  let giftCard: number;
  // Rule 20: the program state when the order was placed decides, not the switch now.
  let placedWhileOn = state ? state.program_on_at_placement !== false : true;
  if (!state) {
    const placedAt = ev.placedAt ? new Date(ev.placedAt) : new Date();
    const { multiplier, campaignId } = await multiplierAtPlacement(member, placedAt);
    placedWhileOn = await programOnAtPlacement(placedAt);
    giftCard = ev.hasGiftCard ? await fetchGiftCardAmount(ev.id, shop) : 0;

    let influencerId: string | null = null;
    const influencer = await findInfluencerByCodes(ev.discountCodes);
    if (influencer && influencer.shopify_customer_id !== customerId) influencerId = influencer.id;

    // First order? An earlier order that was not cancelled settles it;
    // otherwise ask Shopify, but only when the answer matters (a code sale).
    // Shopify's count includes cancelled orders, so the ones we know were
    // cancelled are taken off.
    let isFirstOrder: boolean | null = null;
    const { data: others, error: othersErr } = await db
      .from("order_webhook_state")
      .select("id, cancelled_at")
      .eq("shopify_customer_id", customerId)
      .neq("shopify_order_id", ev.id)
      .limit(500);
    if (othersErr) throw new Error(`order lookup failed: ${othersErr.message}`);
    const live = (others ?? []).filter((o) => !o.cancelled_at).length;
    const cancelledBefore = (others ?? []).length - live;
    if (live > 0) isFirstOrder = false;
    else if (influencerId) isFirstOrder = (await shopifyOrderCount(customerId, shop)) - cancelledBefore <= 1;

    const { error: insErr } = await db.from("order_webhook_state").insert({
      shopify_order_id: ev.id,
      shopify_customer_id: customerId,
      order_name: ev.name,
      placed_at: placedAt.toISOString(),
      fulfillment_status: ev.fulfillmentStatus,
      financial_status: ev.financialStatus,
      order_total_pkr: ev.grossMerchandisePkr,
      gift_card_amount_pkr: giftCard,
      multiplier_used: multiplier,
      campaign_id: campaignId,
      program_on_at_placement: placedWhileOn,
      discount_codes: ev.discountCodes,
      influencer_member_id: influencerId,
      is_first_order: isFirstOrder,
      taxes_included: ev.taxesIncluded,
    });
    // 23505: another event for the same order got there first; carry on with its row.
    if (insErr && insErr.code !== "23505") throw new Error(`order state insert failed: ${insErr.message}`);
    if (insErr) {
      const winner = await readState(ev.id);
      if (winner) placedWhileOn = winner.program_on_at_placement !== false;
    }
  } else {
    giftCard = ev.hasGiftCard && !state.points_awarded && !state.cancelled_at
      ? await fetchGiftCardAmount(ev.id, shop)
      : Number(state.gift_card_amount_pkr ?? 0);
  }

  // An order placed while the program was off never earns, even when it is
  // delivered and paid after the program is back on; one placed while it was
  // on still earns when it completes during a pause (rule 20). The purchase
  // rule's own switch is still read as it is now (rule 17).
  const canEarn = !member.is_blocked && !member.opted_out && placedWhileOn && isEarnRuleSwitchedOn(settings, "purchase");

  // The figures go through the database, which ignores a payload older than
  // the newest one already applied, never lets the refunded total shrink, and
  // for an awarded order reverses the difference at once (reconcile on totals).
  const { data: synced, error: syncErr } = await db.rpc("sync_order_snapshot", {
    p_shopify_order_id: ev.id,
    p_source_updated_at: ev.updatedAt,
    p_gross_basis_pkr: computeEarningBasis(ev.grossMerchandisePkr, giftCard),
    p_current_basis_pkr: computeEarningBasis(ev.merchandisePkr, giftCard),
    p_points_rate: settings.purchase_points_rate,
    p_can_earn: canEarn && !ev.cancelledAt,
  });
  if (syncErr) throw new Error(`sync_order_snapshot failed: ${syncErr.message}`);
  const applied = synced?.[0]?.applied ?? false;

  if (applied) {
    const { error } = await db
      .from("order_webhook_state")
      .update({
        order_name: ev.name ?? state?.order_name ?? null,
        fulfillment_status: ev.fulfillmentStatus,
        financial_status: ev.financialStatus,
        discount_codes: ev.discountCodes,
        gift_card_amount_pkr: giftCard,
        taxes_included: ev.taxesIncluded,
      })
      .eq("shopify_order_id", ev.id);
    if (error) throw new Error(`order state update failed: ${error.message}`);
  }
  state = await readState(ev.id);
  if (!state) throw new Error(`order state for ${ev.id} missing after sync`);

  await markCodesUsed(member.id, ev);

  if (ev.cancelledAt) {
    await processOrderCancelled(ev, shop, { stateSynced: true });
    return { status: "cancelled" };
  }
  if (Number(synced?.[0]?.reversed ?? 0) > 0 || state.points_awarded) await reverseFollowUpsIfFullyRefunded(ev.id);

  // A stale payload does not decide the award: the stored (newer) statuses do.
  const awardable = applied
    ? isAwardable(ev)
    : isAwardable({ fulfillmentStatus: state.fulfillment_status, financialStatus: state.financial_status, cancelledAt: state.cancelled_at });
  if (awardable) return awardOrder(ev.id, shop);
  return { status: "recorded", pendingPoints: state.pending_points };
}

/** What is left of an awarded order's basis after refunds (rule 10: "refunded in full"). */
export function remainingBasis(state: Pick<OrderState, "earning_basis_pkr" | "refunded_basis_pkr" | "refund_basis_at_award_pkr">): number {
  const basis = Number(state.earning_basis_pkr ?? 0);
  const since = Math.max(0, Number(state.refunded_basis_pkr ?? 0) - Number(state.refund_basis_at_award_pkr ?? 0));
  return Math.max(0, basis - since);
}

/** Refunded in full: nothing (to the paisa) is left, or every awarded point has been reversed. */
export function isFullyRefunded(state: OrderState): boolean {
  if (!state.points_awarded) return false;
  if (state.points_awarded_amount > 0 && state.points_reversed_amount >= state.points_awarded_amount) return true;
  return Number(state.earning_basis_pkr ?? 0) > 0 && remainingBasis(state) < 0.01;
}

/** After any reversal: a qualifying order refunded in full also takes back the referral / code-sale reward. */
async function reverseFollowUpsIfFullyRefunded(shopifyOrderId: string): Promise<void> {
  const after = await readState(shopifyOrderId);
  if (!after || after.cancelled_at || !isFullyRefunded(after)) return;
  await reverseReferralForOrder(shopifyOrderId, "refunded");
  await reverseInfluencerSale(after, "refunded");
}

/**
 * Award a fulfilled and paid order, then run the follow-ups (tier, referral,
 * influencer sale). The database refuses a cancelled or already-awarded order;
 * the follow-ups are idempotent, so a retried job finishes what was left.
 */
export async function awardOrder(shopifyOrderId: string, shop?: string | null): Promise<OrderEventResult> {
  let state = await readState(shopifyOrderId);
  if (!state || !state.shopify_customer_id) return { status: "skipped", reason: "no_order_row" };
  if (state.cancelled_at) return { status: "skipped", reason: "cancelled" };

  const member = await readMemberByCustomer(state.shopify_customer_id);
  if (!member) return { status: "skipped", reason: "no_member" };

  const settings = await getSettings();
  let pointsAwarded = 0;
  if (!state.points_awarded) {
    if (member.is_blocked) return { status: "skipped", reason: "blocked" };
    if (member.opted_out) return { status: "skipped", reason: "opted_out" };

    const { data, error } = await db.rpc("award_order_points", {
      p_shopify_order_id: shopifyOrderId,
      p_member_id: member.id,
      p_points: Math.max(0, state.pending_points ?? 0),
      p_basis_pkr: Number(state.earning_basis_pkr ?? 0),
      p_multiplier: Number(state.multiplier_used ?? 1),
      p_expires_at: expiresAtForTier(member.tier, settings),
    });
    if (error) throw new Error(`award_order_points failed: ${error.message}`);
    // The database awards on the order's own, current figures (net of any
    // refund that landed since `state` was read), so read back what it did.
    const awardedNow = data?.[0]?.awarded ? await readState(shopifyOrderId) : null;
    if (awardedNow) {
      const points = awardedNow.points_awarded_amount;
      if (points > 0) {
        await notificationQueue
          .add("points_earned", {
            memberId: member.id,
            points,
            reason: state.order_name ? `Order ${state.order_name}` : "Your order",
          })
          .catch((err) => console.error("[awardOrder] notification enqueue failed:", err));
      }
    }
    state = await readState(shopifyOrderId);
    if (!state || !state.points_awarded || state.cancelled_at) return { status: "skipped", reason: "not_awarded" };
    pointsAwarded = data?.[0]?.awarded ? state.points_awarded_amount : 0;
  }

  const fresh = await readMemberByCustomer(state.shopify_customer_id!);
  if (fresh) {
    // Throws when a follow-up cannot be queued, so the job is retried; every
    // step looks at what is already there and only does what is missing.
    await checkAndUpgradeTier(fresh.id, Number(fresh.lifetime_spend_pkr ?? 0), fresh.tier, { shopifyOrderId, shop });
  }
  await completeReferralForCustomer(state.shopify_customer_id!);
  await awardInfluencerSale(state);

  return { status: "awarded", pointsAwarded };
}

/**
 * Rule 12: an order placed with an influencer's public code pays the
 * influencer once, for a NEW customer's first order only, and never when the
 * customer came through a referral link (the link wins).
 */
export async function awardInfluencerSale(state: OrderState): Promise<{ awarded: boolean; points?: number; reason?: string }> {
  if (!state.influencer_member_id || !state.shopify_customer_id) return { awarded: false, reason: "no_attribution" };
  if (state.is_first_order !== true) return { awarded: false, reason: "repeat_customer" };
  if (isFullyRefunded(state)) return { awarded: false, reason: "refunded" };

  const { data: linkReferral, error } = await db
    .from("referrals")
    .select("id")
    .eq("referred_shopify_customer_id", state.shopify_customer_id)
    .in("status", ["pending", "flagged", "completed"])
    .limit(1);
  if (error) throw new Error(`referral lookup failed: ${error.message}`);
  if ((linkReferral ?? []).length > 0) return { awarded: false, reason: "link_referral_wins" };

  // Rule 20: a code sale placed while the program was off earns nothing; one
  // placed while it was on is paid even if the program is off by delivery.
  if (state.program_on_at_placement === false) return { awarded: false, reason: "placed_while_program_off" };
  const settings = await getSettings();
  if (!isEarnRuleSwitchedOn(settings, "referral")) return { awarded: false, reason: "disabled" };

  const { data: influencer } = await db.from("members").select("*").eq("id", state.influencer_member_id).maybeSingle();
  if (!influencer || !influencer.is_influencer) return { awarded: false, reason: "not_an_influencer" };
  // Paused only removes the special rate: effectiveReferralPoints returns the standard amount.
  if (influencer.is_blocked || influencer.opted_out) return { awarded: false, reason: "not_eligible" };

  const points = effectiveReferralPoints(influencer, settings.referral_points);
  if (points <= 0) return { awarded: false, reason: "zero_points" };

  const { data, error: rpcErr } = await db.rpc("award_points", {
    p_member_id: influencer.id,
    p_action_type: "influencer_sale",
    p_reference_id: state.shopify_order_id,
    p_points: points,
    p_expires_at: expiresAtForTier(influencer.tier, settings),
    p_shopify_order_id: state.shopify_order_id,
    p_reason_note: `first order of a new customer with code ${influencer.influencer_code ?? ""}`,
    p_customer_note: "A new customer ordered with your code",
  });
  if (rpcErr) throw new Error(`award_points(influencer_sale) failed: ${rpcErr.message}`);
  const awarded = data?.[0]?.awarded ?? false;
  if (awarded) {
    await notificationQueue
      .add("points_earned", { memberId: influencer.id, points, reason: "A new customer ordered with your code" })
      .catch((err) => console.error("[awardInfluencerSale] notification enqueue failed:", err));
  }
  return { awarded, points };
}

async function reverseInfluencerSale(state: OrderState, why: "refunded" | "cancelled"): Promise<void> {
  if (!state.influencer_member_id) return;
  const { data: row } = await db
    .from("points_ledger")
    .select("points")
    .eq("member_id", state.influencer_member_id)
    .eq("action_type", "influencer_sale")
    .eq("reference_id", state.shopify_order_id)
    .maybeSingle();
  const points = Number(row?.points ?? 0);
  if (points <= 0) return;
  const { error } = await db.rpc("award_points", {
    p_member_id: state.influencer_member_id,
    p_action_type: "referral_reversal",
    p_reference_id: `influencer_sale:${state.shopify_order_id}`,
    p_points: -points,
    p_shopify_order_id: state.shopify_order_id,
    p_reason_note: `code sale order ${state.shopify_order_id} ${why}`,
    p_customer_note: `Code sale reversed: the order was ${why}`,
  });
  if (error) throw new Error(`award_points(influencer reversal) failed: ${error.message}`);
}

// ── Refunds and cancellations (rule 6) ────────────────────────────────────

export async function processRefundEvent(
  ev: RefundEvent,
): Promise<{ reversed: number; reason?: string }> {
  const state = await readState(ev.orderId);
  // The customer is found through the stored order, never the refund payload.
  if (!state) return { reversed: 0, reason: "no_order_row" };

  // Prices that include tax: the earning basis never included it, so it comes off.
  let merchandiseRefunded = ev.refundedMerchandisePkr;
  if (state.taxes_included && !ev.amountOnly) merchandiseRefunded -= Math.max(0, Number(ev.refundedTaxPkr ?? 0));
  if (merchandiseRefunded <= 0) return { reversed: 0, reason: "no_merchandise_refunded" };

  // Scale from merchandise value to the earning basis (they differ when part
  // of the order was paid by gift card). An amount-only refund is money already.
  const merchandise = Number(state.order_total_pkr ?? 0);
  const gross = Number(state.gross_basis_pkr ?? state.earning_basis_pkr ?? merchandise);
  const refundedBasis =
    !ev.amountOnly && merchandise > 0 ? money2((merchandiseRefunded * gross) / merchandise) : money2(merchandiseRefunded);

  // Recorded against the order whether or not it has been awarded yet: before
  // the award it lowers what will be awarded, after it points are reversed.
  // The database counts each refund id once and works from totals, so the
  // order in which this and the order update arrive does not matter.
  const { data, error } = await db.rpc("reverse_order_points", {
    p_shopify_order_id: ev.orderId,
    p_kind: "refund",
    p_reference_id: ev.refundId,
    p_refunded_basis_pkr: refundedBasis,
  });
  if (error) throw new Error(`reverse_order_points(refund) failed: ${error.message}`);
  const reversed = Number(data?.[0]?.reversed ?? 0);

  await reverseFollowUpsIfFullyRefunded(ev.orderId);
  return state.points_awarded ? { reversed } : { reversed, reason: "recorded_before_award" };
}

export async function processOrderCancelled(
  ev: OrderEvent,
  shop?: string | null,
  opts: { stateSynced?: boolean } = {},
): Promise<{ reversed: number; redemptionReturned: number; reason?: string }> {
  let state = await readState(ev.id);
  if (!state && !opts.stateSynced && ev.customer) {
    // Cancellation of an order we have never seen: record it (as cancelled, so
    // it can never be awarded); that call comes back here with the row in place.
    await processOrderEvent({ ...ev, cancelledAt: ev.cancelledAt ?? new Date().toISOString() }, shop);
    return { reversed: 0, redemptionReturned: 0, reason: "recorded_as_cancelled" };
  }
  if (!state) return { reversed: 0, redemptionReturned: 0, reason: "no_order_row" };
  const wasAwarded = state.points_awarded;

  const { data, error } = await db.rpc("reverse_order_points", {
    p_shopify_order_id: ev.id,
    p_kind: "cancel",
    p_reference_id: ev.id,
  });
  if (error) throw new Error(`reverse_order_points(cancel) failed: ${error.message}`);
  const reversed = Number(data?.[0]?.reversed ?? 0);

  // Rule 7: only when the order never shipped. An awarded order was fulfilled.
  let redemptionReturned = 0;
  const shipped = wasAwarded || ev.fulfillmentStatus === "fulfilled" || ev.fulfillmentStatus === "partial";
  if (!shipped) {
    if (ev.customer) {
      const member = await readMemberByCustomer(String(ev.customer.id));
      if (member) await markCodesUsed(member.id, ev);
    }
    redemptionReturned = (await returnRedemptionsForCancelledOrder(ev.id)).returned;
  }

  await reverseReferralForOrder(ev.id, "cancelled");
  await reverseInfluencerSale(state, "cancelled");
  // A later order may now be the friend's first.
  if (state.shopify_customer_id) await completeReferralForCustomer(state.shopify_customer_id);

  return { reversed, redemptionReturned };
}

/** Sum of points waiting on unpaid / undelivered orders (shown as "pending" on the storefront). */
export async function pendingPointsForCustomer(shopifyCustomerId: string): Promise<number> {
  const { data, error } = await db
    .from("order_webhook_state")
    .select("pending_points")
    .eq("shopify_customer_id", String(shopifyCustomerId))
    .eq("points_awarded", false)
    .is("cancelled_at", null)
    .gt("pending_points", 0)
    .limit(1000);
  if (error) throw new Error(`pending points lookup failed: ${error.message}`);
  return (data ?? []).reduce((s, r) => s + (r.pending_points ?? 0), 0);
}
