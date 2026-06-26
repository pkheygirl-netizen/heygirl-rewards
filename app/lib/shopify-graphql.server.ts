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
      extensions?: {
        cost?: {
          throttleStatus?: {
            status?: string;
            restoreRate?: number;
            currentlyAvailable?: number;
          };
        };
      };
    };

    const throttle = json.extensions?.cost?.throttleStatus;
    if (throttle?.status === "THROTTLED") {
      if (attempt >= maxRetries) throw new ShopifyRateLimitError();
      // Sleep long enough for the bucket to restore the estimated cost
      const restoreRate = throttle.restoreRate ?? 50;
      const sleepMs = Math.max(BASE_DELAY_MS, Math.ceil(1000 / restoreRate) * 100);
      await new Promise((r) => setTimeout(r, sleepMs));
      attempt++;
      continue;
    }

    if (!json.data) {
      throw new Error(`Shopify GraphQL returned no data: ${JSON.stringify(json)}`);
    }
    return json.data;
  }
  throw new ShopifyRateLimitError();
}
