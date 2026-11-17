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
  reviewReleaseHours: { min: 1, max: 720 },
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
 * What switching the program off does (rule 20), word for word on the
 * Settings page, its confirmation and the Home banner.
 */
export const PROGRAM_OFF_EFFECTS = [
  "Customers earn no points: no purchase, welcome, referral, review, social or birthday rewards.",
  "Customers cannot redeem points, and the rewards panel, launcher and points lines are hidden on the storefront.",
  "Reward codes already issued still work at checkout until they expire.",
  "An order placed while the program is off never earns points, even if it is delivered and paid after you switch it back on.",
  "Orders placed before you switched off still earn when they are delivered and paid, and balances are kept.",
] as const;

/**
 * FAQ entries the owner approved as defaults. Migration 014 writes them to a
 * store whose list is still empty; a store with its own list is offered them
 * on the On-site page.
 */
export const SUGGESTED_FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "How are my points calculated?",
    a: "Points are earned on the amount you pay after discounts, and are added once your order is delivered and paid. Shipping and tax do not earn points.",
  },
];
