import { beforeEach, expect, it, vi } from "vitest";
import { fakeAdmin, h, opName, resetHarness } from "./testing/harness";
import { ensureRewardsPage } from "./rewards-page.server";

beforeEach(() => {
  resetHarness();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

it("creates /pages/rewards with the current pageCreate shape when it does not exist", async () => {
  h.graphql = (q) =>
    opName(q) === "HgFindRewardsPage"
      ? { pages: { nodes: [] } }
      : { pageCreate: { page: { id: "gid://shopify/Page/1", handle: "rewards" }, userErrors: [] } };
  expect(await ensureRewardsPage(fakeAdmin)).toEqual({ created: true, exists: true });
  const create = h.graphqlCalls[1];
  expect(create.query).toContain("pageCreate(page: $page)");
  expect(create.variables.page).toMatchObject({ title: "Rewards", handle: "rewards", isPublished: true });
  expect(h.graphqlCalls.map((c) => c.query).join("\n")).not.toMatch(/scriptTag/i); // script tags are gone
});

it("does nothing when the page exists", async () => {
  h.graphql = () => ({ pages: { nodes: [{ id: "gid://shopify/Page/1", handle: "rewards" }] } });
  expect(await ensureRewardsPage(fakeAdmin)).toEqual({ created: false, exists: true });
  expect(h.graphqlCalls).toHaveLength(1);
});

it("checks userErrors and never throws (install must not be blocked)", async () => {
  h.graphql = (q) =>
    opName(q) === "HgFindRewardsPage" ? { pages: { nodes: [] } } : { pageCreate: { page: null, userErrors: [{ field: ["handle"], message: "taken" }] } };
  expect(await ensureRewardsPage(fakeAdmin)).toEqual({ created: false, exists: false, reason: "user_errors" });
  h.graphql = () => { throw new Error("network"); };
  expect(await ensureRewardsPage(fakeAdmin)).toEqual({ created: false, exists: false, reason: "request_failed" });
});
