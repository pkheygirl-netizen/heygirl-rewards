import { db } from "../db.server";
import type { Database } from "../database.types";

type SettingsRow = Database["public"]["Tables"]["app_settings"]["Row"];

/**
 * One entry of `app_settings.redemption_tiers`. `hidden: true` switches a
 * reward off without deleting it: it is not offered and cannot be redeemed.
 * The key is absent (never `false`) on a visible reward.
 */
export type RedemptionTier = { points: number; discount_pkr: number; hidden?: boolean };

export const EARN_RULE_KEYS = [
  "purchase",
  "signup",
  "referral",
  "instagram",
  "facebook",
  "youtube",
  "review",
  "birthday",
] as const;
export type EarnRuleKey = (typeof EARN_RULE_KEYS)[number];
export type EarnRules = Record<EarnRuleKey, { enabled: boolean }>;

/**
 * The singleton `app_settings` row with the two JSON columns parsed and the
 * numeric columns guaranteed to be numbers. Everything the engine reads comes
 * from here; nothing about tiers, expiry, rates or the reward table is
 * hard-coded in the services.
 */
export type AppSettings = Omit<SettingsRow, "redemption_tiers" | "earn_rules"> & {
  redemption_tiers: RedemptionTier[];
  earn_rules: EarnRules;
};

export const DEFAULT_REDEMPTION_TIERS: RedemptionTier[] = [
  { points: 3000, discount_pkr: 100 },
  { points: 6000, discount_pkr: 250 },
  { points: 11500, discount_pkr: 500 },
  { points: 22000, discount_pkr: 1000 },
  { points: 100000, discount_pkr: 5000 },
  { points: 180000, discount_pkr: 10000 },
];

// Mirrors the column defaults of migrations 001-010. Used only when the row
// cannot be read at all, and to fill a column a not-yet-migrated database lacks.
const DEFAULTS: SettingsRow = {
  id: 1,
  program_name: "HeyGirl.pk Rewards®",
  program_enabled: true,
  brand_color_primary: "#E91E8C",
  brand_color_secondary: "#7B5EA7",
  tagline: "Shop. Earn. Glow.",
  tier_gold_threshold_pkr: 50000,
  tier_diamond_threshold_pkr: 100000,
  signup_points: 1000,
  purchase_points_rate: 1,
  referral_points: 6000,
  social_points: 1000,
  social_points_youtube: 1000,
  social_points_facebook: 1000,
  social_points_instagram: 1000,
  review_points: 3000,
  silver_expiry_days: 365,
  whatsapp_enabled: false,
  whatsapp_provider: null,
  whatsapp_api_key: null,
  wa_referral_template: null,
  nudge_account_creation_enabled: true,
  nudge_points_spending_enabled: true,
  nudge_reward_usage_enabled: true,
  nudge_post_purchase_enabled: true,
  nudge_tier_progress_enabled: true,
  tier_progress_gold_threshold_pkr: 5000,
  tier_progress_diamond_threshold_pkr: 10000,
  redemption_tiers: DEFAULT_REDEMPTION_TIERS,
  referral_friend_discount_pkr: 0,
  birthday_reward_silver_pkr: 250,
  birthday_reward_gold_pkr: 500,
  birthday_reward_diamond_pkr: 1000,
  bonus_campaign_default_multiplier: 2,
  influencer_cta_link: null,
  shopify_email_injection_enabled: true,
  terms_and_conditions: null,
  faqs: [],
  nudges_config: {},
  earn_rules: {},
  referral_friend_free_shipping: true,
  tier_reward_gold_free_shipping: true,
  tier_reward_diamond_pkr: 500,
  review_release_hours: 72,
  social_url_instagram: null,
  social_url_facebook: null,
  social_url_youtube: null,
  reward_code_expiry_days: 30,
  updated_at: new Date(0).toISOString(),
};

