// app/lib/widget-data.server.ts
// Read models for the storefront proxy API (contract section 4).
import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../db.server";

// Columns added by migration 010 are not in the generated types until stream A
// regenerates them, so reads here go through an untyped handle and are narrowed
// by the row types below.
const sdb = db as unknown as SupabaseClient;

export type Tier = "silver" | "gold" | "diamond";
export type SocialPlatform = "instagram" | "facebook" | "youtube";
export const SOCIAL_PLATFORMS: SocialPlatform[] = ["instagram", "facebook", "youtube"];

export type MemberRow = {
  id: string;
  shopify_customer_id: string;
  email: string | null;
  first_name: string | null;
  tier: string;
  points_balance: number | null;
  lifetime_spend_pkr: number | string | null;
  referral_slug: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_set_at: string | null;
  is_influencer: boolean | null;
  influencer_code?: string | null;
  influencer_code_percent?: number | null;
  influencer_paused: boolean | null;
  influencer_multiplier: number | null;
  influencer_referral_rate: number | null;
  influencer_rate_starts_at: string | null;
  influencer_rate_ends_at: string | null;
  is_blocked: boolean | null;
  opted_out: boolean | null;
};

export type CustomerPayload = {
  member: {
    firstName: string | null;
    tier: Tier;
    pointsBalance: number;
    pendingPoints: number;
    lifetimeSpendPkr: number;
    referralLink: string;
    birthday: { month: number; day: number } | null;
    canSetBirthday: boolean;
    isInfluencer: boolean;
    optedOut: boolean;
    blocked: boolean;
  };
  codes: Array<{ id: string; code: string; kind: string; discountPkr: number; expiresAt: string | null }>;
  social: Record<SocialPlatform, "available" | "claimed">;
  review: { eligible: boolean; pending: number };
  nextExpiry: { points: number; at: string } | null;
  /** Only for influencers: her own reward per referral and her public discount code. */
  influencer: { code: string | null; percent: number | null; rewardPoints: number } | null;
};

/** `rewardPoints` is what stream A's effectiveReferralPoints returns for this member. */
export function buildInfluencer(member: MemberRow, rewardPoints: number): CustomerPayload["influencer"] {
  if (!member.is_influencer) return null;
  const code = typeof member.influencer_code === "string" && member.influencer_code.trim() ? member.influencer_code.trim() : null;
  const pct = Number(member.influencer_code_percent);
  return { code, percent: code && Number.isFinite(pct) && pct > 0 ? pct : null, rewardPoints: Math.max(0, Math.round(rewardPoints || 0)) };
}

export type HistoryFilter = "all" | "earned" | "redeemed" | "referral" | "other";
export type HistoryRow = { id: string; type: string; label: string; points: number; at: string; note: string | null };

const MEMBER_COLUMNS = "*";

export async function getMemberByCustomerId(shopifyCustomerId: string): Promise<MemberRow | null> {
  const { data, error } = await sdb
    .from("members")
    .select(MEMBER_COLUMNS)
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (error) throw new Error(`member_lookup_failed: ${error.message}`);
  return (data as MemberRow | null) ?? null;
}

function asTier(t: string | null | undefined): Tier {
  return t === "gold" || t === "diamond" ? t : "silver";
}

/**
 * Absolute when STOREFRONT_URL is configured, otherwise root-relative; the
 * widget resolves a relative link against the page origin. No domain is ever
 * hard-coded here.
 */
export function buildReferralLink(slug: string | null, storefrontUrl: string | undefined = process.env.STOREFRONT_URL): string {
  if (!slug) return "";
  const path = `/?ref=${encodeURIComponent(slug)}`;
  const base = (storefrontUrl ?? "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+$/i.test(base) ? `${base}${path}` : path;
}

/** Karachi calendar day (YYYY-MM-DD) of an instant. */
export function karachiDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(new Date(iso));
}

/** Earliest upcoming expiry: all points that lapse on that same Karachi day. */
export function computeNextExpiry(
  rows: Array<{ points_remaining: number | null; expires_at: string | null }>,
  now: Date = new Date(),
): { points: number; at: string } | null {
  const live = rows
    .filter((r) => r.expires_at && (r.points_remaining ?? 0) > 0 && new Date(r.expires_at).getTime() > now.getTime())
    .sort((a, b) => new Date(a.expires_at!).getTime() - new Date(b.expires_at!).getTime());
  if (!live.length) return null;
  const at = live[0].expires_at!;
  const day = karachiDay(at);
  const points = live.filter((r) => karachiDay(r.expires_at!) === day).reduce((n, r) => n + (r.points_remaining ?? 0), 0);
  return points > 0 ? { points, at } : null;
}

