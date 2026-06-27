import { describe, it, expect, vi } from "vitest";

describe("reviewAndUnblock", () => {
  it("rejects when referral is not blocked/flagged", async () => {
    const maybeSingle = vi.fn(() => Promise.resolve({ data: { status: "completed" }, error: null }));
    const eqSel = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: eqSel }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ select })) } }));
    vi.resetModules();
    const { reviewAndUnblock } = await import("./admin-referrals.server");
    await expect(reviewAndUnblock("r1")).rejects.toThrow("not blocked");
  });
});

describe("listReferrals", () => {
  it("flags ip match", async () => {
    const rows = [
      { id: "r1", referred_email: "a@x.com", status: "flagged", block_reason: "ip", created_at: "2026-06-01T00:00:00Z", completed_at: null, referred_ip: "1.1.1.1", referrer_ip: "1.1.1.1", members: { first_name: "Sara", last_name: "K" } },
    ];
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      lte: vi.fn(() => builder),
      order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    };
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => builder) } }));
    vi.resetModules();
    const { listReferrals } = await import("./admin-referrals.server");
    const result = await listReferrals({});
    expect(result[0].ipMatch).toBe(true);
    expect(result[0].referrerName).toBe("Sara K");
  });
});
