// app/lib/admin-data.server.ts
// Numbers and lists for Home. Every total comes from a SQL function in
// 011_admin_stats.sql; nothing here downloads a table to add it up (handbook R1).
import { num, rpcObject, rpcRows, str, strOrNull, adb, memberName, type Row } from "./admin-db.server";
import { fmtInt, fmtPkr, tierLabel } from "../components/karachi";

// ── period totals ────────────────────────────────────────────────────────────

export type PeriodStats = {
  membersTotal: number;
  membersNew: number;
  pointsEarned: number;
  pointsRedeemed: number;
  pointsExpired: number;
  pointsReversed: number;
  /** Not period-bound: points on delivered or unpaid orders waiting right now. */
  pointsPending: number;
  /** Reward codes created in the period (kind = 'reward' only, handbook R8). */
  redemptions: number;
  rewardOrders: number;
  rewardSalesPkr: number;
  rewardCostPkr: number;
  /** points redeemed ÷ points earned, 0 when nothing was earned */
  redemptionRate: number;
};

export function redemptionRate(redeemed: number, earned: number): number {
  if (!(earned > 0) || !(redeemed > 0)) return 0;
  return redeemed / earned;
}

export function toPeriodStats(row: Row): PeriodStats {
  const pointsEarned = num(row.points_earned);
  const pointsRedeemed = num(row.points_redeemed);
  return {
    membersTotal: num(row.members_total),
    membersNew: num(row.members_new),
    pointsEarned,
    pointsRedeemed,
    pointsExpired: num(row.points_expired),
    pointsReversed: num(row.points_reversed),
    pointsPending: num(row.points_pending),
    redemptions: num(row.redemptions),
    rewardOrders: num(row.reward_orders),
    rewardSalesPkr: Math.round(num(row.reward_sales_pkr)),
    rewardCostPkr: Math.round(num(row.reward_cost_pkr)),
    redemptionRate: redemptionRate(pointsRedeemed, pointsEarned),
  };
}

export async function getPeriodStats(from: string, to: string): Promise<PeriodStats> {
  return toPeriodStats(await rpcObject("admin_period_stats", { p_from: from, p_to: to }));
}

// ── daily series ─────────────────────────────────────────────────────────────

export type SeriesPoint = { day: string; earned: number; redeemed: number; expired: number };

export async function getPointsSeries(from: string, to: string): Promise<SeriesPoint[]> {
  const rows = await rpcRows("admin_points_series", { p_from: from, p_to: to });
  return rows.map((r) => ({
    day: str(r.day).slice(0, 10),
    earned: num(r.earned),
    redeemed: num(r.redeemed),
    expired: num(r.expired),
  }));
}

/** Group a daily series into weeks (7 consecutive days from the first day) when it is long. */
export function groupSeries(series: SeriesPoint[], maxPoints = 31): SeriesPoint[] {
  if (series.length <= maxPoints) return series;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < series.length; i += 7) {
    const chunk = series.slice(i, i + 7);
    out.push({
      day: chunk[0].day,
      earned: chunk.reduce((s, p) => s + p.earned, 0),
      redeemed: chunk.reduce((s, p) => s + p.redeemed, 0),
      expired: chunk.reduce((s, p) => s + p.expired, 0),
    });
  }
  return out;
}

// ── tiers ────────────────────────────────────────────────────────────────────

export type TierCounts = {
  silver: number; gold: number; diamond: number;
  nearGold: number; nearDiamond: number;
  nearGoldWithinPkr: number; nearDiamondWithinPkr: number;
};

export async function getTierCounts(): Promise<TierCounts> {
  const r = await rpcObject("admin_tier_counts");
  return {
    silver: num(r.silver), gold: num(r.gold), diamond: num(r.diamond),
    nearGold: num(r.near_gold), nearDiamond: num(r.near_diamond),
    nearGoldWithinPkr: Math.round(num(r.near_gold_within_pkr)),
    nearDiamondWithinPkr: Math.round(num(r.near_diamond_within_pkr)),
  };
}

// ── needs your attention ─────────────────────────────────────────────────────

