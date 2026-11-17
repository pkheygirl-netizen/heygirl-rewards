import { describe, expect, it } from "vitest";
import {
  baseRedemptionRate, earnRuleViews, isEarnRuleKey, isHiddenFlag, visibleRedemptionTiers, parseBirthdayRewardsForm, parseEarnRuleForm, parseExpiryForm,
  parseRedemptionTiersForm, parseTiersForm, pointsValuePkr, readRedemptionTiers, ruleEnabled, toggleRulePatch,
} from "./admin-program.server";
import { formOf } from "./admin-test-helpers";

const SETTINGS = {
  purchase_points_rate: "1.00", signup_points: 1000, referral_points: 6000, review_points: 3000, review_release_hours: 72,
  social_points_instagram: 1000, social_points_facebook: 1000, social_points_youtube: 1000,
  social_url_instagram: "https://instagram.com/heygirl.pk", social_url_facebook: null, social_url_youtube: "",
  earn_rules: { purchase: { enabled: true }, review: { enabled: false } },
};

describe("ways to earn", () => {
  it("builds one row per rule with its value and state", () => {
    const rows = earnRuleViews(SETTINGS);
    expect(rows.map((r) => r.key)).toEqual(["purchase", "signup", "referral", "instagram", "facebook", "youtube", "review", "birthday"]);
    expect(rows[0]).toMatchObject({ value: "1 point per Rs.1", enabled: true });
    expect(rows[1].value).toBe("1,000 points");
    expect(rows.find((r) => r.key === "review")).toMatchObject({ enabled: false, when: "Released 72 hours after the customer claims it" });
  });

  it("warns when a social rule is on but has no profile link", () => {
    const rows = earnRuleViews(SETTINGS);
    expect(rows.find((r) => r.key === "instagram")!.problem).toBeNull();
    expect(rows.find((r) => r.key === "facebook")!.problem).toContain("No profile link");
  });

  it("treats a rule that is missing from earn_rules as on", () => {
    expect(ruleEnabled(undefined, "signup")).toBe(true);
    expect(ruleEnabled({}, "signup")).toBe(true);
    expect(ruleEnabled({ signup: { enabled: false } }, "signup")).toBe(false);
    expect(isEarnRuleKey("review")).toBe(true);
    expect(isEarnRuleKey("drop")).toBe(false);
  });

  it("switching one rule keeps every other rule's state", () => {
    const patch = toggleRulePatch(SETTINGS, "signup", false) as { earn_rules: Record<string, { enabled: boolean }> };
    expect(patch.earn_rules.signup.enabled).toBe(false);
    expect(patch.earn_rules.review.enabled).toBe(false);
    expect(patch.earn_rules.purchase.enabled).toBe(true);
    expect(Object.keys(patch.earn_rules)).toHaveLength(8);
  });
});

