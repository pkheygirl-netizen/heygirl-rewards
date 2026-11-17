import { HttpMaxRetriesError, HttpRequestError } from "@shopify/shopify-api";

export class ShopifyRateLimitError extends Error {
  constructor(message = "Shopify GraphQL rate limit exhausted after retries") {
    super(message);
    this.name = "ShopifyRateLimitError";
  }
}

const BASE_DELAY_MS = 500;

/**
 * Upper bound on the time one call may spend SLEEPING between attempts (the
 * requests themselves are not counted). A customer-facing redeem call makes
 * one or two of these calls, so it can never hang on back-off for more than a
 * few seconds; a wait that would cross the bound ends the call instead.
 * 6 s covers a throttled bucket refilling (a discount mutation costs ~10
 * points, the bucket restores at least 50 a second), a short Retry-After, and
 * the three 5xx back-offs (0.5 s + 1 s + 2 s).
 */
export const MAX_TOTAL_WAIT_MS = 6_000;

/**
 * The slice of Shopify's Admin client the engine needs. Both the request-bound
 * client (`authenticate.admin`) and the background one (`getAdminForShop`)
 * satisfy it, and tests can pass a plain object.
 */
export type AdminGraphqlClient = {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

type GraphqlErrorItem = { message?: string; extensions?: { code?: string } };
type CostExtensions = {
  cost?: {
    requestedQueryCost?: number;
    throttleStatus?: { status?: string; restoreRate?: number; currentlyAvailable?: number };
  };
};

export type ShopifyFailure =
  /** Shopify refused to run the request for lack of capacity: it did NOT run, wait and repeat. */
  | { kind: "throttled"; waitMs: number }
  /** 5xx or no response at all: the request may or may not have run. */
  | { kind: "transient" }
  /** Anything else (bad query, 4xx, a bug): never retried, rethrown as it is. */
  | { kind: "fatal" };

function throttleWaitMs(ext: CostExtensions | undefined): number {
  const throttle = ext?.cost?.throttleStatus;
  const restoreRate = throttle?.restoreRate && throttle.restoreRate > 0 ? throttle.restoreRate : 50;
  const needed = Math.max(0, (ext?.cost?.requestedQueryCost ?? 50) - (throttle?.currentlyAvailable ?? 0));
  return Math.max(BASE_DELAY_MS, Math.ceil((needed / restoreRate) * 1000));
}

function retryAfterMs(seconds: unknown): number {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n * 1000) : 2 * BASE_DELAY_MS;
}

const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

/**
 * What a thrown error from `admin.graphql` means. The real client
 * (@shopify/shopify-api, called by shopify-app-remix with retries: 0) THROWS:
 *   GraphqlQueryError    HTTP 200 with GraphQL errors (THROTTLED included);
 *                        .body.errors.graphQLErrors, .body.extensions.cost
 *   HttpThrottlingError  HTTP 429; .response.code, .response.retryAfter (seconds)
 *   HttpInternalError    HTTP 5xx; .response.code
 *   HttpResponseError    any other status; .response.code
 *   HttpRequestError / HttpMaxRetriesError   no usable response
 * and the request-bound admin client turns every HttpResponseError into a
 * thrown `Response` carrying only the status and body.
 * Shapes are matched by structure first, so a second or bundled copy of the
 * library is recognised too.
 */
