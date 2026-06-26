import "@shopify/shopify-app-remix/adapters/node";
import { AppDistribution, shopifyApp } from "@shopify/shopify-app-remix/server";
import { SupabaseSessionStorage } from "./supabase-session-storage.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL ?? "https://heygirl-rewards.onrender.com",
  scopes: process.env.SCOPES?.split(",") ?? [
    "read_customers", "write_customers",
    "read_orders", "write_orders",
    "read_discounts", "write_discounts",
    "read_script_tags", "write_script_tags",
    "read_products", "write_products",
  ],
  apiVersion: "2025-04" as any,
  distribution: AppDistribution.SingleMerchant,
  sessionStorage: new SupabaseSessionStorage(),
  hooks: {
    afterAuth: async ({ session }) => {
      await shopify.registerWebhooks({ session });
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
