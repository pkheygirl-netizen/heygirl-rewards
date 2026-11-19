import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  BillingInterval,
  ApiVersion,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { SupabaseSessionStorage } from "./supabase-session-storage.server";
import { removeLegacyScriptTags } from "./lib/legacy-scripttags.server";
import { ensureRewardsPage } from "./lib/rewards-page.server";

// Billing plan definitions — activate by passing `billing` to shopifyApp() and
// adding a requiresBilling check in the app loader when monetisation goes live.
export const PLANS = {
  FREE: "HeyGirl Rewards — Free",
} as const;

export const API_VERSION = "2026-10";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL ?? "https://app.heygirl.pk",
  scopes: process.env.SCOPES?.split(",") ?? [
    // Customer data — enrolment, PII, consent
    "read_customers", "write_customers",
    // Orders — read-only for points calculation (no order editing)
    "read_orders",
    // Discounts — generate loyalty redemption codes
    "read_discounts", "write_discounts",
    // Products — create/manage hidden reward room products
    "read_products", "write_products",
    // Online Store content — auto-create the /pages/rewards landing page
    // (pages query + pageCreate require content scope)
    "read_content", "write_content",
  ],
  // 2026-10 is the newest stable Admin API version (checked 16 Nov 2026). The
  // installed @shopify/shopify-app-remix 3.8.5 only lists versions up to
  // 2025-10 in its ApiVersion enum, which Shopify no longer serves, so the
  // version is given as a string. The client builds the request URL from this
  // value as-is. Keep it in step with [webhooks] api_version in shopify.app.toml.
  apiVersion: API_VERSION as ApiVersion,
  distribution: AppDistribution.SingleMerchant,
  sessionStorage: new SupabaseSessionStorage(),
  // Use OAuth token exchange (managed install) instead of the auth-code flow.
  // The auth-code flow exits the admin iframe to run OAuth, which caused an
  // /auth/exit-iframe → /auth redirect loop on embedded load. Token exchange
  // swaps the App Bridge session token for an access token with no iframe exit.
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  },
  // Billing scaffold — currently free. To activate paid plans, uncomment the
  // billing block below and add `await requireBillingOrRedirect(admin, [PLANS.FREE])`
  // in the app loader.
  //
  // billing: {
  //   [PLANS.FREE]: {
  //     amount: 0,
  //     currencyCode: "USD",
  //     interval: BillingInterval.Every30Days,
  //   },
  // },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      await shopify.registerWebhooks({ session });
      await ensureRewardsPage(admin);
      // v2 left a script tag on every storefront page; remove it (non-fatal,
      // reports "no_scope" while the script-tag scopes are not granted).
      await removeLegacyScriptTags(admin);
    },
  },
});

export default shopify;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const sessionStorage = shopify.sessionStorage;

// Wire workers into server startup (no-op unless WORKER=1)
import { startWorkers } from "./lib/queue.server";
startWorkers();
