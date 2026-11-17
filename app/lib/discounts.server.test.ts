import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());

import { fakeAdmin, h, opName, resetHarness, seedMember } from "./testing/harness";
import {
  createCustomerAmountOffCode,
  createCustomerFreeShippingCode,
  createPublicPercentageCode,
  deactivateDiscount,
  deleteDiscount,
  deterministicCode,
  findDiscountIdByCode,
  issueAutomaticCode,
} from "./discounts.server";

const NODE = "gid://shopify/DiscountCodeNode/1";
const ends = new Date("2026-12-16T00:00:00Z");

beforeEach(() => {
  resetHarness();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("create mutations", () => {
  it("amount off: customer-locked, single use, combines with nothing, never the removed priceRule calls", async () => {
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const r = await createCustomerAmountOffCode(fakeAdmin, { code: "REWARD-X", title: "t", amountPkr: 250, shopifyCustomerId: "77", endsAt: ends });
    expect(r).toEqual({ ok: true, discountId: NODE });
    const call = h.graphqlCalls[0];
    expect(call.query).toContain("discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount)");
    expect(call.query).not.toMatch(/priceRule/i);
    const input = call.variables.basicCodeDiscount as Record<string, any>;
    expect(input.code).toBe("REWARD-X");
    expect(input.usageLimit).toBe(1);
    expect(input.appliesOncePerCustomer).toBe(true);
    expect(input.context).toEqual({ customers: { add: ["gid://shopify/Customer/77"] } });
    expect(input.customerGets).toEqual({ items: { all: true }, value: { discountAmount: { amount: "250.00", appliesOnEachItem: false } } });
    expect(input.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: false });
    expect(input.endsAt).toBe(ends.toISOString());
    expect(input).not.toHaveProperty("customerSelection");
  });

  it("free shipping: customer-locked, all destinations", async () => {
    h.graphql = () => ({ discountCodeFreeShippingCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const r = await createCustomerFreeShippingCode(fakeAdmin, { code: "WELCOME-1", title: "t", shopifyCustomerId: "gid://shopify/Customer/5", endsAt: ends });
    expect(r.ok).toBe(true);
    const input = h.graphqlCalls[0].variables.freeShippingCodeDiscount as Record<string, any>;
    expect(h.graphqlCalls[0].query).toContain("discountCodeFreeShippingCreate(freeShippingCodeDiscount: $freeShippingCodeDiscount)");
    expect(input.context).toEqual({ customers: { add: ["gid://shopify/Customer/5"] } });
    expect(input.destination).toEqual({ all: true });
    expect(input.usageLimit).toBe(1);
  });

  it("influencer code: public, percentage as a fraction, no usage limit or end date", async () => {
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const r = await createPublicPercentageCode(fakeAdmin, { code: "AYESHA10", title: "t", percentOff: 10 });
    expect(r.ok).toBe(true);
    const input = h.graphqlCalls[0].variables.basicCodeDiscount as Record<string, any>;
    expect(input.context).toEqual({ all: "ALL" });
    expect(input.customerGets.value).toEqual({ percentage: 0.1 });
    expect(input.usageLimit).toBeUndefined();
    expect(input.endsAt).toBeUndefined();
    expect(input.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: false });
  });

  it("reports userErrors instead of success", async () => {
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ["code"], message: "bad", code: "INVALID" }] } });
    const r = await createCustomerAmountOffCode(fakeAdmin, { code: "X", title: "t", amountPkr: 100, shopifyCustomerId: "1", endsAt: ends });
    expect(r).toMatchObject({ ok: false, reason: "user_errors" });
  });

  it("a TAKEN code is reported as code_taken", async () => {
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "taken", code: "TAKEN" }] } });
    const r = await createPublicPercentageCode(fakeAdmin, { code: "X10", title: "t", percentOff: 10 });
    expect(r).toMatchObject({ ok: false, reason: "code_taken" });
  });

  it("a thrown request is reported, not thrown", async () => {
    h.graphql = () => { throw new Error("network"); };
    const r = await createCustomerFreeShippingCode(fakeAdmin, { code: "X", title: "t", shopifyCustomerId: "1", endsAt: ends });
    expect(r).toMatchObject({ ok: false, reason: "request_failed" });
  });

  it("refuses a zero amount and an out-of-range percentage without calling Shopify", async () => {
    expect((await createCustomerAmountOffCode(fakeAdmin, { code: "X", title: "t", amountPkr: 0, shopifyCustomerId: "1", endsAt: ends })).ok).toBe(false);
    expect((await createPublicPercentageCode(fakeAdmin, { code: "X", title: "t", percentOff: 150 })).ok).toBe(false);
    expect(h.graphqlCalls).toHaveLength(0);
  });
});

