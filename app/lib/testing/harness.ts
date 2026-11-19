// app/lib/testing/harness.ts
// Shared state for unit tests. Each test file mocks the infrastructure modules
// with getters that read from `h`, then calls resetHarness() in beforeEach:
//
//   vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
//   vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
//   vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());
import { FakeDb, fakeQueue, type Row } from "./fake-db";

type GraphqlHandler = (query: string, variables: Record<string, unknown>) => unknown;

export const h = {
  db: new FakeDb(),
  points: fakeQueue(),
  notifications: fakeQueue(),
  social: fakeQueue(),
  cron: fakeQueue(),
  /** Every Admin GraphQL call made through the fake admin client. */
  graphqlCalls: [] as Array<{ query: string; variables: Record<string, unknown> }>,
  /** Decides what Shopify "returns"; replace per test. */
  graphql: ((): unknown => ({})) as GraphqlHandler,
  adminUnavailable: false,
  /** What failedJobCountsSince answers, and the `since` it was last asked with. */
  failedSince: {} as Record<string, number>,
  lastFailedSince: null as number | null,
};

export function resetHarness(seed: Record<string, Row[]> = {}): FakeDb {
  h.db = new FakeDb({ app_settings: [{ id: 1 }], ...seed });
  h.points = fakeQueue();
  h.notifications = fakeQueue();
  h.social = fakeQueue();
  h.cron = fakeQueue();
  h.graphqlCalls = [];
  h.graphql = () => ({});
  h.adminUnavailable = false;
  h.failedSince = {};
  h.lastFailedSince = null;
  return h.db;
}

/** Admin client whose responses come from h.graphql (wrapped as { data }). */
export const fakeAdmin = {
  graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    const variables = opts?.variables ?? {};
    h.graphqlCalls.push({ query, variables });
    const data = h.graphql(query, variables);
    return { json: async () => ({ data }) };
  },
};

export function dbModule() {
  return {
    get db() {
      return h.db;
    },
  };
}

export function queueModule() {
  return {
    get pointsQueue() {
      return h.points;
    },
    get notificationQueue() {
      return h.notifications;
    },
    get socialQueue() {
      return h.social;
    },
    get cronQueue() {
      return h.cron;
    },
    failedJobCounts: async () => ({ points: 0, social: 0, notifications: 0, cron: 0 }),
    failedJobCountsSince: async (since: number) => {
      h.lastFailedSince = since;
      return { ...h.failedSince };
    },
    isFinalAttempt: (job: { attemptsMade?: number; opts?: { attempts?: number } }) => (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1),
    makeRedis: () => ({}),
    startWorkers: () => undefined,
  };
}

export function adminModule() {
  return {
    getAdminForShop: async (shop?: string) => {
      if (h.adminUnavailable) throw new Error("no stored offline Shopify session");
      void shop;
      return fakeAdmin;
    },
    getInstalledShop: async () => "test-shop.myshopify.com",
  };
}

/** Which operation a GraphQL document is (first field after the operation name). */
export function opName(query: string): string {
  const m = query.match(/(?:query|mutation)\s+(\w+)/);
  return m ? m[1] : "";
}

/** A member row with sensible defaults. */
export function seedMember(db: FakeDb, over: Row = {}): Row {
  const n = db.table("members").length + 1;
  return db.seed("members", {
    shopify_customer_id: `C${n}`,
    email: `c${n}@example.com`,
    referral_slug: `member-${n}`,
    consent_given: true,
    ...over,
  });
}
