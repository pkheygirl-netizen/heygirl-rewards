// app/lib/storefront-config.server.ts
// Builds the public storefront config and writes it to an app-data metafield
// (owner: this app's installation; namespace "hg_loyalty", key "config", type
// json). Theme app extension Liquid reads it as
// `app.metafields.hg_loyalty.config.value`, so guests never hit the app server.
//
// Nothing secret may ever be added here: the JSON is printed into storefront HTML.
import { db } from "../db.server";
import { getSettings } from "./settings.server";

export type AdminGraphqlClient = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

export const CONFIG_NAMESPACE = "hg_loyalty";
export const CONFIG_KEY = "config";

export type SocialPlatform = "instagram" | "facebook" | "youtube";
export type EarnRuleKey = "purchase" | "signup" | "referral" | "instagram" | "facebook" | "youtube" | "review" | "birthday";

export type PublicCampaign = { name: string; multiplier: number; startsAt: string; endsAt: string };

export type StorefrontConfig = {
  enabled: boolean;
  programName: string;
  tagline: string;
  pointsRate: number;
  signupPoints: number;
  referralPoints: number;
  reviewPoints: number;
  social: Record<SocialPlatform, { points: number; url: string; enabled: boolean }>;
  earnRules: Record<EarnRuleKey, { enabled: boolean }>;
  tiers: { gold: number; diamond: number };
  redemptionTiers: Array<{ points: number; discountPkr: number }>;
  birthday: { silver: number; gold: number; diamond: number };
  nudges: {
    accountCreation: boolean;
    pointsSpending: boolean;
    rewardUsage: boolean;
    tierProgress: boolean;
    goldWithin: number;
    diamondWithin: number;
  };
  /** The campaign running at sync time, else the next one that is switched on. */
  campaign: PublicCampaign | null;
  /**
   * Addition: the campaign after `campaign`. The storefront script picks
   * whichever is in force by its own clock, so back-to-back campaigns show
   * without a settings save in between.
   */
  nextCampaign: PublicCampaign | null;
  terms: string;
  faqs: Array<{ q: string; a: string }>;
  // Additions to the contract shape (additive; needed so no number is hard-coded
  // in Liquid or the widget).
  expiryDays: number;
  codeExpiryDays: number;
  reviewReleaseHours: number;
  friendFreeShipping: boolean;
  tierRewards: { goldFreeShipping: boolean; diamondPkr: number };
};

export type CampaignRow = { name: string; multiplier: number; starts_at: string; ends_at: string };

type Loose = Record<string, unknown>;

const RULE_KEYS: EarnRuleKey[] = ["purchase", "signup", "referral", "instagram", "facebook", "youtube", "review", "birthday"];

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}
function int(v: unknown, fallback = 0): number {
  return Math.max(0, Math.round(num(v, fallback)));
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
/** Only http(s) links are ever published; anything else becomes "". */
function safeUrl(v: unknown): string {
  const s = str(v);
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : "";
}

function ruleEnabled(rules: unknown, key: EarnRuleKey): boolean {
  if (!rules || typeof rules !== "object") return true;
  const r = (rules as Loose)[key];
  if (!r || typeof r !== "object") return true;
  return bool((r as Loose).enabled, true);
}

function redemptionTiers(v: unknown): StorefrontConfig["redemptionTiers"] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => {
      const o = (t ?? {}) as Loose;
      return { points: int(o.points), discountPkr: int(o.discount_pkr ?? o.discountPkr) };
    })
    .filter((t) => t.points > 0 && t.discountPkr > 0)
    .sort((a, b) => a.points - b.points);
}

function faqs(v: unknown): StorefrontConfig["faqs"] {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => {
      const o = (f ?? {}) as Loose;
      return { q: str(o.q ?? o.question), a: str(o.a ?? o.answer) };
    })
    .filter((f) => f.q !== "" && f.a !== "");
}

function publicCampaign(c: CampaignRow | null | undefined): PublicCampaign | null {
  if (!c) return null;
  const mult = num(c.multiplier, 1);
  if (!(mult > 0) || mult === 1) return null;
  if (isNaN(Date.parse(c.starts_at)) || isNaN(Date.parse(c.ends_at))) return null;
  return { name: str(c.name), multiplier: mult, startsAt: c.starts_at, endsAt: c.ends_at };
}