export function classifyShopifyError(err: unknown): ShopifyFailure {
  if (!err || typeof err !== "object") return { kind: "fatal" };

  // A thrown fetch Response (request-bound admin client).
  if (typeof Response !== "undefined" && err instanceof Response) {
    if (err.status === 429) return { kind: "throttled", waitMs: retryAfterMs(err.headers.get("Retry-After")) };
    if (err.status >= 500) return { kind: "transient" };
    return { kind: "fatal" };
  }

  const e = err as {
    name?: string;
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown } | null;
    graphQLErrors?: GraphqlErrorItem[];
    body?: { errors?: { graphQLErrors?: GraphqlErrorItem[] } | GraphqlErrorItem[]; extensions?: CostExtensions } | null;
    response?: { code?: unknown; status?: unknown; retryAfter?: unknown } | null;
  };
  // Shopify's error classes do not set `name` (it stays "Error"); the class
  // name is on the constructor.
  const names = new Set([e.name, (err as object).constructor?.name]);

  const bodyErrors = e.body?.errors;
  const list = (Array.isArray(bodyErrors) ? bodyErrors : bodyErrors?.graphQLErrors) ?? e.graphQLErrors;
  if (Array.isArray(list) && list.length > 0) {
    if (list.some((g) => g?.extensions?.code === "THROTTLED")) {
      return { kind: "throttled", waitMs: throttleWaitMs(e.body?.extensions) };
    }
    return { kind: "fatal" };
  }

  const status = Number(e.response?.code ?? e.response?.status);
  if (status === 429 || names.has("HttpThrottlingError")) {
    return { kind: "throttled", waitMs: retryAfterMs(e.response?.retryAfter) };
  }
  if (Number.isFinite(status) && status >= 500) return { kind: "transient" };
  if (Number.isFinite(status) && status >= 400) return { kind: "fatal" };
  if (err instanceof HttpRequestError || err instanceof HttpMaxRetriesError) return { kind: "transient" };
  if (names.has("HttpInternalError") || names.has("HttpRequestError") || names.has("HttpMaxRetriesError")) return { kind: "transient" };

  // Failures below the HTTP layer (undici / node sockets).
  const code = typeof e.code === "string" ? e.code : typeof e.cause?.code === "string" ? e.cause.code : "";
  if (NETWORK_CODES.has(code)) return { kind: "transient" };
  if (names.has("TypeError") && /fetch failed|network/i.test(String(e.message ?? ""))) return { kind: "transient" };

  return { kind: "fatal" };
}

export type RetryOptions = {
  /** Sleep budget for the whole call; default MAX_TOTAL_WAIT_MS. */
  maxTotalWaitMs?: number;
  /**
   * Repeat after a 5xx or a network failure. Such a request may already have
   * run, so the default is yes for queries and NO for mutations; a caller
   * passes true only for a mutation that is safe to send twice.
   */
  retryTransient?: boolean;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isMutation(query: string): boolean {
  return /^\s*(#[^\n]*\n\s*)*mutation\b/.test(query);
}

/**
 * Run one Admin GraphQL operation.
 *   throttled (THROTTLED error, HTTP 429): wait for the bucket / Retry-After, repeat
 *   transient (5xx, no response):          back off 0.5 s, 1 s, 2 s and repeat, when allowed
 *   anything else:                         rethrown unchanged
 * At most `maxRetries` repeats and never more than `maxTotalWaitMs` of waiting;
 * when either runs out a throttled call ends in ShopifyRateLimitError and a
 * transient one rethrows Shopify's own error.
 */
export async function shopifyGraphqlWithRetry<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
  maxRetries = 3,
  options: RetryOptions = {},
): Promise<T> {
  const budget = Math.max(0, options.maxTotalWaitMs ?? MAX_TOTAL_WAIT_MS);
  const retryTransient = options.retryTransient ?? !isMutation(query);
  let waited = 0;
  let transientSeen = 0;

  /** True when the wait was taken; false when the retry or time budget is spent. */
  const pause = async (attempt: number, ms: number): Promise<boolean> => {
    if (attempt >= maxRetries || waited + ms > budget) return false;
    waited += ms;
    await sleep(ms);
    return true;
  };

  for (let attempt = 0; ; attempt++) {
    let json: { data?: T; errors?: GraphqlErrorItem[]; extensions?: CostExtensions };
    try {
      const res = await admin.graphql(query, { variables });
      json = (await res.json()) as typeof json;
    } catch (err) {
      const failure = classifyShopifyError(err);
      if (failure.kind === "throttled") {
        if (await pause(attempt, failure.waitMs)) continue;
        throw new ShopifyRateLimitError();
      }
      if (failure.kind === "transient" && retryTransient) {
        if (await pause(attempt, BASE_DELAY_MS * 2 ** transientSeen++)) continue;
      }
      throw err;
    }

    // A client that returns `{ errors }` instead of throwing (tests, other
    // clients): extensions.cost.throttleStatus, or an errors[] entry with
    // extensions.code === "THROTTLED" and no data.
    const throttle = json.extensions?.cost?.throttleStatus;
    const throttledError = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttle?.status === "THROTTLED" || throttledError) {
      if (await pause(attempt, throttleWaitMs(json.extensions))) continue;
      throw new ShopifyRateLimitError();
    }

    // Surface real GraphQL errors with their detail instead of a generic
    // "no data" message.
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `Shopify GraphQL errors: ${json.errors.map((e) => e.message ?? "unknown").join("; ")}`,
      );
    }
    if (!json.data) {
      throw new Error(`Shopify GraphQL returned no data: ${JSON.stringify(json)}`);
    }
    return json.data;
  }
}
