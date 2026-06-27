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
