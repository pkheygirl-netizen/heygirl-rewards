// Renders every admin page on the server with data produced by its own loader
// (database faked), once with rows and once empty. Catches a page that throws
// while rendering, and checks that empty states say what to do next.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import type { ReactElement } from "react";
import { fakeDb } from "./admin-test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";
const SHOP = "heygirl-pk.myshopify.com";
let loaderData: unknown = null;
let fetcherData: unknown = undefined;

function mockAll(script: Parameters<typeof fakeDb>[0]) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("../shopify.server", () => ({
    authenticate: { admin: async () => ({ admin: { graphql: vi.fn() }, session: { shop: SHOP } }) },
  }));
  vi.doMock("./points.service", () => ({ setOptOut: vi.fn(), setBirthday: vi.fn() }));
  vi.doMock("./redemption.service", () => ({ cancelRewardCode: vi.fn() }));
  vi.doMock("./influencer.service", () => ({
    setInfluencer: vi.fn(), createInfluencerCode: vi.fn(), removeInfluencerCode: vi.fn(),
    effectiveReferralPoints: (m: { influencer_multiplier: number | null }, s: number) => (m.influencer_multiplier ? Math.round(s * m.influencer_multiplier) : s),
  }));
  vi.doMock("./referrals.service", () => ({ approveReferral: vi.fn(), rejectReferral: vi.fn() }));
  vi.doMock("./review-claims.service", () => ({ rejectReviewClaim: vi.fn() }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache: vi.fn() }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig: vi.fn() }));
  vi.doMock("./heartbeat.server", () => ({
    readHeartbeats: async () => [{ key: "worker", at: new Date().toISOString(), detail: { failed: { points: 0 } } }],
  }));
  vi.doMock("./queue.server", () => ({}));
  vi.doMock("./csv-download.client", () => ({ downloadCsv: vi.fn() }));
  vi.doMock("@shopify/polaris-viz", () => ({ LineChart: () => null }));
  vi.doMock("@shopify/polaris-viz/build/esm/styles.css", () => ({}));
  // The pieces of Remix a page touches, without a running router.
  vi.doMock("@remix-run/react", () => {
    const fetcher = () => ({
      state: "idle", data: fetcherData, submit: vi.fn(), load: vi.fn(),
      Form: (p: Record<string, unknown>) => <form {...(p as object)} />,
    });
    return {
      useLoaderData: () => loaderData,
      useActionData: () => undefined,
      useFetcher: fetcher,
      useSearchParams: () => [new URLSearchParams(), vi.fn()],
      useNavigate: () => vi.fn(),
      useNavigation: () => ({ state: "idle" }),
      useLocation: () => ({ pathname: "/app" }),
      useSubmit: () => vi.fn(),
      useRouteError: () => null,
      Form: (p: Record<string, unknown>) => <form {...(p as object)} />,
      Link: (p: { to: string; children?: unknown }) => <a href={p.to}>{p.children as never}</a>,
      Outlet: () => null,
    };
  });
}

type RouteModule = {
  loader: (a: { request: Request; params: Record<string, string>; context: Record<string, never> }) => Promise<Response>;
  default: () => ReactElement | null;
};

async function renderRoute(file: string, url: string, params: Record<string, string> = {}): Promise<string> {
  const mod = (await import(/* @vite-ignore */ `../routes/${file}`)) as RouteModule;
  const res = await mod.loader({ request: new Request(`https://app.test${url}`), params, context: {} });
  expect(res.status).toBe(200);
  loaderData = await res.json();
  const Page = mod.default;
  return renderToString(<AppProvider i18n={en}><Page /></AppProvider>);
}

const SETTINGS = {
  id: 1, program_enabled: true, program_name: "HeyGirl.pk Rewards", tagline: "Shop. Earn. Glow.", updated_at: "2026-11-16T00:00:00Z",
  purchase_points_rate: "1.00", signup_points: 1000, referral_points: 6000, review_points: 3000, review_release_hours: 72,
  social_points_instagram: 1000, social_points_facebook: 1000, social_points_youtube: 1000,
  social_url_instagram: "https://instagram.com/heygirl.pk", social_url_facebook: null, social_url_youtube: null,
  earn_rules: { review: { enabled: false } }, referral_friend_free_shipping: true,
  redemption_tiers: [{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250 }],
  tier_gold_threshold_pkr: "50000.00", tier_diamond_threshold_pkr: "100000.00", tier_reward_gold_free_shipping: true, tier_reward_diamond_pkr: 500,
  birthday_reward_silver_pkr: 250, birthday_reward_gold_pkr: 500, birthday_reward_diamond_pkr: 1000,
  silver_expiry_days: 365, reward_code_expiry_days: 30, whatsapp_enabled: false, whatsapp_api_key: "never-shown",
  terms_and_conditions: "Terms text", faqs: [{ q: "When do I get points?", a: "When your order is delivered and paid." }],
  nudge_account_creation_enabled: true, nudge_points_spending_enabled: true, nudge_reward_usage_enabled: false, nudge_tier_progress_enabled: true,
  tier_progress_gold_threshold_pkr: "5000.00", tier_progress_diamond_threshold_pkr: "10000.00",
};

