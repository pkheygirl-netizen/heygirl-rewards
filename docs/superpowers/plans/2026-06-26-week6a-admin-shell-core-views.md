# Week 6A — Admin Shell + Core Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the embedded admin navigation shell plus the Overview and Members tabs of the HeyGirl.pk Rewards admin dashboard.

**Architecture:** Remix routes under `app.*`, each with a server `loader` (reads) and `action` (writes), authenticated via `authenticate.admin(request)`. A parent layout route `app.tsx` renders a Polaris `Tabs` navigation bar + `<Outlet/>`. Read aggregations live in `app/lib/admin-data.server.ts`; member reads/writes in `app/lib/admin-members.server.ts`. Charts use `@shopify/polaris-viz`. All computation server-side; no client data fetching.

**Tech Stack:** Remix 2, Shopify Polaris 13, `@shopify/polaris-viz`, Supabase (`db` from `app/db.server.ts`), Vitest.

## Global Constraints

- Every admin route loader/action MUST call `await authenticate.admin(request)` first.
- All data access goes through `db` imported from `../db.server` (Supabase service client). Never instantiate a new client.
- Read aggregation logic lives in `app/lib/admin-data.server.ts`; member-specific logic in `app/lib/admin-members.server.ts`. Route files stay thin (loader/action call lib functions).
- Manual point adjustments MUST go through the existing `award_points` Postgres RPC with `p_action_type: 'adjustment'` and a non-empty `p_reason_note`. Never write `points_ledger` rows directly from app code.
- No fake/seed data. Sparse data renders Polaris empty states.
- Tests use Vitest. Any test file that imports a module which transitively imports `queue.server` MUST `vi.mock("../queue.server", ...)` (and `vi.mock("./queue.server")` from route tests) — see existing service tests for the pattern.
- Money is PKR (`Rs.`), points are integers. Tier values are `'silver' | 'gold' | 'diamond'`.
- TypeScript files are the source of truth (`.ts`/`.tsx`). The repo also commits compiled `.js` siblings for some files — do NOT hand-write `.js`; the build produces them. Only create/modify `.ts`/`.tsx`.

---

## File Structure

- `app/routes/app.tsx` — NEW. Layout route: auth + Polaris `Tabs` nav + `<Outlet/>`.
- `app/routes/app._index.tsx` — MODIFY. Replace placeholder with Overview tab.
- `app/routes/app.members.tsx` — NEW. Members tab (table + detail drawer + write actions).
- `app/lib/admin-data.server.ts` — NEW. Overview read aggregations + activity feed.
- `app/lib/admin-data.server.test.ts` — NEW. Unit tests for aggregations.
- `app/lib/admin-members.server.ts` — NEW. Member search/detail + adjust/block/influencer writes.
- `app/lib/admin-members.server.test.ts` — NEW. Unit tests for member ops.
- `package.json` — MODIFY. Add `@shopify/polaris-viz` dependency.

---

## Task 1: Add Polaris Viz dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the charting library**

Run:
```bash
cd "/d/Heygirlpk Rewards/heygirl-rewards" && npm install @shopify/polaris-viz@^16.0.0
```
Expected: `package.json` gains `@shopify/polaris-viz` under dependencies; `package-lock.json` updates; exit 0.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
node -e "require.resolve('@shopify/polaris-viz'); console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @shopify/polaris-viz for admin charts"
```

---

## Task 2: Admin navigation shell (`app.tsx` layout route)

**Files:**
- Create: `app/routes/app.tsx`

**Interfaces:**
- Produces: a Remix layout route at path `/app` that authenticates and renders child routes via `<Outlet/>`. All `app.*` child routes render inside it.

- [ ] **Step 1: Write the layout route**

```tsx
// app/routes/app.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Outlet, useLocation, useNavigate } from "@remix-run/react";
import { Tabs } from "@shopify/polaris";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

