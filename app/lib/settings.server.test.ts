import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());

import { h, resetHarness } from "./testing/harness";
import {
  bustSettingsCache,
  DEFAULT_REDEMPTION_TIERS,
  getSettings,
  isEarnRuleEnabled,
  isRedeemPaused,
  karachiMonthStart,
  karachiParts,
  normaliseSettings,
  parseEarnRules,
  parseRedemptionTiers,
  tierThresholds,
} from "./settings.server";

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  vi.useRealTimers();
});

describe("getSettings", () => {
  it("returns the typed row with JSON columns parsed and numerics as numbers", async () => {
    resetHarness({
      app_settings: [{
        id: 1,
        tier_gold_threshold_pkr: "60000.00", // numeric can arrive as text
        signup_points: 1500,
        redemption_tiers: [{ points: 6000, discount_pkr: 250 }, { points: 3000, discount_pkr: 100 }],
        earn_rules: { review: { enabled: false } },
      }],
    });
    const s = await getSettings();
    expect(s.tier_gold_threshold_pkr).toBe(60000);
    expect(s.signup_points).toBe(1500);
    expect(s.redemption_tiers).toEqual([{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250 }]);
    expect(s.earn_rules.review.enabled).toBe(false);
    expect(s.earn_rules.purchase.enabled).toBe(true);
    expect(tierThresholds(s)).toEqual({ gold: 60000, diamond: 100000 });
  });

  it("caches for 30 seconds and re-reads after bustSettingsCache()", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T10:00:00Z"));
    expect((await getSettings()).signup_points).toBe(1000);
    h.db.table("app_settings")[0].signup_points = 2000;
    expect((await getSettings()).signup_points).toBe(1000); // cached
    vi.setSystemTime(new Date("2026-11-16T10:00:29Z"));
    expect((await getSettings()).signup_points).toBe(1000); // still inside 30 s
    vi.setSystemTime(new Date("2026-11-16T10:00:31Z"));
    expect((await getSettings()).signup_points).toBe(2000); // expired
    h.db.table("app_settings")[0].signup_points = 3000;
    bustSettingsCache();
    expect((await getSettings()).signup_points).toBe(3000);
  });

  it("serves the last good copy when the database read fails, and defaults when there is none", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.db.failNext("app_settings", "select", { code: "XX000", message: "down" });
    const fallback = await getSettings();
    expect(fallback.signup_points).toBe(1000);
    expect(fallback.redemption_tiers).toEqual(DEFAULT_REDEMPTION_TIERS);
    errorSpy.mockRestore();
  });
});

describe("parsers", () => {
  it("parseRedemptionTiers treats true and the text \"true\" as hidden, like the admin and storefront (review L1)", () => {
    expect(
      parseRedemptionTiers([
        { points: 6000, discount_pkr: 250, hidden: true },
        { points: 3000, discount_pkr: 100, hidden: false },
        { points: 9000, discount_pkr: 400, hidden: "true" },
        { points: 12000, discount_pkr: 500 },
      ]),
    ).toEqual([
      { points: 3000, discount_pkr: 100 },
      { points: 6000, discount_pkr: 250, hidden: true },
      { points: 9000, discount_pkr: 400, hidden: true },
      { points: 12000, discount_pkr: 500 },
    ]);
    // every reward hidden is a legal state: it must not fall back to the defaults
    expect(parseRedemptionTiers([{ points: 6000, discount_pkr: 250, hidden: true }])).toEqual([{ points: 6000, discount_pkr: 250, hidden: true }]);
  });

  it("parseRedemptionTiers drops bad rows, duplicates and falls back to defaults", () => {
    expect(parseRedemptionTiers(null)).toEqual(DEFAULT_REDEMPTION_TIERS);
    expect(parseRedemptionTiers([{ points: -1, discount_pkr: 5 }, "x"])).toEqual(DEFAULT_REDEMPTION_TIERS);
    expect(
      parseRedemptionTiers([{ points: 500, discount_pkr: 50 }, { points: 500, discount_pkr: 99 }, { points: 100, discountPkr: 10 }]),
    ).toEqual([{ points: 100, discount_pkr: 10 }, { points: 500, discount_pkr: 50 }]);
  });

  it("parseEarnRules: a rule is on unless explicitly switched off", () => {
    const rules = parseEarnRules({ purchase: { enabled: false }, signup: {}, nonsense: { enabled: false } });
    expect(rules.purchase.enabled).toBe(false);
    expect(rules.signup.enabled).toBe(true);
    expect(rules.birthday.enabled).toBe(true);
    expect(Object.keys(rules)).toHaveLength(8);
  });

  it("owner defaults (17 Nov 2026): social follows 500 each, review 3,000, and 50,000 points -> Rs. 2,500 in the reward table", () => {
    const d = normaliseSettings(null);
    expect([d.social_points, d.social_points_instagram, d.social_points_facebook, d.social_points_youtube]).toEqual([500, 500, 500, 500]);
    expect(d.review_points).toBe(3000);
    expect(d.redemption_tiers.map((t) => [t.points, t.discount_pkr])).toEqual([
      [3000, 100], [6000, 250], [11500, 500], [22000, 1000], [50000, 2500], [100000, 5000], [180000, 10000],
    ]);
    // A saved row keeps its own values.
    expect(normaliseSettings({ social_points_instagram: 1000 }).social_points_instagram).toBe(1000);
  });

  it("rule 20: isEarnRuleEnabled reads only the rule's own switch; the program switch only pauses redeeming", () => {
    const on = normaliseSettings({ earn_rules: { review: { enabled: false } } });
    expect(isEarnRuleEnabled(on, "purchase")).toBe(true);
    expect(isEarnRuleEnabled(on, "review")).toBe(false);
    const off = normaliseSettings({ program_enabled: false, earn_rules: { review: { enabled: false } } });
    for (const rule of ["purchase", "signup", "referral", "instagram", "facebook", "youtube", "birthday"] as const) {
      expect(isEarnRuleEnabled(off, rule), rule).toBe(true);
    }
    expect(isEarnRuleEnabled(off, "review")).toBe(false);
    expect(isRedeemPaused(off)).toBe(true);
    expect(isRedeemPaused(on)).toBe(false);
    expect(isRedeemPaused(normaliseSettings(null))).toBe(false);
  });
});

describe("Asia/Karachi helpers", () => {
  it("karachiParts uses Pakistan time, not UTC", () => {
    // 31 Oct 20:30 UTC is already 1 Nov 01:30 in Karachi
    expect(karachiParts(new Date("2026-10-31T20:30:00Z"))).toEqual({ year: 2026, month: 11, day: 1 });
    expect(karachiParts(new Date("2026-10-31T18:59:00Z"))).toEqual({ year: 2026, month: 10, day: 31 });
  });
  it("karachiMonthStart is midnight PKT", () => {
    expect(karachiMonthStart(2026, 11).toISOString()).toBe("2026-10-31T19:00:00.000Z");
  });
});
