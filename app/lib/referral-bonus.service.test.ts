import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({ db: { from: vi.fn() } }));
vi.mock("./shopify-graphql.server", () => ({ shopifyGraphqlWithRetry: vi.fn() }));

import { awardReferralBonus } from "./referral-bonus.service";
import { db } from "../db.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

test("awardReferralBonus: returns disabled when referral_friend_discount_pkr is 0", async () => {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { referral_friend_discount_pkr: 0 },
      error: null,
    }),
  });
  const result = await awardReferralBonus("cust_123", "ref_456", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("disabled");
});

test("awardReferralBonus: returns disabled when settings null", async () => {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
  const result = await awardReferralBonus("cust_123", "ref_456", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("disabled");
});
