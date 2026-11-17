import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ getSettings: vi.fn(), campaigns: vi.fn(), rawRow: vi.fn() }));

vi.mock("./settings.server", () => ({ getSettings: h.getSettings }));
vi.mock("../db.server", () => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "order"]) c[m] = vi.fn(() => c);
  c.limit = vi.fn(() => h.campaigns());
  c.maybeSingle = vi.fn(() => h.rawRow()); // the raw app_settings read
  return { db: { from: vi.fn(() => c) } };
});

import { APP_INSTALLATION_QUERY, buildStorefrontConfig, CONFIG_METAFIELD_MUTATION, isHiddenRedemptionTier, syncStorefrontConfig, visibleRedemptionTiers } from "./storefront-config.server";

const SETTINGS = {
  program_enabled: true,
  program_name: " HeyGirl Rewards ",
  tagline: "Earn points. Unlock perks.",
  purchase_points_rate: 1,
  signup_points: 1000,
  referral_points: 6000,
  review_points: 3000,
  social_points: 500,
  social_points_instagram: 1000,
  social_points_facebook: 1000,
  social_points_youtube: null,
  social_url_instagram: "https://instagram.com/heygirl.pk",
  social_url_facebook: "javascript:alert(1)",
  social_url_youtube: "https://www.youtube.com/c/heygirlpk",
  earn_rules: { purchase: { enabled: true }, review: { enabled: false } },
  tier_gold_threshold_pkr: 50000,
  tier_diamond_threshold_pkr: 100000,
  tier_progress_gold_threshold_pkr: 5000,
  tier_progress_diamond_threshold_pkr: 10000,
  redemption_tiers: [
    { points: 6000, discount_pkr: 250 },
    { points: 3000, discount_pkr: 100 },
    { points: 0, discount_pkr: 50 },
  ],
  birthday_reward_silver_pkr: 250,
  birthday_reward_gold_pkr: 500,
  birthday_reward_diamond_pkr: 1000,
  nudge_account_creation_enabled: true,
  nudge_points_spending_enabled: false,
  nudge_reward_usage_enabled: true,
  nudge_tier_progress_enabled: true,
  terms_and_conditions: "No cash value.",
  faqs: [{ question: "When do points expire?", answer: "After a year on Silver." }, { q: "", a: "dropped" }],
  silver_expiry_days: 365,
  reward_code_expiry_days: 30,
  review_release_hours: 72,
  referral_friend_free_shipping: true,
  tier_reward_gold_free_shipping: true,
  tier_reward_diamond_pkr: 500,
  // must never be published
  whatsapp_api_key: "secret-key",
  wa_referral_template: "tpl",
};
const CAMPAIGN = { name: "11.11", multiplier: 2, starts_at: "2026-11-10T00:00:00Z", ends_at: "2026-11-20T00:00:00Z" };

