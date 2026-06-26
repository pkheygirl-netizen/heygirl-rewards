import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({ db: { from: vi.fn() } }));
vi.mock("./shopify-graphql.server", () => ({ shopifyGraphqlWithRetry: vi.fn() }));

import { birthdayDiscountPkr, awardBirthdayReward } from "./birthday.service";
import { db } from "../db.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

test("birthdayDiscountPkr: silver → 250", () => {
  expect(birthdayDiscountPkr("silver")).toBe(250);
});

test("birthdayDiscountPkr: gold → 500", () => {
  expect(birthdayDiscountPkr("gold")).toBe(500);
});

test("birthdayDiscountPkr: diamond → 1000", () => {
  expect(birthdayDiscountPkr("diamond")).toBe(1000);
});

test("birthdayDiscountPkr: unknown tier → 250 (silver default)", () => {
  expect(birthdayDiscountPkr("unknown")).toBe(250);
});

test("awardBirthdayReward: returns already_awarded_this_month on duplicate", async () => {
  mockFrom.mockReturnValue({
    insert: vi.fn().mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate" } }),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
  });
  const result = await awardBirthdayReward("member-id", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("already_awarded_this_month");
});

test("awardBirthdayReward: returns db_error on unexpected insert error", async () => {
  mockFrom.mockReturnValue({
    insert: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied" } }),
  });
  const result = await awardBirthdayReward("member-id", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("db_error");
});