export type Attention = {
  referralsFlagged: number;
  reviewClaimsPending: number;
  expiringMembers: number;
  expiringPoints: number;
  /** Of expiringMembers: those whose date has passed but the nightly job has not run yet ("expiring now"). */
  expiringOverdueMembers: number;
  gdprOpen: number;
};

export async function getAttention(days = 30): Promise<Attention> {
  const r = await rpcObject("admin_attention", { p_days: days });
  return {
    referralsFlagged: num(r.referrals_flagged),
    reviewClaimsPending: num(r.review_claims_pending),
    expiringMembers: num(r.expiring_members),
    expiringPoints: num(r.expiring_points),
    expiringOverdueMembers: num(r.expiring_overdue_members),
    gdprOpen: num(r.gdpr_open),
  };
}

export type ReviewClaimRow = {
  id: string; memberId: string; memberName: string; points: number;
  claimedAt: string; releaseAt: string; orderId: string | null;
};

export async function listPendingReviewClaims(page = 0, pageSize = 25): Promise<{ rows: ReviewClaimRow[]; total: number }> {
  const { data, count, error } = await adb()
    .from("review_claims")
    .select(
      "id, member_id, shopify_order_id, points, claimed_at, release_at, members(first_name,last_name,email,phone)",
      { count: "exact" },
    )
    .eq("status", "pending")
    .order("release_at", { ascending: true })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw new Error(`could not read review claims: ${error.message}`);
  const rows = ((data ?? []) as Row[]).map((r) => ({
    id: str(r.id),
    memberId: str(r.member_id),
    memberName: memberName(r.members as Row | null),
    points: num(r.points),
    claimedAt: str(r.claimed_at),
    releaseAt: str(r.release_at),
    orderId: strOrNull(r.shopify_order_id),
  }));
  return { rows, total: num(count) };
}

export type ExpiringRow = {
  memberId: string; name: string; email: string | null; phone: string | null;
  points: number; firstExpiry: string;
};

export async function listExpiringMembers(
  days = 30, page = 0, pageSize = 25,
): Promise<{ rows: ExpiringRow[]; total: number }> {
  const rows = await rpcRows("admin_expiring_members", {
    p_days: days, p_limit: pageSize, p_offset: page * pageSize,
  });
  return {
    rows: rows.map((r) => ({
      memberId: str(r.member_id), name: str(r.name), email: strOrNull(r.email), phone: strOrNull(r.phone),
      points: num(r.points), firstExpiry: str(r.first_expiry),
    })),
    total: rows.length ? num(rows[0].total_count) : 0,
  };
}

// ── activity ─────────────────────────────────────────────────────────────────

import { ACTIVITY_FILTERS, type ActivityFilter } from "../components/admin-constants";
export { ACTIVITY_FILTERS, type ActivityFilter };

export function parseActivityFilter(v: string | null | undefined): ActivityFilter {
  return (ACTIVITY_FILTERS as readonly string[]).includes(v ?? "") ? (v as ActivityFilter) : "all";
}

export type ActivityItem = {
  id: string;
  at: string;
  kind: "points" | "code" | "tier" | "pending";
  memberId: string;
  memberName: string;
  title: string;
  /** Second line. May include the internal reason: admin only, never the storefront. */
  detail: string;
  points: number;
  /** What the points column shows when it is not a plain number. */
  pointsLabel: string | null;
};

const SOCIAL: Record<string, string> = {
  social_instagram: "Followed on Instagram",
  social_facebook: "Liked on Facebook",
  social_youtube: "Subscribed on YouTube",
};

function orderRef(row: Row): string {
  const name = str(row.order_name);
  if (name) return name.startsWith("#") ? name : `#${name}`;
  return row.order_id ? `#${str(row.order_id)}` : "";
}

