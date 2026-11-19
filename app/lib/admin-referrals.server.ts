// app/lib/admin-referrals.server.ts
// Referral review queue. Approve and reject are stream A's functions; this file
// lists referrals with the reason each one is held and wraps the two actions.
import { adb, memberName, num, rpcObject, shopifyNumericId, str, strOrNull, UUID_RE, type Row } from "./admin-db.server";
import { setReferralsBlocked } from "./admin-members.server";
import { approveReferral, rejectReferral } from "./referrals.service";
import {
  ORDER_CHECK_FAILED_FLAG, ORDER_CHECK_FAILED_REASON, ORDER_FLAGS, REFERRAL_ORDER_TAG as ORDER_TAG, SIGNIN_FLAGS,
} from "./referral-checks.server";

import {
  REFERRAL_STATUSES, REFERRAL_STATUS_LABELS, REJECT_NOTE_MAX, type ReferralStatus,
} from "../components/admin-constants";
export { REFERRAL_STATUSES, REJECT_NOTE_MAX, type ReferralStatus };

export function parseReferralStatus(v: string | null | undefined): ReferralStatus | null {
  return (REFERRAL_STATUSES as readonly string[]).includes(v ?? "") ? (v as ReferralStatus) : null;
}

export const STATUS_LABELS = REFERRAL_STATUS_LABELS;

const FLAG_REASONS: Record<string, string> = {
  // current rules (contract rule 10, 19 Nov 2026)
  ...SIGNIN_FLAGS,
  ...ORDER_FLAGS,
  [ORDER_CHECK_FAILED_FLAG]: ORDER_CHECK_FAILED_REASON,
  // older rows, written by rules that are no longer used
  same_network: "Friend signed in from the same network address as the referrer (old rule, no longer used)",
  same_ip: "Friend signed in from the same network address as the referrer (old rule, no longer used)",
  same_contact: "Friend has the same email or phone as the referrer",
  same_address: "Friend uses the same delivery address as the referrer",
  same_device: "Friend used the same device as the referrer",
};

/**
 * Why a referral is held or blocked, from fraud_flags (then block_reason).
 * The old "IP match" column is gone: it compared two copies of the same
 * address and so was true for every row (handbook R5).
 */
export function referralReason(row: { fraud_flags?: unknown; block_reason?: unknown; status?: unknown }): string {
  const status = str(row.status);
  if (status !== "flagged" && status !== "blocked" && status !== "rejected") return "";
  const flags = Array.isArray(row.fraud_flags) ? row.fraud_flags.map(str).filter(Boolean) : [];
  const reasons = [...new Set(flags.map((f) => FLAG_REASONS[f] ?? f.replace(/_/g, " ")))];
  if (reasons.length) return reasons.join("; ");
  return str(row.block_reason) || (status === "flagged" ? "No reason was recorded" : "");
}

/**
 * Plain words for the order-time check when Shopify answered without the
 * delivery details. A check Shopify never answered (flag order_check_failed)
 * is already explained by the reason column.
 */
export function orderCheckNote(row: { order_check?: unknown; fraud_flags?: unknown }): string {
  if (str(row.order_check) !== "not_checked") return "";
  const flags = Array.isArray(row.fraud_flags) ? row.fraud_flags.map(str) : [];
  if (flags.includes(ORDER_CHECK_FAILED_FLAG)) return "";
  return "Her order was not checked against the referrer's phone and address: Shopify did not give the app the delivery details";
}

/** Referral filter: orders not checked against the referrer and not yet dismissed. */
export const ORDER_CHECK_FILTERS = ["not_checked"] as const;
export type OrderCheckFilter = (typeof ORDER_CHECK_FILTERS)[number];
export function parseOrderCheckFilter(v: string | null | undefined): OrderCheckFilter | null {
  return (ORDER_CHECK_FILTERS as readonly string[]).includes(v ?? "") ? (v as OrderCheckFilter) : null;
}

/**
 * How many referral orders were not checked against the referrer's phone and
 * address (Shopify withheld the details, or never answered) and are not yet
 * dismissed or decided. Count only (Home "Needs your attention").
 */
export async function countReferralsNotChecked(): Promise<number> {
  const { count, error } = await adb()
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("order_check", "not_checked")
    .is("alert_resolved_at", null);
  if (error) throw new Error(`could not count unchecked referrals: ${error.message}`);
  return num(count);
}

export type ReferralListRow = {
  id: string;
  referrerId: string;
  referrerName: string;
  referrerIsInfluencer: boolean;
  friend: string;
  status: string;
  statusLabel: string;
  reason: string;
  rewardPoints: number | null;
  createdAt: string;
  completedAt: string | null;
  reviewedNote: string | null;
  /** The referrer's link no longer earns (members.referrals_blocked). */
  referrerReferralsBlocked: boolean;
  /** "Not checked" note from the order-time check, or "". */
  orderCheckNote: string;
  /** A Home alert from the order-time check is still open for this referral. */
  alertOpen: boolean;
};

