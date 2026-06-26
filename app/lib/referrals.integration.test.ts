import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({
  db: {
    from: vi.fn(),
  },
}));

import { awardReferral } from "./referrals.service";
import { db } from "../db.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

test("awardReferral: returns awarded=false when no pending referral", async () => {
  mockFrom.mockReturnValue({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  });

  const result = await awardReferral("12345");
  expect(result.awarded).toBe(false);
});
