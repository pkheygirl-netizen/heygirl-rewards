import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/proxy-auth.server", () => ({
  extractProxyCustomerId: vi.fn(),
}));
vi.mock("../lib/widget-data.server", () => ({
  getMemberDashboard: vi.fn(),
  getNudgeSettings: vi.fn(),
}));
vi.mock("../lib/points.service", () => ({
  enrolLoggedInCustomer: vi.fn(),
}));
vi.mock("../shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));

import { extractProxyCustomerId } from "../lib/proxy-auth.server";
import { getMemberDashboard, getNudgeSettings } from "../lib/widget-data.server";
import { enrolLoggedInCustomer } from "../lib/points.service";
import { unauthenticated } from "../shopify.server";
import { loader } from "./proxy.customer";

const NUDGES = {
  nudge1_enabled: true,
  nudge2_enabled: true,
  nudge3_enabled: true,
  nudge5_enabled: true,
  tier_progress_gold_threshold: 5000,
  tier_progress_diamond_threshold: 10000,
};

const MEMBER = {
  memberId: "m1",
  firstName: "Aisha",
  tier: "silver" as const,
  balance: 4500,
  lifetimeSpend: 20000,
  nextTier: "gold" as const,
  spendToNextTier: 30000,
  activeCodes: [],
  referralSlug: "aisha-1234",
  birthdayMonth: null,
};

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
    vi.mocked(getMemberDashboard).mockResolvedValue(MEMBER);
    vi.mocked(getNudgeSettings).mockResolvedValue(NUDGES);
    const res = await loader({ request: makeRequest(), params: {}, context: {} });
    // Loader returns a per-branch union; cast for assertion access.
    const body = (await res.json()) as any;
    expect(body.loggedIn).toBe(true);
    expect(body.member.balance).toBe(4500);
    expect(body.member.tier).toBe("silver");
  });

  it("auto-enrols a logged-in customer with no member record, then returns the dashboard", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue("99");
    vi.mocked(getNudgeSettings).mockResolvedValue(NUDGES);
    // First lookup: no member. After enrolment: member exists.
    vi.mocked(getMemberDashboard)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(MEMBER);
    const adminStub = { graphql: vi.fn() };
    vi.mocked(unauthenticated.admin).mockResolvedValue({ admin: adminStub } as any);
    vi.mocked(enrolLoggedInCustomer).mockResolvedValue({ enrolled: true });

    const res = await loader({
      request: makeRequest("?shop=heygirl-dev.myshopify.com"),
      params: {},
      context: {},
    });
    const body = (await res.json()) as any;

    expect(unauthenticated.admin).toHaveBeenCalledWith("heygirl-dev.myshopify.com");
    expect(enrolLoggedInCustomer).toHaveBeenCalledWith("99", adminStub);
    expect(body.loggedIn).toBe(true);
    expect(body.member.balance).toBe(4500);
  });

  it("returns member:null when auto-enrol fails to produce a member", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue("99");
    vi.mocked(getNudgeSettings).mockResolvedValue(NUDGES);
    vi.mocked(getMemberDashboard).mockResolvedValue(null); // never becomes a member
    vi.mocked(unauthenticated.admin).mockResolvedValue({ admin: { graphql: vi.fn() } } as any);
    vi.mocked(enrolLoggedInCustomer).mockResolvedValue({ enrolled: false, reason: "no_email" });

    const res = await loader({
      request: makeRequest("?shop=heygirl-dev.myshopify.com"),
      params: {},
      context: {},
    });
    const body = (await res.json()) as any;
    expect(body.loggedIn).toBe(true);
    expect(body.member).toBeNull();
  });

  it("returns member:null and does not throw when admin auth fails", async () => {
    vi.mocked(extractProxyCustomerId).mockReturnValue("99");
    vi.mocked(getNudgeSettings).mockResolvedValue(NUDGES);
    vi.mocked(getMemberDashboard).mockResolvedValue(null);
    vi.mocked(unauthenticated.admin).mockRejectedValue(new Error("no session"));

    const res = await loader({
      request: makeRequest("?shop=heygirl-dev.myshopify.com"),
      params: {},
      context: {},
    });
    const body = (await res.json()) as any;
    expect(body.loggedIn).toBe(true);
    expect(body.member).toBeNull();
  });
});
