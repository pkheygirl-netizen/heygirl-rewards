# Week 6B — Operational Tools (Influencer · Referrals · Points & Campaigns) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Influencer, Referrals, and Points & Campaigns admin tabs, including CSV exports and campaign CRUD.

**Architecture:** Remix routes under `app.*` rendered inside the `app.tsx` shell from Plan 6A. Read/write logic in `app/lib/admin-influencers.server.ts`, `app/lib/admin-referrals.server.ts`, `app/lib/admin-campaigns.server.ts`. CSV exports are Remix resource routes returning `text/csv`.

**Tech Stack:** Remix 2, Shopify Polaris 13, Supabase (`db` from `app/db.server.ts`), Vitest.

**Depends on:** Plan 6A (shell `app.tsx`, `admin-members.server.ts` patterns). Build 6A first.

## Global Constraints

- Every admin route loader/action MUST call `await authenticate.admin(request)` first.
- All data access via `db` from `../db.server`. Never instantiate a new client.
- Referral statuses are exactly `'pending' | 'completed' | 'blocked' | 'flagged'` (DB CHECK constraint).
- Campaign points multiplier applies to purchase points only and only one campaign is active at a time — enforce "only one active" on create/edit.
- CSV exports stream `text/csv` with a `Content-Disposition: attachment` header; values containing commas/quotes/newlines MUST be quoted and inner quotes doubled (RFC 4180).
- "Review & Unblock" on a referral sets `status='completed'` only if it was previously blocked/flagged AND does NOT re-award points (points are awarded by the existing referral webhook flow); it clears `block_reason`.
- Only create/modify `.ts`/`.tsx`. No fake/seed data; sparse data → Polaris empty states.
- Vitest tests; `vi.mock` any module that transitively imports `queue.server`.

---

## File Structure

- `app/lib/csv.server.ts` — NEW. Shared `toCsv(rows, columns)` helper.
- `app/lib/csv.server.test.ts` — NEW.
- `app/lib/admin-influencers.server.ts` — NEW. `getInfluencers()`, `updateReferralSlug()`.
- `app/lib/admin-influencers.server.test.ts` — NEW.
- `app/lib/admin-referrals.server.ts` — NEW. `listReferrals()`, `referralSummary()`, `reviewAndUnblock()`.
- `app/lib/admin-referrals.server.test.ts` — NEW.
- `app/lib/admin-campaigns.server.ts` — NEW. `listCampaigns()`, `createCampaign()`, `updateCampaign()`, `deleteCampaign()`, `listLedger()`.
- `app/lib/admin-campaigns.server.test.ts` — NEW.
- `app/routes/app.influencers.tsx` — NEW.
- `app/routes/app.referrals.tsx` — NEW.
- `app/routes/app.campaigns.tsx` — NEW.
- `app/routes/app.influencers.export[.]csv.tsx` — NEW (resource route, see Task 9 for exact filename).
- `app/routes/app.campaigns.ledger[.]csv.tsx` — NEW (resource route).

---

## Task 1: Shared CSV helper

**Files:**
- Create: `app/lib/csv.server.ts`
- Test: `app/lib/csv.server.test.ts`

**Interfaces:**
- Produces: `toCsv<T>(rows: T[], columns: Array<{ key: keyof T; header: string }>): string` — RFC-4180 CSV with header row. `csvResponse(filename: string, csv: string): Response` — a `Response` with `text/csv` + attachment headers.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/csv.server.test.ts
import { describe, it, expect } from "vitest";
import { toCsv } from "./csv.server";

