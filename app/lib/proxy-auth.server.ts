// app/lib/proxy-auth.server.ts
import crypto from "node:crypto";

/**
 * The string Shopify signs for an app proxy request: every parameter except
 * `signature` as "key=value" (repeated keys joined as "key=v1,v2"), the
 * resulting strings sorted in plain byte order, concatenated with no separator.
 * Sorting is on the whole "key=value" string with the default comparison, as
 * Shopify documents; a locale-aware sort orders mixed-case, digit and prefix
 * keys differently.
 */
export function proxySignatureMessage(params: URLSearchParams): string {
  const keys = [...new Set([...params.keys()])].filter((k) => k !== "signature");
  return keys
    .map((k) => `${k}=${params.getAll(k).join(",")}`)
    .sort()
    .join("");
}

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

  const message = proxySignatureMessage(params);
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

// ── v3 helpers shared by every /proxy/* route ────────────────────────────────

export type ProxyContext = { customerId: string | null; shop: string; url: URL };

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/**
 * Verifies the HMAC first, then reads `shop` from the (now trusted) query.
 * Throws "invalid_proxy_signature" on any failure, including a missing shop.
 */
export function verifyProxyRequest(request: Request): ProxyContext {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("invalid_proxy_signature");
  const url = new URL(request.url);
  const customerId = extractProxyCustomerId(url, secret);
  const shop = url.searchParams.get("shop") ?? "";
  if (!SHOP_RE.test(shop)) throw new Error("invalid_proxy_signature");
  return { customerId, shop, url };
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** JSON response that is never cached. The proxy is same-origin, so no CORS headers. */
export function proxyJson(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...extra },
  });
}

/**
 * The first X-Forwarded-For entry (or X-Real-IP); null when absent. Used ONLY
 * as the rate-limit key for a request without a signed-in customer.
 *
 * This is NOT the shopper's address. Behind Shopify's app proxy and Railway's
 * edge, X-Forwarded-For on /proxy requests carries a Cloudflare egress address
 * that changes on every request plus a second edge address (seen on the dev
 * store, 19 Nov 2026). Never use it to tell shoppers apart (the old
 * "same network" referral rule was removed for this reason) and never store it.
 */
export function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || null;
}

// Fixed-window limiter, in process. The web service is a single Railway
// instance; if it is ever scaled out this must move to Redis.
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 20_000;

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): { allowed: boolean; retryAfterSec: number } {
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
      if (buckets.size >= MAX_BUCKETS) buckets.clear();
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  b.count += 1;
  if (b.count > limit) return { allowed: false, retryAfterSec: Math.ceil((b.resetAt - now) / 1000) };
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export const RATE_LIMITS = {
  customer: { limit: 30, windowMs: 60_000 },
  history: { limit: 40, windowMs: 60_000 },
  redeem: { limit: 5, windowMs: 60_000 },
  social: { limit: 10, windowMs: 60_000 },
  review: { limit: 5, windowMs: 60_000 },
  birthday: { limit: 5, windowMs: 60_000 },
  referral: { limit: 10, windowMs: 60_000 },
} as const;

export type ProxyRouteName = keyof typeof RATE_LIMITS;

/**
 * Standard preamble for a proxy route: HMAC, then rate limit. Returns either a
 * ready Response (to be returned as is) or the verified context.
 */
export function guardProxy(
  request: Request,
  route: ProxyRouteName,
): { response: Response; ctx?: undefined } | { response?: undefined; ctx: ProxyContext & { customerId: string } } {
  let ctx: ProxyContext;
  try {
    ctx = verifyProxyRequest(request);
  } catch {
    return { response: proxyJson({ ok: false, error: "unauthorized" }, 401) };
  }
  const who = ctx.customerId ?? `ip:${clientIp(request) ?? "unknown"}`;
  const rl = rateLimit(`${route}:${who}`, RATE_LIMITS[route].limit, RATE_LIMITS[route].windowMs);
  if (!rl.allowed) {
    return {
      response: proxyJson({ ok: false, error: "rate_limited" }, 429, { "Retry-After": String(rl.retryAfterSec) }),
    };
  }
  // Guests never call the proxy (the storefront renders their view from config).
  if (!ctx.customerId) return { response: proxyJson({ ok: false, error: "not_signed_in" }, 403) };
  return { ctx: { ...ctx, customerId: ctx.customerId } };
}

/** Reads a JSON object body; null when it is not valid JSON or not an object. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