describe("edit a way to earn", () => {
  it("saves points for sign-up and rejects blank, negative and out-of-range values (R3)", () => {
    const ok = parseEarnRuleForm(SETTINGS, "signup", formOf({ enabled: "true", signup_points: "1500" }));
    expect(ok.ok && ok.patch.signup_points).toBe(1500);
    for (const v of ["", "-1", "50001", "12.5", "lots"]) {
      const res = parseEarnRuleForm(SETTINGS, "signup", formOf({ enabled: "true", signup_points: v }));
      expect(res.ok, v).toBe(false);
    }
  });

  it("validates the purchase rate as a decimal in range", () => {
    const ok = parseEarnRuleForm(SETTINGS, "purchase", formOf({ enabled: "true", purchase_points_rate: "1.5" }));
    expect(ok.ok && ok.patch.purchase_points_rate).toBe(1.5);
    for (const v of ["", "0", "0.05", "10.5", "1.234"]) {
      expect(parseEarnRuleForm(SETTINGS, "purchase", formOf({ enabled: "true", purchase_points_rate: v })).ok, v).toBe(false);
    }
  });

  it("needs a profile link while a social rule is on, and stores null when it is cleared and off", () => {
    const missing = parseEarnRuleForm(SETTINGS, "facebook", formOf({ enabled: "true", social_points_facebook: "1000", social_url_facebook: "" }));
    expect(missing.ok).toBe(false);
    const off = parseEarnRuleForm(SETTINGS, "facebook", formOf({ enabled: "false", social_points_facebook: "1000", social_url_facebook: "" }));
    expect(off.ok && off.patch.social_url_facebook).toBeNull();
    const bad = parseEarnRuleForm(SETTINGS, "facebook", formOf({ enabled: "true", social_points_facebook: "1000", social_url_facebook: "javascript:alert(1)" }));
    expect(bad.ok).toBe(false);
    const good = parseEarnRuleForm(SETTINGS, "facebook", formOf({ enabled: "true", social_points_facebook: "800", social_url_facebook: "https://facebook.com/heygirl.pk" }));
    expect(good.ok && good.patch).toMatchObject({ social_points_facebook: 800, social_url_facebook: "https://facebook.com/heygirl.pk" });
  });

  it("saves review points with release hours, and the referral reward with the friend's code switch", () => {
    const review = parseEarnRuleForm(SETTINGS, "review", formOf({ enabled: "true", review_points: "3000", review_release_hours: "48" }));
    expect(review.ok && review.patch).toMatchObject({ review_points: 3000, review_release_hours: 48 });
    expect(parseEarnRuleForm(SETTINGS, "review", formOf({ enabled: "true", review_points: "3000", review_release_hours: "0" })).ok).toBe(false);
    const ref = parseEarnRuleForm(SETTINGS, "referral", formOf({ enabled: "true", referral_points: "100000", referral_friend_free_shipping: "true" }));
    expect(ref.ok && ref.patch).toMatchObject({ referral_points: 100000, referral_friend_free_shipping: true });
    expect(parseEarnRuleForm(SETTINGS, "referral", formOf({ enabled: "true", referral_points: "100001" })).ok).toBe(false);
  });

  it("the birthday rule only carries its switch", () => {
    const res = parseEarnRuleForm(SETTINGS, "birthday", formOf({ enabled: "false" }));
    expect(res.ok && Object.keys(res.patch)).toEqual(["earn_rules"]);
  });
});

describe("ways to redeem", () => {
  const form = (rows: unknown) => formOf({ tiers: JSON.stringify(rows) });

  it("saves the table sorted by points", () => {
    const res = parseRedemptionTiersForm(form([{ points: "6000", discount_pkr: "250" }, { points: "3000", discount_pkr: "100" }]));
    expect(res).toEqual({ ok: true, patch: { redemption_tiers: [{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250 }] } });
  });

  it("rejects blank cells, decimals and out-of-range numbers, naming the row", () => {
    const res = parseRedemptionTiersForm(form([{ points: "", discount_pkr: "100" }, { points: "50", discount_pkr: "2.5" }]));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.points_0).toBe("Reward 1: points needed is required.");
      expect(res.errors.points_1).toContain("between 100 and 1,000,000");
      expect(res.errors.discount_pkr_1).toContain("whole number");
    }
  });

  it("rejects duplicate points, duplicate discounts and a bigger discount that costs fewer points", () => {
    const dupPoints = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100 }, { points: 3000, discount_pkr: 250 }]));
    expect(!dupPoints.ok && dupPoints.errors.points_1).toContain("Two rewards cost 3000 points");
    const dupPkr = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 100 }]));
    expect(!dupPkr.ok && dupPkr.errors.discount_pkr_1).toContain("Two rewards give Rs.100 off");
    const inverted = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 500 }, { points: 6000, discount_pkr: 250 }]));
    expect(!inverted.ok && inverted.errors.discount_pkr_1).toContain("bigger discount must cost more points");
  });

  it("rejects an empty table, too many rows and unreadable input", () => {
    expect(parseRedemptionTiersForm(form([])).ok).toBe(false);
    expect(parseRedemptionTiersForm(form(Array.from({ length: 13 }, (_, i) => ({ points: 1000 * (i + 1), discount_pkr: 100 * (i + 1) })))).ok).toBe(false);
    expect(parseRedemptionTiersForm(formOf({ tiers: "{not json" })).ok).toBe(false);
    expect(parseRedemptionTiersForm(formOf({})).ok).toBe(false);
  });

  it("reads stored tiers in either key style and finds the base rate", () => {
    const tiers = readRedemptionTiers([{ points: 6000, discountPkr: 250 }, { points: 3000, discount_pkr: 100 }, { points: 0, discount_pkr: 5 }, null]);
    expect(tiers).toEqual([{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250 }]);
    expect(baseRedemptionRate(tiers)).toEqual({ points: 3000, discount_pkr: 100 });
    expect(pointsValuePkr(842300, baseRedemptionRate(tiers))).toBe(28077);
    expect(baseRedemptionRate([])).toBeNull();
    expect(pointsValuePkr(1000, null)).toBe(0);
    expect(readRedemptionTiers("nope")).toEqual([]);
  });
});

