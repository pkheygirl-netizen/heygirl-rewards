import { unauthenticated } from "../shopify.server";

// Returns an Admin GraphQL client usable from background workers (no request context).
// Requires SHOP_DOMAIN env var (e.g. "heygirl-pk.myshopify.com").
// Only works for SingleMerchant private apps where the shop session is already stored.
export async function getWorkerAdmin() {
  const shop = process.env.SHOP_DOMAIN;
  if (!shop) throw new Error("SHOP_DOMAIN env var required for worker admin access");
  const { admin } = await unauthenticated.admin(shop);
  return admin;
}
