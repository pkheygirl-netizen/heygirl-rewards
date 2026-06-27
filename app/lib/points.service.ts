import { db } from "../db.server";
import { notificationQueue } from "./queue.server";

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

export async function enrolMember(
  customer: {
    id: number | string;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  },
  // consent must be explicitly collected via the storefront widget opt-in
  // checkbox before this is set to true. Defaults to false so webhook-driven
  // enrolments (customers/create, customers/enable) create the record without
  // consent until the customer actively joins via the loyalty widget.
  consentGiven: boolean = false,
): Promise<{ enrolled: boolean; reason?: string }> {
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

  const now = new Date().toISOString();
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
      consent_given: consentGiven,
      consent_given_at: consentGiven ? now : null,
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
  // Notify member of tier upgrade (non-blocking)
  notificationQueue
    .add("tier_upgrade", { memberId, newTier: target })
    .catch((err) => console.error("[checkAndUpgradeTier] notification enqueue failed:", err));
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
    p_expires_at: expiresAtForMember(member.tier) ?? undefined,
    p_shopify_order_id: String(input.shopifyOrderId),
    p_reason_note: undefined,
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (!awarded) return { awarded: false, points: 0 };

  // NOTE: read-modify-write race — safe for MVP (single Shopify store, low concurrency)
  // Fix before high-concurrency: move lifetime_spend_pkr += into the award_points RPC
  const basisRupees = (input.orderTotalPaisa - input.shippingPaisa - input.taxPaisa) / 100;
  const newSpend = Number(member.lifetime_spend_pkr) + basisRupees;
  await db.from("members").update({ lifetime_spend_pkr: newSpend }).eq("id", member.id);
  await checkAndUpgradeTier(member.id, newSpend, member.tier);
  return { awarded: true, points };
}

async function settingValue(key: "signup_points" | "social_points", fallback: number): Promise<number> {
  const { data } = await db.from("app_settings").select(key).eq("id", 1).maybeSingle();
  const v = (data as Record<string, number> | null)?.[key];
  return typeof v === "number" ? v : fallback;
}

async function socialPointsForPlatform(
  platform: "youtube" | "facebook" | "instagram",
): Promise<number> {
  const { data } = await db.from("app_settings").select("*").eq("id", 1).maybeSingle();
  const s = (data as Record<string, unknown> | null) ?? {};
  const perPlatform = s[`social_points_${platform}`];
  if (typeof perPlatform === "number") return perPlatform;
  if (typeof s.social_points === "number") return s.social_points;
  return 1000;
}

export async function awardSignup(shopifyCustomerId: string): Promise<{ awarded: boolean }> {
  const customerId = String(shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id, consent_given")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) {
    console.warn(`[awardSignup] no member ${customerId}`);
    return { awarded: false };
  }
  // Only award signup bonus if the customer has explicitly opted in via the
  // loyalty widget. The customers/enable webhook fires for all activations;
  // consent gates the actual point award.
  if (!member.consent_given) {
    console.log(`[awardSignup] skip: customer ${customerId} has not consented`);
    return { awarded: false };
  }
  const points = await settingValue("signup_points", 1000);
  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "signup",
    p_reference_id: customerId,
    p_points: points,
  });
  if (error) throw error;
  return { awarded: data?.[0]?.awarded ?? false };
}