export async function listReferrals(opts: {
  status?: ReferralStatus | null; page?: number; pageSize?: number; referralId?: string | null;
  /** "not_checked": only referrals counted by countReferralsNotChecked (any status). */
  orderCheck?: OrderCheckFilter | null;
}): Promise<{ rows: ReferralListRow[]; total: number }> {
  const page = Math.max(opts.page ?? 0, 0);
  const pageSize = opts.pageSize ?? 25;
  let q = adb()
    .from("referrals")
    .select(
      "id, referrer_member_id, referred_email, referred_shopify_customer_id, status, block_reason, fraud_flags, " +
        "reward_points, created_at, completed_at, reviewed_note, order_check, alert_resolved_at, " +
        "members:referrer_member_id(first_name,last_name,email,phone,is_influencer,referrals_blocked)",
      { count: "exact" },
    );
  // One referral (opened from a Home alert); an id that is not a uuid is ignored.
  if (opts.referralId && UUID_RE.test(opts.referralId)) q = q.eq("id", opts.referralId);
  else if (opts.orderCheck === "not_checked") q = q.eq("order_check", "not_checked").is("alert_resolved_at", null);
  else if (opts.status) q = q.eq("status", opts.status);
  const { data, count, error } = await q
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw new Error(`could not read referrals: ${error.message}`);
  const rows = ((data ?? []) as unknown as Row[]).map((r) => {
    const m = r.members as Row | null;
    const status = str(r.status);
    return {
      id: str(r.id),
      referrerId: str(r.referrer_member_id),
      referrerName: memberName(m),
      referrerIsInfluencer: m?.is_influencer === true,
      friend: str(r.referred_email) || (r.referred_shopify_customer_id ? `Customer ${str(r.referred_shopify_customer_id)}` : "Unknown"),
      status,
      statusLabel: STATUS_LABELS[status] ?? status,
      reason: referralReason(r),
      rewardPoints: r.reward_points === null || r.reward_points === undefined ? null : num(r.reward_points),
      createdAt: str(r.created_at),
      completedAt: strOrNull(r.completed_at),
      reviewedNote: strOrNull(r.reviewed_note),
      referrerReferralsBlocked: m?.referrals_blocked === true,
      orderCheckNote: orderCheckNote(r),
      alertOpen: isOpenAlert(r),
    };
  });
  return { rows, total: num(count) };
}

const ALERT_CHECKS = ["same_phone", "same_address"];
/** Open = can be dismissed: a matched order, or an order that was not checked. */
const isOpenAlert = (r: Row): boolean => [...ALERT_CHECKS, "not_checked"].includes(str(r.order_check)) && !r.alert_resolved_at;

// ── Home alerts from the order-time check ────────────────────────────────────

export type ReferralOrderAlert = {
  referralId: string;
  referrerId: string;
  referrerName: string;
  referrerReferralsBlocked: boolean;
  orderId: string;
  orderName: string | null;
  kind: "phone" | "address";
  status: string;
  /** "Order #1007 from a referred friend delivers to the referrer's phone number" */
  title: string;
  detail: string;
};

/** Order link in Shopify admin (same form as the customer link on the profile). */
export function shopifyOrderUrl(shop: string, orderId: string): string | null {
  const id = shopifyNumericId(orderId);
  return id && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop) ? `https://${shop}/admin/orders/${id}` : null;
}

export function alertTitle(orderName: string | null, kind: "phone" | "address"): string {
  // Not "used a referral code": the order checked is also her first delivered
  // and paid order when she left the code out (owner decision, 19 Nov 2026).
  return `${orderName ? `Order ${orderName}` : "An order"} from a referred friend delivers to the referrer's ${kind === "phone" ? "phone number" : "address"}`;
}

/**
 * Open alerts, newest first. Only reason codes are stored, so the alert never
 * shows (and the app never kept) the phone number or address that matched.
 */
