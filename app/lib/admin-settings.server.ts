import { db } from "../db.server";

export const EDITABLE_KEYS = [
  "program_name",
  "brand_color_primary",
  "brand_color_secondary",
  "tagline",
  "tier_gold_threshold_pkr",
  "tier_diamond_threshold_pkr",
  "signup_points",
  "purchase_points_rate",
  "referral_points",
  "review_points",
  "silver_expiry_days",
  "redemption_tiers",
  "social_points_youtube",
  "social_points_facebook",
  "social_points_instagram",
  "birthday_reward_silver_pkr",
  "birthday_reward_gold_pkr",
  "birthday_reward_diamond_pkr",
  "bonus_campaign_default_multiplier",
  "influencer_cta_link",
  "whatsapp_enabled",
  "whatsapp_provider",
  "whatsapp_api_key",
  "wa_referral_template",
  "shopify_email_injection_enabled",
  "terms_and_conditions",
  "faqs",
  "nudges_config",
  "nudge_account_creation_enabled",
  "nudge_points_spending_enabled",
  "nudge_reward_usage_enabled",
  "nudge_post_purchase_enabled",
  "nudge_tier_progress_enabled",
  "tier_progress_gold_threshold_pkr",
  "tier_progress_diamond_threshold_pkr",
] as const;

export async function getSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown>) ?? {};
}

export async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const allowed = new Set<string>(EDITABLE_KEYS as readonly string[]);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) filtered[k] = v;
  }
  if (Object.keys(filtered).length === 0) throw new Error("no editable fields");
  const { error } = await db.from("app_settings").update(filtered).eq("id", 1);
  if (error) throw error;
}
