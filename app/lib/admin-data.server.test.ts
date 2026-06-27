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
