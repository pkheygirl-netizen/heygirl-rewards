import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  BillingInterval,
  ApiVersion,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { SupabaseSessionStorage } from "./supabase-session-storage.server";
import { registerScriptTagAndPage } from "./lib/scripttag.server";

// Billing plan definitions — activate by passing `billing` to shopifyApp() and
// adding a requiresBilling check in the app loader when monetisation goes live.
export const PLANS = {
  FREE: "HeyGirl Rewards — Free",
} as const;

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
    // Script tags — reward room widget + storefront event tracking
    "read_script_tags", "write_script_tags",
    // Products — create/manage hidden reward room products
    "read_products", "write_products",
  ],
  apiVersion: ApiVersion.April25,
  distribution: AppDistribution.SingleMerchant,
  sessionStorage: new SupabaseSessionStorage(),
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
      await registerScriptTagAndPage(admin);
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
