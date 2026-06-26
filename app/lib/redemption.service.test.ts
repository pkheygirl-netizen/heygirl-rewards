import { expect, test, vi } from "vitest";

vi.mock("./queue.server", () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));

import { findTier, validateRedemption, generateCodeValue } from "./redemption.service";

const DEFAULT_TIERS = [
  { points: 3000, discount_pkr: 100 },
  { points: 6000, discount_pkr: 250 },
  { points: 11500, discount_pkr: 500 },
  { points: 22000, discount_pkr: 1000 },
  { points: 100000, discount_pkr: 5000 },
  { points: 180000, discount_pkr: 10000 },
];

test("findTier: returns exact match", () => {
  expect(findTier(DEFAULT_TIERS, 6000)).toEqual({ points: 6000, discount_pkr: 250 });
});

test("findTier: returns null for non-tier amount", () => {
  expect(findTier(DEFAULT_TIERS, 5000)).toBeNull();
});

test("validateRedemption: valid tier + sufficient balance", () => {
  const r = validateRedemption(6000, 6000, DEFAULT_TIERS);
  expect(r.valid).toBe(true);
});

test("validateRedemption: insufficient balance", () => {
  const r = validateRedemption(5000, 6000, DEFAULT_TIERS);
  expect(r.valid).toBe(false);
  expect(r.reason).toBe("insufficient_balance");
});

test("validateRedemption: below minimum 3000", () => {
  const r = validateRedemption(5000, 2000, DEFAULT_TIERS);
  expect(r.valid).toBe(false);
  expect(r.reason).toBe("below_minimum");
});

test("validateRedemption: non-existent tier", () => {
  const r = validateRedemption(5000, 5000, DEFAULT_TIERS);
  expect(r.valid).toBe(false);
  expect(r.reason).toBe("invalid_tier");
});

test("generateCodeValue: format REWARD-XXXXXXXX", () => {
  const code = generateCodeValue();
  expect(code).toMatch(/^REWARD-[A-Z0-9]{6,10}$/);
});
