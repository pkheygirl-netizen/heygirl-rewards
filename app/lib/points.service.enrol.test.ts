import { describe, it, expect, vi, beforeEach } from "vitest";

const { maybeSingle, insert, pointsAdd } = vi.hoisted(() => ({
  maybeSingle: vi.fn(),
  insert: vi.fn(),
  pointsAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db.server", () => ({
  db: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle }) }),
      insert,
    }),
  },
}));
vi.mock("./queue.server", () => ({
  notificationQueue: { add: vi.fn().mockResolvedValue(undefined) },
  pointsQueue: { add: pointsAdd },
}));
vi.mock("./shopify-graphql.server", () => ({
  shopifyGraphqlWithRetry: vi.fn().mockResolvedValue({
    customer: { email: "a@b.com", firstName: "Aisha", lastName: "K" },
  }),
}));

import { enrolLoggedInCustomer } from "./points.service";

const admin = { graphql: vi.fn() };

describe("enrolLoggedInCustomer signup-points enqueue", () => {
  beforeEach(() => {
    pointsAdd.mockClear();
    insert.mockReset();
    maybeSingle.mockReset();
  });

  it("enqueues award_signup_points for a newly-enrolled member", async () => {
    maybeSingle.mockResolvedValue({ data: null }); // not yet a member
    insert.mockResolvedValue({ error: null }); // insert succeeds

    const res = await enrolLoggedInCustomer("123", admin);

    expect(res.enrolled).toBe(true);
    expect(pointsAdd).toHaveBeenCalledWith("award_signup_points", { shopifyCustomerId: "123" });
  });

  it("does NOT enqueue when the customer is already a member", async () => {
    maybeSingle.mockResolvedValue({ data: { id: "existing" } });

    const res = await enrolLoggedInCustomer("123", admin);

    expect(res.enrolled).toBe(false);
    expect(pointsAdd).not.toHaveBeenCalled();
  });
});