export async function listReferralOrderAlerts(limit = 10): Promise<ReferralOrderAlert[]> {
  const { data, error } = await adb()
    .from("referrals")
    .select(
      "id, referrer_member_id, status, order_check, order_checked_order_id, order_tag, " +
        "members:referrer_member_id(first_name,last_name,email,phone,referrals_blocked)",
    )
    .in("order_check", ALERT_CHECKS)
    .is("alert_resolved_at", null)
    .order("order_checked_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(`could not read referral alerts: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];
  const orderIds = [...new Set(rows.map((r) => str(r.order_checked_order_id)).filter(Boolean))];
  const names = new Map<string, string>();
  if (orderIds.length) {
    const { data: orders, error: oErr } = await adb()
      .from("order_webhook_state")
      .select("shopify_order_id, order_name")
      .in("shopify_order_id", orderIds);
    if (oErr) throw new Error(`could not read order numbers: ${oErr.message}`);
    for (const o of (orders ?? []) as Row[]) if (o.order_name) names.set(str(o.shopify_order_id), str(o.order_name));
  }
  return rows.map((r) => {
    const m = r.members as Row | null;
    const kind = str(r.order_check) === "same_phone" ? "phone" as const : "address" as const;
    const orderId = str(r.order_checked_order_id);
    const orderName = names.get(orderId) ?? null;
    const status = str(r.status);
    const tag = str(r.order_tag);
    const tagText = tag === "tagged"
      ? `The order is tagged "${ORDER_TAG}" in Shopify.`
      : tag === "failed"
        ? `The order could not be tagged "${ORDER_TAG}" in Shopify (the app may not have permission to change orders yet).`
        : `The order is not tagged "${ORDER_TAG}" yet: Shopify was busy. The app tries again when the order next changes.`;
    return {
      referralId: str(r.id),
      referrerId: str(r.referrer_member_id),
      referrerName: memberName(m),
      referrerReferralsBlocked: m?.referrals_blocked === true,
      orderId,
      orderName,
      kind,
      status,
      title: alertTitle(orderName, kind),
      detail: [
        tagText,
        kind === "phone"
          ? "The referral was blocked and the referrer gets no points for it. Her link still works for other friends unless you block it."
          : status === "flagged"
            ? "The referral is held: the referrer is paid only if you approve it."
            : `The referral is now ${(STATUS_LABELS[status] ?? status).toLowerCase()}.`,
      ].filter(Boolean).join(" "),
    };
  });
}

/** Close the Home alert for a referral (nothing else changes). */
export async function dismissReferralAlert(referralId: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const { data, error } = await adb()
    .from("referrals")
    .update({ alert_resolved_at: new Date().toISOString() })
    .eq("id", referralId)
    .is("alert_resolved_at", null)
    .select("id");
  if (error) throw new Error(`could not dismiss the alert: ${error.message}`);
  if (!data || (data as unknown[]).length === 0) return { ok: false, error: "That alert was already closed." };
  return { ok: true, message: "Alert dismissed" };
}

/**
 * "Block this referrer": her referral link stops earning (members.referrals_blocked),
 * which also stops payment of any referral of hers still waiting. Recorded in
 * her staff notes; the referral's Home alert is closed.
 */
export async function blockReferrer(referralId: string, actor: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const { data, error } = await adb().from("referrals").select("id, referrer_member_id").eq("id", referralId).maybeSingle();
  if (error) throw new Error(`could not read the referral: ${error.message}`);
  const row = data as Row | null;
  if (!row) return { ok: false, error: "That referral could not be found." };
  const found = await setReferralsBlocked(str(row.referrer_member_id), true, actor);
  if (!found) return { ok: false, error: "The referrer no longer exists. Nothing was changed." };
  const { error: aErr } = await adb()
    .from("referrals")
    .update({ alert_resolved_at: new Date().toISOString() })
    .eq("id", referralId)
    .is("alert_resolved_at", null);
  if (aErr) console.error(`[admin] referral alert not closed for ${referralId}: ${aErr.message}`);
  return { ok: true, message: "Referrer blocked. Her referral link no longer earns" };
}

export type ReferralSummary = {
  recorded: number; withOrder: number; completed: number; pending: number;
  flagged: number; blocked: number; rejected: number; pointsPaid: number;
};

export async function referralSummary(from?: string | null, to?: string | null): Promise<ReferralSummary> {
  const r = await rpcObject("admin_referral_funnel", { p_from: from ?? null, p_to: to ?? null });
  return {
    recorded: num(r.recorded), withOrder: num(r.with_order), completed: num(r.completed),
    pending: num(r.pending), flagged: num(r.flagged), blocked: num(r.blocked),
    rejected: num(r.rejected), pointsPaid: num(r.points_paid),
  };
}

export type ReviewOutcome = { ok: true; message: string } | { ok: false; error: string };

/**
 * Approve: the referral goes back to "pending" and pays when the friend's first
 * order is delivered and paid (straight away if it already is). It does not mark
 * the referral completed without paying, which the old button did (handbook L5).
 */
export async function approve(referralId: string, actor: string, shop: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const res = await approveReferral(referralId, actor, shop);
  if (!res.ok) {
    return { ok: false, error: `The referral was not approved${res.reason ? ` (${res.reason.replace(/_/g, " ")})` : ""}. It may have been reviewed already.` };
  }
  return {
    ok: true,
    message: res.paid
      ? "Referral approved and the referrer has been paid"
      : "Referral approved. It pays when the friend's first order is delivered and paid",
  };
}

export async function reject(referralId: string, actor: string, note: string): Promise<ReviewOutcome> {
  if (!UUID_RE.test(referralId)) return { ok: false, error: "That referral could not be found." };
  const text = (note ?? "").trim();
  if (text.length > REJECT_NOTE_MAX) return { ok: false, error: `The note must be ${REJECT_NOTE_MAX} characters or fewer.` };
  const res = await rejectReferral(referralId, actor, text || undefined);
  if (!res.ok) return { ok: false, error: "The referral was not rejected. It may have been reviewed already." };
  return { ok: true, message: "Referral rejected. No points will be paid" };
}
