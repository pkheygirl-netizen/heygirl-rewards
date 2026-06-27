// app/lib/proxy-auth.server.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { extractProxyCustomerId } from "./proxy-auth.server";

function makeSignedUrl(params: Record<string, string>, secret: string): URL {
  const sp = new URLSearchParams(params);
  const sorted = [...sp.entries()].sort(([a], [b]) => a.localeCompare(b));
  const message = sorted.map(([k, v]) => `${k}=${v}`).join("");
  const sig = crypto.createHmac("sha256", secret).update(message).digest("hex");
  sp.set("signature", sig);
  return new URL(`https://heygirl-rewards.onrender.com/proxy/customer?${sp}`);
}

describe("extractProxyCustomerId", () => {
  it("returns logged_in_customer_id when Shopify signature is valid", () => {
    const secret = "test_secret";
    const ts = String(Math.floor(Date.now() / 1000));
    const url = makeSignedUrl(
      { shop: "heygirl.myshopify.com", path_prefix: "/apps/loyalty", timestamp: ts, logged_in_customer_id: "42" },
      secret,
    );
    expect(extractProxyCustomerId(url, secret)).toBe("42");
  });

  it("throws on invalid signature", () => {
    const url = new URL(
      `https://heygirl-rewards.onrender.com/proxy/customer?shop=x&signature=bad&timestamp=${Math.floor(Date.now() / 1000)}`
    );
    expect(() => extractProxyCustomerId(url, "secret")).toThrow("invalid_proxy_signature");
  });

  it("throws on stale timestamp (replay attack)", () => {
    const secret = "test_secret";
    const staleTs = String(Math.floor(Date.now() / 1000) - 400); // outside 300s window
    const url = makeSignedUrl(
      { shop: "heygirl.myshopify.com", path_prefix: "/apps/loyalty", timestamp: staleTs },
      secret,
    );
    expect(() => extractProxyCustomerId(url, secret)).toThrow("invalid_proxy_signature");
  });

  it("returns null when logged_in_customer_id is absent (guest)", () => {
    const secret = "test_secret";
    const ts = String(Math.floor(Date.now() / 1000));
    const url = makeSignedUrl(
      { shop: "heygirl.myshopify.com", path_prefix: "/apps/loyalty", timestamp: ts },
      secret,
    );
    expect(extractProxyCustomerId(url, secret)).toBeNull();
  });
});
