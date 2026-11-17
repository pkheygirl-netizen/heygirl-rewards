// Test helper: builds a request signed exactly like Shopify's app proxy does.
import crypto from "node:crypto";

export const TEST_SECRET = "test-proxy-secret";
export const TEST_SHOP = "heygirl-dev.myshopify.com";

export function signedRequest(
  path: string,
  opts: { customerId?: string | null; method?: string; body?: unknown; query?: Record<string, string>; shop?: string | null; tamper?: boolean; unsigned?: boolean; ip?: string } = {},
): Request {
  const params: Record<string, string> = {
    logged_in_customer_id: opts.customerId ?? "",
    path_prefix: "/apps/loyalty",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(opts.query ?? {}),
  };
  if (opts.shop !== null) params.shop = opts.shop ?? TEST_SHOP;
  // As Shopify documents: "key=value" strings, plain sort, no separator.
  const message = Object.keys(params).map((k) => `${k}=${params[k]}`).sort().join("");
  const signature = crypto.createHmac("sha256", TEST_SECRET).update(message).digest("hex");
  const qs = new URLSearchParams({ ...params, signature });
  if (opts.tamper) qs.set("logged_in_customer_id", "999");
  if (opts.unsigned) qs.delete("signature");
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? "203.0.113.7, 10.0.0.1" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://app.example/proxy/${path}?${qs}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body === undefined || opts.method === "GET" ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
}

export const args = (request: Request) => ({ request, params: {}, context: {} });
