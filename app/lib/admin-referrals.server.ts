import { db } from "../db.server";

export type ReferralStatus = "pending" | "completed" | "blocked" | "flagged";

export type ReferralListRow = {
  id: string;
  referrerName: string;
  referredEmail: string;
  status: ReferralStatus;
  blockReason: string | null;
  createdAt: string;
  completedAt: string | null;
  ipMatch: boolean;
};

export async function listReferrals(opts: {
  status?: ReferralStatus;
  from?: string;
  to?: string;
}): Promise<ReferralListRow[]> {
  let q = db
    .from("referrals")
    .select(
      "id, referred_email, status, block_reason, created_at, completed_at, referred_ip, referrer_ip, members:referrer_member_id(first_name,last_name)",
    );
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.from) q = q.gte("created_at", opts.from);
  if (opts.to) q = q.lte("created_at", opts.to);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    id: r.id,
    referrerName:
      [r.members?.first_name, r.members?.last_name].filter(Boolean).join(" ") || "—",
    referredEmail: r.referred_email,
    status: r.status,
    blockReason: r.block_reason ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    ipMatch: !!r.referred_ip && !!r.referrer_ip && r.referred_ip === r.referrer_ip,
  }));
}

export async function referralSummary(): Promise<{
  total: number;
  completed: number;
  conversionRate: number;
  rewardsIssued: number;
}> {
  const [total, completed, rewards] = await Promise.all([
    db.from("referrals").select("*", { count: "exact", head: true }),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("status", "completed"),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("points_awarded", true),
  ]);
  const t = total.count ?? 0;
  const c = completed.count ?? 0;
  return {
    total: t,
    completed: c,
    conversionRate: t > 0 ? c / t : 0,
    rewardsIssued: rewards.count ?? 0,
  };
}

export async function reviewAndUnblock(referralId: string): Promise<void> {
  const { data, error } = await db
    .from("referrals")
    .select("status")
    .eq("id", referralId)
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.status !== "blocked" && data.status !== "flagged")) {
    throw new Error("not blocked");
  }
  const { error: upErr } = await db
    .from("referrals")
    .update({ status: "completed", block_reason: null })
    .eq("id", referralId);
  if (upErr) throw upErr;
}