describe("hidden rewards", () => {
  const form = (rows: unknown) => formOf({ tiers: JSON.stringify(rows) });

  it("reads the hidden flag from stored rows, treating anything but true as shown", () => {
    const tiers = readRedemptionTiers([
      { points: 3000, discount_pkr: 100, hidden: true },
      { points: 6000, discount_pkr: 250, hidden: false },
      { points: 11500, discount_pkr: 500 },
      { points: 22000, discount_pkr: 1000, hidden: "true" },
      { points: 50000, discount_pkr: 2500, hidden: "yes" },
      { points: 90000, discount_pkr: 5000, hidden: 1 },
      { points: 99000, discount_pkr: 6000, hidden: null },
    ]);
    expect(tiers.map((t) => t.hidden === true)).toEqual([true, false, false, true, false, false, false]);
    // shown rows carry no flag at all: absent means visible
    expect(tiers[1]).toEqual({ points: 6000, discount_pkr: 250 });
    expect(isHiddenFlag(undefined)).toBe(false);
  });

  it("reads broken jsonb without throwing", () => {
    for (const raw of [null, undefined, "x", 5, {}, [null, 7, "row", [], { points: "abc" }, { hidden: true }]]) {
      expect(readRedemptionTiers(raw)).toEqual([]);
    }
    expect(readRedemptionTiers([{ points: "3000", discountPkr: "100", hidden: true }])).toEqual([{ points: 3000, discount_pkr: 100, hidden: true }]);
  });

  it("saves the flag: hidden rows carry hidden:true, shown rows carry nothing, still sorted by points", () => {
    const res = parseRedemptionTiersForm(form([
      { points: "6000", discount_pkr: "250", hidden: true },
      { points: "3000", discount_pkr: "100", hidden: false },
      { points: "11500", discount_pkr: "500" },
    ]));
    expect(res).toEqual({ ok: true, patch: { redemption_tiers: [
      { points: 3000, discount_pkr: 100 },
      { points: 6000, discount_pkr: 250, hidden: true },
      { points: 11500, discount_pkr: 500 },
    ] } });
  });

  it("applies every rule to hidden rows too, so a hidden reward can always be shown again", () => {
    const dup = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100 }, { points: 3000, discount_pkr: 250, hidden: true }]));
    expect(!dup.ok && dup.errors.points_1).toContain("Two rewards cost 3000 points");
    const inverted = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 500, hidden: true }, { points: 6000, discount_pkr: 250 }]));
    expect(!inverted.ok && inverted.errors.discount_pkr_1).toContain("bigger discount must cost more points");
    const blank = parseRedemptionTiersForm(form([{ points: "", discount_pkr: "100", hidden: true }]));
    expect(!blank.ok && blank.errors.points_0).toBe("Reward 1: points needed is required.");
    const many = Array.from({ length: 13 }, (_, i) => ({ points: 1000 * (i + 1), discount_pkr: 100 * (i + 1), hidden: i > 0 }));
    expect(parseRedemptionTiersForm(form(many)).ok).toBe(false);
  });

  it("rejects a flag that is not true or false instead of guessing", () => {
    for (const hidden of ["true", "false", 1, 0, "yes", {}, []]) {
      const res = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100, hidden }]));
      expect(res.ok, JSON.stringify(hidden)).toBe(false);
      if (!res.ok) expect(res.errors.hidden_0).toContain("shown or hidden");
    }
    expect(parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100, hidden: null }])).ok).toBe(true);
  });

  it("allows every reward to be hidden (reversible), but still refuses an empty table", () => {
    const res = parseRedemptionTiersForm(form([{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250, hidden: true }]));
    expect(res.ok).toBe(true);
    if (res.ok) expect(visibleRedemptionTiers(readRedemptionTiers(res.patch.redemption_tiers))).toEqual([]);
    expect(parseRedemptionTiersForm(form([])).ok).toBe(false);
  });

  it("a hidden reward is never the base rate; with all hidden there is none", () => {
    const tiers = readRedemptionTiers([{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }]);
    expect(visibleRedemptionTiers(tiers)).toEqual([{ points: 6000, discount_pkr: 250 }]);
    expect(baseRedemptionRate(tiers)).toEqual({ points: 6000, discount_pkr: 250 });
    const allHidden = readRedemptionTiers([{ points: 3000, discount_pkr: 100, hidden: true }]);
    expect(baseRedemptionRate(allHidden)).toBeNull();
    expect(pointsValuePkr(9000, baseRedemptionRate(allHidden))).toBe(0);
  });
});

