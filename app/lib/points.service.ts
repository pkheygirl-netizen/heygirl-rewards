import { db } from "../db.server";

const TIER_RANK: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };

export function generateSlug(firstName?: string | null, lastName?: string | null): string {
  const base =
    [firstName, lastName].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") ||
    "member";
  const suffix = Math.floor(1000 + Math.random() * 9000); // 4 digits
  return `${base}-${suffix}`;
}

export function roundAward(value: number): number {
  return Math.floor(value);
}

export function roundClawback(value: number): number {
  return Math.ceil(value);
}

export function computePurchasePoints(
  orderTotalPaisa: number,
  shippingPaisa: number,
  taxPaisa: number,
  multiplier: number,
): number {
  const basisPaisa = orderTotalPaisa - shippingPaisa - taxPaisa;
  const basisRupees = basisPaisa / 100; // exact: integer paisa divided once
  return roundAward(basisRupees * multiplier);
}

export function mapSocialActionType(
  short: "youtube" | "facebook" | "instagram",
): "social_youtube" | "social_facebook" | "social_instagram" {
  return `social_${short}` as const;
}

export function selectMultiplier(
  campaignMultiplier: number | null,
  member: { tier: string; birthday_month: number | null },
  currentMonth: number,
): number {
  if (campaignMultiplier != null) return campaignMultiplier;
  if (member.tier === "diamond" && member.birthday_month === currentMonth) return 1.2;
  return 1;
}

export async function getActiveMultiplier(
  member: { tier: string; birthday_month: number | null },
  now: Date = new Date(),
): Promise<number> {
  const iso = now.toISOString();
  const { data } = await db
    .from("bonus_campaigns")
    .select("multiplier")
    .eq("is_active", true)
    .lte("starts_at", iso)
    .gte("ends_at", iso)
    .limit(1)
    .maybeSingle();
  return selectMultiplier(data?.multiplier ?? null, member, now.getMonth() + 1);
}

export async function enrolMember(customer: {
  id: number | string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): Promise<{ enrolled: boolean; reason?: string }> {
  const customerId = String(customer.id);
  if (!customer.email) {
    console.warn(`[enrolMember] skip: customer ${customerId} has no email`);
    return { enrolled: false, reason: "no_email" };
  }

  const { data: existing } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (existing) return { enrolled: false, reason: "already_member" };

  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await db.from("members").insert({
      shopify_customer_id: customerId,
      email: customer.email,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      tier: "silver",
      points_balance: 0,
      lifetime_spend_pkr: 0,
      referral_slug: generateSlug(customer.first_name, customer.last_name),
      consent_given: false,
    });
    if (!error) return { enrolled: true };
    if (!error.message?.includes("referral_slug")) {
      console.error("[enrolMember] insert error:", error);
      return { enrolled: false, reason: "insert_error" };
    }
    // else slug collision — retry with a new suffix
  }
  return { enrolled: false, reason: "slug_collision" };
}

export function tierForSpend(lifetimeSpendPkr: number): "silver" | "gold" | "diamond" {
  if (lifetimeSpendPkr >= 100000) return "diamond";
  if (lifetimeSpendPkr >= 50000) return "gold";
  return "silver";
}

export async function checkAndUpgradeTier(
  memberId: string,
  lifetimeSpendPkr: number,
  currentTier: string,
): Promise<string> {
  const target = tierForSpend(lifetimeSpendPkr);
  if (TIER_RANK[target] <= TIER_RANK[currentTier]) return currentTier;

  await db.from("members").update({ tier: target }).eq("id", memberId);
  // Points now never expire for gold/diamond — stop aging existing tranches
  await db
    .from("points_ledger")
    .update({ expires_at: null })
    .eq("member_id", memberId)
    .eq("expired", false)
    .not("expires_at", "is", null);
  return target;
}
