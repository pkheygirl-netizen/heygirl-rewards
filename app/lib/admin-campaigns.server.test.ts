import { describe, it, expect, vi } from "vitest";

describe("createCampaign validation", () => {
  it("rejects multiplier < 1 and end<=start", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { createCampaign } = await import("./admin-campaigns.server");
    await expect(
      createCampaign({ name: "X", multiplier: 0.5, startsAt: "2026-07-01", endsAt: "2026-07-10", isActive: false }),
    ).rejects.toThrow("invalid campaign");
    await expect(
      createCampaign({ name: "X", multiplier: 2, startsAt: "2026-07-10", endsAt: "2026-07-01", isActive: false }),
    ).rejects.toThrow("invalid campaign");
  });
});

describe("createCampaign single-active rule", () => {
  it("deactivates others when creating an active campaign", async () => {
    const neq = vi.fn(() => Promise.resolve({ error: null }));
    const update = vi.fn(() => ({ neq }));
    const insert = vi.fn(() => Promise.resolve({ data: [{ id: "new" }], error: null }));
    const from = vi.fn(() => ({ update, insert }));
    vi.doMock("../db.server", () => ({ db: { from } }));
    vi.resetModules();
    const { createCampaign } = await import("./admin-campaigns.server");
    await createCampaign({ name: "Eid", multiplier: 2, startsAt: "2026-07-01", endsAt: "2026-07-10", isActive: true });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(insert).toHaveBeenCalled();
  });
});