export async function awardSocial(socialActionId: string): Promise<{ awarded: boolean }> {
  const { data: row } = await db
    .from("social_actions")
    .select("id, member_id, action_type, status")
    .eq("id", socialActionId)
    .maybeSingle();
  if (!row) {
    console.warn(`[awardSocial] no action ${socialActionId}`);
    return { awarded: false };
  }
  if (row.status !== "pending") return { awarded: false }; // voided/awarded already

  const platform = row.action_type as "youtube" | "facebook" | "instagram";
  const points = await socialPointsForPlatform(platform);
  const ledgerType = mapSocialActionType(platform);
  const { data, error } = await db.rpc("award_points", {
    p_member_id: row.member_id,
    p_action_type: ledgerType,
    p_reference_id: socialActionId,
    p_points: points,
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (awarded) {
    await db
      .from("social_actions")
      .update({ status: "awarded", points_awarded: points })
      .eq("id", socialActionId);
  }
  return { awarded };
}

export async function awardRefund(input: {
  shopifyCustomerId: string;
  refundId: string;
  refundedMerchandisePaisa: number;
}): Promise<{ awarded: boolean; deducted: number }> {
  const customerId = String(input.shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) {
    console.warn(`[awardRefund] no member ${customerId}`);
    return { awarded: false, deducted: 0 };
  }

  const clawback = roundClawback(input.refundedMerchandisePaisa / 100);
  if (clawback <= 0) return { awarded: false, deducted: 0 };

  // Idempotent negative award first; if duplicate refund id, stop (no double FIFO decrement)
  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "refund_deduction",
    p_reference_id: String(input.refundId),
    p_points: -clawback,
    p_reason_note: "refund",
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (!awarded) return { awarded: false, deducted: 0 };

  // NOTE: FIFO decrement is not atomic with RPC — concurrent refunds may over/under-decrement
  // points_remaining. Balance (via RPC) remains correct; points_remaining can drift.
  // Fix before high-concurrency: move FIFO decrement into the award_points RPC.
  // Decrement points_remaining FIFO across purchase tranches
  let remaining = clawback;
  const { data: tranches } = await db
    .from("points_ledger")
    .select("id, points_remaining")
    .eq("member_id", member.id)
    .eq("action_type", "purchase")
    .eq("expired", false)
    .gt("points_remaining", 0)
    .order("earned_at", { ascending: true });
  for (const t of tranches ?? []) {
    if (remaining <= 0) break;
    const take = Math.min(t.points_remaining ?? 0, remaining);
    await db
      .from("points_ledger")
      .update({ points_remaining: (t.points_remaining ?? 0) - take })
      .eq("id", t.id);
    remaining -= take;
  }
  return { awarded: true, deducted: clawback };
}

export async function expireSilverPoints(
  now: Date = new Date(),
): Promise<{ membersAffected: number; pointsExpired: number }> {
  const iso = now.toISOString();
  const { data: tranches } = await db
    .from("points_ledger")
    .select("id, member_id, points_remaining, members!inner(tier)")
    .eq("action_type", "purchase")
    .eq("expired", false)
    .gt("points_remaining", 0)
    .lt("expires_at", iso);

  // NOTE: FIFO decrement is not atomic with RPC — concurrent expiry runs may over/under-decrement
  // points_remaining. Balance (via RPC) remains correct; points_remaining can drift.
  // Fix before high-concurrency: move FIFO decrement into the award_points RPC.
  const affected = new Set<string>();
  let total = 0;
  for (const t of tranches ?? []) {
    const tier = (t as any).members?.tier;
    if (tier !== "silver") continue; // safety: only silver expires
    const amount = t.points_remaining ?? 0;
    if (amount <= 0) continue;
    const { data, error } = await db.rpc("award_points", {
      p_member_id: t.member_id,
      p_action_type: "expiry",
      p_reference_id: String(t.id),
      p_points: -amount,
      p_reason_note: "expiry",
    });
    if (error) throw error;
    if (data?.[0]?.awarded) {
      await db.from("points_ledger").update({ points_remaining: 0, expired: true }).eq("id", t.id);
      affected.add(t.member_id);
      total += amount;
    }
  }
  return { membersAffected: affected.size, pointsExpired: total };
}

// ── GDPR / CCPA compliance ──────────────────────────────────────────────────

/**
 * customers/redact — erase a customer's personal data. We anonymize in place
 * rather than delete: FKs from points_ledger/referrals/etc. have no ON DELETE
 * CASCADE, and the non-identifying transactional records may be retained for
 * legitimate accounting once the personal identifiers are stripped.
 */
export async function redactCustomer(shopifyCustomerId: string): Promise<{ redacted: boolean }> {
  const customerId = String(shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) {
    console.warn(`[redactCustomer] no member ${customerId}`);
    return { redacted: false };
  }

  await db
    .from("members")
    .update({
      email: `redacted-${member.id}@redacted.invalid`,
      first_name: null,
      last_name: null,
      birthday_day: null,
      birthday_month: null,
      consent_given: false,
      consent_given_at: null,
    })
    .eq("id", member.id);

  // Strip referral PII (IPs, email, customer id) tied to this person.
  await db
    .from("referrals")
    .update({ referrer_ip: null, referred_ip: null })
    .eq("referrer_member_id", member.id);
  await db
    .from("referrals")
    .update({ referred_ip: null, referrer_ip: null, referred_email: `redacted-${member.id}@redacted.invalid` })
    .eq("referred_shopify_customer_id", customerId);

  return { redacted: true };
}

/**
 * shop/redact — fires ~48h after uninstall. Single-merchant app, so this erases
 * all stored data. Deletes children before members (FKs are RESTRICT, no cascade).
 */
export async function redactShop(): Promise<{ redacted: boolean }> {
  const all = (table: "points_ledger" | "loyalty_codes" | "social_actions" | "referrals" | "order_webhook_state" | "members") =>
    db.from(table).delete().not("id", "is", null);

  await all("points_ledger");
  await all("loyalty_codes");
  await all("social_actions");
  await all("referrals");
  await all("order_webhook_state");
  await all("members");
  return { redacted: true };
}
