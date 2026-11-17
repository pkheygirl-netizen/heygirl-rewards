// app/lib/admin-analytics.server.ts
// Analytics page. All totals are computed in the database (011_admin_stats.sql).
import { num, rpcObject, rpcRows, str, strOrNull } from "./admin-db.server";
import { getPeriodStats, getPointsSeries, type PeriodStats, type SeriesPoint } from "./admin-data.server";
import { referralSummary, type ReferralSummary } from "./admin-referrals.server";
import { listInfluencers, type InfluencerRow } from "./admin-influencers.server";
import {
  baseRedemptionRate, pointsValuePkr, readRedemptionTiers, type RedemptionTier,
} from "./admin-program.server";
import { getSettingsRow } from "./admin-settings.server";
import type { Period } from "../components/karachi";

export type TopMember = { memberId: string; name: string; email: string | null; points: number };

export async function getTopMembers(
  from: string, to: string, kind: "earned" | "redeemed", limit = 10,
): Promise<TopMember[]> {
  const rows = await rpcRows("admin_top_members", { p_from: from, p_to: to, p_kind: kind, p_limit: limit });
  return rows.map((r) => ({
    memberId: str(r.member_id), name: str(r.name) || "Customer", email: strOrNull(r.email), points: num(r.points),
  }));
}

export type Outstanding = {
  points: number;
  members: number;
  /** Lowest reward in the table; null when the table is empty. */
  baseTier: RedemptionTier | null;
  /** points × (base discount ÷ base points). An estimate: bigger rewards give more per point. */
  valuePkr: number;
};

export function outstandingFrom(points: number, members: number, tiers: RedemptionTier[]): Outstanding {
  const baseTier = baseRedemptionRate(tiers);
  return { points, members, baseTier, valuePkr: pointsValuePkr(points, baseTier) };
}

export async function getOutstanding(): Promise<Outstanding> {
  const [o, settings] = await Promise.all([rpcObject("admin_outstanding_points"), getSettingsRow()]);
  return outstandingFrom(num(o.points), num(o.members), readRedemptionTiers(settings.redemption_tiers));
}

export type Analytics = {
  stats: PeriodStats;
  previous: PeriodStats;
  series: SeriesPoint[];
  outstanding: Outstanding;
  topEarners: TopMember[];
  topRedeemers: TopMember[];
  funnel: ReferralSummary;
  influencers: InfluencerRow[];
  standardReferralPoints: number;
};

export async function getAnalytics(period: Period): Promise<Analytics> {
  const settings = await getSettingsRow();
  const standardReferralPoints = num(settings.referral_points, 6000);
  const [stats, previous, series, o, topEarners, topRedeemers, funnel, inf] = await Promise.all([
    getPeriodStats(period.from, period.to),
    getPeriodStats(period.prevFrom, period.prevTo),
    getPointsSeries(period.from, period.to),
    rpcObject("admin_outstanding_points"),
    getTopMembers(period.from, period.to, "earned"),
    getTopMembers(period.from, period.to, "redeemed"),
    referralSummary(period.from, period.to),
    listInfluencers({ from: period.from, to: period.to, standardPoints: standardReferralPoints }),
  ]);
  return {
    stats, previous, series,
    outstanding: outstandingFrom(num(o.points), num(o.members), readRedemptionTiers(settings.redemption_tiers)),
    topEarners, topRedeemers, funnel,
    influencers: [...inf.rows].sort((a, b) => b.salesPkr - a.salesPkr || b.completed - a.completed).slice(0, 10),
    standardReferralPoints,
  };
}

/** Rows for the analytics CSV: the daily series, one row per Karachi day. */
export const SERIES_CSV_COLUMNS = [
  { key: "day", header: "Date (Asia/Karachi)" },
  { key: "earned", header: "Points earned" },
  { key: "redeemed", header: "Points redeemed" },
  { key: "expired", header: "Points expired" },
] as const;
