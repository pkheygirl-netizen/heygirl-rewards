import { unauthenticated } from "../shopify.server";
import { db } from "../db.server";
import type { AdminGraphqlClient } from "./shopify-graphql.server";

export type { AdminGraphqlClient };

let cachedShop: { shop: string; at: number } | null = null;
const SHOP_CACHE_MS = 5 * 60 * 1000;

/**
 * The shop this single-merchant app is installed on, read from the stored
 * offline session. There is no SHOP_DOMAIN / SHOPIFY_SHOP_DOMAIN variable any
 * more and no hard-coded domain: webhooks and proxy requests carry the shop,
 * and cron jobs fall back to this lookup.
 */
export async function getInstalledShop(): Promise<string> {
  if (cachedShop && Date.now() - cachedShop.at < SHOP_CACHE_MS) return cachedShop.shop;
  const { data, error } = await db
    .from("shopify_sessions")
    .select("shop")
    .eq("is_online", false)
    .not("access_token", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`could not read the stored Shopify session: ${error.message}`);
  if (!data?.shop) {
    throw new Error("no stored offline Shopify session: open the app in Shopify admin once to install it");
  }
  cachedShop = { shop: data.shop, at: Date.now() };
  return data.shop;
}

/** Test hook. */
export function resetInstalledShopCache(): void {
  cachedShop = null;
}

/**
 * Admin GraphQL client for code that runs outside an admin request (workers,
 * app-proxy routes, cron). `shop` is optional: without it the single stored
 * offline session's shop is used.
 */
export async function getAdminForShop(shop?: string): Promise<AdminGraphqlClient> {
  const domain = shop && shop.trim() ? shop.trim() : await getInstalledShop();
  const { admin } = await unauthenticated.admin(domain);
  return admin as unknown as AdminGraphqlClient;
}
