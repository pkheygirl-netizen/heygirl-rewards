import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ webhook: vi.fn() }));
vi.mock("../shopify.server", () => ({ authenticate: auth, sessionStorage: {} }));
vi.mock("../db.server", async () => (await import("../lib/testing/harness")).dbModule());
vi.mock("../lib/queue.server", async () => (await import("../lib/testing/harness")).queueModule());
vi.mock("../lib/worker-admin.server", async () => (await import("../lib/testing/harness")).adminModule());

import { h, resetHarness, seedMember } from "../lib/testing/harness";
import { action as ordersCreate } from "./webhooks.orders-create";
import { action as ordersUpdated } from "./webhooks.orders-updated";
import { action as ordersFulfilled } from "./webhooks.orders-fulfilled";
import { action as ordersCancelled } from "./webhooks.orders-cancelled";
import { action as refundsCreate } from "./webhooks.refunds-create";
import { action as customersCreate } from "./webhooks.customers-create";
import { action as shopRedact } from "./webhooks.shop-redact";
import { action as customersRedact } from "./webhooks.customers-redact";

const SHOP = "store.myshopify.com";
const args = () => ({ request: new Request("https://app.example/webhooks/x", { method: "POST" }), params: {}, context: {} }) as never;
const deliver = (topic: string, payload: unknown) => auth.webhook.mockResolvedValue({ topic, shop: SHOP, payload });
const orderPayload = (over = {}) => ({
  id: 5001, name: "#1001", created_at: "2026-11-10T10:00:00+05:00", total_price: "3250.00",
  total_shipping_price_set: { shop_money: { amount: "250.00" } }, total_tax: "0.00",
  fulfillment_status: null, financial_status: "pending", discount_codes: [], payment_gateway_names: ["Cash on Delivery (COD)"],
  customer: { id: 42, email: "c@example.com", first_name: "Sara" }, ...over,
});

beforeEach(() => {
  resetHarness();
  auth.webhook.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("order webhooks parse and queue; the worker does the work", () => {
  it.each([
    ["orders/create", ordersCreate],
    ["orders/updated", ordersUpdated],
    ["orders/fulfilled", ordersFulfilled],
  ])("%s queues an order_event with the shop from the signed request", async (topic, action) => {
    deliver(topic, orderPayload());
    const res = await action(args());
    expect(res.status).toBe(200);
    const job = h.points.named("order_event")[0];
    expect(job.data).toMatchObject({ shop: SHOP, topic, event: { id: "5001", merchandisePkr: 3000, customer: { id: "42" } } });
  });

  it("orders without a customer are acknowledged and not queued", async () => {
    deliver("orders/create", orderPayload({ customer: null }));
    expect((await ordersCreate(args())).status).toBe(200);
    expect(h.points.jobs).toHaveLength(0);
  });

  it("a queue failure answers 503 so Shopify retries", async () => {
    deliver("orders/create", orderPayload());
    h.points.add = async () => { throw new Error("redis down"); };
    expect((await ordersCreate(args())).status).toBe(503);
  });

  it("orders/cancelled queues an order_cancelled job that always carries a cancellation time", async () => {
    deliver("orders/cancelled", orderPayload({ cancelled_at: null }));
    expect((await ordersCancelled(args())).status).toBe(200);
    const job = h.points.named("order_cancelled")[0];
    expect((job.data.event as { cancelledAt: string | null }).cancelledAt).not.toBeNull();
  });
});

describe("refunds/create", () => {
  it("queues by order id; the payload has no customer (finding B3)", async () => {
    deliver("refunds/create", { id: 9001, order_id: 5001, refund_line_items: [{ quantity: 1, subtotal: 500, line_item: { quantity: 1, price: "500.00", discount_allocations: [] } }] });
    expect((await refundsCreate(args())).status).toBe(200);
    const job = h.points.named("refund_event")[0];
    expect(job.data.event).toEqual({ refundId: "9001", orderId: "5001", refundedMerchandisePkr: 500, refundedTaxPkr: 0, amountOnly: false });
    expect(job.opts).toBeUndefined(); // M4: no fixed job id; the database counts each refund once
  });
  it("a payload without an order id is acknowledged and ignored", async () => {
    deliver("refunds/create", { id: 9001 });
    expect((await refundsCreate(args())).status).toBe(200);
    expect(h.points.jobs).toHaveLength(0);
  });
});

describe("customers/create", () => {
  it("queues enrolment, including phone-only customers", async () => {
    deliver("customers/create", { id: 77, email: null, phone: "+923001234567", first_name: "Hina" });
    expect((await customersCreate(args())).status).toBe(200);
    expect(h.points.named("enrol_member")[0].data).toEqual({ customer: { id: "77", email: null, phone: "+923001234567", first_name: "Hina", last_name: null } });
  });
});

describe("privacy webhooks", () => {
  it("shop/redact answers 200, deletes nothing, and records the request", async () => {
    const m = seedMember(h.db, { points_balance: 9000 });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "x", points: 9000, balance_after: 9000 });
    deliver("shop/redact", { shop_id: 1, shop_domain: SHOP });
    expect((await shopRedact(args())).status).toBe(200);
    expect(h.db.table("members")).toHaveLength(1);
    expect(h.db.table("points_ledger")).toHaveLength(1);
    expect(m.points_balance).toBe(9000);
    expect(h.db.table("gdpr_requests")[0]).toMatchObject({ type: "shop_redact" });
    expect(h.db.table("system_heartbeat")[0].key).toBe("alert:shop_redact");
  });

  it("shop/redact answers 500 when the request cannot be recorded, so Shopify retries", async () => {
    h.db.failNext("gdpr_requests", "insert", { code: "XX000", message: "db down" });
    deliver("shop/redact", {});
    expect((await shopRedact(args())).status).toBe(500);
  });

  it("customers/redact anonymises the member and logs the request", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "42", first_name: "Sara" });
    deliver("customers/redact", { customer: { id: 42 } });
    expect((await customersRedact(args())).status).toBe(200);
    expect(m.first_name).toBeNull();
    expect(h.db.table("gdpr_requests")[0]).toMatchObject({ type: "customer_redact", shopify_customer_id: "42", status: "fulfilled" });
  });
});

describe("fix round: webhook payloads", () => {
  it("H2: an amount-only refund is queued with the refunded money, not dropped", async () => {
    deliver("refunds/create", { id: 9002, order_id: 5001, refund_line_items: [], transactions: [{ kind: "refund", status: "success", gateway: "manual", amount: "400.00" }] });
    expect((await refundsCreate(args())).status).toBe(200);
    expect(h.points.named("refund_event")[0].data.event).toEqual({ refundId: "9002", orderId: "5001", refundedMerchandisePkr: 400, refundedTaxPkr: 0, amountOnly: true });
  });

  it("H1: the order event carries Shopify's updated_at and the original figures", async () => {
    deliver("orders/updated", orderPayload({ updated_at: "2026-11-10T12:00:00+05:00", current_total_price: "2250.00", taxes_included: true }));
    await ordersUpdated(args());
    expect(h.points.named("order_event")[0].data.event).toMatchObject({
      updatedAt: "2026-11-10T12:00:00+05:00", merchandisePkr: 2000, grossMerchandisePkr: 3000, taxesIncluded: true,
    });
  });

  it("M4: customers/create is queued without a fixed job id", async () => {
    deliver("customers/create", { id: 78, email: "x@example.com" });
    await customersCreate(args());
    expect(h.points.named("enrol_member")[0].opts).toBeUndefined();
  });
});
