import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import crypto from "node:crypto";
import { authenticate } from "../shopify.server";
import { redeemPoints, getActiveLoyaltyCodes } from "../lib/redemption.service";

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId") ?? "";
  const sig = url.searchParams.get("sig");
  if (!verifySignature(customerId, sig)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const codes = await getActiveLoyaltyCodes(customerId);
  return json({ codes });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });

  let body: { shopifyCustomerId?: string; requestedPoints?: number; sig?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, { status: 400 });
  }

  const { shopifyCustomerId, requestedPoints, sig } = body;
  if (!shopifyCustomerId || !requestedPoints) {
    return json({ error: "missing_fields" }, { status: 400 });
  }
  if (!verifySignature(String(shopifyCustomerId), sig ?? null)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  // Redemption requires Admin API access — use unauthenticated admin client
  // (service-key pattern for private app with fixed shop domain)
  const { admin } = await authenticate.admin(request).catch(() => ({ admin: null }));
  if (!admin) {
    return json({ error: "admin_auth_failed" }, { status: 500 });
  }

  try {
    const result = await redeemPoints({
      shopifyCustomerId: String(shopifyCustomerId),
      requestedPoints: Number(requestedPoints),
      admin,
    });
    return json(result, { status: result.redeemed ? 200 : 400 });
  } catch (err) {
    console.error("[api.redeem] error:", err);
    return json({ error: "internal_error" }, { status: 500 });
  }
};