const NUMERIC_KEYS = [
  "tier_gold_threshold_pkr",
  "tier_diamond_threshold_pkr",
  "signup_points",
  "purchase_points_rate",
  "referral_points",
  "social_points",
  "social_points_youtube",
  "social_points_facebook",
  "social_points_instagram",
  "review_points",
  "silver_expiry_days",
  "tier_progress_gold_threshold_pkr",
  "tier_progress_diamond_threshold_pkr",
  "referral_friend_discount_pkr",
  "birthday_reward_silver_pkr",
  "birthday_reward_gold_pkr",
  "birthday_reward_diamond_pkr",
  "bonus_campaign_default_multiplier",
  "tier_reward_diamond_pkr",
  "review_release_hours",
  "reward_code_expiry_days",
] as const satisfies ReadonlyArray<keyof SettingsRow>;

export function parseRedemptionTiers(raw: unknown): RedemptionTier[] {
  if (!Array.isArray(raw)) return DEFAULT_REDEMPTION_TIERS;
  const seen = new Set<number>();
  const tiers: RedemptionTier[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const points = Math.floor(Number(rec.points));
    // Accept the storefront spelling too, in case it was saved that way.
    const discount = Math.floor(Number(rec.discount_pkr ?? rec.discountPkr));
    if (!Number.isFinite(points) || !Number.isFinite(discount) || points <= 0 || discount <= 0) continue;
    if (seen.has(points)) continue;
    seen.add(points);
    // Only the boolean true hides a reward; anything else leaves it visible.
    tiers.push(rec.hidden === true ? { points, discount_pkr: discount, hidden: true } : { points, discount_pkr: discount });
  }
  if (tiers.length === 0) return DEFAULT_REDEMPTION_TIERS;
  return tiers.sort((a, b) => a.points - b.points);
}

/** A rule is on unless it is explicitly switched off. */
export function parseEarnRules(raw: unknown): EarnRules {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as EarnRules;
  for (const key of EARN_RULE_KEYS) {
    const rule = src[key];
    const off = !!rule && typeof rule === "object" && (rule as Record<string, unknown>).enabled === false;
    out[key] = { enabled: !off };
  }
  return out;
}

export function normaliseSettings(row: Partial<SettingsRow> | null | undefined): AppSettings {
  const merged: SettingsRow = { ...DEFAULTS };
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }
  for (const key of NUMERIC_KEYS) {
    const n = Number(merged[key]);
    (merged as Record<string, unknown>)[key] = Number.isFinite(n) ? n : DEFAULTS[key];
  }
  return {
    ...merged,
    redemption_tiers: parseRedemptionTiers(merged.redemption_tiers),
    earn_rules: parseEarnRules(merged.earn_rules),
  };
}

const CACHE_MS = 30_000;
let cache: { at: number; value: AppSettings } | null = null;
let inflight: Promise<AppSettings> | null = null;

/**
 * Typed settings row with a 30-second in-process cache. If the row cannot be
 * read and there is an older copy, the older copy is served; if there is none,
 * the documented defaults are (and the failure is logged).
 */
export async function getSettings(): Promise<AppSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await db.from("app_settings").select("*").eq("id", 1).maybeSingle();
      if (error) throw new Error(error.message);
      const value = normaliseSettings(data);
      cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      console.error("[settings] read failed:", err instanceof Error ? err.message : err);
      if (cache) return cache.value;
      return normaliseSettings(null);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function bustSettingsCache(): void {
  cache = null;
  inflight = null;
}

export function isEarnRuleEnabled(settings: AppSettings, rule: EarnRuleKey): boolean {
  return settings.program_enabled !== false && settings.earn_rules[rule]?.enabled !== false;
}

export function tierThresholds(settings: AppSettings): { gold: number; diamond: number } {
  return { gold: settings.tier_gold_threshold_pkr, diamond: settings.tier_diamond_threshold_pkr };
}

// ── Asia/Karachi helpers (UTC+5, no daylight saving) ──────────────────────
const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Calendar parts of an instant in Pakistan time. */
export function karachiParts(at: Date = new Date()): { year: number; month: number; day: number } {
  const shifted = new Date(at.getTime() + KARACHI_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** The instant a Pakistan-time month starts. */
export function karachiMonthStart(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1) - KARACHI_OFFSET_MS);
}
