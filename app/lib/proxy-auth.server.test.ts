// app/lib/proxy-auth.server.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { extractProxyCustomerId } from "./proxy-auth.server";

describe("extractProxyCustomerId", () => {
  it("returns customer_id when Shopify signature is valid", () => {
    // Shopify App Proxy signs: sorted params (excluding signature) joined as key=value&...
    const secret = "test_secret";
    const params = new URLSearchParams({
      shop: "heygirl.myshopify.com",
      path_prefix: "/apps/loyalty",
      timestamp: "1700000000",
      customer_id: "42",
    });
    // Sort params alphabetically by key, join as key=value\n, HMAC-SHA256 hex
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const message = sorted.map(([k, v]) => `${k}=${v}`).join("");
    const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
    params.set("signature", sig);

    const url = new URL(`https://heygirl-rewards.onrender.com/proxy/customer?${params}`);
    const result = extractProxyCustomerId(url, secret);
    expect(result).toBe("42");
  });

  it("throws on invalid signature", () => {
    const url = new URL(
      "https://heygirl-rewards.onrender.com/proxy/customer?shop=x&signature=bad&timestamp=1"
    );
    expect(() => extractProxyCustomerId(url, "secret")).toThrow("invalid_proxy_signature");
  });

  it("returns null when customer_id is absent (guest)", () => {
    const secret = "test_secret";
    const params = new URLSearchParams({
      shop: "heygirl.myshopify.com",
      path_prefix: "/apps/loyalty",
      timestamp: "1700000000",
    });
    const sorted = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const message = sorted.map(([k, v]) => `${k}=${v}`).join("");
    const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
    params.set("signature", sig);
    const url = new URL(`https://heygirl-rewards.onrender.com/proxy/customer?${params}`);
    expect(extractProxyCustomerId(url, secret)).toBeNull();
  });
});