export async function getCustomerPayload(member: MemberRow, now: Date = new Date(), influencerRewardPoints = 0): Promise<CustomerPayload> {
  const nowIso = now.toISOString();
  const [codesRes, socialRes, ordersRes, claimsRes, expiryRes] = await Promise.all([
    sdb
      .from("loyalty_codes")
      .select("id, code, kind, discount_amount_pkr, expires_at")
      .eq("member_id", member.id)
      .eq("status", "active")
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(20),
    sdb.from("social_actions").select("action_type").eq("member_id", member.id),
    sdb
      .from("order_webhook_state")
      .select("pending_points, points_awarded, cancelled_at")
      .eq("shopify_customer_id", member.shopify_customer_id)
      .limit(1000),
    sdb.from("review_claims").select("status").eq("member_id", member.id).limit(1000),
    sdb
      .from("points_ledger")
      .select("points_remaining, expires_at")
      .eq("member_id", member.id)
      .eq("expired", false)
      .gt("points_remaining", 0)
      .not("expires_at", "is", null)
      .gt("expires_at", nowIso)
      .order("expires_at", { ascending: true })
      .limit(200),
  ]);
  for (const r of [codesRes, socialRes, ordersRes, claimsRes, expiryRes]) {
    if (r.error) throw new Error(`customer_payload_failed: ${r.error.message}`);
  }

  type OrderRow = { pending_points: number | null; points_awarded: boolean | null; cancelled_at: string | null };
  const orders = (ordersRes.data ?? []) as OrderRow[];
  const pendingPoints = orders
    .filter((o) => !o.cancelled_at && !o.points_awarded)
    .reduce((n, o) => n + Math.max(0, o.pending_points ?? 0), 0);
  const awardedOrders = orders.filter((o) => o.points_awarded && !o.cancelled_at).length;

  const claims = (claimsRes.data ?? []) as Array<{ status: string }>;
  const liveClaims = claims.filter((c) => c.status !== "rejected").length;
  const pendingClaims = claims.filter((c) => c.status === "pending").length;

  const claimed = new Set(((socialRes.data ?? []) as Array<{ action_type: string }>).map((r) => r.action_type));
  const blocked = !!member.is_blocked;
  const optedOut = !!member.opted_out;
  const hasBirthday = !!member.birthday_month && !!member.birthday_day;

  type CodeRow = { id: string; code: string; kind: string | null; discount_amount_pkr: number | string | null; expires_at: string | null };
  return {
    member: {
      firstName: member.first_name ?? null,
      tier: asTier(member.tier),
      pointsBalance: Math.max(0, member.points_balance ?? 0),
      pendingPoints,
      lifetimeSpendPkr: Math.max(0, Math.floor(Number(member.lifetime_spend_pkr ?? 0))),
      referralLink: buildReferralLink(member.referral_slug),
      birthday: hasBirthday ? { month: member.birthday_month!, day: member.birthday_day! } : null,
      // Set once from the storefront; afterwards only the admin can change it.
      canSetBirthday: !member.birthday_set_at && !hasBirthday && !blocked && !optedOut,
      isInfluencer: !!member.is_influencer,
      optedOut,
      blocked,
    },
    codes: ((codesRes.data ?? []) as CodeRow[]).map((c) => ({
      id: c.id,
      code: c.code,
      kind: c.kind ?? "reward",
      discountPkr: Math.round(Number(c.discount_amount_pkr ?? 0)),
      expiresAt: c.expires_at,
    })),
    social: {
      instagram: claimed.has("instagram") ? "claimed" : "available",
      facebook: claimed.has("facebook") ? "claimed" : "available",
      youtube: claimed.has("youtube") ? "claimed" : "available",
    },
    review: { eligible: !blocked && !optedOut && awardedOrders > liveClaims, pending: pendingClaims },
    influencer: buildInfluencer(member, influencerRewardPoints),
    nextExpiry: computeNextExpiry((expiryRes.data ?? []) as Array<{ points_remaining: number | null; expires_at: string | null }>, now),
  };
}

// ── History ──────────────────────────────────────────────────────────────────

/** Customer-facing label for every ledger action type (contract section 2). */
export const HISTORY_LABELS: Record<string, string> = {
  signup: "Welcome bonus",
  purchase: "Order placed",
  social_youtube: "YouTube subscribe",
  social_facebook: "Facebook like",
  social_instagram: "Instagram follow",
  review: "Review posted",
  referral_earned: "Friend referred",
  referral_bonus: "Referral bonus",
  referral_reversal: "Referral reversed",
  influencer_sale: "Sale with your code",
  redemption: "Reward redeemed",
  redemption_return: "Reward points returned",
  expiry: "Points expired",
  adjustment: "Points adjustment",
  birthday: "Birthday gift",
  campaign_bonus: "Bonus points campaign",
  refund_deduction: "Order refunded",
  order_cancelled: "Order cancelled",
  tier_reward: "Tier reward",
  import: "Points carried over",
};

export function historyLabel(type: string): string {
  return HISTORY_LABELS[type] ?? "Points update";
}

const REFERRAL_TYPES = ["referral_earned", "referral_bonus", "referral_reversal", "influencer_sale"];
const REDEEMED_TYPES = ["redemption", "redemption_return"];
const OTHER_TYPES = ["expiry", "adjustment", "refund_deduction", "order_cancelled", "tier_reward", "import", "birthday", "campaign_bonus"];

