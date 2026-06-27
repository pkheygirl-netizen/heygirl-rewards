import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({ db: { from: vi.fn() } }));
vi.mock("./shopify-graphql.server", () => ({ shopifyGraphqlWithRetry: vi.fn() }));

import { birthdayDiscountPkr, awardBirthdayReward } from "./birthday.service";
import { db } from "../db.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

function mockEmptySettings() {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });
}

test("birthdayDiscountPkr: silver → 250 (default)", async () => {
  mockEmptySettings();
  expect(await birthdayDiscountPkr("silver")).toBe(250);
});

test("birthdayDiscountPkr: gold → 500 (default)", async () => {
  mockEmptySettings();
  expect(await birthdayDiscountPkr("gold")).toBe(500);
});

test("birthdayDiscountPkr: diamond → 1000 (default)", async () => {
  mockEmptySettings();
  expect(await birthdayDiscountPkr("diamond")).toBe(1000);
});

test("birthdayDiscountPkr: unknown tier → 250 (silver default)", async () => {
  mockEmptySettings();
  expect(await birthdayDiscountPkr("unknown")).toBe(250);
});

test("birthdayDiscountPkr: reads override from settings", async () => {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { birthday_reward_gold_pkr: 750 },
      error: null,
    }),
  });
  expect(await birthdayDiscountPkr("gold")).toBe(750);
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
