import { expect, test } from "vitest";
import {
  roundAward, roundClawback, computePurchasePoints, mapSocialActionType, selectMultiplier, generateSlug, tierForSpend, expiresAtForMember,
} from "./points.service";

test("roundAward floors", () => {
  expect(roundAward(1798.8)).toBe(1798);
  expect(roundAward(1500)).toBe(1500);
});

test("roundClawback ceils", () => {
  expect(roundClawback(1798.2)).toBe(1799);
  expect(roundClawback(1500)).toBe(1500);
});

test("computePurchasePoints uses integer paisa, no float drift", () => {
  // Rs.1499.50 total, Rs.0 shipping/tax, 1x -> 1499 (floor)
  expect(computePurchasePoints(149950, 0, 0, 1)).toBe(1499);
  // 1.2x Diamond birthday: 1499.5 * 1.2 = 1799.4 -> 1799
  expect(computePurchasePoints(149950, 0, 0, 1.2)).toBe(1799);
  // subtract shipping+tax in paisa: (200000-15000-5000)/100 = 1800
  expect(computePurchasePoints(200000, 15000, 5000, 1)).toBe(1800);
});

test("mapSocialActionType maps short to ledger long form", () => {
  expect(mapSocialActionType("youtube")).toBe("social_youtube");
  expect(mapSocialActionType("facebook")).toBe("social_facebook");
  expect(mapSocialActionType("instagram")).toBe("social_instagram");
});

test("selectMultiplier: active campaign wins with its own value", () => {
  expect(selectMultiplier(2.5, { tier: "diamond", birthday_month: 6 }, 6)).toBe(2.5);
});

test("selectMultiplier: diamond birthday month -> 1.2 when no campaign", () => {
  expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 6)).toBe(1.2);
});

test("selectMultiplier: gold birthday month -> 1 (no multiplier)", () => {
  expect(selectMultiplier(null, { tier: "gold", birthday_month: 6 }, 6)).toBe(1);
});

test("selectMultiplier: diamond non-birthday month -> 1", () => {
  expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 7)).toBe(1);
});

test("generateSlug: name + 4 random digits, no internal id", () => {
  const slug = generateSlug("Sara", "Khan");
  expect(slug).toMatch(/^sara-khan-\d{4}$/);
});

test("generateSlug: strips unsafe chars, falls back to member", () => {
  expect(generateSlug("", "")).toMatch(/^member-\d{4}$/);
  expect(generateSlug("Zoë!", undefined)).toMatch(/^zo-\d{4}$/);
});

test("tierForSpend thresholds", () => {
  expect(tierForSpend(0)).toBe("silver");
  expect(tierForSpend(49999)).toBe("silver");
  expect(tierForSpend(50000)).toBe("gold");
  expect(tierForSpend(99999)).toBe("gold");
  expect(tierForSpend(100000)).toBe("diamond");
});

test("expiresAtForMember: silver gets +365d, others null", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  expect(expiresAtForMember("silver", base)).toBe(new Date("2027-01-01T00:00:00Z").toISOString());
  expect(expiresAtForMember("gold", base)).toBeNull();
  expect(expiresAtForMember("diamond", base)).toBeNull();
});
