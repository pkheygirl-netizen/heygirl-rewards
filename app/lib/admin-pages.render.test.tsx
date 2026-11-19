// Renders every admin page on the server with data produced by its own loader
// (database faked), once with rows and once empty. Catches a page that throws
// while rendering, and checks that empty states say what to do next.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import en from "@shopify/polaris/locales/en.json";
import type { ReactElement } from "react";
import { fakeDb } from "./admin-test-helpers";
import { PROGRAM_OFF_EFFECTS, SUGGESTED_FAQS } from "../components/admin-constants";

/** React escapes text the way renderToString prints it. */
const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const ID = "11111111-1111-4111-8111-111111111111";
const REF_ALERT = "22222222-2222-4222-8222-222222222222";
const SHOP = "heygirl-pk.myshopify.com";
let loaderData: unknown = null;
let fetcherData: unknown = undefined;
let routeError: unknown = null;
let layoutData: unknown = undefined;

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
  vi.doMock("./referrals.service", () => ({
    approveReferral: vi.fn(), rejectReferral: vi.fn(),
  }));
  vi.doMock("./review-claims.service", () => ({ rejectReviewClaim: vi.fn(), approveReviewClaim: vi.fn() }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache: vi.fn() }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig: vi.fn() }));
  vi.doMock("./heartbeat.server", () => ({
    readHeartbeats: async () => [{ key: "worker", at: new Date().toISOString(), detail: { failed: { points: 0 } } }],
  }));
  vi.doMock("./queue.server", () => ({}));
  vi.doMock("./smile-import-queue.server", () => ({}));
  vi.doMock("./csv-download.client", () => ({ downloadCsv: vi.fn() }));
  vi.doMock("@shopify/polaris-viz", () => ({ LineChart: () => null }));
  // Shopify's provider wires Polaris links to the real Remix <Link>, which needs a
  // running router. Here it only has to show that the App Bridge script is asked for.
  vi.doMock("@shopify/shopify-app-remix/react", () => ({
    AppProvider: (p: { apiKey: string; children?: unknown }) => (
      <>
        <script data-api-key={p.apiKey} />
        {p.children as never}
      </>
    ),
  }));
  vi.doMock("@shopify/polaris-viz/build/esm/styles.css", () => ({}));
  // The pieces of Remix a page touches, without a running router.
  vi.doMock("@remix-run/react", async () => {
    const actual = await vi.importActual<typeof import("@remix-run/react")>("@remix-run/react");
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
      useRouteError: () => routeError,
      useRouteLoaderData: () => layoutData,
      isRouteErrorResponse: actual.isRouteErrorResponse,
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
        return { data: { referrals_flagged: 3, review_claims_pending: 2, expiring_members: 41, expiring_points: 90000, expiring_overdue_members: 2, gdpr_open: 1, referral_order_alerts: 1 } };
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
        return { data: [{ member_id: ID, name: "Sana Ahmed", email: "sana@example.com", phone: null, points: 1500, first_expiry: "2020-12-01T00:00:00Z", total_count: 1 }] };
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
        // Home's open order-check alerts (migration 016): only reason codes, never the matched phone or address
        if (chain.some(([m, a]) => m === "in" && a[0] === "order_check")) {
          return { data: [{ id: REF_ALERT, referrer_member_id: ID, status: "blocked", order_check: "same_phone", order_checked_order_id: "5", order_tag: "tagged", members: MEMBER }] };
        }
        return { count: 3, data: [
          { id: "r1", referrer_member_id: ID, referred_email: "friend@example.com", referred_shopify_customer_id: "C1", status: "flagged", block_reason: null, fraud_flags: ["similar_email", "same_address_on_order"], reward_points: null, created_at: "2026-11-10T00:00:00Z", completed_at: null, reviewed_note: null, order_check: "same_address", alert_resolved_at: null, members: MEMBER },
          { id: "r2", referrer_member_id: ID, referred_email: null, referred_shopify_customer_id: "C2", status: "completed", block_reason: null, fraud_flags: [], reward_points: 12000, created_at: "2026-11-01T00:00:00Z", completed_at: "2026-11-05T00:00:00Z", reviewed_note: null, order_check: "not_checked", members: MEMBER },
          { id: "r3", referrer_member_id: ID, referred_email: "old@example.com", referred_shopify_customer_id: "C3", status: "blocked", block_reason: null, fraud_flags: ["same_phone_on_order"], reward_points: null, created_at: "2026-10-01T00:00:00Z", completed_at: null, reviewed_note: null, order_check: "same_phone", alert_resolved_at: "2026-10-02T00:00:00Z", members: MEMBER },
        ] };
      case "order_webhook_state":
        return { data: [{ shopify_order_id: "5", order_name: "#1042" }] };
      case "review_claims":
        return { count: 1, data: [{ id: "k1", member_id: ID, shopify_order_id: "5", points: 3000, claimed_at: "2026-11-15T00:00:00Z", members: MEMBER }] };
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
  routeError = null;
  layoutData = undefined;
});

