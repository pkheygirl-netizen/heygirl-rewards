import { beforeEach, expect, it, vi } from "vitest";

const adminFor = vi.hoisted(() => vi.fn());
vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: adminFor } }));

import { h, resetHarness } from "./testing/harness";
import { getAdminForShop, getInstalledShop, resetInstalledShopCache } from "./worker-admin.server";

const client = { graphql: vi.fn() };

beforeEach(() => {
  resetHarness();
  resetInstalledShopCache();
  adminFor.mockReset().mockResolvedValue({ admin: client });
  delete process.env.SHOP_DOMAIN;
  delete process.env.SHOPIFY_SHOP_DOMAIN;
});

it("uses the shop it is given", async () => {
  expect(await getAdminForShop("given.myshopify.com")).toBe(client);
  expect(adminFor).toHaveBeenCalledWith("given.myshopify.com");
});

it("without a shop, falls back to the stored offline session (no env variable, no hard-coded domain)", async () => {
  h.db.seed("shopify_sessions", { id: "online_1", shop: "wrong.myshopify.com", is_online: true, access_token: "x" });
  h.db.seed("shopify_sessions", { id: "offline_1", shop: "stored.myshopify.com", is_online: false, access_token: "x" });
  await getAdminForShop();
  expect(adminFor).toHaveBeenCalledWith("stored.myshopify.com");
  expect(await getInstalledShop()).toBe("stored.myshopify.com");
});

it("fails loudly when the app has never been installed", async () => {
  await expect(getAdminForShop()).rejects.toThrow(/no stored offline Shopify session/);
  expect(adminFor).not.toHaveBeenCalled();
});

it("ignores the old SHOP_DOMAIN / SHOPIFY_SHOP_DOMAIN variables", async () => {
  process.env.SHOP_DOMAIN = "env.myshopify.com";
  process.env.SHOPIFY_SHOP_DOMAIN = "env2.myshopify.com";
  h.db.seed("shopify_sessions", { id: "offline_1", shop: "stored.myshopify.com", is_online: false, access_token: "x" });
  await getAdminForShop("  ");
  expect(adminFor).toHaveBeenCalledWith("stored.myshopify.com");
});
