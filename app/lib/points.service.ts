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

export function expiresAtForMember(tier: string, earnedAt: Date = new Date()): string | null {
  if (tier !== "silver") return null;
  const d = new Date(earnedAt);
  d.setDate(d.getDate() + 365);
  return d.toISOString();
}

export async function awardPurchase(input: {
  shopifyCustomerId: string;
  shopifyOrderId: string;
  orderTotalPaisa: number;
  shippingPaisa: number;
  taxPaisa: number;
}): Promise<{ awarded: boolean; points: number }> {
  const customerId = String(input.shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id, tier, birthday_month, lifetime_spend_pkr")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) {
    console.warn(`[awardPurchase] no member for customer ${customerId}`);
    return { awarded: false, points: 0 };
  }

  const multiplier = await getActiveMultiplier(member, new Date());
  const points = computePurchasePoints(
    input.orderTotalPaisa,
    input.shippingPaisa,
    input.taxPaisa,
    multiplier,
  );
  if (points <= 0) return { awarded: false, points: 0 };

  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "purchase",
    p_reference_id: String(input.shopifyOrderId),
    p_points: points,
    p_expires_at: expiresAtForMember(member.tier),
    p_shopify_order_id: String(input.shopifyOrderId),
    p_reason_note: null,
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (!awarded) return { awarded: false, points: 0 };

  const basisRupees = (input.orderTotalPaisa - input.shippingPaisa - input.taxPaisa) / 100;
  const newSpend = Number(member.lifetime_spend_pkr) + basisRupees;
  await db.from("members").update({ lifetime_spend_pkr: newSpend }).eq("id", member.id);
  await checkAndUpgradeTier(member.id, newSpend, member.tier);
  return { awarded: true, points };
}
