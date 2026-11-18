// app/widget/shared.ts
// Types and pure helpers used by both storefront bundles (core and hub).
// Nothing here touches the DOM, so it is unit-testable in plain Node.
import type { PublicCampaign, StorefrontConfig } from "../lib/storefront-config.server";
import type { CustomerPayload } from "../lib/widget-data.server";

// The embed prints every config key except the long page texts.
export type Config = Omit<StorefrontConfig, "terms" | "faqs" | "reviewReleaseHours" | "codeExpiryDays">;
export type MemberData = CustomerPayload & { enabled?: boolean; welcomeQueued?: boolean };
/**
 * Why there is no member payload: "" while unknown or when there is one. The
 * program switch never hides the member's rewards (rule 20: it only pauses
 * redeeming, published as `redeemPaused` in the config).
 */
export type MemberState = "" | "not_enrolled" | "error";
/** What the five-minute cache holds: the payload, or a remembered negative answer. */
export type CacheEntry = MemberData | { member: null; state: MemberState };
export type Tier = "silver" | "gold" | "diamond";

export type CartState = { total: number; count: number; codes: string[] };

export type BootData = {
  config: Config;
  customer: { id: string } | null;
  page: string;
  urls: { login: string; hub: string; rewards: string; shop?: string };
  cart: CartState;
};

export type HubApi = (screen: string, opener?: HTMLElement | null) => void;

export type LoyaltyApi = {
  data: BootData;
  /** Member payload: cached for five minutes per customer, null for guests. */
  member: (force?: boolean) => Promise<MemberData | null>;
  invalidate: () => void;
  /** Set after `member()` resolves null: no member row, or a failed request. */
  state: () => MemberState;
  open: (screen?: string, opener?: HTMLElement | null) => void;
  _hub?: HubApi;
};

export const PROXY = "/apps/loyalty";
export const CACHE_TTL_MS = 5 * 60 * 1000;

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 100000 → "100,000". Western grouping on every device. */
export function fmt(n: number): string {
  const v = Math.round(Number(n) || 0);
  return String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ",").replace(/^/, v < 0 ? "-" : "");
}

export function rs(n: number): string {
  return `Rs. ${fmt(n)}`;
}

/** "point" / "points". */
export function pts(n: number): string {
  return `${fmt(n)} ${Math.abs(n) === 1 ? "point" : "points"}`;
}

const KARACHI = "Asia/Karachi";

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: KARACHI });
  } catch {
    return d.toDateString();
  }
}

type CampaignCfg = { campaign: PublicCampaign | null; nextCampaign?: PublicCampaign | null };

/**
 * The campaign in force at `now`, judged by the shopper's clock against the
 * published dates (Liquid's own "now" can be minutes old on a cached page).
 * Both the current and the following campaign are published, so one that
 * starts right after another shows without a settings save.
 */
export function activeCampaign(cfg: CampaignCfg, now: number = Date.now()): PublicCampaign | null {
  for (const c of [cfg.campaign, cfg.nextCampaign]) {
    if (!c) continue;
    const s = Date.parse(c.startsAt);
    const e = Date.parse(c.endsAt);
    if (!isNaN(s) && !isNaN(e) && now >= s && now <= e && c.multiplier > 0 && c.multiplier !== 1) return c;
  }
  return null;
}

/** Campaign multiplier in force at `now` (1 when none). */
export function activeMultiplier(cfg: CampaignCfg, now: number = Date.now()): number {
  const c = activeCampaign(cfg, now);
  return c ? c.multiplier : 1;
}

/** "11.11 Sale: 2x points until 20 Nov 2026", or "" when no campaign is running. */
export function campaignNote(cfg: CampaignCfg, now: number = Date.now()): string {
  const c = activeCampaign(cfg, now);
  if (!c) return "";
  return `${c.name ? c.name + ": " : ""}${String(c.multiplier)}x points until ${fmtDate(c.endsAt)}`;
}

/**
 * The earning rate in words, never rounded: 1 → "1 point for every Rs. 1 spent",
 * 2 → "2 points for every Rs. 1 spent", 0.5 → "1 point for every Rs. 2 spent",
 * 0.3 → "0.3 points for every Rs. 1 spent".
 */
export function rateText(rate: number): string {
  const r = Number(rate) || 0;
  if (r <= 0) return "";
  if (Math.abs(r - Math.round(r)) < 1e-9) return `${pts(Math.round(r))} for every Rs. 1 spent`;
  const per = 1 / r;
  if (r < 1 && Math.abs(per - Math.round(per)) < 1e-9) return `1 point for every Rs. ${fmt(Math.round(per))} spent`;
  return `${String(parseFloat(r.toFixed(4)))} points for every Rs. 1 spent`;
}

