import { describe, it, expect, vi } from "vitest";

function makeMembersQuery(rows: any[], total: number) {
  const builder: any = {
    select: vi.fn(() => builder),
    or: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn(() => Promise.resolve({ data: rows, count: total, error: null })),
  };
  return builder;
}

describe("searchMembers", () => {
  it("returns members and total, applies tier filter", async () => {
    const rows = [
      {
        id: "m1",
        first_name: "Sara",
        last_name: "K",
        email: "sara@x.com",
        tier: "gold",
        points_balance: 4500,
        lifetime_spend_pkr: 60000,
        is_blocked: false,
        is_influencer: false,
      },
    ];
    const builder = makeMembersQuery(rows, 1);
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => builder) } }));
    vi.resetModules();
    const { searchMembers } = await import("./admin-members.server");
    const result = await searchMembers({ query: "sara", tier: "gold" });
    expect(result.total).toBe(1);
    expect(result.members[0].id).toBe("m1");
    expect(builder.or).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("tier", "gold");
  });
});

describe("adjustPoints", () => {
  it("rejects empty reason", async () => {
    vi.doMock("../db.server", () => ({ db: { rpc: vi.fn() } }));
    vi.resetModules();
    const { adjustPoints } = await import("./admin-members.server");
    await expect(
      adjustPoints({ memberId: "m1", points: 100, reason: "  " }),
    ).rejects.toThrow("reason required");
  });

  it("calls award_points RPC with adjustment type and returns new balance", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: [{ awarded: true, new_balance: 1100 }], error: null }),
    );
    vi.doMock("../db.server", () => ({ db: { rpc } }));
    vi.resetModules();
    const { adjustPoints } = await import("./admin-members.server");
    const res = await adjustPoints({ memberId: "m1", points: 100, reason: "goodwill" });
    expect(res.newBalance).toBe(1100);
    expect(rpc).toHaveBeenCalledWith(
      "award_points",
      expect.objectContaining({
        p_member_id: "m1",
        p_action_type: "adjustment",
        p_points: 100,
        p_reason_note: "goodwill",
      }),
    );
  });
});

describe("setInfluencer", () => {
  it("clears rate when untagging", async () => {
    const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { setInfluencer } = await import("./admin-members.server");
    await setInfluencer({ memberId: "m1", isInfluencer: false });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ is_influencer: false, influencer_referral_rate: null }),
    );
  });
});
