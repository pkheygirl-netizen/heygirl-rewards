import { db } from "../db.server";

export type RedemptionTier = { points: number; discount_pkr: number };

const DEFAULT_TIERS: RedemptionTier[] = [
  { points: 3000, discount_pkr: 100 },
  { points: 6000, discount_pkr: 250 },
  { points: 11500, discount_pkr: 500 },
  { points: 22000, discount_pkr: 1000 },
  { points: 100000, discount_pkr: 5000 },
  { points: 180000, discount_pkr: 10000 },
];

export async function getRedemptionTiers(): Promise<RedemptionTier[]> {
  const { data } = await db.from("app_settings").select("redemption_tiers").eq("id", 1).maybeSingle();
  const tiers = data?.redemption_tiers;
  if (Array.isArray(tiers) && tiers.length > 0) return tiers as RedemptionTier[];
  return DEFAULT_TIERS;
}

export function findTier(tiers: RedemptionTier[], points: number): RedemptionTier | null {
  return tiers.find((t) => t.points === points) ?? null;
}

export function validateRedemption(
  balance: number,
  requestedPoints: number,
  tiers: RedemptionTier[],
): { valid: boolean; reason?: string } {
  if (requestedPoints < 3000) return { valid: false, reason: "below_minimum" };
  if (balance < requestedPoints) return { valid: false, reason: "insufficient_balance" };
  if (!findTier(tiers, requestedPoints)) return { valid: false, reason: "invalid_tier" };
  return { valid: true };
}

export function generateCodeValue(): string {
  return `REWARD-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}
