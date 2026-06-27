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
