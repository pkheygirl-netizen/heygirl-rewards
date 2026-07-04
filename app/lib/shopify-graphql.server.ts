export class ShopifyRateLimitError extends Error {
  constructor(message = "Shopify GraphQL rate limit exhausted after retries") {
    super(message);
    this.name = "ShopifyRateLimitError";
  }
}

const BASE_DELAY_MS = 500;

export async function shopifyGraphqlWithRetry<T>(
  admin: { graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<{ json: () => Promise<unknown> }> },
  query: string,
  variables?: Record<string, unknown>,
  maxRetries = 3,
): Promise<T> {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const res = await admin.graphql(query, { variables });
    const json = (await res.json()) as {
      data?: T;
      errors?: Array<{ message?: string; extensions?: { code?: string } }>;
      extensions?: {
        cost?: {
          requestedQueryCost?: number;
          throttleStatus?: {
            status?: string;
            restoreRate?: number;
            currentlyAvailable?: number;
          };
        };
      };
    };

    // Throttling surfaces two ways: extensions.cost.throttleStatus, or a
    // top-level errors[] entry with extensions.code === "THROTTLED" and no data.
    const throttle = json.extensions?.cost?.throttleStatus;
    const throttledError = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
    if (throttle?.status === "THROTTLED" || throttledError) {
      if (attempt >= maxRetries) throw new ShopifyRateLimitError();
      // Sleep until the bucket restores the requested cost (plus a floor)
      const restoreRate = throttle?.restoreRate ?? 50;
      const needed = Math.max(
        0,
        (json.extensions?.cost?.requestedQueryCost ?? 50) - (throttle?.currentlyAvailable ?? 0),
      );
      const sleepMs = Math.max(BASE_DELAY_MS, Math.ceil((needed / restoreRate) * 1000));
      await new Promise((r) => setTimeout(r, sleepMs));
      attempt++;
      continue;
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
  throw new ShopifyRateLimitError();
}
