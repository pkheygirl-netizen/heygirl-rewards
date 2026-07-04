import crypto from "node:crypto";
import { db } from "../db.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";
import { notificationQueue } from "./queue.server";

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

const CREATE_PRICE_RULE = `
  mutation CreatePriceRule($input: PriceRuleInput!) {
    priceRuleCreate(input: $input) {
      priceRule { id }
      priceRuleUserErrors { field message }
    }
  }
`;

const CREATE_DISCOUNT_CODE = `
  mutation CreateDiscountCode($priceRuleId: ID!, $code: String!) {
    priceRuleDiscountCodeCreate(priceRuleId: $priceRuleId, code: $code) {
      priceRuleDiscountCode { code }
      userErrors { field message }
    }
  }
`;

export async function redeemPoints(input: {
  shopifyCustomerId: string;
  requestedPoints: number;
  admin: Parameters<typeof shopifyGraphqlWithRetry>[0];
}): Promise<{ redeemed: boolean; code?: string; discountPkr?: number; reason?: string }> {
  const customerId = String(input.shopifyCustomerId);

  const { data: member } = await db
    .from("members")
    .select("id, points_balance")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) return { redeemed: false, reason: "member_not_found" };

  const tiers = await getRedemptionTiers();
  const validation = validateRedemption(member.points_balance, input.requestedPoints, tiers);
  if (!validation.valid) return { redeemed: false, reason: validation.reason };

  const tier = findTier(tiers, input.requestedPoints)!;

  // Create a loyalty_codes row first to get a stable reference_id for the RPC
  const { data: codeRow, error: insertErr } = await db
    .from("loyalty_codes")
    .insert({
      member_id: member.id,
      code: `PENDING-${crypto.randomUUID()}`, // unique placeholder until we have the real code
      discount_amount: tier.discount_pkr, // required column from original schema
      discount_amount_pkr: tier.discount_pkr,
      points_spent: input.requestedPoints,
      status: "active",
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select("id")
    .single();
  if (insertErr || !codeRow) {
    console.error("[redeemPoints] failed to create loyalty_codes row:", insertErr);
    return { redeemed: false, reason: "db_error" };
  }

  // Deduct points — idempotent on reference_id = codeRow.id
  const { data: rpcData, error: rpcErr } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "redemption",
    p_reference_id: String(codeRow.id),
    p_points: -input.requestedPoints,
    p_reason_note: `redeemed ${input.requestedPoints} pts for Rs.${tier.discount_pkr} off`,
  });
  if (rpcErr) {
    // Clean up the pending row; the RPC failed before deducting
    await db.from("loyalty_codes").delete().eq("id", codeRow.id);
    throw rpcErr;
  }
  const deducted = rpcData?.[0]?.awarded ?? false;
  if (!deducted) {
    // Not awarded: either a duplicate reference (retry) or, post-migration-008,
    // a concurrent redemption drained the balance first.
    await db.from("loyalty_codes").delete().eq("id", codeRow.id);
    const { data: existing } = await db
      .from("loyalty_codes")
      .select("code, discount_amount_pkr")
      .eq("member_id", member.id)
      .eq("points_spent", input.requestedPoints)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return {
        redeemed: false,
        reason: "duplicate",
        code: existing.code,
        discountPkr: existing.discount_amount_pkr,
      };
    }
    return { redeemed: false, reason: "insufficient_balance" };
  }

  // Compensating action: if Shopify discount creation fails AFTER the deduction
  // succeeded, re-credit the points (idempotent reference) and remove the row so
  // the customer keeps their balance and can simply retry.
  const recredit = async (why: string) => {
    const { error: recreditErr } = await db.rpc("award_points", {
      p_member_id: member.id,
      p_action_type: "adjustment", // 'redemption_reversal' not in ledger CHECK vocab
      p_reference_id: `reversal-${codeRow.id}`,
      p_points: input.requestedPoints,
      p_reason_note: `auto re-credit: ${why}`,
    });
    if (recreditErr) {
      // Re-credit itself failed — keep the row as evidence for manual review.
      console.error("[redeemPoints] RE-CREDIT FAILED — manual adjustment needed:", recreditErr, "code row:", codeRow.id);
      await db.from("loyalty_codes").update({ status: "expired" }).eq("id", codeRow.id);
      return;
    }
    await db.from("loyalty_codes").delete().eq("id", codeRow.id);
  };

  // Create Shopify price rule
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  let priceRuleResult: {
    priceRuleCreate: { priceRule: { id: string } | null; priceRuleUserErrors: Array<{ message: string }> };
  };
  try {
    priceRuleResult = await shopifyGraphqlWithRetry<{
      priceRuleCreate: { priceRule: { id: string } | null; priceRuleUserErrors: Array<{ message: string }> };
    }>(input.admin, CREATE_PRICE_RULE, {
      input: {
        title: `Loyalty Reward — Rs.${tier.discount_pkr} off`,
        target: "LINE_ITEM",
        valueType: "FIXED_AMOUNT",
        value: String(-tier.discount_pkr),
        // I5 (2026-07-03 review): pin the code to its owner — a leaked/shared
        // single-use code would otherwise consume the member's reward.
        customerSelection: { customerIdsToAdd: [`gid://shopify/Customer/${customerId}`] },
        usageLimit: 1,
        startsAt: new Date().toISOString(),
        endsAt: expiresAt,
      },
    });
  } catch (err) {
    console.error("[redeemPoints] priceRuleCreate threw:", err);
    await recredit("Shopify price rule request failed");
    return { redeemed: false, reason: "shopify_price_rule_error" };
  }

  const priceRuleErrors = priceRuleResult.priceRuleCreate.priceRuleUserErrors;
  if (priceRuleErrors.length > 0 || !priceRuleResult.priceRuleCreate.priceRule) {
    console.error("[redeemPoints] priceRuleCreate errors:", priceRuleErrors);
    await recredit("Shopify price rule creation rejected");
    return { redeemed: false, reason: "shopify_price_rule_error" };
  }

  const priceRuleId = priceRuleResult.priceRuleCreate.priceRule.id;
  const codeValue = generateCodeValue();

  let discountResult: {
    priceRuleDiscountCodeCreate: {
      priceRuleDiscountCode: { code: string } | null;
      userErrors: Array<{ message: string }>;
    };
  };
  try {
    discountResult = await shopifyGraphqlWithRetry<{
      priceRuleDiscountCodeCreate: {
        priceRuleDiscountCode: { code: string } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(input.admin, CREATE_DISCOUNT_CODE, { priceRuleId, code: codeValue });
  } catch (err) {
    console.error("[redeemPoints] discountCodeCreate threw:", err);
    await recredit("Shopify discount code request failed");
    return { redeemed: false, reason: "shopify_discount_code_error" };
  }

  const discountErrors = discountResult.priceRuleDiscountCodeCreate.userErrors;
  if (discountErrors.length > 0 || !discountResult.priceRuleDiscountCodeCreate.priceRuleDiscountCode) {
    console.error("[redeemPoints] discountCodeCreate errors:", discountErrors);
    await recredit("Shopify discount code creation rejected");
    return { redeemed: false, reason: "shopify_discount_code_error" };
  }

  const finalCode = discountResult.priceRuleDiscountCodeCreate.priceRuleDiscountCode.code;

  // Update the loyalty_codes row with the real code
  await db
    .from("loyalty_codes")
    .update({ code: finalCode, shopify_price_rule_id: priceRuleId })
    .eq("id", codeRow.id);

  // Notify member of redemption (non-blocking)
  notificationQueue
    .add("redemption_confirmed", {
      memberId: member.id,
      code: finalCode,
      discountPkr: tier.discount_pkr,
    })
    .catch((err) => console.error("[redeemPoints] redemption_confirmed enqueue failed:", err));

  return { redeemed: true, code: finalCode, discountPkr: tier.discount_pkr };
}

export async function getActiveLoyaltyCodes(shopifyCustomerId: string): Promise<
  Array<{ id: string; code: string; discount_amount_pkr: number; expires_at: string | null; status: string }>
> {
  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", String(shopifyCustomerId))
    .maybeSingle();
  if (!member) return [];

  const { data } = await db
    .from("loyalty_codes")
    .select("id, code, discount_amount_pkr, expires_at, status")
    .eq("member_id", member.id)
    .in("status", ["active", "used"])
    .order("created_at", { ascending: false })
    .limit(50);
  return data ?? [];
}