/** Pure: settings row (+ current-or-next campaign and the one after) → public config. */
export function buildStorefrontConfig(settings: Loose, campaign: CampaignRow | null, next: CampaignRow | null = null): StorefrontConfig {
  const s = settings;
  const fallbackSocial = int(s.social_points);
  const social = (p: SocialPlatform) => ({
    points: int(s[`social_points_${p}`], fallbackSocial),
    url: safeUrl(s[`social_url_${p}`]),
    enabled: ruleEnabled(s.earn_rules, p) && safeUrl(s[`social_url_${p}`]) !== "",
  });
  const earnRules = Object.fromEntries(
    RULE_KEYS.map((k) => [k, { enabled: ruleEnabled(s.earn_rules, k) }]),
  ) as StorefrontConfig["earnRules"];

  const first = publicCampaign(campaign);
  const second = publicCampaign(next);
  return {
    enabled: bool(s.program_enabled, true),
    programName: str(s.program_name) || "Rewards",
    tagline: str(s.tagline),
    pointsRate: num(s.purchase_points_rate, 1),
    signupPoints: int(s.signup_points),
    referralPoints: int(s.referral_points),
    reviewPoints: int(s.review_points),
    social: { instagram: social("instagram"), facebook: social("facebook"), youtube: social("youtube") },
    earnRules,
    tiers: { gold: int(s.tier_gold_threshold_pkr), diamond: int(s.tier_diamond_threshold_pkr) },
    redemptionTiers: redemptionTiers(s.redemption_tiers),
    birthday: {
      silver: int(s.birthday_reward_silver_pkr),
      gold: int(s.birthday_reward_gold_pkr),
      diamond: int(s.birthday_reward_diamond_pkr),
    },
    nudges: {
      accountCreation: bool(s.nudge_account_creation_enabled, true),
      pointsSpending: bool(s.nudge_points_spending_enabled, true),
      rewardUsage: bool(s.nudge_reward_usage_enabled, true),
      tierProgress: bool(s.nudge_tier_progress_enabled, true),
      goldWithin: int(s.tier_progress_gold_threshold_pkr),
      diamondWithin: int(s.tier_progress_diamond_threshold_pkr),
    },
    campaign: first ?? second,
    nextCampaign: first ? second : null,
    terms: str(s.terms_and_conditions),
    faqs: faqs(s.faqs),
    expiryDays: int(s.silver_expiry_days),
    codeExpiryDays: int(s.reward_code_expiry_days, 30),
    reviewReleaseHours: int(s.review_release_hours, 72),
    friendFreeShipping: bool(s.referral_friend_free_shipping, true),
    tierRewards: {
      goldFreeShipping: bool(s.tier_reward_gold_free_shipping, true),
      diamondPkr: int(s.tier_reward_diamond_pkr),
    },
  };
}

/** Switched-on campaigns that have not ended, soonest first: [current or next, the one after]. */
export async function getUpcomingCampaigns(now: Date = new Date()): Promise<CampaignRow[]> {
  const { data, error } = await db
    .from("bonus_campaigns")
    .select("name, multiplier, starts_at, ends_at")
    .eq("is_active", true)
    .gte("ends_at", now.toISOString())
    .order("starts_at", { ascending: true })
    .limit(2);
  if (error) throw new Error(`campaign_lookup_failed: ${error.message}`);
  return (data ?? []) as CampaignRow[];
}

/** The campaign running now, else the next one that is switched on. */
export async function getCurrentOrNextCampaign(now: Date = new Date()): Promise<CampaignRow | null> {
  return (await getUpcomingCampaigns(now))[0] ?? null;
}

export const APP_INSTALLATION_QUERY = `#graphql
  query HgCurrentAppInstallation {
    currentAppInstallation {
      id
    }
  }`;

export const CONFIG_METAFIELD_MUTATION = `#graphql
  mutation HgSetStorefrontConfig($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }`;

type GqlBody<T> = { data?: T; errors?: Array<{ message?: string }> };

async function gql<T>(admin: AdminGraphqlClient, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await res.json()) as GqlBody<T>;
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message ?? "graphql_error").join("; "));
  if (!body.data) throw new Error("empty_graphql_response");
  return body.data;
}

export async function syncStorefrontConfig(admin: AdminGraphqlClient): Promise<{ ok: boolean; reason?: string }> {
  try {
    const settings = (await getSettings()) as unknown as Loose;
    const campaigns = await getUpcomingCampaigns();
    const config = buildStorefrontConfig(settings, campaigns[0] ?? null, campaigns[1] ?? null);

    const inst = await gql<{ currentAppInstallation: { id: string } | null }>(admin, APP_INSTALLATION_QUERY);
    const ownerId = inst.currentAppInstallation?.id;
    if (!ownerId) return { ok: false, reason: "no_app_installation" };

    const out = await gql<{
      metafieldsSet: { userErrors: Array<{ field: string[] | null; message: string }> } | null;
    }>(admin, CONFIG_METAFIELD_MUTATION, {
      metafields: [
        { ownerId, namespace: CONFIG_NAMESPACE, key: CONFIG_KEY, type: "json", value: JSON.stringify(config) },
      ],
    });
    const errs = out.metafieldsSet?.userErrors ?? [];
    if (errs.length) return { ok: false, reason: errs.map((e) => e.message).join("; ") };
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown_error";
    console.error("[storefront-config] sync failed:", reason);
    return { ok: false, reason };
  }
}
