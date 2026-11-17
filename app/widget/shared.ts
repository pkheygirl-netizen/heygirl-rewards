// app/widget/shared.ts
// Types and pure helpers used by both storefront bundles (core and hub).
// Nothing here touches the DOM, so it is unit-testable in plain Node.
import type { StorefrontConfig } from "../lib/storefront-config.server";
import type { CustomerPayload } from "../lib/widget-data.server";

// The embed prints every config key except the long page texts.
export type Config = Omit<StorefrontConfig, "terms" | "faqs">;
export type MemberData = CustomerPayload & { enabled?: boolean; welcomeQueued?: boolean };
export type Tier = "silver" | "gold" | "diamond";

export type CartState = { total: number; count: number; codes: string[] };

export type BootData = {
  config: Config;
  customer: { id: string; firstName: string | null } | null;
  page: string;
  urls: { login: string; hub: string; rewards: string };
  cart: CartState;
};

export type HubApi = (screen: string, opener?: HTMLElement | null) => void;

export type LoyaltyApi = {
  data: BootData;
  /** Member payload: cached for five minutes per customer, null for guests. */
  member: (force?: boolean) => Promise<MemberData | null>;
  invalidate: () => void;
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

/** Campaign multiplier in force at `now` (1 when none). */
export function activeMultiplier(cfg: Pick<Config, "campaign">, now: number = Date.now()): number {
  const c = cfg.campaign;
  if (!c) return 1;
  const s = Date.parse(c.startsAt);
  const e = Date.parse(c.endsAt);
  if (isNaN(s) || isNaN(e) || now < s || now > e) return 1;
  return c.multiplier > 0 ? c.multiplier : 1;
}

/** Points for an amount in the shop's minor unit (paisa). floor(rupees × rate × multiplier). */
export function pointsFor(cents: number, cfg: Pick<Config, "pointsRate" | "campaign" | "earnRules">, now: number = Date.now()): number {
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
