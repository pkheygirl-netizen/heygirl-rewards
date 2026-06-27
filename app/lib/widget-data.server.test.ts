import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({
  db: {
    from: vi.fn(),
  },
}));
vi.mock("./redemption.service", () => ({
  getActiveLoyaltyCodes: vi.fn(),
}));

import { db } from "../db.server";
import { getActiveLoyaltyCodes } from "./redemption.service";
import { getMemberDashboard } from "./widget-data.server";

const mockSelect = (data: unknown) => ({
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
});

describe("getMemberDashboard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when member not found", async () => {
    vi.mocked(db.from).mockReturnValue(mockSelect(null) as never);
    vi.mocked(getActiveLoyaltyCodes).mockResolvedValue([]);
    const result = await getMemberDashboard("999");
    expect(result).toBeNull();
  });

  it("computes spendToNextTier for silver member", async () => {
    vi.mocked(db.from).mockReturnValue(
      mockSelect({
        id: "m1",
        first_name: "Aisha",
        tier: "silver",
        points_balance: 1200,
        lifetime_spend_pkr: 20000, // Rs.20,000 (stored in rupees)
        referral_slug: "aisha-1234",
        birthday_month: 3,
      }) as never
    );
    vi.mocked(getActiveLoyaltyCodes).mockResolvedValue([]);
    const result = await getMemberDashboard("123");
    expect(result?.tier).toBe("silver");
    expect(result?.lifetimeSpend).toBe(20000);
    expect(result?.nextTier).toBe("gold");
    expect(result?.spendToNextTier).toBe(30000); // 50000 - 20000
  });

  it("returns null nextTier for diamond members", async () => {
    vi.mocked(db.from).mockReturnValue(
      mockSelect({
        id: "m1",
        first_name: "Sara",
        tier: "diamond",
        points_balance: 50000,
        lifetime_spend_pkr: 120000, // Rs.120,000 (stored in rupees)
        referral_slug: "sara-9999",
        birthday_month: null,
      }) as never
    );
    vi.mocked(getActiveLoyaltyCodes).mockResolvedValue([]);
    const result = await getMemberDashboard("456");
    expect(result?.nextTier).toBeNull();
    expect(result?.spendToNextTier).toBe(0);
  });
});
