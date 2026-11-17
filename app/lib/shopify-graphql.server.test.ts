import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GraphqlQueryError,
  HttpInternalError,
  HttpRequestError,
  HttpResponseError,
  HttpThrottlingError,
} from "@shopify/shopify-api";
import {
  classifyShopifyError,
  MAX_TOTAL_WAIT_MS,
  shopifyGraphqlWithRetry,
  ShopifyRateLimitError,
  type AdminGraphqlClient,
} from "./shopify-graphql.server";

// The real client throws; these build exactly what it throws
// (@shopify/shopify-api lib/clients/common.js throwFailedRequest).
const throttledQueryError = (available = 0, requested = 10) =>
  new GraphqlQueryError({
    message: "Throttled",
    response: {} as never,
    headers: {},
    body: {
      errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] },
      extensions: { cost: { requestedQueryCost: requested, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: available, restoreRate: 50 } } },
    } as never,
  });
const badQueryError = () =>
  new GraphqlQueryError({
    message: "Field 'nope' doesn't exist on type 'QueryRoot'",
    response: {} as never,
    headers: {},
    body: { errors: { graphQLErrors: [{ message: "Field 'nope' doesn't exist on type 'QueryRoot'" }] } } as never,
  });
const http429 = (retryAfter?: number) =>
  new HttpThrottlingError({ message: "Shopify is throttling requests", code: 429, statusText: "Too Many Requests", body: {}, headers: {}, retryAfter });
const http503 = () => new HttpInternalError({ message: "Shopify internal error", code: 503, statusText: "Service Unavailable", body: {}, headers: {} });
const http403 = () => new HttpResponseError({ message: "Forbidden", code: 403, statusText: "Forbidden", body: {}, headers: {} });

const OK = { data: { shop: { name: "OK" } } };
type Step = { throw: unknown } | { json: unknown };

function makeAdmin(steps: Step[]) {
  let call = 0;
  const graphql = vi.fn(async () => {
    const step = steps[Math.min(call++, steps.length - 1)];
    if ("throw" in step) throw step.throw;
    return { json: async () => step.json };
  });
  return { admin: { graphql } as unknown as AdminGraphqlClient, graphql };
}

const QUERY = "#graphql\n  query HgShop { shop { name } }";
const MUTATION = "#graphql\n  mutation HgThing($id: ID!) { thing(id: $id) { id } }";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Run to completion under fake timers and report how long the call slept. */
async function run<T>(p: Promise<T>): Promise<{ result?: T; error?: unknown; sleptMs: number }> {
  const start = Date.now();
  const settled = p.then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await settled), sleptMs: Date.now() - start };
}

describe("classifyShopifyError: the real thrown classes", () => {
  it("recognises throttling, transient failures and everything else", () => {
    expect(classifyShopifyError(throttledQueryError(0, 100))).toEqual({ kind: "throttled", waitMs: 2000 });
    expect(classifyShopifyError(http429(1.5))).toEqual({ kind: "throttled", waitMs: 1500 });
    expect(classifyShopifyError(http429())).toEqual({ kind: "throttled", waitMs: 1000 });
    expect(classifyShopifyError(http503())).toEqual({ kind: "transient" });
    expect(classifyShopifyError(new HttpRequestError("Http request error, no response available: socket hang up"))).toEqual({ kind: "transient" });
    expect(classifyShopifyError(badQueryError())).toEqual({ kind: "fatal" });
    expect(classifyShopifyError(http403())).toEqual({ kind: "fatal" });
    expect(classifyShopifyError(new Error("a bug"))).toEqual({ kind: "fatal" });
    expect(classifyShopifyError("nope")).toEqual({ kind: "fatal" });
  });

  it("recognises the Response the request-bound admin client throws", () => {
    expect(classifyShopifyError(new Response("{}", { status: 429, headers: { "Retry-After": "2" } }))).toEqual({ kind: "throttled", waitMs: 2000 });
    expect(classifyShopifyError(new Response("{}", { status: 429 }))).toEqual({ kind: "throttled", waitMs: 1000 });
    expect(classifyShopifyError(new Response("{}", { status: 502 }))).toEqual({ kind: "transient" });
    expect(classifyShopifyError(new Response("{}", { status: 401 }))).toEqual({ kind: "fatal" });
  });
});

