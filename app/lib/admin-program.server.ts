// app/lib/admin-program.server.ts
// Program page: ways to earn, ways to redeem, tiers, birthday, expiry.
// Every number has a range and blanks are rejected on the server (handbook R3).
import { num, str, type Row } from "./admin-db.server";
import { FormReader, type FieldErrors } from "./admin-validate.server";

import { EARN_RULE_KEYS, PROGRAM_LIMITS, type EarnRuleKey } from "../components/admin-constants";
export { EARN_RULE_KEYS, PROGRAM_LIMITS, type EarnRuleKey };

export type EarnRuleView = {
  key: EarnRuleKey;
  title: string;
  when: string;
  /** e.g. "1,000 points" or "1 point per Rs.1" */
  value: string;
  enabled: boolean;
  /** shown under the row when the rule is on but cannot work yet */
  problem: string | null;
};

export function ruleEnabled(rules: unknown, key: EarnRuleKey): boolean {
  if (!rules || typeof rules !== "object") return true;
  const r = (rules as Row)[key];
  if (!r || typeof r !== "object") return true;
  return (r as Row).enabled !== false;
}

function pts(n: unknown): string {
  return `${String(Math.round(num(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} points`;
}

/** Pure: settings row → the "ways to earn" rows. */
export function earnRuleViews(s: Row): EarnRuleView[] {
  const rate = num(s.purchase_points_rate, 1);
  const hours = num(s.review_release_hours, 72);
  const social = (key: "instagram" | "facebook" | "youtube", title: string): EarnRuleView => {
    const enabled = ruleEnabled(s.earn_rules, key);
    const url = str(s[`social_url_${key}`]).trim();
    return {
      key, title, when: "Customer opens the profile, then confirms in the rewards panel",
      value: pts(s[`social_points_${key}`]),
      enabled,
      problem: enabled && !url ? "No profile link yet, so this is hidden on the storefront. Add the link in Edit." : null,
    };
  };
  return [
    {
      key: "purchase", title: "Place an order", when: "Given when the order is delivered and paid",
      value: `${rate} point${rate === 1 ? "" : "s"} per Rs.1`, enabled: ruleEnabled(s.earn_rules, "purchase"), problem: null,
    },
    {
      key: "signup", title: "Create an account", when: "Given once, at first sign-in on the store",
      value: pts(s.signup_points), enabled: ruleEnabled(s.earn_rules, "signup"), problem: null,
    },
    {
      key: "referral", title: "Refer a friend",
      when: "Given when the friend's first order is delivered and paid",
      value: pts(s.referral_points), enabled: ruleEnabled(s.earn_rules, "referral"), problem: null,
    },
    social("instagram", "Follow on Instagram"),
    social("facebook", "Like on Facebook"),
    social("youtube", "Subscribe on YouTube"),
    {
      key: "review", title: "Post a review",
      when: `Released ${hours} hours after the customer claims it`,
      value: pts(s.review_points), enabled: ruleEnabled(s.earn_rules, "review"), problem: null,
    },
    {
      key: "birthday", title: "Birthday reward",
      when: "A discount code on the 1st of her birthday month. Amounts are under Birthday below",
      value: "Discount code", enabled: ruleEnabled(s.earn_rules, "birthday"), problem: null,
    },
  ];
}

type Parsed = { ok: true; patch: Record<string, unknown> } | { ok: false; errors: FieldErrors };
type Form = { get(name: string): unknown };

function withRule(current: unknown, key: EarnRuleKey, enabled: boolean): Record<string, { enabled: boolean }> {
  const out: Record<string, { enabled: boolean }> = {};
  for (const k of EARN_RULE_KEYS) out[k] = { enabled: ruleEnabled(current, k) };
  out[key] = { enabled };
  return out;
}

export function isEarnRuleKey(v: string): v is EarnRuleKey {
  return (EARN_RULE_KEYS as readonly string[]).includes(v);
}

/** On/off switch for one rule. The other rules keep their current state. */
export function toggleRulePatch(current: Row, key: EarnRuleKey, enabled: boolean): Record<string, unknown> {
  return { earn_rules: withRule(current.earn_rules, key, enabled) };
}

