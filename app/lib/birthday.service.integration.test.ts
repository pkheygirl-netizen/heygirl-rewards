import { expect, test, vi, beforeEach } from "vitest";

vi.mock("../db.server", () => ({ db: { from: vi.fn() } }));
vi.mock("./shopify-graphql.server", () => ({ shopifyGraphqlWithRetry: vi.fn() }));

import { awardBirthdayReward } from "./birthday.service";
import { db } from "../db.server";

const mockFrom = db.from as ReturnType<typeof vi.fn>;
beforeEach(() => vi.clearAllMocks());

test("awardBirthdayReward: returns already_awarded_this_month on duplicate notification_log insert", async () => {
  mockFrom.mockReturnValue({
    insert: vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "duplicate key violates unique constraint" },
    }),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
  });
  const result = await awardBirthdayReward("member-uuid", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("already_awarded_this_month");
});

test("awardBirthdayReward: returns member_not_found when member query returns null", async () => {
  // First call: notification_log insert succeeds
  const mockInsert = vi.fn().mockResolvedValueOnce({ data: { id: "log-1" }, error: null });
  // Second call: members select returns null
  const mockMaybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null });
  // Third call: delete cleanup
  const mockDelete = vi.fn().mockReturnThis();
  const mockEq = vi.fn().mockReturnThis();

  mockFrom
    .mockReturnValueOnce({ insert: mockInsert }) // notification_log insert
    .mockReturnValueOnce({ select: vi.fn().mockReturnThis(), eq: mockEq, maybeSingle: mockMaybeSingle }) // members select
    .mockReturnValue({ delete: mockDelete, eq: mockEq }); // cleanup delete

  const result = await awardBirthdayReward("member-uuid", {} as any);
  expect(result.awarded).toBe(false);
  expect(result.reason).toBe("member_not_found");
});
