import { describe, it, expect, vi } from "vitest";

describe("updateSettings", () => {
  it("drops non-whitelisted keys and writes the rest", async () => {
    const eq = vi.fn(() => Promise.resolve({ error: null }));
    const update = vi.fn(() => ({ eq }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { updateSettings } = await import("./admin-settings.server");
    await updateSettings({ program_name: "New Name", hacker_field: "x" } as any);
    expect(update).toHaveBeenCalledWith({ program_name: "New Name" });
    expect(eq).toHaveBeenCalledWith("id", 1);
  });

  it("throws when nothing editable remains", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { updateSettings } = await import("./admin-settings.server");
    await expect(updateSettings({ hacker_field: "x" } as any)).rejects.toThrow("no editable fields");
  });
});