/** Edit form for one rule: its numbers, its link, and its on/off switch. */
export function parseEarnRuleForm(current: Row, key: EarnRuleKey, form: Form): Parsed {
  const r = new FormReader(form);
  const enabled = r.bool("enabled");
  const patch: Record<string, unknown> = { earn_rules: withRule(current.earn_rules, key, enabled) };
  const L = PROGRAM_LIMITS;
  switch (key) {
    case "purchase":
      patch.purchase_points_rate = r.decimal(
        "purchase_points_rate", "Points per rupee", L.purchaseRate.min, L.purchaseRate.max, 2);
      break;
    case "signup":
      patch.signup_points = r.int("signup_points", "Points given", L.points.min, L.points.max);
      break;
    case "referral":
      patch.referral_points = r.int("referral_points", "Points given", L.referralPoints.min, L.referralPoints.max);
      patch.referral_friend_free_shipping = r.bool("referral_friend_free_shipping");
      break;
    case "instagram":
    case "facebook":
    case "youtube": {
      patch[`social_points_${key}`] = r.int(`social_points_${key}`, "Points given", L.points.min, L.points.max);
      // The storefront button must open the profile before she can confirm, so a
      // rule that is on needs its link.
      const url = r.url(`social_url_${key}`, "Profile link", { required: enabled });
      patch[`social_url_${key}`] = url || null;
      break;
    }
    case "review":
      patch.review_points = r.int("review_points", "Points given", L.points.min, L.points.max);
      patch.review_release_hours = r.int(
        "review_release_hours", "Hours before release", L.reviewReleaseHours.min, L.reviewReleaseHours.max);
      break;
    case "birthday":
      break;
  }
  return r.ok ? { ok: true, patch } : { ok: false, errors: r.errors };
}

// ── ways to redeem ───────────────────────────────────────────────────────────

/**
 * One reward in app_settings.redemption_tiers. `hidden: true` keeps the reward
 * in the table but takes it away from customers (not offered on the storefront,
 * refused by redeem); absent or false means it is shown. Stored as
 * {"points", "discount_pkr"} plus "hidden": true only when hidden.
 */
export type RedemptionTier = { points: number; discount_pkr: number; hidden?: boolean };

/**
 * Only the literal boolean true (or the text "true", in case a row was edited
 * by hand) hides a reward. Anything else, including a missing key, is "shown":
 * an unreadable flag must never make a reward quietly disappear for customers.
 */
export function isHiddenFlag(v: unknown): boolean {
  return v === true || v === "true";
}

/** Reads the raw jsonb defensively: rows that are not usable rewards are dropped. */
export function readRedemptionTiers(v: unknown): RedemptionTier[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t): RedemptionTier => {
      const o = (t && typeof t === "object" ? t : {}) as Row;
      const tier: RedemptionTier = {
        points: Math.round(num(o.points)),
        discount_pkr: Math.round(num(o.discount_pkr ?? o.discountPkr)),
      };
      if (isHiddenFlag(o.hidden)) tier.hidden = true;
      return tier;
    })
    .filter((t) => t.points > 0 && t.discount_pkr > 0)
    .sort((a, b) => a.points - b.points);
}

/**
 * The whole table is saved at once (JSON in the `tiers` field: rows of
 * {points, discount_pkr, hidden} as typed). Rules: 1-12 rows, whole numbers in
 * range, no two rewards with the same points or the same discount, and a bigger
 * discount must always cost more points. Saved sorted by points.
 *
 * The rules apply to every row, hidden or not: a hidden reward can be shown
 * again with one click, so the table must be valid with it shown.
 *
 * `hidden` must be a real true/false (or absent). Every reward may be hidden:
 * that is a deliberate, reversible choice, unlike an empty table, which is
 * still refused. The page warns that customers then have nothing to redeem.
 */
