import { expect, test } from "vitest";
import {
  roundAward, roundClawback, computePurchasePoints, mapSocialActionType,
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