describe("shopifyGraphqlWithRetry", () => {
  it("returns data on first success", async () => {
    const { admin, graphql } = makeAdmin([{ json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.result).toEqual(OK.data);
    expect(r.sleptMs).toBe(0);
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it("a thrown THROTTLED GraphqlQueryError is waited out and the call repeated", async () => {
    const { admin, graphql } = makeAdmin([{ throw: throttledQueryError(0, 100) }, { json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, MUTATION, { id: "1" }));
    expect(r.result).toEqual(OK.data);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(r.sleptMs).toBe(2000); // 100 points at 50 a second
  });

  it("a thrown HttpThrottlingError (429) waits Retry-After seconds, also for a mutation", async () => {
    const { admin, graphql } = makeAdmin([{ throw: http429(1.5) }, { json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, MUTATION, { id: "1" }));
    expect(r.result).toEqual(OK.data);
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(r.sleptMs).toBe(1500);
  });

  it("a thrown Response 429 / 503 from the request-bound client is retried", async () => {
    const { admin, graphql } = makeAdmin([
      { throw: new Response("{}", { status: 429 }) },
      { throw: new Response("{}", { status: 503 }) },
      { json: OK },
    ]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.result).toEqual(OK.data);
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("a query is retried after HttpInternalError and HttpRequestError with 0.5 s, 1 s back-off", async () => {
    const { admin, graphql } = makeAdmin([{ throw: http503() }, { throw: new HttpRequestError("no response") }, { json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.result).toEqual(OK.data);
    expect(graphql).toHaveBeenCalledTimes(3);
    expect(r.sleptMs).toBe(1500);
  });

  it("a mutation is NOT repeated after a 5xx (it may have run) unless the caller says it is safe", async () => {
    const original = http503();
    const once = makeAdmin([{ throw: original }, { json: OK }]);
    const r1 = await run(shopifyGraphqlWithRetry(once.admin, MUTATION, { id: "1" }));
    expect(r1.error).toBe(original); // unchanged, same object
    expect(once.graphql).toHaveBeenCalledTimes(1);

    const first = makeAdmin([{ throw: http503() }, { json: OK }]);
    const r2 = await run(shopifyGraphqlWithRetry(first.admin, MUTATION, { id: "1" }, 3, { retryTransient: true }));
    expect(r2.result).toEqual(OK.data);
    expect(first.graphql).toHaveBeenCalledTimes(2);
  });

  it("everything else is rethrown unchanged and never retried", async () => {
    for (const err of [badQueryError(), http403(), new Error("a bug"), new Response("{}", { status: 404 })]) {
      const { admin, graphql } = makeAdmin([{ throw: err }, { json: OK }]);
      const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
      expect(r.error).toBe(err);
      expect(graphql).toHaveBeenCalledTimes(1);
      expect(r.sleptMs).toBe(0);
    }
  });

  it("throttled for good: ShopifyRateLimitError after maxRetries repeats", async () => {
    const { admin, graphql } = makeAdmin([{ throw: throttledQueryError(0, 25) }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY, {}, 2));
    expect(r.error).toBeInstanceOf(ShopifyRateLimitError);
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("persistent 5xx: Shopify's own error comes back after the retries", async () => {
    const err = http503();
    const { admin, graphql } = makeAdmin([{ throw: err }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.error).toBe(err);
    expect(graphql).toHaveBeenCalledTimes(4);
    expect(r.sleptMs).toBe(3500); // 0.5 + 1 + 2
  });

  it("never sleeps longer than the bound: a long Retry-After ends the call at once", async () => {
    const { admin, graphql } = makeAdmin([{ throw: http429(30) }, { json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.error).toBeInstanceOf(ShopifyRateLimitError);
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(r.sleptMs).toBe(0);

    // Repeated 2.5 s waits stop before the total passes the bound.
    const slow = makeAdmin([{ throw: http429(2.5) }]);
    const r2 = await run(shopifyGraphqlWithRetry(slow.admin, QUERY, {}, 10));
    expect(r2.error).toBeInstanceOf(ShopifyRateLimitError);
    expect(r2.sleptMs).toBe(5000);
    expect(r2.sleptMs).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS);
    expect(slow.graphql).toHaveBeenCalledTimes(3);
  });

  it("still handles a client that returns throttling in the body instead of throwing", async () => {
    const throttled = { data: null, extensions: { cost: { throttleStatus: { status: "THROTTLED", restoreRate: 50, currentlyAvailable: 0 } } } };
    const { admin, graphql } = makeAdmin([{ json: throttled }, { json: OK }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(r.result).toEqual(OK.data);
    expect(graphql).toHaveBeenCalledTimes(2);

    const never = makeAdmin([{ json: throttled }]);
    const r2 = await run(shopifyGraphqlWithRetry(never.admin, QUERY, {}, 2));
    expect(r2.error).toBeInstanceOf(ShopifyRateLimitError);
  });

  it("GraphQL errors in a returned body are reported with their messages", async () => {
    const { admin } = makeAdmin([{ json: { errors: [{ message: "Access denied" }] } }]);
    const r = await run(shopifyGraphqlWithRetry(admin, QUERY));
    expect(String((r.error as Error).message)).toContain("Access denied");
  });
});
