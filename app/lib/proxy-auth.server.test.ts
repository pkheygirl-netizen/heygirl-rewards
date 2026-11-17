// app/lib/proxy-auth.server.test.ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { extractProxyCustomerId, proxySignatureMessage } from "./proxy-auth.server";

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

describe("item 7: signature message is sorted as Shopify documents", () => {
  const secret = "test_secret";
  const sign = (message: string) => crypto.createHmac("sha256", secret).update(message).digest("hex");

  it("sorts whole key=value strings in plain byte order (mixed case, digits, prefixes)", () => {
    const p = new URLSearchParams("shop=x.myshopify.com&Zeta=1&a_b=2&a=3&ab=4&a1=5&_x=6&B=7&timestamp=9&signature=zz");
    // Byte order: upper case before "_" before lower case; "a=3" < "a1=5" < "a_b=2" < "ab=4".
    expect(proxySignatureMessage(p)).toBe("B=7Zeta=1_x=6a1=5a=3a_b=2ab=4shop=x.myshopify.comtimestamp=9");
    // A locale-aware key sort would give a different string, so this is a real difference.
    const localeOrder = [...new Set([...p.keys()])].filter((k) => k !== "signature").sort((a, b) => a.localeCompare(b)).map((k) => `${k}=${p.get(k)}`).join("");
    expect(localeOrder).not.toBe(proxySignatureMessage(p));
  });

  it("joins repeated parameters with a comma before sorting", () => {
    const p = new URLSearchParams("ids=2&shop=x&ids=1&ids=3");
    expect(proxySignatureMessage(p)).toBe("ids=2,1,3shop=x");
  });

  it("accepts a request signed that way and rejects the locale-sorted variant", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const pairs: Array<[string, string]> = [["shop", "x.myshopify.com"], ["a", "3"], ["a_b", "2"], ["a1", "5"], ["B", "7"], ["extra", "1"], ["extra", "2"], ["timestamp", ts], ["logged_in_customer_id", "42"]];
    const sp = new URLSearchParams(pairs);
    const good = new URL(`https://app.example/proxy/customer?${sp}&signature=${sign(proxySignatureMessage(sp))}`);
    expect(extractProxyCustomerId(good, secret)).toBe("42");

    const keys = [...new Set(pairs.map(([k]) => k))].sort((a, b) => a.localeCompare(b));
    const wrong = keys.map((k) => `${k}=${sp.getAll(k).join(",")}`).join("");
    expect(wrong).not.toBe(proxySignatureMessage(sp));
    const bad = new URL(`https://app.example/proxy/customer?${sp}&signature=${sign(wrong)}`);
    expect(() => extractProxyCustomerId(bad, secret)).toThrow("invalid_proxy_signature");
  });
});