describe("buildStorefrontConfig", () => {
  it("produces the contract shape from settings", () => {
    const c = buildStorefrontConfig(SETTINGS, CAMPAIGN);
    expect(c).toMatchObject({
      enabled: true,
      programName: "HeyGirl Rewards",
      pointsRate: 1,
      signupPoints: 1000,
      referralPoints: 6000,
      reviewPoints: 3000,
      tiers: { gold: 50000, diamond: 100000 },
      birthday: { silver: 250, gold: 500, diamond: 1000 },
      nudges: { accountCreation: true, pointsSpending: false, rewardUsage: true, tierProgress: true, goldWithin: 5000, diamondWithin: 10000 },
      campaign: { name: "11.11", multiplier: 2, startsAt: CAMPAIGN.starts_at, endsAt: CAMPAIGN.ends_at },
      terms: "No cash value.",
      faqs: [{ q: "When do points expire?", a: "After a year on Silver." }],
    });
    expect(Object.keys(c).sort()).toEqual(
      ["campaign", "nextCampaign", "birthday", "codeExpiryDays", "earnRules", "enabled", "expiryDays", "faqs", "friendFreeShipping", "nudges", "pointsRate", "programName", "redemptionTiers", "referralPoints", "reviewPoints", "reviewReleaseHours", "signupPoints", "social", "tagline", "terms", "tierRewards", "tiers"].sort(),
    );
  });

  it("sorts and cleans the redemption table", () => {
    expect(buildStorefrontConfig(SETTINGS, null).redemptionTiers).toEqual([
      { points: 3000, discountPkr: 100 },
      { points: 6000, discountPkr: 250 },
    ]);
  });

  it("hidden rewards are left out of the public config (absent flag = visible)", () => {
    const tiers = [
      { points: 3000, discount_pkr: 100 },
      { points: 6000, discount_pkr: 250, hidden: true },
      { points: 9000, discount_pkr: 400, hidden: false },
      { points: 12000, discount_pkr: 600, hidden: "true" },
      null,
      "junk",
    ];
    const c = buildStorefrontConfig({ ...SETTINGS, redemption_tiers: tiers }, null);
    expect(c.redemptionTiers).toEqual([
      { points: 3000, discountPkr: 100 },
      { points: 9000, discountPkr: 400 },
    ]);
    expect(JSON.stringify(c)).not.toContain("hidden");
    expect(visibleRedemptionTiers(tiers)).toEqual(c.redemptionTiers);
    expect(visibleRedemptionTiers(null)).toEqual([]);
    expect(buildStorefrontConfig({ ...SETTINGS, redemption_tiers: [{ points: 3000, discount_pkr: 100, hidden: true }] }, null).redemptionTiers).toEqual([]);
  });

  it("isHiddenRedemptionTier: only an existing, hidden-only reward counts", () => {
    const tiers = [{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }, { points: 9000, discountPkr: 1, hidden: true }, { points: 9000, discountPkr: 400 }];
    expect(isHiddenRedemptionTier(tiers, 3000)).toBe(true);
    expect(isHiddenRedemptionTier(tiers, 6000)).toBe(false);
    expect(isHiddenRedemptionTier(tiers, 9000)).toBe(false); // a visible one with the same points exists
    expect(isHiddenRedemptionTier(tiers, 1234)).toBe(false); // unknown: the service answers
    expect(isHiddenRedemptionTier(undefined, 3000)).toBe(false);
  });

  it("fills every earn rule, defaulting missing ones to enabled", () => {
    const c = buildStorefrontConfig(SETTINGS, null);
    expect(c.earnRules.review).toEqual({ enabled: false });
    expect(c.earnRules.birthday).toEqual({ enabled: true });
    expect(Object.keys(c.earnRules)).toHaveLength(8);
  });

  it("publishes only http(s) social links and disables a platform without one", () => {
    const c = buildStorefrontConfig(SETTINGS, null);
    expect(c.social.instagram).toEqual({ points: 1000, url: "https://instagram.com/heygirl.pk", enabled: true });
    expect(c.social.facebook).toEqual({ points: 1000, url: "", enabled: false });
    expect(c.social.youtube.points).toBe(500); // falls back to the shared value
  });

  it("never leaks private settings", () => {
    const text = JSON.stringify(buildStorefrontConfig(SETTINGS, CAMPAIGN));
    expect(text).not.toContain("secret-key");
    expect(text).not.toContain("whatsapp");
    expect(text).not.toContain("tpl");
  });

  it("has no campaign when there is none or it changes nothing", () => {
    expect(buildStorefrontConfig(SETTINGS, null).campaign).toBeNull();
    expect(buildStorefrontConfig(SETTINGS, { ...CAMPAIGN, multiplier: 1 }).campaign).toBeNull();
  });
});

