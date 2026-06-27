import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/proxy-auth.server", () => ({
  extractProxyCustomerId: vi.fn(),
}));
vi.mock("../lib/widget-data.server", () => ({
  getMemberDashboard: vi.fn(),
  getNudgeSettings: vi.fn(),
}));

import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getMemberDashboard, getNudgeSettings } from "../lib/widget-data.server";
import { loader } from "./proxy.customer";

const makeRequest = (search = "") =>
  new Request(`https://heygirl-rewards.onrender.com/proxy/customer${search}`);

describe("proxy.customer loader", () => {
  it("returns 401 on invalid proxy signature", async () => {
    vi.mocked(extractProxyCustomerId).mockImplementation(() => {
      throw new Error("invalid_proxy_signature");
    });
    const res = await loader({ request: makeRequest(), params: {}, context: {} });
    expect(res.status).toBe(401);
  });

  it("returns guest payload when no customer_id", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue(null);
    vi.mocked(getNudgeSettings).mockResolvedValue({
      nudge1_enabled: true,
      nudge2_enabled: true,
      nudge3_enabled: true,
      nudge5_enabled: true,
      tier_progress_gold_threshold: 5000,
      tier_progress_diamond_threshold: 10000,
    });
    const res = await loader({ request: makeRequest(), params: {}, context: {} });
    // Loader returns a per-branch union; cast for assertion access.
    const body = (await res.json()) as any;
    expect(body.loggedIn).toBe(false);
    expect(body.nudgeSettings).toBeDefined();
  });

  it("returns member data when logged in", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue("42");
    vi.mocked(getMemberDashboard).mockResolvedValue({
      memberId: "m1",
      firstName: "Aisha",
      tier: "silver",
      balance: 4500,
      lifetimeSpend: 20000,
      nextTier: "gold",
      spendToNextTier: 30000,
      activeCodes: [],
      referralSlug: "aisha-1234",
      birthdayMonth: null,
    });
    vi.mocked(getNudgeSettings).mockResolvedValue({
      nudge1_enabled: true,
      nudge2_enabled: true,
      nudge3_enabled: true,
      nudge5_enabled: true,
      tier_progress_gold_threshold: 5000,
      tier_progress_diamond_threshold: 10000,
    });
    const res = await loader({ request: makeRequest(), params: {}, context: {} });
    // Loader returns a per-branch union; cast for assertion access.
    const body = (await res.json()) as any;
    expect(body.loggedIn).toBe(true);
    expect(body.member.balance).toBe(4500);
    expect(body.member.tier).toBe("silver");
  });
});