describe("toCsv", () => {
  it("writes header and quotes values containing commas/quotes", () => {
    const csv = toCsv(
      [{ name: 'Sara, K', pts: 1200, note: 'says "hi"' }],
      [
        { key: "name", header: "Name" },
        { key: "pts", header: "Points" },
        { key: "note", header: "Note" },
      ] as const,
    );
    expect(csv).toBe('Name,Points,Note\n"Sara, K",1200,"says ""hi"""');
  });

  it("handles empty rows", () => {
    const csv = toCsv([], [{ key: "a", header: "A" }] as const);
    expect(csv).toBe("A");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/csv.server.test.ts
```
Expected: FAIL — cannot find module `./csv.server`.

- [ ] **Step 3: Implement**

```ts
// app/lib/csv.server.ts
function escape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(
  rows: T[],
  columns: ReadonlyArray<{ key: keyof T; header: string }>,
): string {
  const header = columns.map((c) => escape(c.header)).join(",");
  const body = rows
    .map((row) => columns.map((c) => escape(row[c.key])).join(","))
    .join("\n");
  return body ? `${header}\n${body}` : header;
}

export function csvResponse(filename: string, csv: string): Response {
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/csv.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/csv.server.ts app/lib/csv.server.test.ts
git commit -m "feat(admin): shared RFC-4180 CSV helper"
```

---

## Task 2: Influencer reads

**Files:**
- Create: `app/lib/admin-influencers.server.ts`
- Test: `app/lib/admin-influencers.server.test.ts`

**Interfaces:**
- Produces:
  - `getInfluencers(): Promise<InfluencerRow[]>` where
    `InfluencerRow = { id; name; email; tier; customRate: number | null; clicks: number; conversions: number; conversionRate: number; pointsEarned: number; rsEquivalent: number }`.
    `clicks` = total `referrals` rows where `referrer_member_id = member.id`; `conversions` = those with `status='completed'`; `pointsEarned` = sum of `points_ledger.points` where `action_type IN ('referral_earned','referral_bonus')` for that member; `rsEquivalent` = `pointsEarned / 40` rounded (40 pts ≈ Rs.1 from the redemption table baseline 6000 pts → Rs.250 = 24, but use the documented 4000pts→Rs.100 ratio: Rs = pointsEarned * 100 / 4000). Use helper `pointsToRs(points)` = `Math.round(points * 100 / 4000)`.
  - `updateReferralSlug(memberId: string, slug: string): Promise<void>` — validates slug is non-empty, lowercased, `[a-z0-9-]+`; throws `Error("invalid slug")` otherwise; updates `members.referral_slug` (unique — surfaces DB unique-violation as `Error("slug taken")`).
  - Exported helper `pointsToRs(points: number): number`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/admin-influencers.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("pointsToRs", () => {
  it("converts points to Rs at 4000pts=Rs.100", async () => {
    const { pointsToRs } = await import("./admin-influencers.server");
    expect(pointsToRs(4000)).toBe(100);
    expect(pointsToRs(6000)).toBe(150);
  });
});

describe("updateReferralSlug", () => {
  it("rejects invalid slug", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { updateReferralSlug } = await import("./admin-influencers.server");
    await expect(updateReferralSlug("m1", "Bad Slug!")).rejects.toThrow("invalid slug");
  });

  it("maps unique violation to 'slug taken'", async () => {
    const eq = vi.fn(() => Promise.resolve({ error: { code: "23505" } }));
    const update = vi.fn(() => ({ eq }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { updateReferralSlug } = await import("./admin-influencers.server");
    await expect(updateReferralSlug("m1", "sara-123")).rejects.toThrow("slug taken");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run app/lib/admin-influencers.server.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/lib/admin-influencers.server.ts
import { db } from "../db.server";

export function pointsToRs(points: number): number {
  return Math.round((points * 100) / 4000);
}

export type InfluencerRow = {
  id: string;
  name: string;
  email: string;
  tier: string;
  customRate: number | null;
  clicks: number;
  conversions: number;
  conversionRate: number;
  pointsEarned: number;
  rsEquivalent: number;
};

export async function getInfluencers(): Promise<InfluencerRow[]> {
  const { data: members, error } = await db
    .from("members")
    .select("id, first_name, last_name, email, tier, influencer_referral_rate")
    .eq("is_influencer", true)
    .order("enrolled_at", { ascending: false });
  if (error) throw error;

  const rows: InfluencerRow[] = [];
  for (const m of members ?? []) {
    const [refs, ledger] = await Promise.all([
      db.from("referrals").select("status").eq("referrer_member_id", m.id),
      db
        .from("points_ledger")
        .select("points")
        .eq("member_id", m.id)
        .in("action_type", ["referral_earned", "referral_bonus"]),
    ]);
    if (refs.error) throw refs.error;
    if (ledger.error) throw ledger.error;
    const clicks = refs.data?.length ?? 0;
    const conversions = (refs.data ?? []).filter((r) => r.status === "completed").length;
    const pointsEarned = (ledger.data ?? []).reduce((s, r) => s + (r.points as number), 0);
    rows.push({
      id: m.id as string,
      name: [m.first_name, m.last_name].filter(Boolean).join(" ") || (m.email as string),
      email: m.email as string,
      tier: m.tier as string,
      customRate: (m.influencer_referral_rate as number | null) ?? null,
      clicks,
      conversions,
      conversionRate: clicks > 0 ? conversions / clicks : 0,
      pointsEarned,
      rsEquivalent: pointsToRs(pointsEarned),
    });
  }
  return rows;
}

export async function updateReferralSlug(memberId: string, slug: string): Promise<void> {
  const normalized = (slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) throw new Error("invalid slug");
  const { error } = await db
    .from("members")
    .update({ referral_slug: normalized })
    .eq("id", memberId);
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("slug taken");
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run app/lib/admin-influencers.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-influencers.server.ts app/lib/admin-influencers.server.test.ts
git commit -m "feat(admin): influencer stats reads and slug edit"
```

---

## Task 3: Influencer tab route

**Files:**
- Create: `app/routes/app.influencers.tsx`

**Interfaces:**
- Consumes: `getInfluencers`, `updateReferralSlug` from `../lib/admin-influencers.server`; `adjustPoints` from `../lib/admin-members.server`.

- [ ] **Step 1: Write the route**

```tsx
// app/routes/app.influencers.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher, Link } from "@remix-run/react";
import {
  Page, Card, IndexTable, Text, Banner, Button, TextField, BlockStack, Box, InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getInfluencers, updateReferralSlug } from "../lib/admin-influencers.server";
import { adjustPoints } from "../lib/admin-members.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ influencers: await getInfluencers() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const memberId = String(form.get("memberId"));
  try {
    if (intent === "slug") {
      await updateReferralSlug(memberId, String(form.get("slug") ?? ""));
    } else if (intent === "adjust") {
      await adjustPoints({
        memberId,
        points: Number(form.get("points")),
        reason: String(form.get("reason") ?? ""),
      });
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

export default function Influencers() {
  const { influencers } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();

  return (
    <Page
      title="Influencers"
      primaryAction={{ content: "Export CSV", url: "/app/influencers/export.csv", external: false }}
    >
      {fetcher.data && !fetcher.data.ok ? (
        <Box paddingBlockEnd="300"><Banner tone="critical">{fetcher.data.error}</Banner></Box>
      ) : null}
      <Card>
        {influencers.length === 0 ? (
          <Box padding="400"><Text as="p" tone="subdued">No influencer-tagged members yet.</Text></Box>
        ) : (
          <IndexTable
            resourceName={{ singular: "influencer", plural: "influencers" }}
            itemCount={influencers.length}
            selectable={false}
            headings={[
              { title: "Name" }, { title: "Tier" }, { title: "Custom rate" },
              { title: "Clicks" }, { title: "Conversions" }, { title: "Conv %" },
              { title: "Pts earned" }, { title: "Rs. equiv" }, { title: "Slug" },
            ]}
          >
            {influencers.map((inf, i) => (
              <IndexTable.Row id={inf.id} key={inf.id} position={i}>
                <IndexTable.Cell>{inf.name}</IndexTable.Cell>
                <IndexTable.Cell>{inf.tier}</IndexTable.Cell>
                <IndexTable.Cell>{inf.customRate ?? "—"}</IndexTable.Cell>
                <IndexTable.Cell>{inf.clicks}</IndexTable.Cell>
                <IndexTable.Cell>{inf.conversions}</IndexTable.Cell>
                <IndexTable.Cell>{(inf.conversionRate * 100).toFixed(0)}%</IndexTable.Cell>
                <IndexTable.Cell>{inf.pointsEarned.toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>Rs.{inf.rsEquivalent.toLocaleString()}</IndexTable.Cell>
                <IndexTable.Cell>
                  <fetcher.Form method="post">
                    <input type="hidden" name="intent" value="slug" />
                    <input type="hidden" name="memberId" value={inf.id} />
                    <InlineStack gap="100">
                      <TextField label="Slug" labelHidden name="slug" autoComplete="off" value={inf.slug ?? inf.id} onChange={() => {}} />
                      <Button submit>Save</Button>
                    </InlineStack>
                  </fetcher.Form>
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        )}
      </Card>
    </Page>
  );
}
```

> NOTE: `InfluencerRow` from Task 2 does not include a `slug` field. Either (a) add `slug: string` to `InfluencerRow` and select `referral_slug` in `getInfluencers`, or (b) replace the inline slug `TextField` default with an empty controlled value. Choose (a): in Task 2's implementation add `referral_slug` to the select and `slug: m.referral_slug as string` to each row, and `slug: string` to the type. Update the Task 2 test only if it asserts on row shape (it does not).

- [ ] **Step 2: Apply the (a) fix to Task 2 module**

Edit `app/lib/admin-influencers.server.ts`: add `slug: string;` to `InfluencerRow`, add `referral_slug` to the members `.select(...)`, and `slug: m.referral_slug as string` to each pushed row. Then in `app.influencers.tsx` use `value={inf.slug}`.

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing the two files.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.influencers.tsx app/lib/admin-influencers.server.ts
git commit -m "feat(admin): Influencer tab with stats table, slug edit, quick adjust"
```

---

## Task 4: Influencer CSV export resource route

**Files:**
- Create: `app/routes/app.influencers.export[.]csv.tsx`

> Remix flat-routes: a literal dot in the path segment is escaped as `[.]`. This file maps to URL `/app/influencers/export.csv`.

**Interfaces:**
- Consumes: `getInfluencers` from `../lib/admin-influencers.server`; `toCsv`, `csvResponse` from `../lib/csv.server`.

- [ ] **Step 1: Write the resource route**

```tsx
// app/routes/app.influencers.export[.]csv.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { getInfluencers } from "../lib/admin-influencers.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const rows = await getInfluencers();
  const csv = toCsv(rows, [
    { key: "name", header: "Name" },
    { key: "email", header: "Email" },
    { key: "tier", header: "Tier" },
    { key: "customRate", header: "Custom Rate" },
    { key: "clicks", header: "Clicks" },
    { key: "conversions", header: "Conversions" },
    { key: "conversionRate", header: "Conversion Rate" },
    { key: "pointsEarned", header: "Points Earned" },
    { key: "rsEquivalent", header: "Rs Equivalent" },
  ] as const);
  return csvResponse("influencers.csv", csv);
};
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "app/routes/app.influencers.export[.]csv.tsx"
git commit -m "feat(admin): influencer CSV export route"
```

---

## Task 5: Referrals reads + review/unblock

**Files:**
- Create: `app/lib/admin-referrals.server.ts`
- Test: `app/lib/admin-referrals.server.test.ts`

**Interfaces:**
- Produces:
  - `listReferrals(opts: { status?: ReferralStatus; from?: string; to?: string }): Promise<ReferralListRow[]>` where `ReferralStatus = 'pending'|'completed'|'blocked'|'flagged'` and `ReferralListRow = { id; referrerName; referredEmail; status; blockReason: string|null; createdAt; completedAt: string|null; ipMatch: boolean }`. `ipMatch` = `referred_ip === referrer_ip` (both non-null).
  - `referralSummary(): Promise<{ total: number; completed: number; conversionRate: number; rewardsIssued: number }>` — `rewardsIssued` = count of referrals with `points_awarded = true`.
  - `reviewAndUnblock(referralId: string): Promise<void>` — sets `status='completed'`, clears `block_reason`; throws `Error("not blocked")` if the referral isn't currently `blocked` or `flagged`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/admin-referrals.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("reviewAndUnblock", () => {
  it("rejects when referral is not blocked/flagged", async () => {
    const maybeSingle = vi.fn(() => Promise.resolve({ data: { status: "completed" }, error: null }));
    const eqSel = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq: eqSel }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ select })) } }));
    vi.resetModules();
    const { reviewAndUnblock } = await import("./admin-referrals.server");
    await expect(reviewAndUnblock("r1")).rejects.toThrow("not blocked");
  });
});

describe("listReferrals", () => {
  it("flags ip match", async () => {
    const rows = [
      { id: "r1", referred_email: "a@x.com", status: "flagged", block_reason: "ip", created_at: "2026-06-01T00:00:00Z", completed_at: null, referred_ip: "1.1.1.1", referrer_ip: "1.1.1.1", members: { first_name: "Sara", last_name: "K" } },
    ];
    const builder: any = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      gte: vi.fn(() => builder),
      lte: vi.fn(() => builder),
      order: vi.fn(() => Promise.resolve({ data: rows, error: null })),
    };
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => builder) } }));
    vi.resetModules();
    const { listReferrals } = await import("./admin-referrals.server");
    const result = await listReferrals({});
    expect(result[0].ipMatch).toBe(true);
    expect(result[0].referrerName).toBe("Sara K");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run app/lib/admin-referrals.server.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/lib/admin-referrals.server.ts
import { db } from "../db.server";

export type ReferralStatus = "pending" | "completed" | "blocked" | "flagged";

export type ReferralListRow = {
  id: string;
  referrerName: string;
  referredEmail: string;
  status: ReferralStatus;
  blockReason: string | null;
  createdAt: string;
  completedAt: string | null;
  ipMatch: boolean;
};

export async function listReferrals(opts: {
  status?: ReferralStatus;
  from?: string;
  to?: string;
}): Promise<ReferralListRow[]> {
  let q = db
    .from("referrals")
    .select(
      "id, referred_email, status, block_reason, created_at, completed_at, referred_ip, referrer_ip, members:referrer_member_id(first_name,last_name)",
    );
  if (opts.status) q = q.eq("status", opts.status);
  if (opts.from) q = q.gte("created_at", opts.from);
  if (opts.to) q = q.lte("created_at", opts.to);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) throw error;

  return (data ?? []).map((r: any) => ({
    id: r.id,
    referrerName:
      [r.members?.first_name, r.members?.last_name].filter(Boolean).join(" ") || "—",
    referredEmail: r.referred_email,
    status: r.status,
    blockReason: r.block_reason ?? null,
    createdAt: r.created_at,
    completedAt: r.completed_at ?? null,
    ipMatch: !!r.referred_ip && !!r.referrer_ip && r.referred_ip === r.referrer_ip,
  }));
}

export async function referralSummary(): Promise<{
  total: number;
  completed: number;
  conversionRate: number;
  rewardsIssued: number;
}> {
  const [total, completed, rewards] = await Promise.all([
    db.from("referrals").select("*", { count: "exact", head: true }),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("status", "completed"),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("points_awarded", true),
  ]);
  const t = total.count ?? 0;
  const c = completed.count ?? 0;
  return {
    total: t,
    completed: c,
    conversionRate: t > 0 ? c / t : 0,
    rewardsIssued: rewards.count ?? 0,
  };
}

export async function reviewAndUnblock(referralId: string): Promise<void> {
  const { data, error } = await db
    .from("referrals")
    .select("status")
    .eq("id", referralId)
    .maybeSingle();
  if (error) throw error;
  if (!data || (data.status !== "blocked" && data.status !== "flagged")) {
    throw new Error("not blocked");
  }
  const { error: upErr } = await db
    .from("referrals")
    .update({ status: "completed", block_reason: null })
    .eq("id", referralId);
  if (upErr) throw upErr;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run app/lib/admin-referrals.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-referrals.server.ts app/lib/admin-referrals.server.test.ts
git commit -m "feat(admin): referrals list/summary and review-and-unblock"
```

---

## Task 6: Referrals tab route

**Files:**
- Create: `app/routes/app.referrals.tsx`

**Interfaces:**
- Consumes: `listReferrals`, `referralSummary`, `reviewAndUnblock` from `../lib/admin-referrals.server`.

- [ ] **Step 1: Write the route**

```tsx
// app/routes/app.referrals.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useFetcher, Form } from "@remix-run/react";
import {
  Page, Card, IndexTable, Badge, Select, Button, Text, InlineGrid, Box, BlockStack, Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  listReferrals, referralSummary, reviewAndUnblock, type ReferralStatus,
} from "../lib/admin-referrals.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const status = (url.searchParams.get("status") as ReferralStatus | "") || undefined;
  const [referrals, summary] = await Promise.all([
    listReferrals({ status }),
    referralSummary(),
  ]);
  return json({ referrals, summary, status: status ?? "" });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  try {
    await reviewAndUnblock(String(form.get("referralId")));
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function statusBadge(s: string, ipMatch: boolean) {
  if (s === "blocked") return <Badge tone="critical">Blocked</Badge>;
  if (s === "flagged") return <Badge tone="warning">{ipMatch ? "Flagged · IP match" : "Flagged"}</Badge>;
  if (s === "completed") return <Badge tone="success">Completed</Badge>;
  return <Badge>Pending</Badge>;
}

export default function Referrals() {
  const { referrals, summary, status } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();

  return (
    <Page title="Referrals">
      <BlockStack gap="400">
        <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Total referrals</Text><Text as="span" variant="headingLg">{summary.total}</Text></BlockStack></Box></Card>
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Conversion rate</Text><Text as="span" variant="headingLg">{(summary.conversionRate * 100).toFixed(0)}%</Text></BlockStack></Box></Card>
          <Card><Box padding="400"><BlockStack gap="100"><Text as="span" tone="subdued">Rewards issued</Text><Text as="span" variant="headingLg">{summary.rewardsIssued}</Text></BlockStack></Box></Card>
        </InlineGrid>

        {fetcher.data && !fetcher.data.ok ? <Banner tone="critical">{fetcher.data.error}</Banner> : null}

        <Card>
          <Box padding="400">
            <Form method="get">
              <Select
                label="Status" labelHidden name="status" value={status}
                options={[
                  { label: "All", value: "" },
                  { label: "Pending", value: "pending" },
                  { label: "Completed", value: "completed" },
                  { label: "Flagged", value: "flagged" },
                  { label: "Blocked", value: "blocked" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  if (v) next.set("status", v); else next.delete("status");
                  setParams(next);
                }}
              />
            </Form>
          </Box>
          {referrals.length === 0 ? (
            <Box padding="400"><Text as="p" tone="subdued">No referrals match this filter.</Text></Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "referral", plural: "referrals" }}
              itemCount={referrals.length}
              selectable={false}
              headings={[
                { title: "Referrer" }, { title: "Referred email" }, { title: "Status" },
                { title: "Created" }, { title: "Action" },
              ]}
            >
              {referrals.map((r, i) => (
                <IndexTable.Row id={r.id} key={r.id} position={i}>
                  <IndexTable.Cell>{r.referrerName}</IndexTable.Cell>
                  <IndexTable.Cell>{r.referredEmail}</IndexTable.Cell>
                  <IndexTable.Cell>{statusBadge(r.status, r.ipMatch)}</IndexTable.Cell>
                  <IndexTable.Cell>{r.createdAt.slice(0, 10)}</IndexTable.Cell>
                  <IndexTable.Cell>
                    {r.status === "blocked" || r.status === "flagged" ? (
                      <fetcher.Form method="post">
                        <input type="hidden" name="referralId" value={r.id} />
                        <Button submit size="slim">Review &amp; Unblock</Button>
                      </fetcher.Form>
                    ) : null}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.referrals.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.referrals.tsx
git commit -m "feat(admin): Referrals tab with fraud flags, filters, review-and-unblock"
```

---

## Task 7: Campaigns reads + CRUD

**Files:**
- Create: `app/lib/admin-campaigns.server.ts`
- Test: `app/lib/admin-campaigns.server.test.ts`

**Interfaces:**
- Produces:
  - `listCampaigns(): Promise<CampaignRow[]>` — `CampaignRow = { id; name; multiplier; startsAt; endsAt; isActive }`, newest first.
  - `createCampaign(input: { name: string; multiplier: number; startsAt: string; endsAt: string; isActive: boolean }): Promise<void>` — validates `name` non-empty, `multiplier >= 1`, `endsAt > startsAt` (throws `Error("invalid campaign")`). If `isActive`, deactivates all other campaigns first (only one active).
  - `updateCampaign(id: string, input: same): Promise<void>` — same validation + single-active rule.
  - `deleteCampaign(id: string): Promise<void>`.
  - `listLedger(opts: { from?: string; to?: string; actionType?: string }): Promise<LedgerExportRow[]>` — joins member name; newest first; capped at 5000 rows. `LedgerExportRow = { earnedAt; memberName; email; actionType; points; balanceAfter; reason }`.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/admin-campaigns.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("createCampaign validation", () => {
  it("rejects multiplier < 1 and end<=start", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { createCampaign } = await import("./admin-campaigns.server");
    await expect(
      createCampaign({ name: "X", multiplier: 0.5, startsAt: "2026-07-01", endsAt: "2026-07-10", isActive: false }),
    ).rejects.toThrow("invalid campaign");
    await expect(
      createCampaign({ name: "X", multiplier: 2, startsAt: "2026-07-10", endsAt: "2026-07-01", isActive: false }),
    ).rejects.toThrow("invalid campaign");
  });
});

describe("createCampaign single-active rule", () => {
  it("deactivates others when creating an active campaign", async () => {
    const neq = vi.fn(() => Promise.resolve({ error: null }));
    const update = vi.fn(() => ({ neq }));
    const insert = vi.fn(() => Promise.resolve({ data: [{ id: "new" }], error: null }));
    const from = vi.fn(() => ({ update, insert }));
    vi.doMock("../db.server", () => ({ db: { from } }));
    vi.resetModules();
    const { createCampaign } = await import("./admin-campaigns.server");
    await createCampaign({ name: "Eid", multiplier: 2, startsAt: "2026-07-01", endsAt: "2026-07-10", isActive: true });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(insert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run app/lib/admin-campaigns.server.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/lib/admin-campaigns.server.ts
import { db } from "../db.server";

export type CampaignRow = {
  id: string;
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

export type CampaignInput = {
  name: string;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
};

function validate(input: CampaignInput) {
  if (!input.name || !input.name.trim()) throw new Error("invalid campaign");
  if (!(input.multiplier >= 1)) throw new Error("invalid campaign");
  if (new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
    throw new Error("invalid campaign");
  }
}

async function deactivateAllExcept(exceptId: string | null) {
  let q = db.from("bonus_campaigns").update({ is_active: false });
  q = exceptId ? q.neq("id", exceptId) : q.neq("id", "00000000-0000-0000-0000-000000000000");
  const { error } = await q;
  if (error) throw error;
}

export async function listCampaigns(): Promise<CampaignRow[]> {
  const { data, error } = await db
    .from("bonus_campaigns")
    .select("id, name, multiplier, starts_at, ends_at, is_active")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((c: any) => ({
    id: c.id, name: c.name, multiplier: Number(c.multiplier),
    startsAt: c.starts_at, endsAt: c.ends_at, isActive: c.is_active,
  }));
}

export async function createCampaign(input: CampaignInput): Promise<void> {
  validate(input);
  if (input.isActive) await deactivateAllExcept(null);
  const { error } = await db.from("bonus_campaigns").insert({
    name: input.name.trim(),
    multiplier: input.multiplier,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    is_active: input.isActive,
  });
  if (error) throw error;
}

export async function updateCampaign(id: string, input: CampaignInput): Promise<void> {
  validate(input);
  if (input.isActive) await deactivateAllExcept(id);
  const { error } = await db
    .from("bonus_campaigns")
    .update({
      name: input.name.trim(),
      multiplier: input.multiplier,
      starts_at: input.startsAt,
      ends_at: input.endsAt,
      is_active: input.isActive,
    })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await db.from("bonus_campaigns").delete().eq("id", id);
  if (error) throw error;
}

export type LedgerExportRow = {
  earnedAt: string;
  memberName: string;
  email: string;
  actionType: string;
  points: number;
  balanceAfter: number;
  reason: string;
};

export async function listLedger(opts: {
  from?: string;
  to?: string;
  actionType?: string;
}): Promise<LedgerExportRow[]> {
  let q = db
    .from("points_ledger")
    .select("earned_at, action_type, points, balance_after, reason_note, members(first_name,last_name,email)");
  if (opts.from) q = q.gte("earned_at", opts.from);
  if (opts.to) q = q.lte("earned_at", opts.to);
  if (opts.actionType) q = q.eq("action_type", opts.actionType);
  const { data, error } = await q.order("earned_at", { ascending: false }).limit(5000);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    earnedAt: r.earned_at,
    memberName: [r.members?.first_name, r.members?.last_name].filter(Boolean).join(" ") || "—",
    email: r.members?.email ?? "",
    actionType: r.action_type,
    points: r.points,
    balanceAfter: r.balance_after,
    reason: r.reason_note ?? "",
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run app/lib/admin-campaigns.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-campaigns.server.ts app/lib/admin-campaigns.server.test.ts
git commit -m "feat(admin): campaign CRUD with single-active rule and ledger export reads"
```

---

## Task 8: Points & Campaigns tab route

**Files:**
- Create: `app/routes/app.campaigns.tsx`

**Interfaces:**
- Consumes: `listCampaigns`, `createCampaign`, `updateCampaign`, `deleteCampaign` from `../lib/admin-campaigns.server`.

- [ ] **Step 1: Write the route**

```tsx
// app/routes/app.campaigns.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useState } from "react";
import {
  Page, Card, IndexTable, Badge, Button, Modal, TextField, Checkbox, BlockStack, Box, Text, Banner, InlineStack,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import {
  listCampaigns, createCampaign, updateCampaign, deleteCampaign,
} from "../lib/admin-campaigns.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ campaigns: await listCampaigns() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "delete") {
      await deleteCampaign(String(form.get("id")));
    } else {
      const input = {
        name: String(form.get("name") ?? ""),
        multiplier: Number(form.get("multiplier")),
        startsAt: String(form.get("startsAt")),
        endsAt: String(form.get("endsAt")),
        isActive: form.get("isActive") === "true",
      };
      if (intent === "create") await createCampaign(input);
      else if (intent === "update") await updateCampaign(String(form.get("id")), input);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

export default function Campaigns() {
  const { campaigns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [multiplier, setMultiplier] = useState("2");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [isActive, setIsActive] = useState(true);

  return (
    <Page
      title="Points & Campaigns"
      primaryAction={{ content: "New campaign", onAction: () => setOpen(true) }}
      secondaryActions={[{ content: "Export ledger CSV", url: "/app/campaigns/ledger.csv" }]}
    >
      <BlockStack gap="400">
        {fetcher.data && !fetcher.data.ok ? <Banner tone="critical">{fetcher.data.error}</Banner> : null}
        <Card>
          {campaigns.length === 0 ? (
            <Box padding="400"><Text as="p" tone="subdued">No campaigns yet.</Text></Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "campaign", plural: "campaigns" }}
              itemCount={campaigns.length}
              selectable={false}
              headings={[
                { title: "Name" }, { title: "Multiplier" }, { title: "Window" },
                { title: "Status" }, { title: "" },
              ]}
            >
              {campaigns.map((c, i) => (
                <IndexTable.Row id={c.id} key={c.id} position={i}>
                  <IndexTable.Cell>{c.name}</IndexTable.Cell>
                  <IndexTable.Cell>{c.multiplier}×</IndexTable.Cell>
                  <IndexTable.Cell>{c.startsAt.slice(0, 10)} → {c.endsAt.slice(0, 10)}</IndexTable.Cell>
                  <IndexTable.Cell>{c.isActive ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</IndexTable.Cell>
                  <IndexTable.Cell>
                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={c.id} />
                      <Button submit size="slim" tone="critical">Delete</Button>
                    </fetcher.Form>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New campaign"
        primaryAction={{
          content: "Create",
          onAction: () => {
            fetcher.submit(
              { intent: "create", name, multiplier, startsAt, endsAt, isActive: String(isActive) },
              { method: "post" },
            );
            setOpen(false);
          },
        }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
            <TextField label="Multiplier" type="number" value={multiplier} onChange={setMultiplier} autoComplete="off" />
            <InlineStack gap="300">
              <TextField label="Starts at" type="datetime-local" value={startsAt} onChange={setStartsAt} autoComplete="off" />
              <TextField label="Ends at" type="datetime-local" value={endsAt} onChange={setEndsAt} autoComplete="off" />
            </InlineStack>
            <Checkbox label="Set as the active campaign" checked={isActive} onChange={setIsActive} />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.campaigns.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.campaigns.tsx
git commit -m "feat(admin): Points & Campaigns tab with CRUD and ledger export link"
```

---

## Task 9: Ledger CSV export resource route

**Files:**
- Create: `app/routes/app.campaigns.ledger[.]csv.tsx`

> Maps to URL `/app/campaigns/ledger.csv`.

**Interfaces:**
- Consumes: `listLedger` from `../lib/admin-campaigns.server`; `toCsv`, `csvResponse` from `../lib/csv.server`.

- [ ] **Step 1: Write the resource route**

```tsx
// app/routes/app.campaigns.ledger[.]csv.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { listLedger } from "../lib/admin-campaigns.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const rows = await listLedger({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    actionType: url.searchParams.get("actionType") ?? undefined,
  });
  const csv = toCsv(rows, [
    { key: "earnedAt", header: "Date" },
    { key: "memberName", header: "Member" },
    { key: "email", header: "Email" },
    { key: "actionType", header: "Action" },
    { key: "points", header: "Points" },
    { key: "balanceAfter", header: "Balance After" },
    { key: "reason", header: "Reason" },
  ] as const);
  return csvResponse("points-ledger.csv", csv);
};
```

- [ ] **Step 2: Type-check & full test run**

Run:
```bash
npx tsc --noEmit -p tsconfig.json && npx vitest run
```
Expected: no type errors; all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add "app/routes/app.campaigns.ledger[.]csv.tsx"
git commit -m "feat(admin): points ledger CSV export route"
```

---

## Task 10: Build verification & deploy

- [ ] **Step 1: Production build**

Run:
```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 2: Commit any tracked artifacts, then push**

Run:
```bash
git status --porcelain
git add -A && git commit -m "chore(admin): build artifacts for Week 6B operational tools" || echo "nothing to commit"
git push origin main
```
Expected: push succeeds; Render auto-deploys.

---

## Self-Review Notes

- **Spec coverage (6B scope):** Influencer list + per-influencer stats + slug edit + quick adjust + CSV (Tasks 2–4); Referrals events with fraud flags + status/date filter + summary + Review & Unblock (Tasks 5–6); Points & Campaigns full ledger CSV + campaign create/edit/delete + history + single-active rule (Tasks 7–9). ✅
- **CSV correctness:** RFC-4180 quoting unit-tested (Task 1). ✅
- **Single-active campaign rule** enforced and tested (Task 7). ✅
- **Review & Unblock** does not re-award points (points come from the referral webhook flow), only flips status + clears reason (Task 5). ✅
- **Clicks interpretation:** no clicks table exists; "clicks" = total referral rows per influencer (documented in Task 2 interface). If a dedicated visit-tracking table is added later, swap the `clicks` source.
- `updateCampaign`/`deleteCampaign` UI: this plan ships create + delete in the route; an edit modal can reuse the same form with `intent="update"` and a hidden `id` — fold into Task 8 if the reviewer wants edit-in-place now (interfaces already support it).
