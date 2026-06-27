// app/lib/admin-data.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const counts: Record<string, number> = { silver: 5, gold: 2, diamond: 1 };

vi.mock("../db.server", () => {
  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === "members") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((_col: string, tier: string) =>
                Promise.resolve({ count: counts[tier] ?? 0, error: null }),
              ),
            })),
          };
        }
        throw new Error("unexpected table " + table);
      }),
    },
  };
});

describe("getTierBreakdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns counts per tier", async () => {
    const { getTierBreakdown } = await import("./admin-data.server");
    const result = await getTierBreakdown();
    expect(result).toEqual({ silver: 5, gold: 2, diamond: 1 });
  });
});

describe("getPointsIssuedSeries", () => {
  it("buckets positive ledger points by day", async () => {
    const rows = [
      { points: 1000, earned_at: "2026-06-01T10:00:00Z" },
      { points: 200, earned_at: "2026-06-01T18:00:00Z" },
      { points: -50, earned_at: "2026-06-01T19:00:00Z" }, // excluded (negative)
      { points: 500, earned_at: "2026-06-02T08:00:00Z" },
    ];
    vi.doMock("../db.server", () => ({
      db: {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            gt: vi.fn(() => ({
              gte: vi.fn(() => ({
                lt: vi.fn(() => Promise.resolve({ data: rows, error: null })),
              })),
            })),
          })),
        })),
      },
    }));
    vi.resetModules();
    const { getPointsIssuedSeries } = await import("./admin-data.server");
    const series = await getPointsIssuedSeries(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-03T00:00:00Z"),
    );
    expect(series).toEqual([
      { date: "2026-06-01", points: 1200 },
      { date: "2026-06-02", points: 500 },
    ]);
  });
});

describe("getActivityFeed", () => {
  it("merges and sorts recent events newest-first", async () => {
    vi.resetModules();
    vi.doMock("../db.server", () => ({
      db: {
        from: vi.fn((table: string) => ({
          select: vi.fn(() => ({
            gte: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() =>
                  Promise.resolve({
                    data:
                      table === "points_ledger"
                        ? [
                            {
                              id: "l1",
                              points: 1200,
                              action_type: "purchase",
                              earned_at: "2026-06-26T10:00:00Z",
                              members: { first_name: "Sara", last_name: "K" },
                            },
                          ]
                        : table === "loyalty_codes"
                          ? [
                              {
                                id: "c1",
                                created_at: "2026-06-26T11:00:00Z",
                                members: { first_name: "Mina", last_name: "A" },
                              },
                            ]
                          : [
                              {
                                id: "r1",
                                completed_at: "2026-06-26T09:00:00Z",
                                members: { first_name: "Zoya", last_name: "B" },
                              },
                            ],
                    error: null,
                  }),
                ),
              })),
            })),
          })),
        })),
      },
    }));
    const { getActivityFeed } = await import("./admin-data.server");
    const feed = await getActivityFeed(10);
    expect(feed.map((f) => f.id)).toEqual(["c1", "l1", "r1"]);
    expect(feed[1]).toMatchObject({ kind: "earn", memberName: "Sara K" });
  });
});
