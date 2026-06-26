import { db } from "../db.server";
import { getActiveLoyaltyCodes } from "./redemption.service";

export type ActiveCode = { code: string; discount_pkr: number; expires_at: string };
export type MemberDashboard = {
  memberId: string;
  firstName: string | null;
  tier: "silver" | "gold" | "diamond";
  balance: number;
  lifetimeSpend: number;
  nextTier: "gold" | "diamond" | null;
  spendToNextTier: number;
  activeCodes: ActiveCode[];
  referralSlug: string | null;
  birthdayMonth: number | null;
};
export type HistoryItem = {
  id: string;
  action_type: string;
  delta: number;
  balance_after: number;
  created_at: string;
};
export type ReferralHistoryItem = { status: string; created_at: string };
export type ReferralDashboard = {
  referralSlug: string;
  referralLink: string;
  totalReferrals: number;
  completedReferrals: number;
  totalPtsEarned: number;
  history: ReferralHistoryItem[];
  isInfluencer: boolean;
  customRate: number | null;
};
export type NudgeSettings = {
  nudge1_enabled: boolean;
  nudge2_enabled: boolean;
  nudge3_enabled: boolean;
  nudge5_enabled: boolean;
  tier_progress_gold_threshold: number;
  tier_progress_diamond_threshold: number;
};

const GOLD_THRESHOLD_RS = 50_000;
const DIAMOND_THRESHOLD_RS = 100_000;

export async function getMemberDashboard(
  shopifyCustomerId: string
): Promise<MemberDashboard | null> {
  const { data: member } = await db
    .from("members")
    .select(
      "id, first_name, tier, points_balance, lifetime_spend_paisa, referral_slug, birthday_month"
    )
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();

  if (!member) return null;

  const activeCodes = await getActiveLoyaltyCodes(shopifyCustomerId);
  const lifetimeSpend = Math.floor((member.lifetime_spend_paisa ?? 0) / 100);

  let nextTier: "gold" | "diamond" | null = null;
  let spendToNextTier = 0;
  if (member.tier === "silver") {
    nextTier = "gold";
    spendToNextTier = Math.max(0, GOLD_THRESHOLD_RS - lifetimeSpend);
  } else if (member.tier === "gold") {
    nextTier = "diamond";
    spendToNextTier = Math.max(0, DIAMOND_THRESHOLD_RS - lifetimeSpend);
  }

  return {
    memberId: member.id,
    firstName: member.first_name ?? null,
    tier: member.tier as MemberDashboard["tier"],
    balance: member.points_balance ?? 0,
    lifetimeSpend,
    nextTier,
    spendToNextTier,
    activeCodes: (activeCodes ?? []).map(
      (c: { code: string; discount_pkr: number; expires_at: string }) => ({
        code: c.code,
        discount_pkr: c.discount_pkr,
        expires_at: c.expires_at,
      })
    ),
    referralSlug: member.referral_slug ?? null,
    birthdayMonth: member.birthday_month ?? null,
  };
}

export async function getPointsHistory(
  shopifyCustomerId: string,
  page: number,
  filterType: string | null
): Promise<{ items: HistoryItem[]; total: number }> {
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (!member) return { items: [], total: 0 };

  const PAGE_SIZE = 50;
  const offset = (page - 1) * PAGE_SIZE;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = db
    .from("points_ledger")
    .select("id, action_type, delta, balance_after, created_at", { count: "exact" })
    .eq("member_id", member.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  if (filterType) query = query.eq("action_type", filterType);

  const { data, count } = await query;
  return {
    items: (data ?? []) as HistoryItem[],
    total: count ?? 0,
  };
}

export async function getReferralDashboard(
  shopifyCustomerId: string
): Promise<ReferralDashboard | null> {
  const { data: member } = await db
    .from("members")
    .select("id, referral_slug, is_influencer, custom_referral_rate")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (!member || !member.referral_slug) return null;

  const { data: referrals, count } = await db
    .from("referrals")
    .select("status, created_at, pts_awarded", { count: "exact" })
    .eq("referrer_member_id", member.id)
    .order("created_at", { ascending: false })
    .limit(20);

  const completed = (referrals ?? []).filter(
    (r: { status: string }) => r.status === "rewarded"
  );
  const totalPts = completed.reduce(
    (sum: number, r: { pts_awarded: number }) => sum + (r.pts_awarded ?? 0),
    0
  );

  return {
    referralSlug: member.referral_slug,
    referralLink: `https://heygirl.pk?ref=${member.referral_slug}`,
    totalReferrals: count ?? 0,
    completedReferrals: completed.length,
    totalPtsEarned: totalPts,
    history: (referrals ?? []).map(
      (r: { status: string; created_at: string }) => ({
        status: r.status,
        created_at: r.created_at,
      })
    ),
    isInfluencer: member.is_influencer ?? false,
    customRate: member.custom_referral_rate ?? null,
  };
}

export async function getNudgeSettings(): Promise<NudgeSettings> {
  const { data } = await db
    .from("app_settings")
    .select("nudge_settings")
    .eq("id", 1)
    .maybeSingle();

  const s = (data?.nudge_settings as Partial<NudgeSettings>) ?? {};
  return {
    nudge1_enabled: s.nudge1_enabled ?? true,
    nudge2_enabled: s.nudge2_enabled ?? true,
    nudge3_enabled: s.nudge3_enabled ?? true,
    nudge5_enabled: s.nudge5_enabled ?? true,
    tier_progress_gold_threshold: s.tier_progress_gold_threshold ?? 5000,
    tier_progress_diamond_threshold: s.tier_progress_diamond_threshold ?? 10000,
  };
}
