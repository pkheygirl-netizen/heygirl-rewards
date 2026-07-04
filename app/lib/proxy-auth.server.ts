// app/lib/proxy-auth.server.ts
import crypto from "node:crypto";

/**
 * Verifies the Shopify App Proxy HMAC signature.
 * Shopify signs: alphabetically-sorted params (excluding `signature`),
 * concatenated as "key=value" with no separator, HMAC-SHA256 hex.
 * Returns the Shopify customer_id string, or null for guests.
 * Throws "invalid_proxy_signature" if HMAC check fails.
 */
export function extractProxyCustomerId(url: URL, apiSecret: string): string | null {
  const params = new URLSearchParams(url.search);
  const receivedSig = params.get("signature") ?? "";
  params.delete("signature");

  // Shopify joins repeated params as "key=v1,v2" — build from unique keys + getAll,
  // not per-entry, or any multi-value param fails verification (W1, 2026-07-03 review).
  const keys = [...new Set([...params.keys()])].sort((a, b) => a.localeCompare(b));
  const message = keys.map((k) => `${k}=${params.getAll(k).join(",")}`).join("");
  const expected = crypto.createHmac("sha256", apiSecret).update(message).digest("hex");

  const sigBuf = Buffer.from(receivedSig, "hex");
  const expBuf = Buffer.from(expected, "hex");
  if (
    sigBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expBuf)
  ) {
    throw new Error("invalid_proxy_signature");
  }

  // Reject replayed requests — Shopify includes a signed timestamp param
  const ts = Number(params.get("timestamp") ?? 0);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) {
    throw new Error("invalid_proxy_signature"); // reuse same error to avoid leaking reason
  }

  const customerId = params.get("logged_in_customer_id");
  return customerId || null; // empty string → null (guest)
}