/** Pure: one admin_activity row → the text staff read. */
export function describeActivity(row: Row): Pick<ActivityItem, "title" | "detail" | "pointsLabel"> {
  const kind = str(row.kind);
  const action = str(row.action);
  const order = orderRef(row);
  const reason = str(row.reason_note);
  const note = str(row.customer_note);

  if (kind === "pending") {
    return {
      title: `Order ${order} waiting`.replace("  ", " "),
      detail: "Points are released when the order is delivered and marked paid",
      pointsLabel: `Pending ${fmtInt(num(row.points))}`,
    };
  }
  if (kind === "tier") {
    return {
      title: `Moved to ${tierLabel(action)}`,
      detail: reason ? `From ${tierLabel(reason)}` : "",
      pointsLabel: "Tier",
    };
  }
  if (kind === "code") {
    const off = num(row.discount_pkr) > 0 ? `${fmtPkr(num(row.discount_pkr))} off` : "Free shipping";
    const titles: Record<string, string> = {
      birthday: "Birthday reward issued",
      referral_friend: "Welcome code for a referred friend",
      tier_gold: "Gold reward issued",
      tier_diamond: "Diamond reward issued",
    };
    return { title: titles[action] ?? "Code issued", detail: `${off} · ${str(row.code)}`, pointsLabel: "Code" };
  }

  const detailParts = (first: string) =>
    [first, reason ? `Reason: ${reason}` : "", note ? `Customer sees: ${note}` : ""].filter(Boolean).join(" · ");

  switch (action) {
    case "purchase":
      return { title: `Order ${order} delivered and paid`.replace("  ", " "), detail: detailParts(""), pointsLabel: null };
    case "signup":
      return { title: "Welcome points", detail: "First sign-in on the store", pointsLabel: null };
    case "social_instagram":
    case "social_facebook":
    case "social_youtube":
      return { title: SOCIAL[action], detail: "", pointsLabel: null };
    case "review":
      return { title: "Review points released", detail: "", pointsLabel: null };
    case "referral_earned":
      return { title: "Referral completed", detail: "Friend's first order delivered and paid", pointsLabel: null };
    case "referral_bonus":
      return { title: "Referral bonus", detail: detailParts(""), pointsLabel: null };
    case "influencer_sale":
      return { title: "Sale with her discount code", detail: order ? `Order ${order}` : "", pointsLabel: null };
    case "referral_reversal":
      return { title: "Referral reward reversed", detail: "Friend's order was refunded or cancelled", pointsLabel: null };
    case "redemption":
      return { title: "Redeemed points for a reward code", detail: detailParts(""), pointsLabel: null };
    case "redemption_return":
      return { title: "Reward code cancelled, points returned", detail: detailParts(""), pointsLabel: null };
    case "refund_deduction":
      return { title: `Order ${order} refunded, points reversed`.replace("  ", " "), detail: "", pointsLabel: null };
    case "order_cancelled":
      return { title: `Order ${order} cancelled, points reversed`.replace("  ", " "), detail: "", pointsLabel: null };
    case "expiry":
      return { title: "Points expired", detail: "", pointsLabel: null };
    case "adjustment":
      return { title: "Balance adjusted by staff", detail: detailParts(""), pointsLabel: null };
    case "birthday":
      return { title: "Birthday points", detail: "", pointsLabel: null };
    case "campaign_bonus":
      return { title: "Campaign bonus", detail: detailParts(""), pointsLabel: null };
    case "tier_reward":
      return { title: "Tier reward", detail: detailParts(""), pointsLabel: null };
    case "import":
      return { title: "Balance brought over from Smile", detail: "", pointsLabel: null };
    default:
      return { title: action || "Points changed", detail: detailParts(""), pointsLabel: null };
  }
}

export async function getActivity(opts: {
  filter?: ActivityFilter; memberId?: string | null; page?: number; pageSize?: number;
}): Promise<{ items: ActivityItem[]; hasMore: boolean }> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
  const page = Math.max(opts.page ?? 0, 0);
  // one extra row tells us whether there is another page
  const rows = await rpcRows("admin_activity", {
    p_filter: opts.filter ?? "all",
    p_member: opts.memberId ?? null,
    p_limit: pageSize + 1,
    p_offset: page * pageSize,
  });
  const items = rows.slice(0, pageSize).map((r) => {
    const k = str(r.kind);
    return {
      id: str(r.id),
      at: str(r.at),
      kind: (k === "code" || k === "tier" || k === "pending" ? k : "points") as ActivityItem["kind"],
      memberId: str(r.member_id),
      memberName: str(r.member_name) || "Customer",
      points: num(r.points),
      ...describeActivity(r),
    };
  });
  return { items, hasMore: rows.length > pageSize };
}
