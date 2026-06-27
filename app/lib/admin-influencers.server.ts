import { db } from "../db.server";

export function pointsToRs(points: number): number {
  return Math.round((points * 100) / 4000);
}

export type InfluencerRow = {
  id: string;
  name: string;
  email: string;
  tier: string;
  customRate: number | null;
  clicks: number;
  conversions: number;
  conversionRate: number;
  pointsEarned: number;
  rsEquivalent: number;
  slug: string;
};

export async function getInfluencers(): Promise<InfluencerRow[]> {
  const { data: members, error } = await db
    .from("members")
    .select(
      "id, first_name, last_name, email, tier, influencer_referral_rate, referral_slug",
    )
    .eq("is_influencer", true)
    .order("enrolled_at", { ascending: false });
  if (error) throw error;

  const rows: InfluencerRow[] = [];
  for (const m of members ?? []) {
    const [refs, ledger] = await Promise.all([
      db.from("referrals").select("status").eq("referrer_member_id", m.id),
      db
        .from("points_ledger")
        .select("points")
        .eq("member_id", m.id)
        .in("action_type", ["referral_earned", "referral_bonus"]),
    ]);
    if (refs.error) throw refs.error;
    if (ledger.error) throw ledger.error;
    const clicks = refs.data?.length ?? 0;
    const conversions = (refs.data ?? []).filter((r) => r.status === "completed").length;
    const pointsEarned = (ledger.data ?? []).reduce((s, r) => s + (r.points as number), 0);
    rows.push({
      id: m.id as string,
      name: [m.first_name, m.last_name].filter(Boolean).join(" ") || (m.email as string),
      email: m.email as string,
      tier: m.tier as string,
      customRate: (m.influencer_referral_rate as number | null) ?? null,
      clicks,
      conversions,
      conversionRate: clicks > 0 ? conversions / clicks : 0,
      pointsEarned,
      rsEquivalent: pointsToRs(pointsEarned),
      slug: m.referral_slug as string,
    });
  }
  return rows;
}

export async function updateReferralSlug(memberId: string, slug: string): Promise<void> {
  const normalized = (slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) throw new Error("invalid slug");
  const { error } = await db
    .from("members")
    .update({ referral_slug: normalized })
    .eq("id", memberId);
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("slug taken");
    throw error;
  }
}