export function parseRedemptionTiersForm(form: Form): Parsed {
  const r = new FormReader(form);
  const L = PROGRAM_LIMITS.redemption;
  let raw: unknown;
  try {
    raw = JSON.parse(r.raw("tiers") || "null");
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) {
    r.fail("tiers", "The reward table could not be read. Reload the page and try again.");
    return { ok: false, errors: r.errors };
  }
  if (raw.length === 0) r.fail("tiers", "Keep at least one reward, or switch the program off in Settings.");
  if (raw.length > L.maxRows) r.fail("tiers", `No more than ${L.maxRows} rewards.`);

  const tiers: RedemptionTier[] = [];
  raw.forEach((item, i) => {
    const o = (item ?? {}) as Row;
    const row = new FormReader({ get: (n: string) => (o[n] === undefined || o[n] === null ? "" : String(o[n])) });
    const points = row.int("points", `Reward ${i + 1}: points needed`, L.minPoints, L.maxPoints);
    const pkr = row.int("discount_pkr", `Reward ${i + 1}: discount`, L.minPkr, L.maxPkr);
    if (row.errors.points) r.fail(`points_${i}`, row.errors.points);
    if (row.errors.discount_pkr) r.fail(`discount_pkr_${i}`, row.errors.discount_pkr);
    const flag = o.hidden;
    if (flag !== undefined && flag !== null && typeof flag !== "boolean") {
      r.fail(`hidden_${i}`, `Reward ${i + 1}: could not tell whether it is shown or hidden. Reload the page and try again.`);
    }
    tiers.push(flag === true ? { points, discount_pkr: pkr, hidden: true } : { points, discount_pkr: pkr });
  });

  if (r.ok) {
    const indexed = tiers.map((t, i) => ({ ...t, i })).sort((a, b) => a.points - b.points);
    for (let k = 1; k < indexed.length; k++) {
      const prev = indexed[k - 1];
      const cur = indexed[k];
      if (cur.points === prev.points) {
        r.fail(`points_${cur.i}`, `Two rewards cost ${cur.points} points. Each reward needs its own points amount.`);
      } else if (cur.discount_pkr === prev.discount_pkr) {
        r.fail(`discount_pkr_${cur.i}`, `Two rewards give Rs.${cur.discount_pkr} off. Each reward needs its own discount.`);
      } else if (cur.discount_pkr < prev.discount_pkr) {
        r.fail(
          `discount_pkr_${cur.i}`,
          `Rs.${cur.discount_pkr} off costs more points than Rs.${prev.discount_pkr} off. A bigger discount must cost more points.`,
        );
      }
    }
  }
  if (!r.ok) return { ok: false, errors: r.errors };
  return { ok: true, patch: { redemption_tiers: [...tiers].sort((a, b) => a.points - b.points) } };
}

/** The rewards customers can actually choose. */
export function visibleRedemptionTiers(tiers: RedemptionTier[]): RedemptionTier[] {
  return tiers.filter((t) => t.hidden !== true);
}

/**
 * Lowest reward customers can choose: the "base rate" used to put a rupee value
 * on outstanding points. A hidden reward is not available, so it is never the
 * base rate; with every reward hidden there is none.
 */
export function baseRedemptionRate(tiers: RedemptionTier[]): RedemptionTier | null {
  const shown = visibleRedemptionTiers(tiers);
  return shown.length ? shown.reduce((a, b) => (a.points <= b.points ? a : b)) : null;
}

export function pointsValuePkr(points: number, base: RedemptionTier | null): number {
  if (!base || base.points <= 0) return 0;
  return Math.round((points * base.discount_pkr) / base.points);
}

// ── tiers, birthday, expiry ──────────────────────────────────────────────────

export function parseTiersForm(form: Form): Parsed {
  const r = new FormReader(form);
  const L = PROGRAM_LIMITS;
  const gold = r.int("tier_gold_threshold_pkr", "Gold threshold", L.tierPkr.min, L.tierPkr.max);
  const diamond = r.int("tier_diamond_threshold_pkr", "Diamond threshold", L.tierPkr.min, L.tierPkr.max);
  if (r.ok && diamond <= gold) {
    r.fail("tier_diamond_threshold_pkr", "The Diamond threshold must be higher than the Gold threshold.");
  }
  const patch = {
    tier_gold_threshold_pkr: gold,
    tier_diamond_threshold_pkr: diamond,
    tier_reward_gold_free_shipping: r.bool("tier_reward_gold_free_shipping"),
    tier_reward_diamond_pkr: r.int("tier_reward_diamond_pkr", "Diamond upgrade reward", L.rewardPkr.min, L.rewardPkr.max),
  };
  return r.ok ? { ok: true, patch } : { ok: false, errors: r.errors };
}

export function parseBirthdayRewardsForm(form: Form): Parsed {
  const r = new FormReader(form);
  const L = PROGRAM_LIMITS.rewardPkr;
  const patch = {
    birthday_reward_silver_pkr: r.int("birthday_reward_silver_pkr", "Silver birthday reward", L.min, L.max),
    birthday_reward_gold_pkr: r.int("birthday_reward_gold_pkr", "Gold birthday reward", L.min, L.max),
    birthday_reward_diamond_pkr: r.int("birthday_reward_diamond_pkr", "Diamond birthday reward", L.min, L.max),
  };
  return r.ok ? { ok: true, patch } : { ok: false, errors: r.errors };
}

export function parseExpiryForm(form: Form): Parsed {
  const r = new FormReader(form);
  const L = PROGRAM_LIMITS;
  const patch = {
    silver_expiry_days: r.int("silver_expiry_days", "Silver points expiry", L.expiryDays.min, L.expiryDays.max),
    reward_code_expiry_days: r.int(
      "reward_code_expiry_days", "Reward code expiry", L.codeExpiryDays.min, L.codeExpiryDays.max),
  };
  return r.ok ? { ok: true, patch } : { ok: false, errors: r.errors };
}