const TABS = [
  { id: "overview", content: "Overview", path: "/app" },
  { id: "members", content: "Members", path: "/app/members" },
  { id: "influencers", content: "Influencer", path: "/app/influencers" },
  { id: "referrals", content: "Referrals", path: "/app/referrals" },
  { id: "campaigns", content: "Points & Campaigns", path: "/app/campaigns" },
  { id: "analytics", content: "Analytics", path: "/app/analytics" },
  { id: "nudges", content: "Nudges", path: "/app/nudges" },
  { id: "settings", content: "Settings", path: "/app/settings" },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const selected = Math.max(
    0,
    TABS.findIndex((t) =>
      t.path === "/app"
        ? location.pathname === "/app" || location.pathname === "/app/"
        : location.pathname.startsWith(t.path),
    ),
  );

  return (
    <Tabs
      tabs={TABS.map((t) => ({ id: t.id, content: t.content }))}
      selected={selected}
      onSelect={(i) => navigate(TABS[i].path)}
    >
      <Outlet />
    </Tabs>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.tsx
git commit -m "feat(admin): add tabbed navigation shell layout route"
```

---

## Task 3: Overview aggregations — tier breakdown

**Files:**
- Create: `app/lib/admin-data.server.ts`
- Test: `app/lib/admin-data.server.test.ts`

**Interfaces:**
- Produces: `getTierBreakdown(): Promise<{ silver: number; gold: number; diamond: number }>` — counts non-blocked members per tier.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/admin-data.server.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const counts: Record<string, number> = { silver: 5, gold: 2, diamond: 1 };

vi.mock("../db.server", () => {
  return {
    db: {
      from: vi.fn((table: string) => {
        if (table === "members") {
          return {
            select: vi.fn(() => ({
              eq: vi.fn((_col: string, tier: string) => ({
                // head:true count query resolves to { count }
                then: undefined,
                count: counts[tier] ?? 0,
              })),
            })),
          };
        }
        throw new Error("unexpected table " + table);
      }),
    },
  };
});

describe("getTierBreakdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns counts per tier", async () => {
    const { getTierBreakdown } = await import("./admin-data.server");
    const result = await getTierBreakdown();
    expect(result).toEqual({ silver: 5, gold: 2, diamond: 1 });
  });
});
```

> NOTE: Supabase count queries are awaited as `{ count, error }`. The implementation below issues one count query per tier; the test mock returns a resolved-shaped object. Match the mock to whatever query shape you implement — keep the implementation using `select("*", { count: "exact", head: true }).eq("tier", t)` and adjust the mock so each call resolves to `{ count, error: null }`.

Replace the mock's `eq` return with a thenable that resolves to `{ count, error: null }`:

```ts
              eq: vi.fn((_col: string, tier: string) =>
                Promise.resolve({ count: counts[tier] ?? 0, error: null }),
              ),
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "returns counts per tier"
```
Expected: FAIL — cannot find module `./admin-data.server` / `getTierBreakdown` not a function.

- [ ] **Step 3: Implement `getTierBreakdown`**

```ts
// app/lib/admin-data.server.ts
import { db } from "../db.server";

const TIERS = ["silver", "gold", "diamond"] as const;
type Tier = (typeof TIERS)[number];

export async function getTierBreakdown(): Promise<Record<Tier, number>> {
  const result: Record<Tier, number> = { silver: 0, gold: 0, diamond: 0 };
  for (const tier of TIERS) {
    const { count, error } = await db
      .from("members")
      .select("*", { count: "exact", head: true })
      .eq("tier", tier);
    if (error) throw error;
    result[tier] = count ?? 0;
  }
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "returns counts per tier"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-data.server.ts app/lib/admin-data.server.test.ts
git commit -m "feat(admin): tier breakdown aggregation for Overview"
```

---

## Task 4: Overview aggregations — points-issued series

**Files:**
- Modify: `app/lib/admin-data.server.ts`
- Modify: `app/lib/admin-data.server.test.ts`

**Interfaces:**
- Consumes: `db` from `../db.server`.
- Produces: `getPointsIssuedSeries(from: Date, to: Date): Promise<Array<{ date: string; points: number }>>` — sums positive `points_ledger.points` bucketed by calendar day (`YYYY-MM-DD`) between `from` (inclusive) and `to` (exclusive). Days with zero issuance are omitted (caller fills gaps for charting).

- [ ] **Step 1: Write the failing test**

```ts
// append to app/lib/admin-data.server.test.ts
describe("getPointsIssuedSeries", () => {
  it("buckets positive ledger points by day", async () => {
    const rows = [
      { points: 1000, earned_at: "2026-06-01T10:00:00Z" },
      { points: 200, earned_at: "2026-06-01T18:00:00Z" },
      { points: -50, earned_at: "2026-06-01T19:00:00Z" }, // excluded (negative)
      { points: 500, earned_at: "2026-06-02T08:00:00Z" },
    ];
    vi.doMock("../db.server", () => ({
      db: {
        from: vi.fn(() => ({
          select: vi.fn(() => ({
            gt: vi.fn(() => ({
              gte: vi.fn(() => ({
                lt: vi.fn(() => Promise.resolve({ data: rows, error: null })),
              })),
            })),
          })),
        })),
      },
    }));
    vi.resetModules();
    const { getPointsIssuedSeries } = await import("./admin-data.server");
    const series = await getPointsIssuedSeries(
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-03T00:00:00Z"),
    );
    expect(series).toEqual([
      { date: "2026-06-01", points: 1200 },
      { date: "2026-06-02", points: 500 },
    ]);
  });
});
```

> NOTE: Because Task 3's mock and this test mock the same module differently, use `vi.resetModules()` + `vi.doMock` inside this test (as shown) so the re-import picks up the local mock. Keep Task 3's top-level `vi.mock` for its own test.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "buckets positive ledger points by day"
```
Expected: FAIL — `getPointsIssuedSeries` is not a function.

- [ ] **Step 3: Implement `getPointsIssuedSeries`**

```ts
// append to app/lib/admin-data.server.ts
export async function getPointsIssuedSeries(
  from: Date,
  to: Date,
): Promise<Array<{ date: string; points: number }>> {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, earned_at")
    .gt("points", 0)
    .gte("earned_at", from.toISOString())
    .lt("earned_at", to.toISOString());
  if (error) throw error;

  const byDay = new Map<string, number>();
  for (const row of data ?? []) {
    const day = new Date(row.earned_at as string).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (row.points as number));
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, points]) => ({ date, points }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "buckets positive ledger points by day"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-data.server.ts app/lib/admin-data.server.test.ts
git commit -m "feat(admin): points-issued daily series aggregation"
```

---

## Task 5: Overview aggregations — activity feed

**Files:**
- Modify: `app/lib/admin-data.server.ts`
- Modify: `app/lib/admin-data.server.test.ts`

**Interfaces:**
- Produces: `getActivityFeed(limit?: number): Promise<ActivityItem[]>` where
  `type ActivityItem = { id: string; kind: "earn" | "redeem" | "referral"; memberName: string; detail: string; at: string }`.
  Merges recent `points_ledger` (positive points → earn), `loyalty_codes` (redeem), and `referrals` (completed) rows from the last 7 days, sorted by `at` descending, capped at `limit` (default 20). Exported type `ActivityItem`.

- [ ] **Step 1: Write the failing test**

```ts
// append to app/lib/admin-data.server.test.ts
describe("getActivityFeed", () => {
  it("merges and sorts recent events newest-first", async () => {
    vi.resetModules();
    vi.doMock("../db.server", () => ({
      db: {
        from: vi.fn((table: string) => ({
          select: vi.fn(() => ({
            gte: vi.fn(() => ({
              order: vi.fn(() => ({
                limit: vi.fn(() =>
                  Promise.resolve({
                    data:
                      table === "points_ledger"
                        ? [
                            {
                              id: "l1",
                              points: 1200,
                              action_type: "purchase",
                              earned_at: "2026-06-26T10:00:00Z",
                              members: { first_name: "Sara", last_name: "K" },
                            },
                          ]
                        : table === "loyalty_codes"
                          ? [
                              {
                                id: "c1",
                                created_at: "2026-06-26T11:00:00Z",
                                members: { first_name: "Mina", last_name: "A" },
                              },
                            ]
                          : [
                              {
                                id: "r1",
                                completed_at: "2026-06-26T09:00:00Z",
                                members: { first_name: "Zoya", last_name: "B" },
                              },
                            ],
                    error: null,
                  }),
                ),
              })),
            })),
          })),
        })),
      },
    }));
    const { getActivityFeed } = await import("./admin-data.server");
    const feed = await getActivityFeed(10);
    expect(feed.map((f) => f.id)).toEqual(["c1", "l1", "r1"]);
    expect(feed[1]).toMatchObject({ kind: "earn", memberName: "Sara K" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "merges and sorts recent events newest-first"
```
Expected: FAIL — `getActivityFeed` is not a function.

- [ ] **Step 3: Implement `getActivityFeed`**

```ts
// append to app/lib/admin-data.server.ts
export type ActivityItem = {
  id: string;
  kind: "earn" | "redeem" | "referral";
  memberName: string;
  detail: string;
  at: string;
};

function memberName(m: { first_name?: string | null; last_name?: string | null } | null): string {
  if (!m) return "A member";
  return [m.first_name, m.last_name].filter(Boolean).join(" ") || "A member";
}

export async function getActivityFeed(limit = 20): Promise<ActivityItem[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [earns, redeems, refs] = await Promise.all([
    db
      .from("points_ledger")
      .select("id, points, action_type, earned_at, members(first_name,last_name)")
      .gte("earned_at", since)
      .order("earned_at", { ascending: false })
      .limit(limit),
    db
      .from("loyalty_codes")
      .select("id, created_at, members(first_name,last_name)")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(limit),
    db
      .from("referrals")
      .select("id, completed_at, members:referrer_member_id(first_name,last_name)")
      .gte("completed_at", since)
      .order("completed_at", { ascending: false })
      .limit(limit),
  ]);

  const items: ActivityItem[] = [];
  for (const r of earns.data ?? []) {
    if ((r.points as number) <= 0) continue;
    items.push({
      id: r.id as string,
      kind: "earn",
      memberName: memberName(r.members as any),
      detail: `earned ${r.points} points (${r.action_type})`,
      at: r.earned_at as string,
    });
  }
  for (const r of redeems.data ?? []) {
    items.push({
      id: r.id as string,
      kind: "redeem",
      memberName: memberName(r.members as any),
      detail: "redeemed a reward",
      at: r.created_at as string,
    });
  }
  for (const r of refs.data ?? []) {
    if (!r.completed_at) continue;
    items.push({
      id: r.id as string,
      kind: "referral",
      memberName: memberName(r.members as any),
      detail: "completed a referral",
      at: r.completed_at as string,
    });
  }

  return items
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "merges and sorts recent events newest-first"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-data.server.ts app/lib/admin-data.server.test.ts
git commit -m "feat(admin): 7-day activity feed aggregation"
```

---

## Task 6: Overview aggregations — KPI summary

**Files:**
- Modify: `app/lib/admin-data.server.ts`
- Modify: `app/lib/admin-data.server.test.ts`

**Interfaces:**
- Produces: `getOverviewKpis(): Promise<OverviewKpis>` where
  ```ts
  type OverviewKpis = {
    todayNewMembers: number;
    todayRedemptions: number;
    todayPointsAwarded: number;
    activeReferrals: number;         // referrals.status = 'pending'
    pointsRedeemedThisMonth: number; // abs sum of action_type='redemption' points this month
    redemptionConversionRate: number; // pointsRedeemedThisMonth / pointsIssuedThisMonth, 0 if denom 0
    pointsIssuedThisMonth: number;
  };
  ```

- [ ] **Step 1: Write the failing test**

```ts
// append to app/lib/admin-data.server.test.ts
describe("getOverviewKpis", () => {
  it("computes conversion rate as redeemed/issued, 0 when no issuance", async () => {
    const { conversionRate } = await import("./admin-data.server");
    expect(conversionRate(500, 1000)).toBe(0.5);
    expect(conversionRate(500, 0)).toBe(0);
  });
});
```

> NOTE: `getOverviewKpis` itself fans out across many small count/sum queries; rather than mock all of them, we extract the only non-trivial pure logic — `conversionRate(redeemed, issued)` — and unit-test that. The query wiring is exercised via the route smoke test in Task 8.

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "computes conversion rate"
```
Expected: FAIL — `conversionRate` is not a function.

- [ ] **Step 3: Implement `conversionRate` and `getOverviewKpis`**

```ts
// append to app/lib/admin-data.server.ts
export function conversionRate(redeemed: number, issued: number): number {
  if (issued <= 0) return 0;
  return redeemed / issued;
}

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthUtc(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export type OverviewKpis = {
  todayNewMembers: number;
  todayRedemptions: number;
  todayPointsAwarded: number;
  activeReferrals: number;
  pointsRedeemedThisMonth: number;
  redemptionConversionRate: number;
  pointsIssuedThisMonth: number;
};

export async function getOverviewKpis(): Promise<OverviewKpis> {
  const today = startOfTodayUtc();
  const monthStart = startOfMonthUtc();

  const [newMembers, redemptionsToday, refs] = await Promise.all([
    db.from("members").select("*", { count: "exact", head: true }).gte("enrolled_at", today),
    db
      .from("loyalty_codes")
      .select("*", { count: "exact", head: true })
      .gte("created_at", today),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("status", "pending"),
  ]);

  const todayLedger = await db
    .from("points_ledger")
    .select("points, action_type, earned_at")
    .gte("earned_at", today);
  if (todayLedger.error) throw todayLedger.error;
  const todayPointsAwarded = (todayLedger.data ?? [])
    .filter((r) => (r.points as number) > 0)
    .reduce((s, r) => s + (r.points as number), 0);

  const monthLedger = await db
    .from("points_ledger")
    .select("points, action_type")
    .gte("earned_at", monthStart);
  if (monthLedger.error) throw monthLedger.error;
  let issued = 0;
  let redeemed = 0;
  for (const r of monthLedger.data ?? []) {
    const p = r.points as number;
    if (p > 0) issued += p;
    if (r.action_type === "redemption") redeemed += Math.abs(p);
  }

  return {
    todayNewMembers: newMembers.count ?? 0,
    todayRedemptions: redemptionsToday.count ?? 0,
    todayPointsAwarded,
    activeReferrals: refs.count ?? 0,
    pointsRedeemedThisMonth: redeemed,
    pointsIssuedThisMonth: issued,
    redemptionConversionRate: conversionRate(redeemed, issued),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-data.server.test.ts -t "computes conversion rate"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-data.server.ts app/lib/admin-data.server.test.ts
git commit -m "feat(admin): overview KPI summary aggregation"
```

---

## Task 7: Overview tab route

**Files:**
- Modify: `app/routes/app._index.tsx`

**Interfaces:**
- Consumes: `getTierBreakdown`, `getPointsIssuedSeries`, `getActivityFeed`, `getOverviewKpis` from `../lib/admin-data.server`.

- [ ] **Step 1: Replace the placeholder with the Overview route**

```tsx
// app/routes/app._index.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineGrid,
  Box,
  Text,
  EmptyState,
} from "@shopify/polaris";
import { DonutChart, LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import {
  getTierBreakdown,
  getPointsIssuedSeries,
  getActivityFeed,
  getOverviewKpis,
} from "../lib/admin-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [tiers, series, feed, kpis] = await Promise.all([
    getTierBreakdown(),
    getPointsIssuedSeries(from, to),
    getActivityFeed(20),
    getOverviewKpis(),
  ]);
  return json({ tiers, series, feed, kpis });
};

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <Box padding="400">
        <BlockStack gap="100">
          <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
          <Text as="span" variant="headingLg">{value}</Text>
        </BlockStack>
      </Box>
    </Card>
  );
}

export default function Overview() {
  const { tiers, series, feed, kpis } = useLoaderData<typeof loader>();
  const totalMembers = tiers.silver + tiers.gold + tiers.diamond;

  return (
    <Page title="Overview">
      <Layout>
        <Layout.Section>
          <InlineGrid columns={{ xs: 2, md: 4 }} gap="400">
            <Kpi label="New members today" value={String(kpis.todayNewMembers)} />
            <Kpi label="Redemptions today" value={String(kpis.todayRedemptions)} />
            <Kpi label="Points awarded today" value={kpis.todayPointsAwarded.toLocaleString()} />
            <Kpi label="Active referrals" value={String(kpis.activeReferrals)} />
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Members by tier</Text>
                  {totalMembers === 0 ? (
                    <Text as="p" tone="subdued">No members yet.</Text>
                  ) : (
                    <DonutChart
                      data={[
                        { name: "Silver", data: [{ key: "Silver", value: tiers.silver }] },
                        { name: "Gold", data: [{ key: "Gold", value: tiers.gold }] },
                        { name: "Diamond", data: [{ key: "Diamond", value: tiers.diamond }] },
                      ]}
                    />
                  )}
                </BlockStack>
              </Box>
            </Card>
            <Card>
              <Box padding="400">
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">Points issued (30 days)</Text>
                  <Text as="p" tone="subdued">
                    Conversion rate: {(kpis.redemptionConversionRate * 100).toFixed(1)}%
                  </Text>
                  {series.length === 0 ? (
                    <Text as="p" tone="subdued">No points issued in this range.</Text>
                  ) : (
                    <LineChart
                      data={[
                        {
                          name: "Points issued",
                          data: series.map((p) => ({ key: p.date, value: p.points })),
                        },
                      ]}
                    />
                  )}
                </BlockStack>
              </Box>
            </Card>
          </InlineGrid>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Recent activity (7 days)</Text>
                {feed.length === 0 ? (
                  <EmptyState heading="No recent activity" image="">
                    <p>Member activity from the last 7 days will appear here.</p>
                  </EmptyState>
                ) : (
                  <BlockStack gap="200">
                    {feed.map((item) => (
                      <Text as="p" key={item.id}>
                        <strong>{item.memberName}</strong> {item.detail} ·{" "}
                        <Text as="span" tone="subdued">
                          {new Date(item.at).toLocaleString()}
                        </Text>
                      </Text>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app._index.tsx` (if Polaris Viz type names differ in the installed version, adjust the import/props to match — run `node -e "console.log(Object.keys(require('@shopify/polaris-viz')))"` to confirm `DonutChart`/`LineChart` export names).

- [ ] **Step 3: Commit**

```bash
git add app/routes/app._index.tsx
git commit -m "feat(admin): Overview tab with tier donut, points line chart, KPIs, activity feed"
```

---

## Task 8: Member search & detail reads

**Files:**
- Create: `app/lib/admin-members.server.ts`
- Test: `app/lib/admin-members.server.test.ts`

**Interfaces:**
- Produces:
  - `searchMembers(opts: { query?: string; tier?: Tier; page?: number; pageSize?: number }): Promise<{ members: MemberRow[]; total: number }>` — `MemberRow = { id; first_name; last_name; email; tier; points_balance; lifetime_spend_pkr; is_blocked; is_influencer }`. `query` matches name OR email (case-insensitive, partial). Default `pageSize` 25.
  - `getMemberDetail(memberId: string): Promise<MemberDetail>` — `{ member: MemberRow & { referral_slug; enrolled_at; influencer_referral_rate }; ledger: LedgerRow[]; referrals: ReferralRow[] }`. `ledger` is the member's 50 most recent `points_ledger` rows; `referrals` are referrals where this member is referrer.
  - Exported types `Tier`, `MemberRow`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/admin-members.server.test.ts
import { describe, it, expect, vi } from "vitest";

function makeMembersQuery(rows: any[], total: number) {
  const builder: any = {
    select: vi.fn(() => builder),
    or: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    range: vi.fn(() => Promise.resolve({ data: rows, count: total, error: null })),
  };
  return builder;
}

describe("searchMembers", () => {
  it("returns members and total, applies tier filter", async () => {
    const rows = [
      {
        id: "m1",
        first_name: "Sara",
        last_name: "K",
        email: "sara@x.com",
        tier: "gold",
        points_balance: 4500,
        lifetime_spend_pkr: 60000,
        is_blocked: false,
        is_influencer: false,
      },
    ];
    const builder = makeMembersQuery(rows, 1);
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => builder) } }));
    vi.resetModules();
    const { searchMembers } = await import("./admin-members.server");
    const result = await searchMembers({ query: "sara", tier: "gold" });
    expect(result.total).toBe(1);
    expect(result.members[0].id).toBe("m1");
    expect(builder.or).toHaveBeenCalled();
    expect(builder.eq).toHaveBeenCalledWith("tier", "gold");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-members.server.test.ts -t "returns members and total"
```
Expected: FAIL — cannot find module `./admin-members.server`.

- [ ] **Step 3: Implement reads**

```ts
// app/lib/admin-members.server.ts
import { db } from "../db.server";

export type Tier = "silver" | "gold" | "diamond";

export type MemberRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  tier: Tier;
  points_balance: number;
  lifetime_spend_pkr: number;
  is_blocked: boolean;
  is_influencer: boolean;
};

export type LedgerRow = {
  id: string;
  points: number;
  action_type: string;
  reason_note: string | null;
  balance_after: number;
  earned_at: string;
};

export type ReferralRow = {
  id: string;
  referred_email: string;
  status: string;
  created_at: string;
  completed_at: string | null;
};

const MEMBER_COLS =
  "id, first_name, last_name, email, tier, points_balance, lifetime_spend_pkr, is_blocked, is_influencer";

export async function searchMembers(opts: {
  query?: string;
  tier?: Tier;
  page?: number;
  pageSize?: number;
}): Promise<{ members: MemberRow[]; total: number }> {
  const page = opts.page ?? 0;
  const pageSize = opts.pageSize ?? 25;

  let q = db.from("members").select(MEMBER_COLS, { count: "exact" });

  if (opts.query && opts.query.trim()) {
    const term = opts.query.trim().replace(/[%,]/g, "");
    q = q.or(
      `first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%`,
    );
  }
  if (opts.tier) q = q.eq("tier", opts.tier);

  const { data, count, error } = await q
    .order("enrolled_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw error;

  return { members: (data ?? []) as MemberRow[], total: count ?? 0 };
}

export async function getMemberDetail(memberId: string): Promise<{
  member: (MemberRow & {
    referral_slug: string;
    enrolled_at: string;
    influencer_referral_rate: number | null;
  }) | null;
  ledger: LedgerRow[];
  referrals: ReferralRow[];
}> {
  const [memberRes, ledgerRes, refRes] = await Promise.all([
    db
      .from("members")
      .select(`${MEMBER_COLS}, referral_slug, enrolled_at, influencer_referral_rate`)
      .eq("id", memberId)
      .maybeSingle(),
    db
      .from("points_ledger")
      .select("id, points, action_type, reason_note, balance_after, earned_at")
      .eq("member_id", memberId)
      .order("earned_at", { ascending: false })
      .limit(50),
    db
      .from("referrals")
      .select("id, referred_email, status, created_at, completed_at")
      .eq("referrer_member_id", memberId)
      .order("created_at", { ascending: false }),
  ]);
  if (memberRes.error) throw memberRes.error;
  if (ledgerRes.error) throw ledgerRes.error;
  if (refRes.error) throw refRes.error;

  return {
    member: (memberRes.data as any) ?? null,
    ledger: (ledgerRes.data ?? []) as LedgerRow[],
    referrals: (refRes.data ?? []) as ReferralRow[],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-members.server.test.ts -t "returns members and total"
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-members.server.ts app/lib/admin-members.server.test.ts
git commit -m "feat(admin): member search and detail reads"
```

---

## Task 9: Member write actions (adjust / block / influencer)

**Files:**
- Modify: `app/lib/admin-members.server.ts`
- Modify: `app/lib/admin-members.server.test.ts`

**Interfaces:**
- Consumes: `db` from `../db.server`.
- Produces:
  - `adjustPoints(input: { memberId: string; points: number; reason: string }): Promise<{ newBalance: number }>` — `points` may be negative; `reason` MUST be non-empty (throws `Error("reason required")` otherwise). Calls `db.rpc("award_points", { p_member_id, p_action_type: "adjustment", p_reference_id, p_points, p_reason_note })`.
  - `setBlocked(memberId: string, blocked: boolean): Promise<void>`
  - `setInfluencer(input: { memberId: string; isInfluencer: boolean; rate?: number | null }): Promise<void>` — when `isInfluencer` is false, clears `influencer_referral_rate` to null.

- [ ] **Step 1: Write the failing tests**

```ts
// append to app/lib/admin-members.server.test.ts
describe("adjustPoints", () => {
  it("rejects empty reason", async () => {
    vi.doMock("../db.server", () => ({ db: { rpc: vi.fn() } }));
    vi.resetModules();
    const { adjustPoints } = await import("./admin-members.server");
    await expect(
      adjustPoints({ memberId: "m1", points: 100, reason: "  " }),
    ).rejects.toThrow("reason required");
  });

  it("calls award_points RPC with adjustment type and returns new balance", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: [{ awarded: true, new_balance: 1100 }], error: null }),
    );
    vi.doMock("../db.server", () => ({ db: { rpc } }));
    vi.resetModules();
    const { adjustPoints } = await import("./admin-members.server");
    const res = await adjustPoints({ memberId: "m1", points: 100, reason: "goodwill" });
    expect(res.newBalance).toBe(1100);
    expect(rpc).toHaveBeenCalledWith(
      "award_points",
      expect.objectContaining({
        p_member_id: "m1",
        p_action_type: "adjustment",
        p_points: 100,
        p_reason_note: "goodwill",
      }),
    );
  });
});

describe("setInfluencer", () => {
  it("clears rate when untagging", async () => {
    const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: null })) }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { setInfluencer } = await import("./admin-members.server");
    await setInfluencer({ memberId: "m1", isInfluencer: false });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ is_influencer: false, influencer_referral_rate: null }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run app/lib/admin-members.server.test.ts -t "adjustPoints"
```
Expected: FAIL — `adjustPoints` is not a function.

- [ ] **Step 3: Implement writes**

```ts
// append to app/lib/admin-members.server.ts
export async function adjustPoints(input: {
  memberId: string;
  points: number;
  reason: string;
}): Promise<{ newBalance: number }> {
  if (!input.reason || !input.reason.trim()) throw new Error("reason required");
  const { data, error } = await db.rpc("award_points", {
    p_member_id: input.memberId,
    p_action_type: "adjustment",
    p_reference_id: `admin-adjust:${Date.now()}`,
    p_points: input.points,
    p_reason_note: input.reason.trim(),
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return { newBalance: (row?.new_balance as number) ?? 0 };
}

export async function setBlocked(memberId: string, blocked: boolean): Promise<void> {
  const { error } = await db
    .from("members")
    .update({ is_blocked: blocked })
    .eq("id", memberId);
  if (error) throw error;
}

export async function setInfluencer(input: {
  memberId: string;
  isInfluencer: boolean;
  rate?: number | null;
}): Promise<void> {
  const patch = input.isInfluencer
    ? { is_influencer: true, influencer_referral_rate: input.rate ?? null }
    : { is_influencer: false, influencer_referral_rate: null };
  const { error } = await db.from("members").update(patch).eq("id", input.memberId);
  if (error) throw error;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run app/lib/admin-members.server.test.ts
```
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-members.server.ts app/lib/admin-members.server.test.ts
git commit -m "feat(admin): member point-adjust/block/influencer write actions"
```

---

## Task 10: Members tab route (table + detail drawer + actions)

**Files:**
- Create: `app/routes/app.members.tsx`

**Interfaces:**
- Consumes: `searchMembers`, `getMemberDetail`, `adjustPoints`, `setBlocked`, `setInfluencer` from `../lib/admin-members.server`.

- [ ] **Step 1: Write the route (loader + action + UI)**

```tsx
// app/routes/app.members.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, Form } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  IndexTable,
  TextField,
  Select,
  Badge,
  Modal,
  BlockStack,
  InlineStack,
  Text,
  Button,
  Banner,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  searchMembers,
  getMemberDetail,
  adjustPoints,
  setBlocked,
  setInfluencer,
  type Tier,
} from "../lib/admin-members.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const tier = (url.searchParams.get("tier") as Tier | "") || undefined;
  const detailId = url.searchParams.get("detail");

  const { members, total } = await searchMembers({ query, tier });
  const detail = detailId ? await getMemberDetail(detailId) : null;
  return json({ members, total, query, tier: tier ?? "", detail });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const memberId = String(form.get("memberId"));

  try {
    if (intent === "adjust") {
      await adjustPoints({
        memberId,
        points: Number(form.get("points")),
        reason: String(form.get("reason") ?? ""),
      });
    } else if (intent === "block") {
      await setBlocked(memberId, form.get("blocked") === "true");
    } else if (intent === "influencer") {
      const isInfluencer = form.get("isInfluencer") === "true";
      const rateRaw = form.get("rate");
      await setInfluencer({
        memberId,
        isInfluencer,
        rate: rateRaw ? Number(rateRaw) : null,
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function tierBadge(tier: string) {
  const tone = tier === "diamond" ? "info" : tier === "gold" ? "warning" : undefined;
  return <Badge tone={tone as any}>{tier}</Badge>;
}

export default function Members() {
  const { members, total, query, tier, detail } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [reason, setReason] = useState("");
  const [points, setPoints] = useState("");

  const openDetail = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("detail", id);
    setParams(next);
  };
  const closeDetail = () => {
    const next = new URLSearchParams(params);
    next.delete("detail");
    setParams(next);
  };

  return (
    <Page title="Members" subtitle={`${total} members`}>
      <Card>
        <Box padding="400">
          <Form method="get">
            <InlineStack gap="300" align="start">
              <TextField
                label="Search"
                labelHidden
                name="q"
                value={query}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("q", v); else next.delete("q");
                  setParams(next);
                }}
                placeholder="Name or email"
                autoComplete="off"
              />
              <Select
                label="Tier"
                labelHidden
                name="tier"
                value={tier}
                options={[
                  { label: "All tiers", value: "" },
                  { label: "Silver", value: "silver" },
                  { label: "Gold", value: "gold" },
                  { label: "Diamond", value: "diamond" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("tier", v); else next.delete("tier");
                  setParams(next);
                }}
              />
            </InlineStack>
          </Form>
        </Box>
        <IndexTable
          resourceName={{ singular: "member", plural: "members" }}
          itemCount={members.length}
          selectable={false}
          headings={[
            { title: "Name" },
            { title: "Email" },
            { title: "Tier" },
            { title: "Points" },
            { title: "Lifetime spend" },
            { title: "Status" },
          ]}
        >
          {members.map((m, i) => (
            <IndexTable.Row
              id={m.id}
              key={m.id}
              position={i}
              onClick={() => openDetail(m.id)}
            >
              <IndexTable.Cell>
                {[m.first_name, m.last_name].filter(Boolean).join(" ") || "—"}
              </IndexTable.Cell>
              <IndexTable.Cell>{m.email}</IndexTable.Cell>
              <IndexTable.Cell>{tierBadge(m.tier)}</IndexTable.Cell>
              <IndexTable.Cell>{m.points_balance.toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>Rs.{Number(m.lifetime_spend_pkr).toLocaleString()}</IndexTable.Cell>
              <IndexTable.Cell>
                {m.is_blocked ? <Badge tone="critical">Blocked</Badge> : <Badge tone="success">Active</Badge>}
                {m.is_influencer ? <Badge tone="info">Influencer</Badge> : null}
              </IndexTable.Cell>
            </IndexTable.Row>
          ))}
        </IndexTable>
      </Card>

      {detail?.member ? (
        <Modal
          open
          onClose={closeDetail}
          title={`${[detail.member.first_name, detail.member.last_name].filter(Boolean).join(" ") || detail.member.email}`}
          large
        >
          <Modal.Section>
            <BlockStack gap="400">
              {fetcher.data && !fetcher.data.ok ? (
                <Banner tone="critical">{fetcher.data.error}</Banner>
              ) : null}

              <InlineStack gap="400">
                <Text as="span">Tier: {tierBadge(detail.member.tier)}</Text>
                <Text as="span">Balance: {detail.member.points_balance.toLocaleString()} pts</Text>
                <Text as="span">Lifetime: Rs.{Number(detail.member.lifetime_spend_pkr).toLocaleString()}</Text>
                <Text as="span">Slug: {detail.member.referral_slug}</Text>
              </InlineStack>

              <Card>
                <Box padding="300">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Manual point adjustment</Text>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="adjust" />
                      <input type="hidden" name="memberId" value={detail.member.id} />
                      <InlineStack gap="200" align="start">
                        <TextField
                          label="Points (+/-)"
                          name="points"
                          type="number"
                          value={points}
                          onChange={setPoints}
                          autoComplete="off"
                        />
                        <TextField
                          label="Reason (required)"
                          name="reason"
                          value={reason}
                          onChange={setReason}
                          autoComplete="off"
                        />
                      </InlineStack>
                      <Box paddingBlockStart="200">
                        <Button submit disabled={!reason.trim() || !points}>Apply adjustment</Button>
                      </Box>
                    </fetcher.Form>
                  </BlockStack>
                </Box>
              </Card>

              <InlineStack gap="200">
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="block" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="blocked" value={String(!detail.member.is_blocked)} />
                  <Button submit tone={detail.member.is_blocked ? undefined : "critical"}>
                    {detail.member.is_blocked ? "Unblock" : "Block"}
                  </Button>
                </fetcher.Form>
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="influencer" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="isInfluencer" value={String(!detail.member.is_influencer)} />
                  <Button submit>
                    {detail.member.is_influencer ? "Remove influencer tag" : "Tag as influencer"}
                  </Button>
                </fetcher.Form>
              </InlineStack>

              {detail.member.is_influencer ? (
                <fetcher.Form method="post">
                  <input type="hidden" name="intent" value="influencer" />
                  <input type="hidden" name="memberId" value={detail.member.id} />
                  <input type="hidden" name="isInfluencer" value="true" />
                  <InlineStack gap="200" align="start">
                    <TextField
                      label="Custom referral rate (pts)"
                      name="rate"
                      type="number"
                      autoComplete="off"
                      value={String(detail.member.influencer_referral_rate ?? "")}
                      onChange={() => {}}
                    />
                    <Button submit>Save rate</Button>
                  </InlineStack>
                </fetcher.Form>
              ) : null}

              <Card>
                <Box padding="300">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Recent activity</Text>
                    {detail.ledger.length === 0 ? (
                      <Text as="p" tone="subdued">No point activity yet.</Text>
                    ) : (
                      detail.ledger.map((l) => (
                        <Text as="p" key={l.id}>
                          {l.earned_at.slice(0, 10)} · {l.action_type} ·{" "}
                          {l.points > 0 ? "+" : ""}{l.points} → {l.balance_after}
                          {l.reason_note ? ` · ${l.reason_note}` : ""}
                        </Text>
                      ))
                    )}
                  </BlockStack>
                </Box>
              </Card>
            </BlockStack>
          </Modal.Section>
        </Modal>
      ) : null}
    </Page>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.members.tsx`. (If a Polaris prop type mismatches in v13 — e.g. `Badge` tone — adjust to the nearest valid value; do not suppress with `any` beyond what's shown.)

- [ ] **Step 3: Run the full test suite**

Run:
```bash
npx vitest run
```
Expected: all tests PASS (existing + new admin tests).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.members.tsx
git commit -m "feat(admin): Members tab with search, detail drawer, adjust/block/influencer actions"
```

---

## Task 11: Build verification & deploy

**Files:** none (verification only)

- [ ] **Step 1: Production build**

Run:
```bash
npm run build
```
Expected: build succeeds (widget build + `remix vite:build`), no type/import errors.

- [ ] **Step 2: Commit any generated artifacts the repo tracks**

Run:
```bash
git status --porcelain
```
If build produced tracked `.js` siblings or lockfile changes that belong in the repo, stage and commit them:
```bash
git add -A
git commit -m "chore(admin): build artifacts for Week 6A shell + core views"
```
If nothing changed, skip.

- [ ] **Step 3: Push to main (triggers Render auto-deploy)**

Run:
```bash
git push origin main
```
Expected: push succeeds; Render auto-deploys from main.

---

## Self-Review Notes

- **Spec coverage (6A scope):** nav shell (Task 2), Overview donut/line/conversion/Today-KPIs/active-referrals/activity-feed (Tasks 3–7), Members search+filter/detail drawer/manual-adjust-with-reason/block-unblock/influencer-tag/custom-rate (Tasks 8–10). ✅
- **Audit trail:** manual adjust routes through `award_points` RPC with `action_type='adjustment'` + required `reason_note` (Task 9). ✅
- **Empty states:** donut/line/feed/ledger all render empty states on sparse data (Tasks 7, 10). ✅
- **No new ledger action_type needed** — `adjustment` already exists in the schema.
- Deferred to 6B/6C: Influencer, Referrals, Points & Campaigns, Analytics, Nudges, Settings tabs (their nav links exist but route to not-yet-created routes until 6B/6C land).
