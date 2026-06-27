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
      "id, first_name, tier, points_balance, lifetime_spend_pkr, referral_slug, birthday_month"
    )
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();

  if (!member) return null;

  const activeCodes = await getActiveLoyaltyCodes(shopifyCustomerId);
  // lifetime_spend_pkr is stored directly in rupees (PKR), not paisa.
  const lifetimeSpend = member.lifetime_spend_pkr ?? 0;

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
    activeCodes: (activeCodes ?? []).map((c) => ({
      code: c.code,
      discount_pkr: c.discount_amount_pkr,
      expires_at: c.expires_at ?? "",
    })),
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
    // points_ledger stores the amount in `points` and the timestamp in
    // `earned_at`; alias them to the widget's expected `delta`/`created_at`.
    .select("id, action_type, delta:points, balance_after, created_at:earned_at", {
      count: "exact",
    })
    .eq("member_id", member.id)
    .order("earned_at", { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const FILTER_MAP: Record<string, string[]> = {
    purchase: ["purchase"],
    redemption: ["redemption"],
    referral: ["referral"],
    social: ["social_youtube", "social_facebook", "social_instagram"],
    other: ["signup", "birthday", "adjustment", "expiry"],
  };

  if (filterType && FILTER_MAP[filterType]) {
    const types = FILTER_MAP[filterType];
    if (types.length === 1) {
      query = query.eq("action_type", types[0]);
    } else {
      query = query.in("action_type", types);
    }
  } else if (filterType && !FILTER_MAP[filterType]) {
    // Unknown filter — pass through as-is (graceful fallback)
    query = query.eq("action_type", filterType);
  }

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
    .select("id, referral_slug, is_influencer, influencer_referral_rate")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();
  if (!member || !member.referral_slug) return null;

  const { data: referrals, count } = await db
    .from("referrals")
    .select("status, created_at", { count: "exact" })
    .eq("referrer_member_id", member.id)
    .order("created_at", { ascending: false })
    .limit(20);

  // Separate query for exact completed count — avoids undercounting when >20 referrals exist
  const { count: completedCount } = await db
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_member_id", member.id)
    .eq("status", "completed");

  // referrals.points_awarded is a boolean flag, not an amount — the actual
  // points earned live in points_ledger under the referral action types.
  const { data: referralLedger } = await db
    .from("points_ledger")
    .select("points")
    .eq("member_id", member.id)
    .in("action_type", ["referral_earned", "referral_bonus"]);
  const totalPts = (referralLedger ?? []).reduce(
    (sum, r) => sum + (r.points ?? 0),
    0
  );

  return {
    referralSlug: member.referral_slug,
    referralLink: `https://heygirl.pk?ref=${member.referral_slug}`,
    totalReferrals: count ?? 0,
    completedReferrals: completedCount ?? 0,
    totalPtsEarned: totalPts,
    history: (referrals ?? []).map(
      (r: { status: string; created_at: string }) => ({
        status: r.status,
        created_at: r.created_at,
      })
    ),
    isInfluencer: member.is_influencer ?? false,
    customRate: member.influencer_referral_rate ?? null,
  };
}

export async function getNudgeSettings(): Promise<NudgeSettings> {
  // The nudge config lives in individual boolean columns (there is no single
  // `nudge_settings` JSON column). Map them to the widget's nudge1/2/3/5 shape
  // (nudge4 = post-purchase is email-only and intentionally not surfaced here).
  const { data } = await db
    .from("app_settings")
    .select(
      "nudge_account_creation_enabled, nudge_points_spending_enabled, nudge_reward_usage_enabled, nudge_tier_progress_enabled, tier_progress_gold_threshold_pkr, tier_progress_diamond_threshold_pkr"
    )
    .eq("id", 1)
    .maybeSingle();

  return {
    nudge1_enabled: data?.nudge_account_creation_enabled ?? true,
    nudge2_enabled: data?.nudge_points_spending_enabled ?? true,
    nudge3_enabled: data?.nudge_reward_usage_enabled ?? true,
    nudge5_enabled: data?.nudge_tier_progress_enabled ?? true,
    tier_progress_gold_threshold: data?.tier_progress_gold_threshold_pkr ?? 5000,
    tier_progress_diamond_threshold: data?.tier_progress_diamond_threshold_pkr ?? 10000,
  };
}
