import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import crypto from "node:crypto";
import { recordReferralVisit } from "../lib/referrals.service";

function verifySignature(customerId: string, sig: string | null): boolean {
  if (!sig || !process.env.SHOPIFY_API_SECRET) return false;
  const expected = crypto
    .createHmac("sha256", process.env.SHOPIFY_API_SECRET)
    .update(customerId)
    .digest("hex");
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

  let body: {
    referralSlug?: string;
    referredShopifyCustomerId?: string;
    referredEmail?: string;
    referredIp?: string;
    referredShippingAddress?: string;
    deviceFingerprintHash?: string;
    sig?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  const { referralSlug, referredShopifyCustomerId, referredEmail, referredIp, sig } = body;
  if (!referralSlug || !referredShopifyCustomerId || !referredEmail || !referredIp) {
    return json({ error: "missing_fields" }, { status: 400 });
  }
  if (!verifySignature(String(referredShopifyCustomerId), sig ?? null)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await recordReferralVisit({
      referralSlug,
      referredShopifyCustomerId: String(referredShopifyCustomerId),
      referredEmail,
      referredIp,
      referredShippingAddress: body.referredShippingAddress,
      deviceFingerprintHash: body.deviceFingerprintHash,
    });
    return json(result);
  } catch (err) {
    console.error("[api.referral-visit] error:", err);
    return json({ error: "internal_error" }, { status: 500 });
  }
};