describe("tiers, birthday, expiry", () => {
  it("requires Diamond above Gold and validates the upgrade reward", () => {
    const ok = parseTiersForm(formOf({ tier_gold_threshold_pkr: "50000", tier_diamond_threshold_pkr: "100000", tier_reward_gold_free_shipping: "true", tier_reward_diamond_pkr: "500" }));
    expect(ok).toEqual({ ok: true, patch: { tier_gold_threshold_pkr: 50000, tier_diamond_threshold_pkr: 100000, tier_reward_gold_free_shipping: true, tier_reward_diamond_pkr: 500 } });
    const same = parseTiersForm(formOf({ tier_gold_threshold_pkr: "50000", tier_diamond_threshold_pkr: "50000", tier_reward_diamond_pkr: "500" }));
    expect(!same.ok && same.errors.tier_diamond_threshold_pkr).toContain("higher than the Gold");
    expect(parseTiersForm(formOf({ tier_gold_threshold_pkr: "", tier_diamond_threshold_pkr: "100000", tier_reward_diamond_pkr: "500" })).ok).toBe(false);
    expect(parseTiersForm(formOf({ tier_gold_threshold_pkr: "500", tier_diamond_threshold_pkr: "100000", tier_reward_diamond_pkr: "500" })).ok).toBe(false);
    const unticked = parseTiersForm(formOf({ tier_gold_threshold_pkr: "50000", tier_diamond_threshold_pkr: "100000", tier_reward_diamond_pkr: "0" }));
    expect(unticked.ok && unticked.patch.tier_reward_gold_free_shipping).toBe(false);
  });

  it("validates the three birthday amounts", () => {
    const ok = parseBirthdayRewardsForm(formOf({ birthday_reward_silver_pkr: "250", birthday_reward_gold_pkr: "500", birthday_reward_diamond_pkr: "1000" }));
    expect(ok.ok).toBe(true);
    const bad = parseBirthdayRewardsForm(formOf({ birthday_reward_silver_pkr: "", birthday_reward_gold_pkr: "-1", birthday_reward_diamond_pkr: "100001" }));
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(["birthday_reward_diamond_pkr", "birthday_reward_gold_pkr", "birthday_reward_silver_pkr"]);
  });

  it("validates expiry days", () => {
    expect(parseExpiryForm(formOf({ silver_expiry_days: "365", reward_code_expiry_days: "30" })))
      .toEqual({ ok: true, patch: { silver_expiry_days: 365, reward_code_expiry_days: 30 } });
    expect(parseExpiryForm(formOf({ silver_expiry_days: "0", reward_code_expiry_days: "30" })).ok).toBe(false);
    expect(parseExpiryForm(formOf({ silver_expiry_days: "365", reward_code_expiry_days: "" })).ok).toBe(false);
  });
});