// ── Referral slug kept until the server gives a final answer ─────────────────

export type PendingRef = { s: string; t: number; n: number };
export const REF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const REF_MAX_TRIES = 20;
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

export function validSlug(s: unknown): s is string {
  return typeof s === "string" && SLUG_RE.test(s);
}

/** Reads the stored value (JSON, or a bare slug from older versions); null when absent, malformed, too old or tried too often. */
export function parsePendingRef(raw: string | null, now: number = Date.now()): PendingRef | null {
  if (!raw) return null;
  let v: PendingRef | null = null;
  try {
    const o = JSON.parse(raw) as Partial<PendingRef> | null;
    if (o && typeof o === "object") v = { s: String(o.s || ""), t: Number(o.t) || now, n: Number(o.n) || 0 };
  } catch {
    v = { s: raw, t: now, n: 0 };
  }
  if (!v || !validSlug(v.s)) return null;
  if (now - v.t > REF_MAX_AGE_MS || v.n >= REF_MAX_TRIES) return null;
  return v;
}

const REF_FINAL = ["recorded", "duplicate", "self_referral", "invalid_slug", "not_eligible", "already_referred", "disabled"];

/**
 * True only when the server's answer can never change, so the slug may be
 * forgotten. Temporary answers (try_again, not_a_member, 401/403/429/5xx,
 * a network error, or an unknown error such as an older server's
 * program_disabled) keep it for a later page.
 */
export function isFinalReferralReply(httpStatus: number, body: { ok?: boolean; status?: string; error?: string } | null | undefined): boolean {
  if (!body || httpStatus === 401 || httpStatus === 403 || httpStatus === 429 || httpStatus >= 500) return false;
  if (body.ok === true) return true;
  return REF_FINAL.indexOf(String(body.status || "")) >= 0 || REF_FINAL.indexOf(String(body.error || "")) >= 0;
}

/** Points for an amount in the shop's minor unit (paisa). floor(rupees × rate × multiplier). */
export function pointsFor(cents: number, cfg: Pick<Config, "pointsRate" | "earnRules"> & CampaignCfg, now: number = Date.now()): number {
  if (cfg.earnRules && cfg.earnRules.purchase && cfg.earnRules.purchase.enabled === false) return 0;
  const v = (Math.max(0, cents) / 100) * (cfg.pointsRate || 0) * activeMultiplier(cfg, now);
  return Math.floor(v + 1e-6);
}

export type TierProgress = {
  tier: Tier;
  next: "gold" | "diamond" | null;
  /** 0–100 towards `next`; 100 at the top tier. */
  pct: number;
  /** Rupees still to spend to reach `next`. */
  remaining: number;
  target: number;
};

/**
 * Progress uses the real tier thresholds (never the nudge distances). Tiers are
 * never taken away, so the member's stored tier wins over what spend implies.
 */
export function tierProgress(spend: number, tier: Tier, tiers: { gold: number; diamond: number }): TierProgress {
  const s = Math.max(0, spend || 0);
  if (tier === "diamond") return { tier, next: null, pct: 100, remaining: 0, target: tiers.diamond };
  const from = tier === "gold" ? tiers.gold : 0;
  const target = tier === "gold" ? tiers.diamond : tiers.gold;
  const span = target - from;
  const pct = span > 0 ? Math.max(0, Math.min(100, Math.floor(((s - from) / span) * 100))) : 0;
  return { tier, next: tier === "gold" ? "diamond" : "gold", pct, remaining: Math.max(0, Math.ceil(target - s)), target };
}

export const TIER_NAME: Record<Tier, string> = { silver: "Silver", gold: "Gold", diamond: "Diamond" };

/** The code worth applying first: highest rupee value, else the first one. */
export function bestCode<T extends { discountPkr: number }>(codes: T[]): T | null {
  let best: T | null = null;
  for (const c of codes) if (!best || c.discountPkr > best.discountPkr) best = c;
  return best;
}

export function codeValue(c: { kind: string; discountPkr: number }): string {
  return c.discountPkr > 0 ? `${rs(c.discountPkr)} off` : "Free shipping";
}

export function discountUrl(code: string, path: string): string {
  const p = path && path.charAt(0) === "/" && path.charAt(1) !== "/" ? path : "/";
  return `/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(p)}`;
}

export function minRedeem(cfg: Pick<Config, "redemptionTiers">): number {
  return cfg.redemptionTiers.length ? cfg.redemptionTiers[0].points : 0;
}

export const GIFT_ICON = '<svg class="hg-ico" aria-hidden="true" focusable="false"><use href="#hg-i-gift"/></svg>';
