import crypto from "node:crypto";
import { db } from "../db.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";

type AdminArg = Parameters<typeof shopifyGraphqlWithRetry>[0];

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

export async function awardReferralBonus(
  referredShopifyCustomerId: string,
  referralId: string,
  admin: AdminArg,
): Promise<{ awarded: boolean; code?: string; reason?: string }> {
  const customerId = String(referredShopifyCustomerId);

  const { data: settings } = await db
    .from("app_settings")
    .select("referral_friend_discount_pkr")
    .eq("id", 1)
    .maybeSingle();
  if (!settings || (settings.referral_friend_discount_pkr ?? 0) === 0) {
    return { awarded: false, reason: "disabled" };
  }

  const { data: member } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) return { awarded: false, reason: "member_not_found" };

  // Dedup: skip if already awarded for this referral
  const { error: logErr } = await db.from("notification_log").insert({
    member_id: member.id,
    event_type: "referral_bonus",
    reference_id: String(referralId),
  });
  if (logErr) {
    if (logErr.code === "23505") return { awarded: false, reason: "already_awarded" };
    console.error("[awardReferralBonus] log insert error:", logErr);
    return { awarded: false, reason: "db_error" };
  }

  const now = new Date();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const priceRuleResult = await shopifyGraphqlWithRetry<{
    priceRuleCreate: {
      priceRule: { id: string } | null;
      priceRuleUserErrors: Array<{ message: string }>;
    };
  }>(admin, CREATE_PRICE_RULE, {
    input: {
      title: "Referral Welcome — Free Shipping",
      target: "SHIPPING_LINE",
      valueType: "PERCENTAGE",
      value: "-100",
      customerSelection: { forAllCustomers: true },
      usageLimit: 1,
      appliesOncePerCustomer: true,
      startsAt: now.toISOString(),
      endsAt: expiresAt,
    },
  });

  const priceRuleErrors = priceRuleResult.priceRuleCreate.priceRuleUserErrors;
  if (priceRuleErrors.length > 0 || !priceRuleResult.priceRuleCreate.priceRule) {
    console.error("[awardReferralBonus] priceRuleCreate errors:", priceRuleErrors);
    return { awarded: false, reason: "shopify_price_rule_error" };
  }

  const priceRuleId = priceRuleResult.priceRuleCreate.priceRule.id;
  const codeValue = `FREESHIP-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

  const discountResult = await shopifyGraphqlWithRetry<{
    priceRuleDiscountCodeCreate: {
      priceRuleDiscountCode: { code: string } | null;
      userErrors: Array<{ message: string }>;
    };
  }>(admin, CREATE_DISCOUNT_CODE, { priceRuleId, code: codeValue });

  if (
    discountResult.priceRuleDiscountCodeCreate.userErrors.length > 0 ||
    !discountResult.priceRuleDiscountCodeCreate.priceRuleDiscountCode
  ) {
    console.error(
      "[awardReferralBonus] discountCodeCreate errors:",
      discountResult.priceRuleDiscountCodeCreate.userErrors,
    );
    return { awarded: false, reason: "shopify_discount_code_error" };
  }

  const finalCode = discountResult.priceRuleDiscountCodeCreate.priceRuleDiscountCode.code;

  await db.from("loyalty_codes").insert({
    member_id: member.id,
    code: finalCode,
    shopify_price_rule_id: priceRuleId,
    discount_amount: 0,
    discount_amount_pkr: 0,
    points_spent: 0,
    status: "active",
    expires_at: expiresAt,
  });

  return { awarded: true, code: finalCode };
}