describe("deactivate / delete / find", () => {
  it("deactivate returns the usage count and checks userErrors", async () => {
    h.graphql = () => ({ discountCodeDeactivate: { codeDiscountNode: { id: NODE, codeDiscount: { asyncUsageCount: 1 } }, userErrors: [] } });
    expect(await deactivateDiscount(fakeAdmin, NODE)).toEqual({ ok: true, usageCount: 1 });
    expect(h.graphqlCalls[0].variables).toEqual({ id: NODE });
    h.graphql = () => ({ discountCodeDeactivate: { codeDiscountNode: null, userErrors: [{ message: "nope" }] } });
    expect((await deactivateDiscount(fakeAdmin, NODE)).ok).toBe(false);
  });

  it("delete checks userErrors and the deleted id", async () => {
    h.graphql = () => ({ discountCodeDelete: { deletedCodeDiscountId: NODE, userErrors: [] } });
    expect(await deleteDiscount(fakeAdmin, NODE)).toEqual({ ok: true });
    h.graphql = () => ({ discountCodeDelete: { deletedCodeDiscountId: null, userErrors: [] } });
    expect((await deleteDiscount(fakeAdmin, NODE)).ok).toBe(false);
  });

  it("findDiscountIdByCode", async () => {
    h.graphql = () => ({ codeDiscountNodeByCode: { id: NODE } });
    expect(await findDiscountIdByCode(fakeAdmin, "abc")).toBe(NODE);
    h.graphql = () => ({ codeDiscountNodeByCode: null });
    expect(await findDiscountIdByCode(fakeAdmin, "abc")).toBeNull();
  });
});

describe("issueAutomaticCode (two-step, idempotent)", () => {
  const base = (memberId: string) => ({
    admin: fakeAdmin, memberId, shopifyCustomerId: "C1", kind: "birthday" as const, issueKey: `birthday:${memberId}:2026`,
    title: "Birthday", discountPkr: 500, freeShipping: false, expiryDays: 30,
  });

  it("the code text is fixed per issue key", () => {
    expect(deterministicCode("birthday", "birthday:m:2026")).toBe(deterministicCode("birthday", "birthday:m:2026"));
    expect(deterministicCode("birthday", "birthday:m:2026")).not.toBe(deterministicCode("birthday", "birthday:m:2027"));
    expect(deterministicCode("tier_gold", "tier_gold:m")).toMatch(/^GOLD-[0-9A-F]{10}$/);
  });

  it("happy path: pending row, Shopify create, then active with the discount id", async () => {
    const m = seedMember(h.db);
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const r = await issueAutomaticCode(base(String(m.id)));
    expect(r.issued).toBe(true);
    const row = h.db.table("loyalty_codes")[0];
    expect(row).toMatchObject({ status: "active", kind: "birthday", shopify_discount_id: NODE, points_spent: 0, discount_amount_pkr: 500 });
  });

  it("a second call after success issues nothing", async () => {
    const m = seedMember(h.db);
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    await issueAutomaticCode(base(String(m.id)));
    const again = await issueAutomaticCode(base(String(m.id)));
    expect(again).toMatchObject({ issued: false, reason: "already_issued" });
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("Shopify failure keeps the pending row; the retry finishes it without a second row", async () => {
    const m = seedMember(h.db);
    h.graphql = () => { throw new Error("502"); };
    const first = await issueAutomaticCode(base(String(m.id)));
    expect(first).toMatchObject({ issued: false, reason: "shopify_error" });
    expect(h.db.table("loyalty_codes")[0].status).toBe("pending"); // not lost

    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const second = await issueAutomaticCode(base(String(m.id)));
    expect(second.issued).toBe(true);
    expect(h.db.table("loyalty_codes")).toHaveLength(1); // not duplicated
    expect(h.db.table("loyalty_codes")[0].status).toBe("active");
  });

  it("if Shopify already has the code (crash after create), the existing discount is adopted", async () => {
    const m = seedMember(h.db);
    h.db.failNext("loyalty_codes", "update", { code: "XX000", message: "db blip" });
    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    expect((await issueAutomaticCode(base(String(m.id)))).issued).toBe(false); // created in Shopify, row still pending

    h.graphql = (q) =>
      opName(q) === "HgCodeDiscountNodeByCode"
        ? { codeDiscountNodeByCode: { id: NODE } }
        : { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "taken", code: "TAKEN" }] } };
    const retry = await issueAutomaticCode(base(String(m.id)));
    expect(retry.issued).toBe(true);
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ status: "active", shopify_discount_id: NODE });
  });

  it("free-shipping kinds use the free-shipping mutation", async () => {
    const m = seedMember(h.db);
    h.graphql = () => ({ discountCodeFreeShippingCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const r = await issueAutomaticCode({ ...base(String(m.id)), kind: "tier_gold", issueKey: `tier_gold:${m.id}`, discountPkr: 0, freeShipping: true });
    expect(r.issued).toBe(true);
    expect(opName(h.graphqlCalls[0].query)).toBe("HgDiscountCodeFreeShippingCreate");
  });
});