describe("pages render with data", () => {
  beforeEach(() => mockAll(full));

  it("Home", async () => {
    const html = await renderRoute("app._index.tsx", "/app?view=claims");
    for (const text of ["Needs your attention", "3 referrals held for review", "2 review claims waiting", "41 members have points expiring", "1,912", "842,300", "14%", "Rs.386,000", "Reward cost Rs.21,500", "Members by tier", "Order #1042 delivered and paid", "Program live", "Reject", "Approve", "then approve or reject each claim",
      "Order value using a reward", "after discounts, without shipping and tax, before refunds"]) {
      expect(html, text).toContain(text);
    }
    // the figure is not called "sales" anywhere on Home, and rewards are available so there is no warning
    expect(html).not.toMatch(/Sales using a reward/);
    expect(html).not.toContain("Customers currently have nothing to redeem");
    // review points are never promised for a time (manual approval)
    expect(html).not.toMatch(/release automatically|Releases|due now/);
    expect(html).toContain(`href="/app/customers/${ID}"`);
    expect(html).toContain('href="/app/referrals?status=flagged"');
    // referral orders not compared with the referrer: a count and a link, no customer details
    expect(html).toContain("3 referral orders were not checked");
    expect(html).toContain('href="/app/referrals?check=not_checked"');
  });

  it("Referrals filtered to orders that were not checked", async () => {
    const html = await renderRoute("app.referrals.tsx", "/app/referrals?check=not_checked");
    expect(html).toContain("Showing referrals whose order was not checked");
    expect(html).toContain("Dismiss alert");
  });

  it("Home lists a referral order alert with links to the order and the referral, and Block / Dismiss", async () => {
    const html = await renderRoute("app._index.tsx", "/app");
    expect(html).toContain("Order #1042 from a referred friend delivers to the referrer&#x27;s phone number");
    expect(html).toContain("Open order in Shopify");
    expect(html).toContain("The order is tagged &quot;Rewards: check referral&quot; in Shopify.");
    expect(html).toContain("https://heygirl-pk.myshopify.com/admin/orders/5");
    expect(html).toContain(`href="/app/referrals?referral=${REF_ALERT}"`);
    expect(html).toContain("Block this referrer");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain("network address");
  });

  it("Home shows overdue expiries as expiring now (A9)", async () => {
    const html = await renderRoute("app._index.tsx", "/app?view=expiring");
    expect(html).toContain("2 of them have points expiring now");
    expect(html).toContain("Expiring now (due 1 Dec 2020)");
  });

  it("Customers list", async () => {
    const html = await renderRoute("app.customers._index.tsx", "/app/customers?q=sana");
    expect(html).toContain("Sana Ahmed");
    expect(html).toContain("03001234567");
    expect(html).toContain("Influencer");
  });

  it("Customer profile", async () => {
    const html = await renderRoute("app.customers.$id.tsx", `/app/customers/${ID}`, { id: ID });
    for (const text of ["18,450", "Available", "Pending, released when", "Adjust balance", "Rs.28,800 more to reach Diamond", "12 August", "Cancel and return points", "REWARD-AAAA", "Staff notes", "Called about a late parcel", "?ref=sana", "Moved to Gold", "Pending 900", "held for review", "Review claims waiting", "Points are added only when you approve", "Approve"]) {
      expect(html, text).toContain(text);
    }
    // only the reward code that is still active can be cancelled
    expect(html.match(/Cancel and return points/g)).toHaveLength(1);
    // admin sees the internal reason, clearly labelled
    expect(html).toContain("Reason: INTERNAL-REASON");
  });

  it("Program", async () => {
    const html = await renderRoute("app.program.tsx", "/app/program");
    // every reward row has the switch; none is hidden in this fixture
    expect(html.match(/Shown to customers/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("Customers currently have nothing to redeem");
    expect(html).not.toContain(">Hidden<");
    for (const text of ["Ways to earn", "Place an order", "1 point per Rs.1", "Post your order review", "Points are added only when you approve", "Ways to redeem", "Add reward", "No profile link yet"]) {
      expect(html, text).toContain(text);
    }
  });

  it("Referrals", async () => {
    const html = await renderRoute("app.referrals.tsx", "/app/referrals");
    // the current rules in plain words
    expect(html).toContain("The friend&#x27;s email looks like the referrer&#x27;s; The friend&#x27;s order delivers to the referrer&#x27;s address");
    expect(html).toContain("The friend&#x27;s order uses the referrer&#x27;s phone number");
    expect(html).toContain("Her order was not checked against the referrer&#x27;s phone and address");
    expect(html).toContain("Block this referrer");
    // r1's alert is open, and r2's order was not checked (it can be dismissed too); r3's was dismissed
    expect(html).toContain("Dismiss alert");
    expect(html.match(/Dismiss alert/g)).toHaveLength(2);
    expect(html).not.toContain("network address");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).not.toMatch(/IP match/i);
  });

  it("Influencers list and detail", async () => {
    const list = await renderRoute("app.influencers._index.tsx", "/app/influencers");
    for (const text of ["Winter Glow", "12,000", "SANA10 (10% off)", "Rs.181,000", "270,000", "Add influencer", "All-time results.", "an order that completed a link referral counts for that link only"]) expect(list, text).toContain(text);
    const period = await renderRoute("app.influencers._index.tsx", "/app/influencers?period=30d");
    expect(period).toContain("each number counts what happened in the period");
    expect(period).toContain("completed referrals by the day they completed");
    const detail = await renderRoute("app.influencers.$id.tsx", `/app/influencers/${ID}`, { id: ID });
    for (const text of ["Points per referral", "1.5× (9,000 points)", "3× (18,000 points)", "Custom", "Rate starts, optional", "Remove code", "Her referrals", "Held for review", "Pause"]) {
      expect(detail, text).toContain(text);
    }
  });

  it("Campaigns", async () => {
    const html = await renderRoute("app.campaigns._index.tsx", "/app/campaigns");
    for (const text of ["Eid Edit", "Live", "Rs.48,000", "90,000", "6,000 pending", "Create campaign", "End now"]) expect(html, text).toContain(text);
    // a campaign with orders offers no Delete
    expect(html).not.toContain(">Delete<");
  });

  it("Analytics", async () => {
    const html = await renderRoute("app.analytics._index.tsx", "/app/analytics?period=90d");
    for (const text of ["Redemption rate", "Outstanding points", "600,000", "Value at the base redemption rate", "Rs.20,000", "3,000 points for Rs.100 off", "Top earners", "Referral funnel", "Influencers compared",
      "Order value using a reward against reward cost", "Order value, before refunds", "after discounts, without shipping and tax", "Refunds made later are not taken off, so this is not net sales"]) {
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
    for (const text of ["Redeeming", "Notifications", "Not configured", "Data export", "System health", "Healthy", "Privacy requests", "Mark as answered",
      "Staff alert email, optional", "each morning when something needs your attention"]) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain("never-shown");
  });
});

describe("hidden rewards", () => {
  const withTiers = (tiers: unknown): Parameters<typeof fakeDb>[0] => ({
    rpc: full.rpc,
    from: (table, chain) => (table === "app_settings" ? { data: { ...SETTINGS, redemption_tiers: tiers } } : full.from!(table, chain)),
  });

  it("Program shows a hidden reward muted, with a Hidden badge and its switch off, and keeps it in the table", async () => {
    mockAll(withTiers([{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }]));
    const html = await renderRoute("app.program.tsx", "/app/program");
    expect(html.match(/>Hidden</g)).toHaveLength(1);
    expect(html.match(/Shown to customers<\/span>/g)!.length).toBe(2); // one switch per row
    expect(html.match(/type="checkbox"[^>]*checked=""/g) ?? []).toHaveLength(1); // only the shown reward is ticked
    expect(html).toContain("customers do not see this reward and cannot redeem it");
    expect(html).toContain("1 of 2 hidden.");
    expect(html).toContain('value="3000"'); // still editable, not deleted
    expect(html).toContain("--p-color-bg-surface-secondary"); // the muted row background
    expect(html).not.toContain("Customers currently have nothing to redeem");
  });

  it("with every reward hidden, Program and Home warn that customers have nothing to redeem", async () => {
    mockAll(withTiers([{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250, hidden: true }]));
    const program = await renderRoute("app.program.tsx", "/app/program");
    expect(program).toContain("Customers currently have nothing to redeem");
    expect(program.match(/>Hidden</g)).toHaveLength(2);
    const home = await renderRoute("app._index.tsx", "/app");
    expect(home).toContain("Customers currently have nothing to redeem");
    expect(home).toContain("All 2 rewards are hidden");
    expect(home).toContain('href="/app/program"');
  });

  it("Analytics never values points at a hidden reward", async () => {
    mockAll(withTiers([{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250 }]));
    const some = await renderRoute("app.analytics._index.tsx", "/app/analytics");
    expect(some).toContain("6,000 points for Rs.250 off");
    expect(some).not.toContain("3,000 points for Rs.100 off");
    expect(some).toContain("Rs.25,000"); // 600,000 points at 250 per 6,000
    mockAll(withTiers([{ points: 3000, discount_pkr: 100, hidden: true }]));
    const none = await renderRoute("app.analytics._index.tsx", "/app/analytics");
    expect(none).toContain("No reward is shown");
    expect(none).not.toContain("3,000 points for Rs.100 off");
  });

  it("Home does not warn while the program is switched off", async () => {
    mockAll({ rpc: full.rpc, from: (table, chain) => (table === "app_settings" ? { data: { ...SETTINGS, program_enabled: false, redemption_tiers: [] } } : full.from!(table, chain)) });
    const home = await renderRoute("app._index.tsx", "/app");
    expect(home).not.toContain("Customers currently have nothing to redeem");
  });
});

describe("rule 20: the switch only pauses redeeming (admin wording)", () => {
  beforeEach(() => mockAll(full));
  const off = () =>
    mockAll({ rpc: full.rpc, from: (table, chain) => (table === "app_settings" ? { data: { ...SETTINGS, program_enabled: false } } : full.from!(table, chain)) });

  it("Settings: the switch is 'Redeeming' and says exactly what pausing does, in both states", async () => {
    const on = await renderRoute("app.settings.tsx", "/app/settings");
    expect(on).toContain(">Redeeming</h2>");
    expect(on).toContain(">Allowed<");
    expect(on).toContain(">Pause redeeming<");
    expect(on).toContain("If you pause redeeming:");
    for (const t of PROGRAM_OFF_EFFECTS) expect(on, t).toContain(escapeHtml(t));
    off();
    const offHtml = await renderRoute("app.settings.tsx", "/app/settings");
    expect(offHtml).toContain(">Paused<");
    expect(offHtml).toContain(">Allow redeeming<");
    expect(offHtml).toContain("While redeeming is paused:");
    expect(offHtml).toContain(escapeHtml("Customers cannot redeem points right now. They are still earning as normal."));
    for (const t of PROGRAM_OFF_EFFECTS) expect(offHtml, t).toContain(escapeHtml(t));
    // Nothing left from the old rule (no earning while off).
    for (const old of ["earn no new points", "never earns points", "are hidden on the storefront", "switched off"]) expect(offHtml).not.toContain(old);
  });

  it("the wording covers the owner's four points", () => {
    const all = PROGRAM_OFF_EFFECTS.join(" ");
    expect(all).toContain("Customers cannot redeem points");
    expect(all).toContain("Customers still earn points as normal");
    expect(all).toContain("Reward codes already issued still work at checkout until they expire");
    expect(all).toContain("run the sale as an automatic discount");
    expect(all).toContain("Shopify applies only the one discount that is best for the customer");
    expect(all).toContain("Everything else continues");
  });

  it("Home shows the 'Redeeming is paused' banner with the same list only while paused", async () => {
    const on = await renderRoute("app._index.tsx", "/app");
    expect(on).not.toContain("Redeeming is paused");
    expect(on).toContain("Program live");
    off();
    const offHtml = await renderRoute("app._index.tsx", "/app");
    expect(offHtml).toContain("Redeeming is paused");
    expect(offHtml).toContain("Redeeming paused");
    for (const t of PROGRAM_OFF_EFFECTS) expect(offHtml, t).toContain(escapeHtml(t));
  });

  it("On-site has the Panel style choice (Light and Dark with swatches), Dark by default, Light when saved", async () => {
    const html = await renderRoute("app.onsite.tsx", "/app/onsite");
    expect(html).toContain(">Panel style</h2>");
    expect(html).toContain('data-swatch="light"');
    expect(html).toContain('data-swatch="dark"');
    expect(html).toMatch(/<input id="panel_theme_dark" name="panel_theme" type="radio"[^>]*checked=""[^>]*value="dark"/);
    expect(html).toMatch(/<input id="panel_theme_light" name="panel_theme" type="radio"[^>]*value="light"/);
    expect(html).not.toMatch(/<input id="panel_theme_light"[^>]*checked=""/);
    mockAll({ rpc: full.rpc, from: (table, chain) => (table === "app_settings" ? { data: { ...SETTINGS, panel_theme: "light" } } : full.from!(table, chain)) });
    const light = await renderRoute("app.onsite.tsx", "/app/onsite");
    expect(light).toMatch(/<input id="panel_theme_light"[^>]*checked=""/);
    expect(light).not.toMatch(/<input id="panel_theme_dark"[^>]*checked=""/);
  });

  it("On-site offers the approved FAQ when the saved list lacks it, and not once it is there", async () => {
    const without = await renderRoute("app.onsite.tsx", "/app/onsite");
    expect(without).toContain("Suggested question: How are my points calculated?");
    expect(without).toContain("Add this question");
    mockAll({
      rpc: full.rpc,
      from: (table, chain) => (table === "app_settings" ? { data: { ...SETTINGS, faqs: [...SETTINGS.faqs, ...SUGGESTED_FAQS] } } : full.from!(table, chain)),
    });
    const withIt = await renderRoute("app.onsite.tsx", "/app/onsite");
    expect(withIt).not.toContain("Suggested question:");
    expect(withIt).toContain("How are my points calculated?");
  });
});

describe("admin error boundary", () => {
  class ErrorResponseImpl {
    constructor(public status: number, public statusText: string, public data: unknown, public internal = false) {}
  }
  async function renderBoundary(): Promise<string> {
    const mod = (await import("../routes/app")) as unknown as { ErrorBoundary: () => ReactElement | null };
    const Boundary = mod.ErrorBoundary;
    return renderToString(<AppProvider i18n={en}><Boundary /></AppProvider>);
  }
  beforeEach(() => mockAll(full));

  it("a page that fails to load shows a plain message and none of the system text", async () => {
    routeError = new Error('relation "points_ledger" does not exist at character 15\n    at loader (/app/build/server/index.js:1:1)');
    layoutData = { apiKey: "client123" };
    const html = await renderBoundary();
    expect(html).toContain("This page could not be loaded");
    expect(html).toContain("Nothing was changed");
    expect(html).toContain("Go to Home");
    expect(html).not.toMatch(/points_ledger|relation|index\.js|at loader/);
    // App Bridge and the navigation stay on the page, so staff can move on
    expect(html).toContain('data-api-key="client123"');
    expect(html).toContain("ui-nav-menu");
  });

  it("when the layout itself could not load there is no in-app link, only the reload advice", async () => {
    routeError = new Error("ECONNREFUSED 10.0.0.5:5432");
    layoutData = undefined;
    const html = await renderBoundary();
    expect(html).toContain("This page could not be loaded");
    expect(html).toContain("Reload this browser tab");
    expect(html).not.toContain("Go to Home");
    expect(html).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });

  it("a record that does not exist shows a not-found state with the loader's own message", async () => {
    routeError = new ErrorResponseImpl(404, "Not Found", { adminMessage: "This customer could not be found" });
    layoutData = { apiKey: "client123" };
    const html = await renderBoundary();
    expect(html).toContain("This customer could not be found");
    expect(html).toContain("open it from the list again");
    expect(html).not.toContain("This page could not be loaded");
  });

  it("Shopify's own auth responses still go to Shopify's boundary untouched", async () => {
    // the App Bridge bounce page that authenticate.admin throws as a Response
    routeError = new ErrorResponseImpl(200, "OK", '<script data-api-key="k" src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>');
    layoutData = { apiKey: "client123" };
    const html = await renderBoundary();
    expect(html).toContain('src="https://cdn.shopify.com/shopifycloud/app-bridge.js"');
    expect(html).not.toContain("This page could not be loaded");
    expect(html).not.toContain("Not found");
    // an empty 401/410 from the auth flow is also left to Shopify
    routeError = new ErrorResponseImpl(401, "Unauthorized", null);
    expect(await renderBoundary()).toContain("Handling response");
  });

  it("the layout still exports Shopify's headers boundary", async () => {
    const mod = (await import("../routes/app")) as unknown as { headers: (a: Record<string, Headers>) => Headers };
    const out = mod.headers({ parentHeaders: new Headers(), loaderHeaders: new Headers(), actionHeaders: new Headers(), errorHeaders: new Headers({ "X-Shopify-Retry-Invalid-Session-Request": "1" }) });
    expect(out.get("X-Shopify-Retry-Invalid-Session-Request")).toBe("1");
  });
});

describe("pages render when there is nothing yet", () => {
  beforeEach(() => mockAll(empty));

  it.each([
    // an empty reward table is itself something to act on
    ["app._index.tsx", "/app", "There are no rewards. Add one so customers can use their points."],
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
