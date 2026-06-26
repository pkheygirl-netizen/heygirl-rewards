import crypto from "node:crypto";
import { db } from "../db.server";

export function hashAddress(address: string): string {
  return crypto.createHash("sha256").update(address.toLowerCase().trim()).digest("hex");
}

export async function resolveReferrer(slug: string): Promise<{ memberId: string } | null> {
  const { data } = await db
    .from("members")
    .select("id")
    .eq("referral_slug", slug)
    .maybeSingle();
  return data ? { memberId: data.id } : null;
}

export async function checkFraud(input: {
  referrerMemberId: string;
  referredEmail: string;
  referredIp: string;
  referredShippingAddress?: string;
  deviceFingerprintHash?: string;
}): Promise<{ blocked: boolean; flagged: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  let blocked = false;
  let flagged = false;

  // 1. Email match: referred email == referrer's email → block
  const { data: referrer } = await db
    .from("members")
    .select("email")
    .eq("id", input.referrerMemberId)
    .maybeSingle();
  if (referrer?.email?.toLowerCase() === input.referredEmail.toLowerCase()) {
    reasons.push("email_match");
    blocked = true;
  }

  // 2. IP match: same IP was used in a prior referral from this referrer → block
  const { data: ipMatches } = await db
    .from("referrals")
    .select("id")
    .eq("referrer_member_id", input.referrerMemberId)
    .eq("referred_ip", input.referredIp)
    .limit(1);
  if ((ipMatches?.length ?? 0) > 0) {
    reasons.push("ip_match");
    blocked = true;
  }

  // 3. Shipping address hash match → block
  if (input.referredShippingAddress) {
    const hash = hashAddress(input.referredShippingAddress);
    const { data: addrMatches } = await db
      .from("referrals")
      .select("id")
      .eq("referrer_member_id", input.referrerMemberId)
      .eq("referred_shipping_address_hash", hash)
      .limit(1);
    if ((addrMatches?.length ?? 0) > 0) {
      reasons.push("address_match");
      blocked = true;
    }
  }

  // 4. Device fingerprint match → flag (not block)
  if (input.deviceFingerprintHash) {
    const { data: fpMatches } = await db
      .from("referrals")
      .select("id")
      .eq("device_fingerprint_hash", input.deviceFingerprintHash)
      .limit(1);
    if ((fpMatches?.length ?? 0) > 0) {
      reasons.push("device_fingerprint");
      flagged = true;
    }
  }

  // 5. Repeated referrals from same IP (≥3 from same referred_ip + same referrer) → flag
  const { count } = await db
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referred_ip", input.referredIp)
    .eq("referrer_member_id", input.referrerMemberId);
  if ((count ?? 0) >= 3) {
    reasons.push("repeated_ip");
    flagged = true;
  }

  return { blocked, flagged, reasons };
}

export async function recordReferralVisit(input: {
  referralSlug: string;
  referredShopifyCustomerId: string;
  referredEmail: string;
  referredIp: string;
  referredShippingAddress?: string;
  deviceFingerprintHash?: string;
}): Promise<{ recorded: boolean; blocked: boolean; reason?: string }> {
  const referrer = await resolveReferrer(input.referralSlug);
  if (!referrer) return { recorded: false, blocked: false, reason: "invalid_slug" };

  // Deduplicate: don't create a second row for the same referred customer
  const { data: existing } = await db
    .from("referrals")
    .select("id, status")
    .eq("referrer_member_id", referrer.memberId)
    .eq("referred_shopify_customer_id", String(input.referredShopifyCustomerId))
    .maybeSingle();
  if (existing) {
    return { recorded: false, blocked: existing.status === "blocked", reason: "duplicate" };
  }

  const fraud = await checkFraud({
    referrerMemberId: referrer.memberId,
    referredEmail: input.referredEmail,
    referredIp: input.referredIp,
    referredShippingAddress: input.referredShippingAddress,
    deviceFingerprintHash: input.deviceFingerprintHash,
  });

  const status = fraud.blocked ? "blocked" : fraud.flagged ? "flagged" : "pending";
  const addressHash = input.referredShippingAddress
    ? hashAddress(input.referredShippingAddress)
    : null;

  await db.from("referrals").insert({
    referrer_member_id: referrer.memberId,
    referred_shopify_customer_id: String(input.referredShopifyCustomerId),
    referred_email: input.referredEmail,
    // NOTE: referrer_ip is populated with the referred user's IP (same as referred_ip).
    // The brief explicitly sets referrer_ip: input.referredIp for symmetry.
    // This is the referrer's IP at the time the referral link was clicked, which we don't
    // have at this point — so both columns store the referred user's IP.
    referrer_ip: input.referredIp,
    referred_ip: input.referredIp,
    referred_shipping_address_hash: addressHash,
    device_fingerprint_hash: input.deviceFingerprintHash ?? null,
    fraud_flags: fraud.reasons,
    status,
  });

  return { recorded: true, blocked: fraud.blocked };
}

export async function awardReferral(
  referredShopifyCustomerId: string,
): Promise<{ awarded: boolean; points?: number }> {
  const customerId = String(referredShopifyCustomerId);

  const { data: referral } = await db
    .from("referrals")
    .select("id, referrer_member_id, status")
    .eq("referred_shopify_customer_id", customerId)
    .eq("status", "pending")
    .maybeSingle();
  if (!referral) return { awarded: false };

  const { data: settings } = await db
    .from("app_settings")
    .select("referral_points")
    .eq("id", 1)
    .maybeSingle();
  const points = settings?.referral_points ?? 6000;

  const { data, error } = await db.rpc("award_points", {
    p_member_id: referral.referrer_member_id,
    p_action_type: "referral_earned",
    p_reference_id: String(referral.id),
    p_points: points,
    p_reason_note: `referral completed by ${customerId}`,
  });
  if (error) throw error;

  const awarded = data?.[0]?.awarded ?? false;
  if (awarded) {
    await db
      .from("referrals")
      .update({ status: "completed" })
      .eq("id", referral.id);
  }
  return { awarded, points: awarded ? points : undefined };
}