export function parseHistoryFilter(v: string | null): HistoryFilter {
  return v === "earned" || v === "redeemed" || v === "referral" || v === "other" ? v : "all";
}

export const HISTORY_PAGE_SIZE = 20;

export async function getPointsHistory(
  memberId: string,
  page: number,
  filter: HistoryFilter,
): Promise<{ rows: HistoryRow[]; page: number; total: number; hasMore: boolean }> {
  const p = Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1;
  const offset = (p - 1) * HISTORY_PAGE_SIZE;

  // `reason_note` is internal and is deliberately not selected.
  let query = sdb
    .from("points_ledger")
    .select("id, action_type, points, earned_at, customer_note", { count: "exact" })
    .eq("member_id", memberId);
  if (filter === "earned") query = query.gt("points", 0);
  else if (filter === "redeemed") query = query.in("action_type", REDEEMED_TYPES);
  else if (filter === "referral") query = query.in("action_type", REFERRAL_TYPES);
  else if (filter === "other") query = query.in("action_type", OTHER_TYPES);

  const { data, count, error } = await query
    .order("earned_at", { ascending: false })
    .range(offset, offset + HISTORY_PAGE_SIZE - 1);
  if (error) throw new Error(`history_failed: ${error.message}`);

  type Row = { id: string; action_type: string; points: number; earned_at: string; customer_note: string | null };
  const rows = ((data ?? []) as Row[]).map((r) => ({
    id: r.id,
    type: r.action_type,
    label: historyLabel(r.action_type),
    points: r.points,
    at: r.earned_at,
    note: r.customer_note ?? null,
  }));
  const total = count ?? rows.length;
  return { rows, page: p, total, hasMore: offset + rows.length < total };
}

// ── Referral summary (additive GET /proxy/referral, used by the Refer tab) ───

export type ReferralSummary = {
  total: number;
  completed: number;
  pointsEarned: number;
  rows: Array<{ status: string; at: string }>;
};

/** Internal statuses collapse to what the customer should see. */
export function publicReferralStatus(status: string): "pending" | "completed" | "not_eligible" {
  if (status === "completed") return "completed";
  if (status === "pending" || status === "flagged") return "pending";
  return "not_eligible";
}

export type ReferralOutcome = { ok: boolean; status: "recorded" | "not_eligible" | "try_again"; friendCode?: string };

const FINAL_NO = ["not_eligible", "already_referred", "self_referral", "invalid_slug", "disabled", "duplicate", "blocked", "rejected"];

/**
 * What the browser is told after POST /proxy/referral. A referral that is held
 * for review or blocked for fraud looks exactly like a recorded one, and no
 * internal status or reason is ever passed through:
 *   recorded     — stored (final; includes held/flagged/blocked rows and repeats)
 *   not_eligible — will never be accepted (final)
 *   try_again    — temporary; the storefront keeps the slug and retries later
 */
export function publicReferralOutcome(result: Record<string, unknown> | null | undefined): ReferralOutcome {
  const r = result ?? {};
  const status = typeof r.status === "string" ? r.status : "";
  const reason = typeof r.reason === "string" ? r.reason : "";
  if (r.recorded === true || status === "pending" || status === "flagged" || reason === "duplicate") {
    const friendCode = typeof r.friendCode === "string" && r.friendCode && r.blocked !== true ? r.friendCode : undefined;
    return friendCode ? { ok: true, status: "recorded", friendCode } : { ok: true, status: "recorded" };
  }
  if (FINAL_NO.includes(status) || FINAL_NO.includes(reason)) return { ok: false, status: "not_eligible" };
  return { ok: false, status: "try_again" };
}

export async function getReferralSummary(memberId: string): Promise<ReferralSummary> {
  const [listRes, doneRes, ledgerRes] = await Promise.all([
    sdb
      .from("referrals")
      .select("status, created_at", { count: "exact" })
      .eq("referrer_member_id", memberId)
      .order("created_at", { ascending: false })
      .limit(20),
    sdb.from("referrals").select("id", { count: "exact", head: true }).eq("referrer_member_id", memberId).eq("status", "completed"),
    sdb.from("points_ledger").select("points").eq("member_id", memberId).in("action_type", REFERRAL_TYPES).limit(5000),
  ]);
  for (const r of [listRes, doneRes, ledgerRes]) {
    if (r.error) throw new Error(`referral_summary_failed: ${r.error.message}`);
  }
  const pointsEarned = ((ledgerRes.data ?? []) as Array<{ points: number | null }>).reduce((n, r) => n + (r.points ?? 0), 0);
  return {
    total: listRes.count ?? 0,
    completed: doneRes.count ?? 0,
    pointsEarned: Math.max(0, pointsEarned),
    rows: ((listRes.data ?? []) as Array<{ status: string; created_at: string }>).map((r) => ({
      status: publicReferralStatus(r.status),
      at: r.created_at,
    })),
  };
}
