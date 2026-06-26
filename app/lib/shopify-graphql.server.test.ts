import { expect, test, vi } from "vitest";
import { shopifyGraphqlWithRetry, ShopifyRateLimitError } from "./shopify-graphql.server";

function makeAdmin(responses: Array<{ data?: unknown; extensions?: unknown }>) {
  let call = 0;
  return {
    graphql: vi.fn(async () => ({
      json: async () => responses[call++],
    })),
  } as any;
}

test("returns data on first success", async () => {
  const admin = makeAdmin([{ data: { shop: { name: "Test" } } }]);
  const result = await shopifyGraphqlWithRetry<{ shop: { name: string } }>(
    admin, "{ shop { name } }"
  );
  expect(result).toEqual({ shop: { name: "Test" } });
});

test("retries on THROTTLED and returns on success", async () => {
  const throttled = {
    data: null,
    extensions: { cost: { throttleStatus: { status: "THROTTLED", restoreRate: 50, currentlyAvailable: 0 } } },
  };
  const ok = { data: { shop: { name: "OK" } } };
  const admin = makeAdmin([throttled, ok]);
  const result = await shopifyGraphqlWithRetry<{ shop: { name: string } }>(
    admin, "{ shop { name } }", {}, 3
  );
  expect(result).toEqual({ shop: { name: "OK" } });
  expect(admin.graphql).toHaveBeenCalledTimes(2);
});

test("throws ShopifyRateLimitError after max retries", async () => {
  const throttled = {
    data: null,
    extensions: { cost: { throttleStatus: { status: "THROTTLED", restoreRate: 50, currentlyAvailable: 0 } } },
  };
  const admin = makeAdmin([throttled, throttled, throttled, throttled]);
  await expect(
    shopifyGraphqlWithRetry(admin, "{ shop { name } }", {}, 2)
  ).rejects.toThrow(ShopifyRateLimitError);
});
