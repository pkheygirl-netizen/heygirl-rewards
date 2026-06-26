// app/routes/proxy.redeem.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/proxy-auth.server", () => ({ extractProxyCustomerId: vi.fn() }));
vi.mock("../lib/redemption.service", () => ({ redeemPoints: vi.fn() }));
vi.mock("../shopify.server", () => ({ unauthenticated: { admin: vi.fn() }, authenticate: { admin: vi.fn() } }));
vi.mock("../lib/queue.server", () => ({
  pointsQueue: { add: vi.fn() }, socialQueue: { add: vi.fn() },
  notificationQueue: { add: vi.fn() }, cronQueue: { add: vi.fn() },
}));

import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { redeemPoints } from "../lib/redemption.service";
import { unauthenticated } from "../shopify.server";
import { action } from "./proxy.redeem";

const makeRequest = (method = "POST", body?: object) =>
  new Request("https://heygirl-rewards.onrender.com/proxy/redeem", {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

describe("proxy.redeem action", () => {
  it("returns 204 on OPTIONS preflight", async () => {
    const res = await action({ request: makeRequest("OPTIONS"), params: {}, context: {} });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("returns 401 on invalid proxy signature", async () => {
    vi.mocked(extractProxyCustomerId).mockImplementation(() => { throw new Error("invalid_proxy_signature"); });
    const res = await action({ request: makeRequest("POST", { requestedPoints: 3000 }), params: {}, context: {} });
    expect(res.status).toBe(401);
  });

  it("returns 403 when guest (no customer_id)", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue(null);
    const res = await action({ request: makeRequest("POST", { requestedPoints: 3000 }), params: {}, context: {} });
    expect(res.status).toBe(403);
  });

  it("returns 200 with code when redemption succeeds", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue("42");
    vi.mocked(unauthenticated.admin).mockResolvedValue({ admin: { graphql: vi.fn() } } as never);
    vi.mocked(redeemPoints).mockResolvedValue({ redeemed: true, code: "REWARD-ABC123", discount_pkr: 100 } as never);
    const res = await action({ request: makeRequest("POST", { requestedPoints: 3000 }), params: {}, context: {} });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.redeemed).toBe(true);
    expect(body.code).toBe("REWARD-ABC123");
  });
});
