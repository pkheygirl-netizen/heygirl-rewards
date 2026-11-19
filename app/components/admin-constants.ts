// Limits and option lists shared by the admin's server validation and its
// forms. They live outside the *.server.ts files so page components can import
// them (a component must never import a server-only module). The server files
// re-export them, so the number shown in a field's help text is always the
// number the server enforces.

export const ACTIVITY_FILTERS = ["all", "earned", "redeemed", "referrals", "adjustments"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export const ADJUST_LIMITS = { maxPoints: 1000000, reason: 300, customerNote: 140 } as const;
export const NOTE_MAX = 1000;
export const REJECT_NOTE_MAX = 300;

export const EARN_RULE_KEYS = [
  "purchase", "signup", "referral", "instagram", "facebook", "youtube", "review", "birthday",
] as const;
export type EarnRuleKey = (typeof EARN_RULE_KEYS)[number];

export const PROGRAM_LIMITS = {
  points: { min: 0, max: 50000 },
  referralPoints: { min: 0, max: 100000 },
  purchaseRate: { min: 0.1, max: 10 },
  tierPkr: { min: 1000, max: 10000000 },
  rewardPkr: { min: 0, max: 100000 },
  expiryDays: { min: 30, max: 3650 },
  codeExpiryDays: { min: 1, max: 365 },
  redemption: { maxRows: 12, minPoints: 100, maxPoints: 1000000, minPkr: 10, maxPkr: 100000 },
} as const;

export const MULTIPLIER_PRESETS = [1.5, 2, 3] as const;
export const INFLUENCER_LIMITS = {
  multiplier: { min: 1, max: 10 },
  campaign: 60,
  codePercent: { min: 1, max: 90 },
} as const;

export const CAMPAIGN_LIMITS = { name: 80, multiplier: { min: 1.1, max: 10 } } as const;
export type CampaignStatus = "scheduled" | "live" | "ended" | "off";
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  scheduled: "Scheduled", live: "Live", ended: "Ended", off: "Switched off",
};

export const ONSITE_LIMITS = {
  programName: 60,
  /** Launcher button text for visitors (app_settings.launcher_label). */
  launcherLabel: 24,
  tagline: 120,
  terms: 20000,
  faqCount: 30,
  faqQuestion: 200,
  faqAnswer: 2000,
  withinMax: 1000000,
} as const;

export const REFERRAL_STATUSES = ["flagged", "pending", "completed", "rejected", "blocked"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_STATUS_LABELS: Record<string, string> = {
  flagged: "Held for review",
  pending: "Waiting for first order",
  completed: "Completed",
  rejected: "Rejected",
  blocked: "Blocked",
};

/** The balance never goes below zero: removing more than she has leaves 0. */
export function previewBalance(balance: number, direction: "add" | "remove", points: number): number {
  if (!Number.isFinite(points) || points <= 0) return balance;
  return direction === "add" ? balance + points : Math.max(balance - points, 0);
}

/**
 * What pausing redeeming does (rule 20, `app_settings.program_enabled = false`,
 * owner decision 17 Nov 2026 evening), word for word on the Settings page, its
 * confirmation and the Home banner.
 */
export const PROGRAM_OFF_EFFECTS = [
  "Customers cannot redeem points for new reward codes. The rewards panel tells them redeeming is paused.",
  "Customers still earn points as normal: orders, the welcome bonus, referrals, influencer codes, reviews, social follows, birthdays, tier rewards and bonus campaigns.",
  "Reward codes already issued still work at checkout until they expire. If reward codes should not stack with your sale, run the sale as an automatic discount: reward codes do not combine with other discounts, so Shopify applies only the one discount that is best for the customer. A sale made by lowering product prices is not a discount, so reward codes still apply on top of it.",
  "Everything else continues: the rewards panel, launcher, points lines, rewards page, balances, points expiry and emails.",
] as const;

/** Colour schemes of the storefront rewards panel (`app_settings.panel_theme`, migration 014). */
export const PANEL_THEMES = ["light", "dark"] as const;
export type PanelThemeChoice = (typeof PANEL_THEMES)[number];

/**
 * FAQ entries the owner approved as defaults. Migration 014 writes them to a
 * store whose list is still empty; a store with its own list is offered them
 * on the On-site page.
 */
export const SUGGESTED_FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "How are my points calculated?",
    a: "Points are earned on the amount you pay after discounts, and are added once your order is delivered and paid. Shipping, tax and any part paid by gift card do not earn points.",
  },
];

/** Settings page: Shopify refused the script-tag calls (the scopes are not granted by default). */
export const NO_SCRIPT_SCOPE_TEXT = "To remove the old script, the app needs temporary script-tag permission (read_script_tags and write_script_tags).";
