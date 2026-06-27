import { describe, it, expect, vi } from "vitest";

describe("pointsToRs", () => {
  it("converts points to Rs at 4000pts=Rs.100", async () => {
    const { pointsToRs } = await import("./admin-influencers.server");
    expect(pointsToRs(4000)).toBe(100);
    expect(pointsToRs(6000)).toBe(150);
  });
});

describe("updateReferralSlug", () => {
  it("rejects invalid slug", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { updateReferralSlug } = await import("./admin-influencers.server");
    await expect(updateReferralSlug("m1", "Bad Slug!")).rejects.toThrow("invalid slug");
  });

  it("maps unique violation to 'slug taken'", async () => {
    const eq = vi.fn(() => Promise.resolve({ error: { code: "23505" } }));
    const update = vi.fn(() => ({ eq }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { updateReferralSlug } = await import("./admin-influencers.server");
    await expect(updateReferralSlug("m1", "sara-123")).rejects.toThrow("slug taken");
  });
});
