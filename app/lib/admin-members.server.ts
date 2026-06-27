import { db } from "../db.server";

export type Tier = "silver" | "gold" | "diamond";

export type MemberRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  tier: Tier;
  points_balance: number;
  lifetime_spend_pkr: number;
  is_blocked: boolean;
  is_influencer: boolean;
};

export type LedgerRow = {
  id: string;
  points: number;
  action_type: string;
  reason_note: string | null;
  balance_after: number;
  earned_at: string;
};

export type ReferralRow = {
  id: string;
  referred_email: string;
  status: string;
  created_at: string;
  completed_at: string | null;
};

const MEMBER_COLS =
  "id, first_name, last_name, email, tier, points_balance, lifetime_spend_pkr, is_blocked, is_influencer";

export async function searchMembers(opts: {
  query?: string;
  tier?: Tier;
  page?: number;
  pageSize?: number;
}): Promise<{ members: MemberRow[]; total: number }> {
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? 25;

  let q = db.from("members").select(MEMBER_COLS, { count: "exact" });

  if (opts.query && opts.query.trim()) {
    const term = opts.query.trim().replace(/[%,]/g, "");
    q = q.or(
      `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`,
    );
  }
  if (opts.tier) q = q.eq("tier", opts.tier);

  const { data, count, error } = await q
    .order("enrolled_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw error;

  return { members: (data ?? []) as MemberRow[], total: count ?? 0 };
}

export async function getMemberDetail(memberId: string): Promise<{
  member:
    | (MemberRow & {
        referral_slug: string;
        enrolled_at: string;
        influencer_referral_rate: number | null;
      })
    | null;
  ledger: LedgerRow[];
  referrals: ReferralRow[];
}> {
  const [memberRes, ledgerRes, refRes] = await Promise.all([
    db
      .from("members")
      .select(`${MEMBER_COLS}, referral_slug, enrolled_at, influencer_referral_rate`)
      .eq("id", memberId)
      .maybeSingle(),
    db
      .from("points_ledger")
      .select("id, points, action_type, reason_note, balance_after, earned_at")
      .eq("member_id", memberId)
      .order("earned_at", { ascending: false })
      .limit(50),
    db
      .from("referrals")
      .select("id, referred_email, status, created_at, completed_at")
      .eq("referrer_member_id", memberId)
      .order("created_at", { ascending: false }),
  ]);
  if (memberRes.error) throw memberRes.error;
  if (ledgerRes.error) throw ledgerRes.error;
  if (refRes.error) throw refRes.error;

  return {
    member: (memberRes.data as any) ?? null,
    ledger: (ledgerRes.data ?? []) as LedgerRow[],
    referrals: (refRes.data ?? []) as ReferralRow[],
  };
}

export async function adjustPoints(input: {
  memberId: string;
  points: number;
  reason: string;
}): Promise<{ newBalance: number }> {
  if (!input.reason || !input.reason.trim()) throw new Error("reason required");
  const { data, error } = await db.rpc("award_points", {
    p_member_id: input.memberId,
    p_action_type: "adjustment",
    p_reference_id: `admin-adjust:${Date.now()}`,
    p_points: input.points,
    p_reason_note: input.reason.trim(),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { newBalance: (row?.new_balance as number) ?? 0 };
}

export async function setBlocked(memberId: string, blocked: boolean): Promise<void> {
  const { error } = await db
    .from("members")
    .update({ is_blocked: blocked })
    .eq("id", memberId);
  if (error) throw error;
}

export async function setInfluencer(input: {
  memberId: string;
  isInfluencer: boolean;
  rate?: number | null;
}): Promise<void> {
  const patch = input.isInfluencer
    ? { is_influencer: true, influencer_referral_rate: input.rate ?? null }
    : { is_influencer: false, influencer_referral_rate: null };
  const { error } = await db.from("members").update(patch).eq("id", input.memberId);
  if (error) throw error;
}