const MEMBER = {
  id: ID, shopify_customer_id: "778899", first_name: "Sana", last_name: "Ahmed", email: "sana@example.com", phone: "03001234567",
  tier: "gold", points_balance: 18450, lifetime_spend_pkr: "71200.00", enrolled_at: "2025-03-14T00:00:00Z", consent_source: "order",
  is_blocked: false, opted_out: false, referrals_blocked: false, imported_from_smile: false, birthday_month: 8, birthday_day: 12,
  birthday_set_at: null, referral_slug: "sana", is_influencer: true, influencer_paused: false, influencer_multiplier: "2.00",
  influencer_referral_rate: null, influencer_campaign: "Winter Glow", influencer_rate_starts_at: null, influencer_rate_ends_at: null,
  influencer_code: "SANA10", influencer_code_percent: 10,
};

const full: Parameters<typeof fakeDb>[0] = {
  rpc: (name) => {
    switch (name) {
      case "admin_period_stats":
        return { data: { members_total: 1912, members_new: 96, points_earned: 842300, points_redeemed: 117922, points_expired: 500, points_reversed: 1800, points_pending: 118000, redemptions: 31, reward_orders: 12, reward_sales_pkr: 386000, reward_cost_pkr: 21500 } };
      case "admin_points_series":
        return { data: [{ day: "2026-11-15", earned: 100, redeemed: 10, expired: 0 }, { day: "2026-11-16", earned: 50, redeemed: 30, expired: 5 }] };
      case "admin_tier_counts":
        return { data: { silver: 1869, gold: 34, diamond: 9, near_gold: 12, near_diamond: 1, near_gold_within_pkr: 5000, near_diamond_within_pkr: 10000 } };
      case "admin_attention":
        return { data: { referrals_flagged: 3, review_claims_pending: 2, expiring_members: 41, expiring_points: 90000, gdpr_open: 1 } };
      case "admin_activity":
        return { data: [
          { id: "l1", at: "2026-11-16T05:00:00Z", kind: "points", action: "purchase", points: 4250, member_id: ID, member_name: "Sana Ahmed", order_id: "5", order_name: "#1042" },
          { id: "l2", at: "2026-11-15T05:00:00Z", kind: "points", action: "adjustment", points: -500, member_id: ID, member_name: "Sana Ahmed", reason_note: "INTERNAL-REASON", customer_note: "Correction" },
          { id: "tier:1", at: "2026-06-28T05:00:00Z", kind: "tier", action: "gold", points: 0, member_id: ID, member_name: "Sana Ahmed", reason_note: "silver" },
          { id: "pending:9", at: "2026-11-16T06:00:00Z", kind: "pending", action: "purchase", points: 900, member_id: ID, member_name: "Sana Ahmed", order_id: "9", order_name: "#1050" },
        ] };
      case "admin_search_members":
        return { data: [{ id: ID, name: "Sana Ahmed", email: "sana@example.com", phone: "03001234567", tier: "gold", points_balance: 18450, lifetime_spend_pkr: 71200, is_blocked: false, opted_out: false, is_influencer: true, enrolled_at: "2025-03-14T00:00:00Z", total_count: 1 }] };
      case "admin_member_summary":
        return { data: { pending_points: 900, referrals_completed: 2, referrals_pending: 1, referrals_held: 1, next_expiry: null } };
      case "admin_referral_funnel":
        return { data: { recorded: 148, with_order: 70, completed: 61, pending: 80, flagged: 3, blocked: 2, rejected: 2, points_paid: 534000 } };
      case "admin_influencer_stats":
        return { data: [{ member_id: ID, friends: 54, completed: 27, pending: 20, held: 1, orders: 30, sales_pkr: 181000, code_orders: 3, points_paid: 270000 }] };
      case "admin_campaign_results":
        return { data: [{ campaign_id: ID, orders: 12, sales_pkr: 48000, points_issued: 90000, points_pending: 6000 }] };
      case "admin_outstanding_points":
        return { data: { points: 600000, members: 420 } };
      case "admin_top_members":
        return { data: [{ member_id: ID, name: "Sana Ahmed", email: "sana@example.com", points: 12000 }] };
      case "admin_expiring_members":
        return { data: [{ member_id: ID, name: "Sana Ahmed", email: "sana@example.com", phone: null, points: 1500, first_expiry: "2026-12-01T00:00:00Z", total_count: 1 }] };
      default:
        return { data: null };
    }
  },
  from: (table, chain) => {
    const single = chain.some(([m]) => m === "maybeSingle");
    switch (table) {
      case "app_settings": return { data: SETTINGS };
      case "members": return single ? { data: MEMBER } : { data: [MEMBER] };
      case "loyalty_codes":
        return { data: [
          { id: "c1", code: "REWARD-AAAA", kind: "reward", status: "active", discount_amount_pkr: 500, points_spent: 11500, expires_at: "2026-12-02T00:00:00Z", used_at: null, created_at: "2026-11-02T00:00:00Z", shopify_order_id: null },
          { id: "c2", code: "BDAY-BBBB", kind: "birthday", status: "used", discount_amount_pkr: 500, points_spent: 0, expires_at: "2026-09-01T00:00:00Z", used_at: "2026-08-09T00:00:00Z", created_at: "2026-08-01T00:00:00Z", shopify_order_id: "7" },
        ] };
      case "staff_notes": return { data: [{ id: "n1", note: "Called about a late parcel", author: "Ayesha", created_at: "2026-11-01T00:00:00Z" }] };
      case "referrals":
        return { count: 2, data: [
          { id: "r1", referrer_member_id: ID, referred_email: "friend@example.com", referred_shopify_customer_id: "C1", status: "flagged", block_reason: null, fraud_flags: ["same_network"], reward_points: null, created_at: "2026-11-10T00:00:00Z", completed_at: null, reviewed_note: null, members: MEMBER },
          { id: "r2", referrer_member_id: ID, referred_email: null, referred_shopify_customer_id: "C2", status: "completed", block_reason: null, fraud_flags: [], reward_points: 12000, created_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-05T00:00:00Z", reviewed_note: null, members: MEMBER },
        ] };
      case "review_claims":
        return { count: 1, data: [{ id: "k1", member_id: ID, shopify_order_id: "5", points: 3000, claimed_at: "2026-11-15T00:00:00Z", release_at: "2099-01-01T00:00:00Z", members: MEMBER }] };
      case "bonus_campaigns":
        return { data: [{ id: ID, name: "Eid Edit", multiplier: "2.0", starts_at: "2026-11-01T00:00:00Z", ends_at: "2099-01-01T00:00:00Z", is_active: true }] };
      case "gdpr_requests":
        return { count: 1, data: [{ id: "g1", type: "data_request", shopify_customer_id: "778899", status: "open", created_at: "2026-11-10T00:00:00Z" }] };
      default: return { data: [], count: 0 };
    }
  },
};

const empty: Parameters<typeof fakeDb>[0] = {
  rpc: (name) => (name === "admin_points_series" || name.startsWith("admin_search") || name === "admin_activity" || name.endsWith("_stats") && name !== "admin_period_stats" || name === "admin_top_members" || name === "admin_campaign_results" || name === "admin_expiring_members"
    ? { data: [] } : { data: {} }),
  from: (table, chain) => (table === "app_settings"
    ? { data: { ...SETTINGS, redemption_tiers: [], faqs: [] } }
    : chain.some(([m]) => m === "maybeSingle") ? { data: null } : { data: [], count: 0 }),
};

beforeEach(() => {
  loaderData = null;
  fetcherData = undefined;
});

describe("pages render with data", () => {
  beforeEach(() => mockAll(full));

  it("Home", async () => {
    const html = await renderRoute("app._index.tsx", "/app?view=claims");
    for (const text of ["Needs your attention", "3 referrals held for review", "2 review claims waiting", "41 members have points expiring", "1,912", "842,300", "14%", "Rs.386,000", "Reward cost Rs.21,500", "Members by tier", "Order #1042 delivered and paid", "Program live", "Reject"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain(`href="/app/customers/${ID}"`);
    expect(html).toContain('href="/app/referrals?status=flagged"');
  });

  it("Customers list", async () => {
    const html = await renderRoute("app.customers._index.tsx", "/app/customers?q=sana");
    expect(html).toContain("Sana Ahmed");
    expect(html).toContain("03001234567");
    expect(html).toContain("Influencer");
  });

  it("Customer profile", async () => {
    const html = await renderRoute("app.customers.$id.tsx", `/app/customers/${ID}`, { id: ID });
    for (const text of ["18,450", "Available", "Pending, released when", "Adjust balance", "Rs.28,800 more to reach Diamond", "12 August", "Cancel and return points", "REWARD-AAAA", "Staff notes", "Called about a late parcel", "?ref=sana", "Moved to Gold", "Pending 900", "held for review"]) {
      expect(html, text).toContain(text);
    }
    // only the reward code that is still active can be cancelled
    expect(html.match(/Cancel and return points/g)).toHaveLength(1);
    // admin sees the internal reason, clearly labelled
    expect(html).toContain("Reason: INTERNAL-REASON");
  });

  it("Program", async () => {
    const html = await renderRoute("app.program.tsx", "/app/program");
    for (const text of ["Ways to earn", "Place an order", "1 point per Rs.1", "Post a review", "Ways to redeem", "Add reward", "No profile link yet"]) {
      expect(html, text).toContain(text);
    }
  });

  it("Referrals", async () => {
    const html = await renderRoute("app.referrals.tsx", "/app/referrals");
    expect(html).toContain("Friend signed in from the same network address as the referrer");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).not.toMatch(/IP match/i);
  });

  it("Influencers list and detail", async () => {
    const list = await renderRoute("app.influencers._index.tsx", "/app/influencers");
    for (const text of ["Winter Glow", "12,000", "SANA10 (10% off)", "Rs.181,000", "270,000", "Add influencer"]) expect(list, text).toContain(text);
    const detail = await renderRoute("app.influencers.$id.tsx", `/app/influencers/${ID}`, { id: ID });
    for (const text of ["Points per referral", "1.5× (9,000 points)", "3× (18,000 points)", "Custom", "Rate starts, optional", "Remove code", "Her referrals", "Held for review", "Pause"]) {
      expect(detail, text).toContain(text);
    }
  });

  it("Campaigns", async () => {
    const html = await renderRoute("app.campaigns._index.tsx", "/app/campaigns");
    for (const text of ["Eid Edit", "Live", "Rs.48,000", "90,000", "6,000 pending", "Create campaign"]) expect(html, text).toContain(text);
    // a campaign with orders offers no Delete
    expect(html).not.toContain(">Delete<");
  });

  it("Analytics", async () => {
    const html = await renderRoute("app.analytics._index.tsx", "/app/analytics?period=90d");
    for (const text of ["Redemption rate", "Outstanding points", "600,000", "Value at the base redemption rate", "Rs.20,000", "3,000 points for Rs.100 off", "Top earners", "Referral funnel", "Influencers compared"]) {
      expect(html, text).toContain(text);
    }
  });

  it("On-site, with deep links built from the app's own theme blocks", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "client123");
    const html = await renderRoute("app.onsite.tsx", "/app/onsite");
    vi.unstubAllEnvs();
    for (const text of ["Show the program in your theme", "Press Save in the theme editor", "Program name", "Questions and answers", "When do I get points?", "Terms and conditions"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain("context=apps&amp;activateAppId=client123/embed");
    expect(html).toContain("template=product&amp;addAppBlockId=client123/product-points&amp;target=newAppsSection");
    expect(html).not.toMatch(/brand colou?r|Shopify Email|Post-purchase/i);
  });

  it("Settings, without any secret", async () => {
    const html = await renderRoute("app.settings.tsx", "/app/settings");
    for (const text of ["Program", "Notifications", "Not configured", "Data export", "System health", "Healthy", "Privacy requests", "Mark as answered"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain("never-shown");
  });
});

describe("pages render when there is nothing yet", () => {
  beforeEach(() => mockAll(empty));

  it.each([
    ["app._index.tsx", "/app", "Nothing is waiting for you"],
    ["app.customers._index.tsx", "/app/customers", "Import from Smile"],
    ["app.customers._index.tsx", "/app/customers?q=zzz", "Clear search and filters"],
    ["app.referrals.tsx", "/app/referrals", "Nothing is held for review"],
    ["app.influencers._index.tsx", "/app/influencers", "No influencers yet"],
    ["app.campaigns._index.tsx", "/app/campaigns", "No campaigns yet"],
    ["app.analytics._index.tsx", "/app/analytics", "No points moved in this period"],
    ["app.program.tsx", "/app/program", "Press Add reward to create the first one"],
    ["app.onsite.tsx", "/app/onsite", "No questions yet"],
    ["app.settings.tsx", "/app/settings", "No requests have been received"],
  ])("%s %s", async (file, url, text) => {
    expect(await renderRoute(file, url)).toContain(text);
  });

  it("an unknown customer or influencer is a 404", async () => {
    const profile = (await import("../routes/app.customers.$id")) as unknown as RouteModule;
    await expect(profile.loader({ request: new Request(`https://app.test/app/customers/${ID}`), params: { id: ID }, context: {} }))
      .rejects.toMatchObject({ status: 404 });
    const inf = (await import("../routes/app.influencers.$id")) as unknown as RouteModule;
    await expect(inf.loader({ request: new Request(`https://app.test/app/influencers/${ID}`), params: { id: ID }, context: {} }))
      .rejects.toMatchObject({ status: 404 });
  });
});