describe("syncStorefrontConfig", () => {
  const reply = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } });

  beforeEach(() => {
    vi.clearAllMocks();
    h.getSettings.mockResolvedValue(SETTINGS);
    h.campaigns.mockResolvedValue({ data: [CAMPAIGN], error: null });
    h.rawRow.mockResolvedValue({ data: { redemption_tiers: SETTINGS.redemption_tiers }, error: null });
  });

  const published = async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(reply({ currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } }))
      .mockResolvedValueOnce(reply({ metafieldsSet: { metafields: [{ id: "x" }], userErrors: [] } }));
    expect(await syncStorefrontConfig({ graphql })).toEqual({ ok: true });
    return JSON.parse(graphql.mock.calls[1][1].variables.metafields[0].value) as { redemptionTiers: unknown[] };
  };

  it("a reward hidden in the stored jsonb is not published, even when the typed settings do not carry the flag", async () => {
    // getSettings() answers without `hidden` (as the typed reader does today); the stored row has it.
    h.rawRow.mockResolvedValue({ data: { redemption_tiers: [{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250, hidden: true }] }, error: null });
    expect((await published()).redemptionTiers).toEqual([{ points: 3000, discountPkr: 100 }]);
  });

  it("a hidden flag carried by the typed settings is honoured too, and a failed raw read changes nothing", async () => {
    h.getSettings.mockResolvedValue({ ...SETTINGS, redemption_tiers: [{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }] });
    h.rawRow.mockResolvedValue({ data: null, error: { message: "down" } });
    expect((await published()).redemptionTiers).toEqual([{ points: 6000, discountPkr: 250 }]);
    h.rawRow.mockRejectedValue(new Error("boom"));
    expect((await published()).redemptionTiers).toEqual([{ points: 6000, discountPkr: 250 }]);
  });

  it("writes one json app-data metafield owned by the app installation", async () => {
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(reply({ currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } }))
      .mockResolvedValueOnce(reply({ metafieldsSet: { metafields: [{ id: "x" }], userErrors: [] } }));
    expect(await syncStorefrontConfig({ graphql })).toEqual({ ok: true });
    expect(graphql).toHaveBeenNthCalledWith(1, APP_INSTALLATION_QUERY, undefined);
    const [query, options] = graphql.mock.calls[1];
    expect(query).toBe(CONFIG_METAFIELD_MUTATION);
    const mf = options.variables.metafields;
    expect(mf).toHaveLength(1);
    expect(mf[0]).toMatchObject({ ownerId: "gid://shopify/AppInstallation/1", namespace: "hg_loyalty", key: "config", type: "json" });
    const value = JSON.parse(mf[0].value);
    expect(value.enabled).toBe(true);
    expect(value.campaign.multiplier).toBe(2);
  });

  it("reports user errors, GraphQL errors and thrown errors without throwing", async () => {
    const inst = () => reply({ currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } });
    const g1 = vi.fn().mockResolvedValueOnce(inst()).mockResolvedValueOnce(reply({ metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "Value is invalid JSON" }] } }));
    expect(await syncStorefrontConfig({ graphql: g1 })).toEqual({ ok: false, reason: "Value is invalid JSON" });
    const g2 = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: "Throttled" }] })));
    expect(await syncStorefrontConfig({ graphql: g2 })).toEqual({ ok: false, reason: "Throttled" });
    const g3 = vi.fn().mockRejectedValueOnce(new Error("network down"));
    expect(await syncStorefrontConfig({ graphql: g3 })).toEqual({ ok: false, reason: "network down" });
    const g4 = vi.fn().mockResolvedValueOnce(reply({ currentAppInstallation: null }));
    expect(await syncStorefrontConfig({ graphql: g4 })).toEqual({ ok: false, reason: "no_app_installation" });
  });

  it("fails cleanly when the campaign lookup errors", async () => {
    h.campaigns.mockResolvedValueOnce({ data: null, error: { message: "db down" } });
    const graphql = vi.fn();
    expect(await syncStorefrontConfig({ graphql })).toEqual({ ok: false, reason: "campaign_lookup_failed: db down" });
    expect(graphql).not.toHaveBeenCalled();
  });
});

describe("review fix item 11: current and next campaign are both published", () => {
  const NEXT = { name: "Black Friday", multiplier: 3, starts_at: "2026-11-20T00:00:01Z", ends_at: "2026-11-30T00:00:00Z" };

  it("keeps the contract's `campaign` and adds `nextCampaign`", () => {
    const c = buildStorefrontConfig(SETTINGS, CAMPAIGN, NEXT);
    expect(c.campaign).toEqual({ name: "11.11", multiplier: 2, startsAt: CAMPAIGN.starts_at, endsAt: CAMPAIGN.ends_at });
    expect(c.nextCampaign).toEqual({ name: "Black Friday", multiplier: 3, startsAt: NEXT.starts_at, endsAt: NEXT.ends_at });
    expect(buildStorefrontConfig(SETTINGS, CAMPAIGN).nextCampaign).toBeNull();
  });

  it("skips campaigns that change nothing or have unreadable dates", () => {
    const c = buildStorefrontConfig(SETTINGS, { ...CAMPAIGN, multiplier: 1 }, NEXT);
    expect(c.campaign!.name).toBe("Black Friday"); // promoted
    expect(c.nextCampaign).toBeNull();
    expect(buildStorefrontConfig(SETTINGS, { ...CAMPAIGN, ends_at: "soon" }, null).campaign).toBeNull();
  });

  it("sync asks for two campaigns and writes both", async () => {
    h.getSettings.mockResolvedValue(SETTINGS);
    h.campaigns.mockResolvedValue({ data: [CAMPAIGN, NEXT], error: null });
    const reply = (data: unknown) => new Response(JSON.stringify({ data }));
    const graphql = vi
      .fn()
      .mockResolvedValueOnce(reply({ currentAppInstallation: { id: "gid://shopify/AppInstallation/1" } }))
      .mockResolvedValueOnce(reply({ metafieldsSet: { metafields: [], userErrors: [] } }));
    expect(await syncStorefrontConfig({ graphql })).toEqual({ ok: true });
    const value = JSON.parse(graphql.mock.calls[1][1].variables.metafields[0].value);
    expect(value.campaign.name).toBe("11.11");
    expect(value.nextCampaign.name).toBe("Black Friday");
  });
});
