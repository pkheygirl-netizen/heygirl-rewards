import { db } from "../db.server";

export function roundAward(value: number): number {
  return Math.floor(value);
}

export function roundClawback(value: number): number {
  return Math.ceil(value);
}

export function computePurchasePoints(
  orderTotalPaisa: number,
  shippingPaisa: number,
  taxPaisa: number,
  multiplier: number,
): number {
  const basisPaisa = orderTotalPaisa - shippingPaisa - taxPaisa;
  const basisRupees = basisPaisa / 100; // exact: integer paisa divided once
  return roundAward(basisRupees * multiplier);
}

export function mapSocialActionType(
  short: "youtube" | "facebook" | "instagram",
): "social_youtube" | "social_facebook" | "social_instagram" {
  return `social_${short}` as const;
}
