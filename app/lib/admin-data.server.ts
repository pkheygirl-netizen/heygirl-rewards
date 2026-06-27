// app/lib/admin-data.server.ts
import { db } from "../db.server";

const TIERS = ["silver", "gold", "diamond"] as const;
type Tier = (typeof TIERS)[number];

export async function getTierBreakdown(): Promise<Record<Tier, number>> {
  const result: Record<Tier, number> = { silver: 0, gold: 0, diamond: 0 };
  for (const tier of TIERS) {
    const { count, error } = await db
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("tier", tier);
    if (error) throw error;
    result[tier] = count ?? 0;
  }
  return result;
}

export async function getPointsIssuedSeries(
  from: Date,
  to: Date,
): Promise<Array<{ date: string; points: number }>> {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, earned_at")
    .gt("points", 0)
    .gte("earned_at", from.toISOString())
    .lt("earned_at", to.toISOString());
  if (error) throw error;

  const byDay = new Map<string, number>();
  for (const row of data ?? []) {
    if ((row.points as number) <= 0) continue;
    const day = new Date(row.earned_at as string).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (row.points as number));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, points]) => ({ date, points }));
}

export type ActivityItem = {
  id: string;
  kind: "earn" | "redeem" | "referral";
  memberName: string;
  detail: string;
  at: string;
};

function memberName(
  m: { first_name?: string | null; last_name?: string | null } | null,
): string {
  if (!m) return "A member";
  return [m.first_name, m.last_name].filter(Boolean).join(" ") || "A member";
}

export async function getActivityFeed(limit = 20): Promise<ActivityItem[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [earns, redeems, refs] = await Promise.all([
    db
      .from("points_ledger")
      .select("id, points, action_type, earned_at, members(first_name,last_name)")
      .gte("earned_at", since)
      .order("earned_at", { ascending: false })
      .limit(limit),
    db
      .from("loyalty_codes")
      .select("id, created_at, members(first_name,last_name)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("referrals")
      .select("id, completed_at, members:referrer_member_id(first_name,last_name)")
      .gte("completed_at", since)
      .order("completed_at", { ascending: false })
      .limit(limit),
  ]);

  const items: ActivityItem[] = [];
  for (const r of earns.data ?? []) {
    if ((r.points as number) <= 0) continue;
    items.push({
      id: r.id as string,
      kind: "earn",
      memberName: memberName(r.members as any),
      detail: `earned ${r.points} points (${r.action_type})`,
      at: r.earned_at as string,
    });
  }
  for (const r of redeems.data ?? []) {
    items.push({
      id: r.id as string,
      kind: "redeem",
      memberName: memberName(r.members as any),
      detail: "redeemed a reward",
      at: r.created_at as string,
    });
  }
  for (const r of refs.data ?? []) {
    if (!r.completed_at) continue;
    items.push({
      id: r.id as string,
      kind: "referral",
      memberName: memberName(r.members as any),
      detail: "completed a referral",
      at: r.completed_at as string,
    });
  }

  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
