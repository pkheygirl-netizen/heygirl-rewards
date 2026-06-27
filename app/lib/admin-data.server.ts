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
