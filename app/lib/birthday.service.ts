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

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

export async function birthdayDiscountPkr(tier: string): Promise<number> {
  const { data } = await db
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  const s = (data as Record<string, unknown>) ?? {};
  if (tier === "diamond") return num(s.birthday_reward_diamond_pkr, 1000);
  if (tier === "gold") return num(s.birthday_reward_gold_pkr, 500);
  return num(s.birthday_reward_silver_pkr, 250);
}

export async function awardBirthdayReward(
  memberId: string,
  admin: AdminArg,
): Promise<{ awarded: boolean; code?: string; discountPkr?: number; reason?: string }> {
  const now = new Date();
  const referenceId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  // Dedup: insert first — unique constraint prevents double award
  const { error: logErr } = await db.from("notification_log").insert({
    member_id: memberId,
    event_type: "birthday_reward",
    reference_id: referenceId,
  });
  if (logErr) {
    if (logErr.code === "23505") return { awarded: false, reason: "already_awarded_this_month" };
    console.error("[awardBirthdayReward] log insert error:", logErr);
    return { awarded: false, reason: "db_error" };
  }

  const { data: member } = await db
    .from("members")
    .select("tier, email")
    .eq("id", memberId)
    .maybeSingle();
  if (!member) {
    await db
      .from("notification_log")
      .delete()
      .eq("member_id", memberId)
      .eq("event_type", "birthday_reward")
      .eq("reference_id", referenceId);
    return { awarded: false, reason: "member_not_found" };
  }

  const discountPkr = await birthdayDiscountPkr(member.tier);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const priceRuleResult = await shopifyGraphqlWithRetry<{
    priceRuleCreate: {
      priceRule: { id: string } | null;
      priceRuleUserErrors: Array<{ message: string }>;
    };
  }>(admin, CREATE_PRICE_RULE, {
    input: {
      title: `Birthday Reward — Rs.${discountPkr} off`,
      target: "LINE_ITEM",
      valueType: "FIXED_AMOUNT",
      value: String(-discountPkr),
      customerSelection: { forAllCustomers: true },
      usageLimit: 1,
      startsAt: now.toISOString(),
      endsAt: expiresAt,
    },
  });

  const priceRuleErrors = priceRuleResult.priceRuleCreate.priceRuleUserErrors;
  if (priceRuleErrors.length > 0 || !priceRuleResult.priceRuleCreate.priceRule) {
    console.error("[awardBirthdayReward] priceRuleCreate errors:", priceRuleErrors);
    return { awarded: false, reason: "shopify_price_rule_error" };
  }

  const priceRuleId = priceRuleResult.priceRuleCreate.priceRule.id;
  const codeValue = `BDAY-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

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
      "[awardBirthdayReward] discountCodeCreate errors:",
      discountResult.priceRuleDiscountCodeCreate.userErrors,
    );
    return { awarded: false, reason: "shopify_discount_code_error" };
  }

  const finalCode = discountResult.priceRuleDiscountCodeCreate.priceRuleDiscountCode.code;

  await db.from("loyalty_codes").insert({
    member_id: memberId,
    code: finalCode,
    shopify_price_rule_id: priceRuleId,
    discount_amount: discountPkr,
    discount_amount_pkr: discountPkr,
    points_spent: 0,
    status: "active",
    expires_at: expiresAt,
  });

  return { awarded: true, code: finalCode, discountPkr };
}
