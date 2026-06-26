import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({
  db: {
    from: vi.fn(),
  },
}));

vi.mock("./shopify-graphql.server", () => ({
  shopifyGraphqlWithRetry: vi.fn(),
}));

import { redeemPoints } from "./redemption.service";
import { db } from "../db.server";
import { shopifyGraphqlWithRetry } from "./shopify-graphql.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;
const mockGraphql = shopifyGraphqlWithRetry as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

test("redeemPoints: returns redeemed=false for unknown member", async () => {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });

  const result = await redeemPoints({
    shopifyCustomerId: "999",
    requestedPoints: 6000,
    admin: {} as any,
  });
  expect(result.redeemed).toBe(false);
  expect(result.reason).toBe("member_not_found");
});
