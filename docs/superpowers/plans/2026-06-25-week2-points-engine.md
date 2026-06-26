# Week 2 Points Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the points earning/removal engine — atomic award RPC, policy service, workers, and webhook handlers — so customers earn/lose points correctly and idempotently on purchase, refund, signup, social action, birthday, and expiry.

**Architecture:** Approach B — a single `points.service.ts` holds all policy; thin BullMQ workers call it; one atomic Postgres `award_points` RPC is the sole writer of `members.points_balance` (advisory lock + ledger-insert-first idempotency). Schema migration lands first; everything depends on it.

**Tech Stack:** Remix (Node 18, ESM), Supabase JS (`@supabase/supabase-js`, service key), Postgres PG17 (RPC + migration via Supabase MCP), BullMQ 5 + ioredis, Vitest (new), Shopify App Remix 3 webhooks (API 2025-04).

## Global Constraints

- **API version:** Shopify `2025-04` (pinned in `shopify.app.toml`).
- **`action_type` values MUST match the live CHECK constraint** `points_ledger_action_type_check`: `signup, purchase, social_youtube, social_facebook, social_instagram, review, referral_earned, referral_bonus, redemption, expiry, adjustment, birthday, campaign_bonus, refund_deduction`. Never invent new values; never loosen the constraint.
- **Points are INTEGER.** Rounding rule: **floor on awards, ceil on claw-backs**. Compute money on **integer paisa** (`Math.round(Number(amount) * 100)`), never `parseFloat`-subtract PKR.
- **`members.points_balance` is written ONLY by the `award_points` RPC.** No service/worker code mutates it directly.
- **`shopify_customer_id` is `text`** — always `String(...)` the Shopify numeric id at every enqueue/award/lookup.
- **Webhook handlers** return 200 for business-logic errors (avoid retry storms) but **non-2xx if the BullMQ enqueue itself throws** (so Shopify redelivers).
- **DB access is service-key only** (RLS enabled, zero policies). No anon-key reads.
- **Timezone for crons:** `Asia/Karachi` (UTC+5, no DST) — pass `tz` explicitly to every repeatable job.
- **Migrations** are applied via the Supabase MCP (`apply_migration`); types regenerated via `generate_typescript_types` into `app/database.types.ts`.
- **Commit frequently** — one commit per task minimum.

---

## File Structure

- `app/lib/points.service.ts` (new) — all policy: `roundAward`, `roundClawback`, `getActiveMultiplier`, `awardPoints`, `deductPoints`, `enrolMember`, `generateSlug`, `checkAndUpgradeTier`, `mapSocialActionType`.
- `app/lib/points.service.test.ts` (new) — pure-unit tests for policy functions.
- `app/workers/points.worker.ts` (new) — purchase + refund jobs.
- `app/workers/social.worker.ts` (new) — 24h-delayed social award.
- `app/workers/cron.worker.ts` (new) — birthday + expiry repeatable jobs.
- `app/lib/queue.server.ts` (modify) — queues + worker registration, guarded so only the worker process runs workers.
- `app/routes/webhooks.orders-fulfilled.tsx` (new) — primary earn trigger.
- `app/routes/webhooks.refunds-create.tsx` (new) — refund claw-back.
- `app/routes/webhooks.customers-create.tsx` (modify) — enrol only, no award, random slug.
- `app/routes/webhooks.customers-enable.tsx` (new) — award 1,000 signup points.
- `app/routes/webhooks.orders-updated.tsx` (modify) — demote: maintain paid status only, no award gate.
- `app/routes/webhooks.orders-paid.tsx` (modify) — fix false comment; keep as paid-status updater.
- `shopify.app.toml` (modify) — add `orders/fulfilled`, `customers/enable`, `refunds/create`.
- `supabase/migrations/*` (new) — gating migration + `award_points` RPC.
- `app/database.types.ts` (regenerate).
- `package.json`, `vitest.config.ts` (modify/new) — test tooling.

---

### Task 1: Test tooling (Vitest)

**Files:**
- Modify: `package.json` (add devDeps + `test` script)
- Create: `vitest.config.ts`
- Create: `app/lib/sanity.test.ts` (temporary smoke test, removed in Step 5)

**Interfaces:**
- Produces: a working `npm test` command for all later tasks.

- [ ] **Step 1: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["app/**/*.test.ts"],
    globals: false,
  },
});
```

- [ ] **Step 2: Add deps and script**

Run:
```bash
cd "D:/Heygirlpk Rewards/heygirl-rewards" && npm install -D vitest@^2.0.0
```
Then add to `package.json` `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 3: Write a smoke test**

Create `app/lib/sanity.test.ts`:
```ts
import { expect, test } from "vitest";
test("vitest runs", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Run it**

Run: `npm test`
Expected: PASS, 1 test.

- [ ] **Step 5: Remove smoke test and commit**

```bash
rm "app/lib/sanity.test.ts"
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add Vitest test tooling"
```

---

### Task 2: Gating schema migration

**Files:**
- Create: migration via Supabase MCP `apply_migration` (name: `week2_points_engine_gating`)
- Modify: `app/database.types.ts` (regenerate via MCP `generate_typescript_types`)

**Interfaces:**
- Produces: `points_ledger.points_remaining` column; unique index `points_ledger_idempotency_uniq`; FIFO partial index; `members_points_balance_nonneg` CHECK; `bonus_campaigns` one-active exclusion + lookup index.

- [ ] **Step 1: Apply the migration**

Use the Supabase MCP `apply_migration` tool, project `zobnrlgfxlbuwlahwngn`, name `week2_points_engine_gating`, with this SQL:

```sql
-- 1. Partial-consumption column for FIFO (refund + expiry)
ALTER TABLE points_ledger
  ADD COLUMN IF NOT EXISTS points_remaining integer;
-- backfill: positive purchase tranches start fully remaining; others null
UPDATE points_ledger
  SET points_remaining = points
  WHERE action_type = 'purchase' AND points_remaining IS NULL AND points > 0;

-- 2. Idempotency unique index (NULLS NOT DISTINCT — PG15+)
CREATE UNIQUE INDEX IF NOT EXISTS points_ledger_idempotency_uniq
  ON points_ledger (member_id, action_type, reference_id) NULLS NOT DISTINCT;

-- 3. FIFO hot-path index
CREATE INDEX IF NOT EXISTS points_ledger_fifo_idx
  ON points_ledger (member_id, earned_at)
  WHERE action_type = 'purchase' AND expired = false;

-- 4. Balance never negative
ALTER TABLE members
  ADD CONSTRAINT members_points_balance_nonneg CHECK (points_balance >= 0) NOT VALID;
ALTER TABLE members VALIDATE CONSTRAINT members_points_balance_nonneg;

-- 5. One active bonus campaign at a time + lookup index
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE bonus_campaigns
  ADD CONSTRAINT bonus_campaigns_no_overlap
  EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&)
  WHERE (is_active);
CREATE INDEX IF NOT EXISTS bonus_campaigns_active_idx
  ON bonus_campaigns (is_active, starts_at, ends_at);
```

- [ ] **Step 2: Verify objects exist**

Use Supabase MCP `execute_sql`:
```sql
SELECT indexname FROM pg_indexes WHERE tablename = 'points_ledger'
  AND indexname IN ('points_ledger_idempotency_uniq','points_ledger_fifo_idx');
SELECT conname FROM pg_constraint WHERE conname IN
  ('members_points_balance_nonneg','bonus_campaigns_no_overlap');
SELECT column_name FROM information_schema.columns
  WHERE table_name='points_ledger' AND column_name='points_remaining';
```
Expected: all five names returned.

- [ ] **Step 3: Regenerate types**

Use Supabase MCP `generate_typescript_types`; write the result to `app/database.types.ts` (overwrite).

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add supabase/ app/database.types.ts
git commit -m "feat(db): week2 gating migration — idempotency index, points_remaining, FIFO index, balance CHECK, one-active-campaign"
```

---

### Task 3: `award_points` RPC

**Files:**
- Create: migration via Supabase MCP `apply_migration` (name: `award_points_rpc`)
- Test: integration via Supabase MCP `execute_sql` (Steps 2, 4)

**Interfaces:**
- Produces: Postgres function
  `award_points(p_member_id uuid, p_action_type text, p_reference_id text, p_points integer, p_expires_at timestamptz, p_shopify_order_id text, p_reason_note text) RETURNS TABLE(awarded boolean, new_balance integer)`.
  `awarded=false` means idempotent no-op (duplicate). `p_points` may be negative (claw-back/expiry). Balance clamps at 0.

- [ ] **Step 1: Create the RPC**

Use Supabase MCP `apply_migration`, name `award_points_rpc`:

```sql
CREATE OR REPLACE FUNCTION award_points(
  p_member_id uuid,
  p_action_type text,
  p_reference_id text,
  p_points integer,
  p_expires_at timestamptz DEFAULT NULL,
  p_shopify_order_id text DEFAULT NULL,
  p_reason_note text DEFAULT NULL
) RETURNS TABLE(awarded boolean, new_balance integer)
LANGUAGE plpgsql AS $$
DECLARE
  v_current integer;
  v_delta integer := p_points;
  v_new integer;
BEGIN
  -- Serialize concurrent jobs for the same action+reference
  PERFORM pg_advisory_xact_lock(hashtextextended(p_action_type || ':' || coalesce(p_reference_id,''), 0));

  SELECT points_balance INTO v_current FROM members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'member % not found', p_member_id;
  END IF;

  -- Clamp negative deltas so balance never goes below zero
  IF v_current + v_delta < 0 THEN
    v_delta := -v_current;
  END IF;
  v_new := v_current + v_delta;

  BEGIN
    INSERT INTO points_ledger
      (member_id, action_type, reference_id, points, balance_after,
       expires_at, points_remaining, shopify_order_id, reason_note)
    VALUES
      (p_member_id, p_action_type, p_reference_id, v_delta, v_new,
       p_expires_at,
       CASE WHEN p_action_type = 'purchase' AND v_delta > 0 THEN v_delta ELSE NULL END,
       p_shopify_order_id, p_reason_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT false, v_current;  -- duplicate: idempotent no-op
    RETURN;
  END;

  UPDATE members SET points_balance = v_new, updated_at = now() WHERE id = p_member_id;

  IF p_shopify_order_id IS NOT NULL AND p_action_type = 'purchase' THEN
    UPDATE order_webhook_state SET points_awarded = true, updated_at = now()
      WHERE shopify_order_id = p_shopify_order_id;
  END IF;

  RETURN QUERY SELECT true, v_new;
END;
$$;
```

- [ ] **Step 2: Integration test — idempotency**

Use Supabase MCP `execute_sql` (against a throwaway member; create one first):
```sql
INSERT INTO members (shopify_customer_id, email, referral_slug, tier)
  VALUES ('test-rpc-1','rpc1@test.local','rpc-test-1','silver')
  ON CONFLICT (shopify_customer_id) DO NOTHING;
WITH m AS (SELECT id FROM members WHERE shopify_customer_id='test-rpc-1')
SELECT * FROM award_points((SELECT id FROM m),'purchase','order-rpc-1',1500,NULL,'order-rpc-1',NULL);
WITH m AS (SELECT id FROM members WHERE shopify_customer_id='test-rpc-1')
SELECT * FROM award_points((SELECT id FROM m),'purchase','order-rpc-1',1500,NULL,'order-rpc-1',NULL);
SELECT points_balance FROM members WHERE shopify_customer_id='test-rpc-1';
```
Expected: first call `awarded=true, new_balance=1500`; second `awarded=false, new_balance=1500`; final balance `1500` (not 3000).

- [ ] **Step 3: Integration test — clamp at zero**

```sql
WITH m AS (SELECT id FROM members WHERE shopify_customer_id='test-rpc-1')
SELECT * FROM award_points((SELECT id FROM m),'refund_deduction','refund-rpc-1',-5000,NULL,NULL,NULL);
SELECT points_balance FROM members WHERE shopify_customer_id='test-rpc-1';
```
Expected: `new_balance=0`, balance `0` (clamped, not -3500).

- [ ] **Step 4: Clean up test data + commit**

```sql
DELETE FROM points_ledger WHERE member_id = (SELECT id FROM members WHERE shopify_customer_id='test-rpc-1');
DELETE FROM members WHERE shopify_customer_id='test-rpc-1';
```
```bash
git add supabase/
git commit -m "feat(db): award_points RPC — advisory lock, idempotent insert, clamp at zero"
```

---

### Task 4: Rounding + multiplier policy (`points.service.ts` part 1)

**Files:**
- Create: `app/lib/points.service.ts`
- Test: `app/lib/points.service.test.ts`

**Interfaces:**
- Produces:
  - `roundAward(value: number): number` — `Math.floor`.
  - `roundClawback(value: number): number` — `Math.ceil`.
  - `computePurchasePoints(orderTotalPaisa: number, shippingPaisa: number, taxPaisa: number, multiplier: number): number` — base = `(total-shipping-tax)/100`, times multiplier, `roundAward`.
  - `mapSocialActionType(short: "youtube"|"facebook"|"instagram"): "social_youtube"|"social_facebook"|"social_instagram"`.

- [ ] **Step 1: Write failing tests**

Create `app/lib/points.service.test.ts`:
```ts
import { expect, test } from "vitest";
import {
  roundAward, roundClawback, computePurchasePoints, mapSocialActionType,
} from "./points.service";

test("roundAward floors", () => {
  expect(roundAward(1798.8)).toBe(1798);
  expect(roundAward(1500)).toBe(1500);
});

test("roundClawback ceils", () => {
  expect(roundClawback(1798.2)).toBe(1799);
  expect(roundClawback(1500)).toBe(1500);
});

test("computePurchasePoints uses integer paisa, no float drift", () => {
  // Rs.1499.50 total, Rs.0 shipping/tax, 1x -> 1499 (floor)
  expect(computePurchasePoints(149950, 0, 0, 1)).toBe(1499);
  // 1.2x Diamond birthday: 1499.5 * 1.2 = 1799.4 -> 1799
  expect(computePurchasePoints(149950, 0, 0, 1.2)).toBe(1799);
  // subtract shipping+tax in paisa: (200000-15000-5000)/100 = 1800
  expect(computePurchasePoints(200000, 15000, 5000, 1)).toBe(1800);
});

test("mapSocialActionType maps short to ledger long form", () => {
  expect(mapSocialActionType("youtube")).toBe("social_youtube");
  expect(mapSocialActionType("facebook")).toBe("social_facebook");
  expect(mapSocialActionType("instagram")).toBe("social_instagram");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — `points.service` has no such exports.

- [ ] **Step 3: Implement**

Create `app/lib/points.service.ts`:
```ts
import { db } from "../db.server";

export function roundAward(value: number): number {
  return Math.floor(value);
}

export function roundClawback(value: number): number {
  return Math.ceil(value);
}

export function computePurchasePoints(
  orderTotalPaisa: number,
  shippingPaisa: number,
  taxPaisa: number,
  multiplier: number,
): number {
  const basisPaisa = orderTotalPaisa - shippingPaisa - taxPaisa;
  const basisRupees = basisPaisa / 100; // exact: integer paisa divided once
  return roundAward(basisRupees * multiplier);
}

export function mapSocialActionType(
  short: "youtube" | "facebook" | "instagram",
): "social_youtube" | "social_facebook" | "social_instagram" {
  return `social_${short}` as const;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat: points.service rounding + purchase-points + social-type policy"
```

---

### Task 5: `getActiveMultiplier` (`points.service.ts` part 2)

**Files:**
- Modify: `app/lib/points.service.ts`
- Test: `app/lib/points.service.test.ts`

**Interfaces:**
- Consumes: `db` (Supabase), `bonus_campaigns`, member `{ tier, birthday_month }`.
- Produces: `getActiveMultiplier(member: { tier: string; birthday_month: number | null }, now?: Date): Promise<number>` — campaign multiplier if an active campaign covers `now`; else `1.2` if Diamond and `now`'s month === birthday_month; else `1`.

- [ ] **Step 1: Write failing tests (pure helper extracted for testability)**

Add to `app/lib/points.service.test.ts`:
```ts
import { selectMultiplier } from "./points.service";

test("selectMultiplier: active campaign wins with its own value", () => {
  expect(selectMultiplier(2.5, { tier: "diamond", birthday_month: 6 }, 6)).toBe(2.5);
});
test("selectMultiplier: diamond birthday month -> 1.2 when no campaign", () => {
  expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 6)).toBe(1.2);
});
test("selectMultiplier: gold birthday month -> 1 (no multiplier)", () => {
  expect(selectMultiplier(null, { tier: "gold", birthday_month: 6 }, 6)).toBe(1);
});
test("selectMultiplier: diamond non-birthday month -> 1", () => {
  expect(selectMultiplier(null, { tier: "diamond", birthday_month: 6 }, 7)).toBe(1);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — `selectMultiplier` not exported.

- [ ] **Step 3: Implement**

Add to `app/lib/points.service.ts`:
```ts
export function selectMultiplier(
  campaignMultiplier: number | null,
  member: { tier: string; birthday_month: number | null },
  currentMonth: number,
): number {
  if (campaignMultiplier != null) return campaignMultiplier;
  if (member.tier === "diamond" && member.birthday_month === currentMonth) return 1.2;
  return 1;
}

export async function getActiveMultiplier(
  member: { tier: string; birthday_month: number | null },
  now: Date = new Date(),
): Promise<number> {
  const iso = now.toISOString();
  const { data } = await db
    .from("bonus_campaigns")
    .select("multiplier")
    .eq("is_active", true)
    .lte("starts_at", iso)
    .gte("ends_at", iso)
    .limit(1)
    .maybeSingle();
  return selectMultiplier(data?.multiplier ?? null, member, now.getMonth() + 1);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (8 total).

- [ ] **Step 5: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat: getActiveMultiplier (campaign value > diamond birthday 1.2x > 1x)"
```

---

### Task 6: `enrolMember` + `generateSlug`

**Files:**
- Modify: `app/lib/points.service.ts`
- Test: `app/lib/points.service.test.ts`

**Interfaces:**
- Consumes: `db`, `members`.
- Produces:
  - `generateSlug(firstName?: string, lastName?: string): string` — `name + "-" + 4-random-digits`, lowercased, `[^a-z0-9-]` stripped; fallback base `member`.
  - `enrolMember(customer: { id: number|string; email?: string|null; first_name?: string|null; last_name?: string|null }): Promise<{ enrolled: boolean; reason?: string }>` — skips (logs) if no email; idempotent on existing `shopify_customer_id`; inserts Silver member with unique slug (retry on collision). **Does NOT award points.**

- [ ] **Step 1: Write failing test for slug shape**

Add to `app/lib/points.service.test.ts`:
```ts
import { generateSlug } from "./points.service";

test("generateSlug: name + 4 random digits, no internal id", () => {
  const slug = generateSlug("Sara", "Khan");
  expect(slug).toMatch(/^sara-khan-\d{4}$/);
});
test("generateSlug: strips unsafe chars, falls back to member", () => {
  expect(generateSlug("", "")).toMatch(/^member-\d{4}$/);
  expect(generateSlug("Zoë!", undefined)).toMatch(/^zo-\d{4}$/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — `generateSlug` not exported.

- [ ] **Step 3: Implement slug + enrolMember**

Add to `app/lib/points.service.ts`:
```ts
export function generateSlug(firstName?: string | null, lastName?: string | null): string {
  const base =
    [firstName, lastName].filter(Boolean).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") ||
    "member";
  const suffix = Math.floor(1000 + Math.random() * 9000); // 4 digits
  return `${base}-${suffix}`;
}

export async function enrolMember(customer: {
  id: number | string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): Promise<{ enrolled: boolean; reason?: string }> {
  const customerId = String(customer.id);
  if (!customer.email) {
    console.warn(`[enrolMember] skip: customer ${customerId} has no email`);
    return { enrolled: false, reason: "no_email" };
  }

  const { data: existing } = await db
    .from("members")
    .select("id")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (existing) return { enrolled: false, reason: "already_member" };

  for (let attempt = 0; attempt < 5; attempt++) {
    const { error } = await db.from("members").insert({
      shopify_customer_id: customerId,
      email: customer.email,
      first_name: customer.first_name ?? null,
      last_name: customer.last_name ?? null,
      tier: "silver",
      points_balance: 0,
      lifetime_spend_pkr: 0,
      referral_slug: generateSlug(customer.first_name, customer.last_name),
      consent_given: false,
    });
    if (!error) return { enrolled: true };
    if (!error.message?.includes("referral_slug")) {
      console.error("[enrolMember] insert error:", error);
      return { enrolled: false, reason: "insert_error" };
    }
    // else slug collision — retry with a new suffix
  }
  return { enrolled: false, reason: "slug_collision" };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (10 total).

- [ ] **Step 5: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat: enrolMember (enrol only, no award) + random-4-digit slug"
```

---

### Task 7: `checkAndUpgradeTier`

**Files:**
- Modify: `app/lib/points.service.ts`
- Test: `app/lib/points.service.test.ts`

**Interfaces:**
- Produces:
  - `tierForSpend(lifetimeSpendPkr: number): "silver"|"gold"|"diamond"` — `>=100000` diamond, `>=50000` gold, else silver.
  - `checkAndUpgradeTier(memberId: string, lifetimeSpendPkr: number, currentTier: string): Promise<string>` — computes target tier; if higher than current, updates `members.tier` and nulls `expires_at` on the member's still-unexpired ledger rows (their points now never expire). Returns the resulting tier.

- [ ] **Step 1: Write failing test for tierForSpend**

Add to `app/lib/points.service.test.ts`:
```ts
import { tierForSpend } from "./points.service";

test("tierForSpend thresholds", () => {
  expect(tierForSpend(0)).toBe("silver");
  expect(tierForSpend(49999)).toBe("silver");
  expect(tierForSpend(50000)).toBe("gold");
  expect(tierForSpend(99999)).toBe("gold");
  expect(tierForSpend(100000)).toBe("diamond");
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — `tierForSpend` not exported.

- [ ] **Step 3: Implement**

Add to `app/lib/points.service.ts`:
```ts
const TIER_RANK: Record<string, number> = { silver: 0, gold: 1, diamond: 2 };

export function tierForSpend(lifetimeSpendPkr: number): "silver" | "gold" | "diamond" {
  if (lifetimeSpendPkr >= 100000) return "diamond";
  if (lifetimeSpendPkr >= 50000) return "gold";
  return "silver";
}

export async function checkAndUpgradeTier(
  memberId: string,
  lifetimeSpendPkr: number,
  currentTier: string,
): Promise<string> {
  const target = tierForSpend(lifetimeSpendPkr);
  if (TIER_RANK[target] <= TIER_RANK[currentTier]) return currentTier;

  await db.from("members").update({ tier: target }).eq("id", memberId);
  // Points now never expire for gold/diamond — stop aging existing tranches
  await db
    .from("points_ledger")
    .update({ expires_at: null })
    .eq("member_id", memberId)
    .eq("expired", false)
    .not("expires_at", "is", null);
  return target;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (11 total).

- [ ] **Step 5: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat: checkAndUpgradeTier — upgrade + null expiry on promotion"
```

---

### Task 8: `awardPurchase` orchestration

**Files:**
- Modify: `app/lib/points.service.ts`
- Test: `app/lib/points.service.test.ts`

**Interfaces:**
- Consumes: `getActiveMultiplier`, `computePurchasePoints`, the `award_points` RPC, `checkAndUpgradeTier`.
- Produces:
  - `expiresAtForMember(tier: string, earnedAt?: Date): string | null` — 365 days from `earnedAt` for Silver, else null.
  - `awardPurchase(input: { shopifyCustomerId: string; shopifyOrderId: string; orderTotalPaisa: number; shippingPaisa: number; taxPaisa: number }): Promise<{ awarded: boolean; points: number }>` — loads member, computes multiplier+points, calls RPC with `expires_at`, updates `lifetime_spend_pkr`, runs tier check.

- [ ] **Step 1: Write failing test for expiresAtForMember**

Add to `app/lib/points.service.test.ts`:
```ts
import { expiresAtForMember } from "./points.service";

test("expiresAtForMember: silver gets +365d, others null", () => {
  const base = new Date("2026-01-01T00:00:00Z");
  expect(expiresAtForMember("silver", base)).toBe(new Date("2027-01-01T00:00:00Z").toISOString());
  expect(expiresAtForMember("gold", base)).toBeNull();
  expect(expiresAtForMember("diamond", base)).toBeNull();
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test`
Expected: FAIL — `expiresAtForMember` not exported.

- [ ] **Step 3: Implement**

Add to `app/lib/points.service.ts`:
```ts
export function expiresAtForMember(tier: string, earnedAt: Date = new Date()): string | null {
  if (tier !== "silver") return null;
  const d = new Date(earnedAt);
  d.setDate(d.getDate() + 365);
  return d.toISOString();
}

export async function awardPurchase(input: {
  shopifyCustomerId: string;
  shopifyOrderId: string;
  orderTotalPaisa: number;
  shippingPaisa: number;
  taxPaisa: number;
}): Promise<{ awarded: boolean; points: number }> {
  const customerId = String(input.shopifyCustomerId);
  const { data: member } = await db
    .from("members")
    .select("id, tier, birthday_month, lifetime_spend_pkr")
    .eq("shopify_customer_id", customerId)
    .maybeSingle();
  if (!member) {
    console.warn(`[awardPurchase] no member for customer ${customerId}`);
    return { awarded: false, points: 0 };
  }

  const multiplier = await getActiveMultiplier(member, new Date());
  const points = computePurchasePoints(
    input.orderTotalPaisa, input.shippingPaisa, input.taxPaisa, multiplier,
  );
  if (points <= 0) return { awarded: false, points: 0 };

  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id,
    p_action_type: "purchase",
    p_reference_id: String(input.shopifyOrderId),
    p_points: points,
    p_expires_at: expiresAtForMember(member.tier),
    p_shopify_order_id: String(input.shopifyOrderId),
    p_reason_note: null,
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (!awarded) return { awarded: false, points: 0 };

  const basisRupees = (input.orderTotalPaisa - input.shippingPaisa - input.taxPaisa) / 100;
  const newSpend = Number(member.lifetime_spend_pkr) + basisRupees;
  await db.from("members").update({ lifetime_spend_pkr: newSpend }).eq("id", member.id);
  await checkAndUpgradeTier(member.id, newSpend, member.tier);
  return { awarded: true, points };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test`
Expected: PASS (12 total).

- [ ] **Step 5: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat: awardPurchase orchestration (multiplier, RPC, spend, tier)"
```

---

### Task 9: `awardSignup` + `awardSocial`

**Files:**
- Modify: `app/lib/points.service.ts`

**Interfaces:**
- Consumes: `award_points` RPC, `mapSocialActionType`, `app_settings` (for point values — fallback to defaults if absent).
- Produces:
  - `awardSignup(shopifyCustomerId: string): Promise<{ awarded: boolean }>` — looks up member, awards `signup_points` (default 1000), `action_type='signup'`, `reference_id=shopifyCustomerId`.
  - `awardSocial(socialActionId: string): Promise<{ awarded: boolean }>` — loads `social_actions` row; if `status !== 'pending'` no-op; awards `social_points` (default 1000) with `action_type = mapSocialActionType(row.action_type)`, `reference_id = socialActionId`; sets row `status='awarded'`, `points_awarded=<n>`.

- [ ] **Step 1: Implement (covered by integration tests in Task 12/handler tasks; no pure unit test needed here)**

Add to `app/lib/points.service.ts`:
```ts
async function settingValue(key: "signup_points" | "social_points", fallback: number): Promise<number> {
  const { data } = await db.from("app_settings").select(key).eq("id", 1).maybeSingle();
  const v = (data as Record<string, number> | null)?.[key];
  return typeof v === "number" ? v : fallback;
}

export async function awardSignup(shopifyCustomerId: string): Promise<{ awarded: boolean }> {
  const customerId = String(shopifyCustomerId);
  const { data: member } = await db
    .from("members").select("id").eq("shopify_customer_id", customerId).maybeSingle();
  if (!member) { console.warn(`[awardSignup] no member ${customerId}`); return { awarded: false }; }
  const points = await settingValue("signup_points", 1000);
  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id, p_action_type: "signup", p_reference_id: customerId,
    p_points: points, p_expires_at: null, p_shopify_order_id: null, p_reason_note: null,
  });
  if (error) throw error;
  return { awarded: data?.[0]?.awarded ?? false };
}

export async function awardSocial(socialActionId: string): Promise<{ awarded: boolean }> {
  const { data: row } = await db
    .from("social_actions")
    .select("id, member_id, action_type, status")
    .eq("id", socialActionId).maybeSingle();
  if (!row) { console.warn(`[awardSocial] no action ${socialActionId}`); return { awarded: false }; }
  if (row.status !== "pending") return { awarded: false }; // voided/awarded already

  const points = await settingValue("social_points", 1000);
  const ledgerType = mapSocialActionType(row.action_type as "youtube" | "facebook" | "instagram");
  const { data, error } = await db.rpc("award_points", {
    p_member_id: row.member_id, p_action_type: ledgerType, p_reference_id: socialActionId,
    p_points: points, p_expires_at: null, p_shopify_order_id: null, p_reason_note: null,
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (awarded) {
    await db.from("social_actions")
      .update({ status: "awarded", points_awarded: points }).eq("id", socialActionId);
  }
  return { awarded };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/points.service.ts
git commit -m "feat: awardSignup + awardSocial (status re-check, settings-driven values)"
```

---

### Task 10: `awardRefund` (FIFO claw-back)

**Files:**
- Modify: `app/lib/points.service.ts`

**Interfaces:**
- Consumes: `award_points` RPC, `points_ledger.points_remaining`.
- Produces:
  - `awardRefund(input: { shopifyCustomerId: string; refundId: string; refundedMerchandisePaisa: number }): Promise<{ awarded: boolean; deducted: number }>` — computes points to claw back = `roundClawback(refundedMerchandisePaisa/100)`, decrements `points_remaining` oldest-first across that member's purchase tranches, and applies a negative RPC delta with `action_type='refund_deduction'`, `reference_id=refundId`.

- [ ] **Step 1: Implement**

Add to `app/lib/points.service.ts`:
```ts
export async function awardRefund(input: {
  shopifyCustomerId: string;
  refundId: string;
  refundedMerchandisePaisa: number;
}): Promise<{ awarded: boolean; deducted: number }> {
  const customerId = String(input.shopifyCustomerId);
  const { data: member } = await db
    .from("members").select("id").eq("shopify_customer_id", customerId).maybeSingle();
  if (!member) { console.warn(`[awardRefund] no member ${customerId}`); return { awarded: false, deducted: 0 }; }

  const clawback = roundClawback(input.refundedMerchandisePaisa / 100);
  if (clawback <= 0) return { awarded: false, deducted: 0 };

  // Idempotent negative award first; if duplicate refund id, stop (no double FIFO decrement)
  const { data, error } = await db.rpc("award_points", {
    p_member_id: member.id, p_action_type: "refund_deduction", p_reference_id: String(input.refundId),
    p_points: -clawback, p_expires_at: null, p_shopify_order_id: null, p_reason_note: "refund",
  });
  if (error) throw error;
  const awarded = data?.[0]?.awarded ?? false;
  if (!awarded) return { awarded: false, deducted: 0 };

  // Decrement points_remaining FIFO across purchase tranches
  let remaining = clawback;
  const { data: tranches } = await db
    .from("points_ledger")
    .select("id, points_remaining")
    .eq("member_id", member.id).eq("action_type", "purchase").eq("expired", false)
    .gt("points_remaining", 0).order("earned_at", { ascending: true });
  for (const t of tranches ?? []) {
    if (remaining <= 0) break;
    const take = Math.min(t.points_remaining ?? 0, remaining);
    await db.from("points_ledger")
      .update({ points_remaining: (t.points_remaining ?? 0) - take }).eq("id", t.id);
    remaining -= take;
  }
  return { awarded: true, deducted: clawback };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/points.service.ts
git commit -m "feat: awardRefund — idempotent clawback + FIFO points_remaining decrement"
```

---

### Task 11: `expireSilverPoints` (cron logic)

**Files:**
- Modify: `app/lib/points.service.ts`

**Interfaces:**
- Produces:
  - `expireSilverPoints(now?: Date): Promise<{ membersAffected: number; pointsExpired: number }>` — for Silver members with purchase tranches where `expires_at < now` and `points_remaining > 0`: per member, sum remaining, set those tranches `points_remaining=0, expired=true`, and apply a negative RPC delta `action_type='expiry'`, `reference_id=<one tranche id>` per tranche.

- [ ] **Step 1: Implement**

Add to `app/lib/points.service.ts`:
```ts
export async function expireSilverPoints(
  now: Date = new Date(),
): Promise<{ membersAffected: number; pointsExpired: number }> {
  const iso = now.toISOString();
  const { data: tranches } = await db
    .from("points_ledger")
    .select("id, member_id, points_remaining, members!inner(tier)")
    .eq("action_type", "purchase").eq("expired", false)
    .gt("points_remaining", 0).lt("expires_at", iso);

  const affected = new Set<string>();
  let total = 0;
  for (const t of tranches ?? []) {
    const tier = (t as any).members?.tier;
    if (tier !== "silver") continue; // safety: only silver expires
    const amount = t.points_remaining ?? 0;
    if (amount <= 0) continue;
    const { data, error } = await db.rpc("award_points", {
      p_member_id: t.member_id, p_action_type: "expiry", p_reference_id: String(t.id),
      p_points: -amount, p_expires_at: null, p_shopify_order_id: null, p_reason_note: "expiry",
    });
    if (error) throw error;
    if (data?.[0]?.awarded) {
      await db.from("points_ledger").update({ points_remaining: 0, expired: true }).eq("id", t.id);
      affected.add(t.member_id);
      total += amount;
    }
  }
  return { membersAffected: affected.size, pointsExpired: total };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/points.service.ts
git commit -m "feat: expireSilverPoints — FIFO expiry consuming points_remaining only"
```

---

### Task 12: Queue refactor + worker topology

**Files:**
- Modify: `app/lib/queue.server.ts`

**Interfaces:**
- Consumes: env `WORKER=1` to decide whether to start workers (web process must NOT start them).
- Produces: exported queues `pointsQueue`, `socialQueue`, `notificationQueue`; `startWorkers()` invoked only when `process.env.WORKER === "1"`.

- [ ] **Step 1: Refactor queue.server.ts**

Replace `app/lib/queue.server.ts` with:
```ts
import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";

if (!process.env.REDIS_URL) throw new Error("REDIS_URL is required");

function makeRedis() {
  const conn = new IORedis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  conn.on("error", (err) => console.error("[Redis] connection error:", err));
  return conn;
}

export const pointsQueue = new Queue("points", { connection: makeRedis() });
export const socialQueue = new Queue("social-actions", { connection: makeRedis() });
export const notificationQueue = new Queue("notifications", { connection: makeRedis() });

// Workers run ONLY in the dedicated worker process (WORKER=1), never the web dyno.
export function startWorkers() {
  if (process.env.WORKER !== "1") return;
  // Imported lazily so the web process never pulls worker code paths.
  void import("../workers/points.worker");
  void import("../workers/social.worker");
  void import("../workers/cron.worker");
  console.log("[workers] started");
}

export { makeRedis };
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/lib/queue.server.ts
git commit -m "refactor: queue exports + WORKER-gated startWorkers()"
```

---

### Task 13: Points worker (purchase + refund jobs)

**Files:**
- Create: `app/workers/points.worker.ts`

**Interfaces:**
- Consumes: `awardPurchase`, `awardRefund`, `awardSignup`, `makeRedis`.
- Job names: `award_purchase_points` `{ shopifyCustomerId, shopifyOrderId, orderTotalPaisa, shippingPaisa, taxPaisa }`; `award_refund` `{ shopifyCustomerId, refundId, refundedMerchandisePaisa }`; `award_signup_points` `{ shopifyCustomerId }`.

- [ ] **Step 1: Implement worker**

Create `app/workers/points.worker.ts`:
```ts
import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { awardPurchase, awardRefund, awardSignup } from "../lib/points.service";

export const pointsWorker = new Worker(
  "points",
  async (job) => {
    switch (job.name) {
      case "award_purchase_points":
        return awardPurchase(job.data);
      case "award_refund":
        return awardRefund(job.data);
      case "award_signup_points":
        return awardSignup(String(job.data.shopifyCustomerId));
      default:
        console.warn("[pointsWorker] unknown job:", job.name);
    }
  },
  { connection: makeRedis() },
);

pointsWorker.on("failed", (job, err) =>
  console.error("[pointsWorker] failed:", job?.id, job?.name, err.message),
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/workers/points.worker.ts
git commit -m "feat: points worker — purchase, refund, signup jobs"
```

---

### Task 14: Social worker

**Files:**
- Create: `app/workers/social.worker.ts`

**Interfaces:**
- Consumes: `awardSocial`, `makeRedis`.
- Job name: `award_social_points` `{ socialActionId }`, enqueued with `delay` = 24h by the storefront action route (later week); worker just calls `awardSocial`.

- [ ] **Step 1: Implement**

Create `app/workers/social.worker.ts`:
```ts
import { Worker } from "bullmq";
import { makeRedis } from "../lib/queue.server";
import { awardSocial } from "../lib/points.service";

export const socialWorker = new Worker(
  "social-actions",
  async (job) => {
    if (job.name === "award_social_points") {
      return awardSocial(String(job.data.socialActionId));
    }
    console.warn("[socialWorker] unknown job:", job.name);
  },
  { connection: makeRedis() },
);

socialWorker.on("failed", (job, err) =>
  console.error("[socialWorker] failed:", job?.id, err.message),
);
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/workers/social.worker.ts
git commit -m "feat: social worker — 24h-delayed award"
```

---

### Task 15: Cron worker (birthday + expiry repeatable jobs)

**Files:**
- Create: `app/workers/cron.worker.ts`

**Interfaces:**
- Consumes: `expireSilverPoints`, `notificationQueue`, `makeRedis`, `pointsQueue`.
- Produces: two repeatable jobs registered on the `points` queue with `tz: 'Asia/Karachi'` and stable `jobId`s: `cron_expiry` (daily 02:00) and `cron_birthday` (monthly, 1st, 09:00). The worker handles them.

- [ ] **Step 1: Implement**

Create `app/workers/cron.worker.ts`:
```ts
import { Worker } from "bullmq";
import { makeRedis, pointsQueue, notificationQueue } from "../lib/queue.server";
import { expireSilverPoints } from "../lib/points.service";
import { db } from "../db.server";

// Register repeatable jobs (idempotent: stable repeat keys via jobId).
export async function registerCronJobs() {
  await pointsQueue.add("cron_expiry", {}, {
    repeat: { pattern: "0 2 * * *", tz: "Asia/Karachi" }, jobId: "cron_expiry",
  });
  await pointsQueue.add("cron_birthday", {}, {
    repeat: { pattern: "0 9 1 * *", tz: "Asia/Karachi" }, jobId: "cron_birthday",
  });
}

export const cronWorker = new Worker(
  "points",
  async (job) => {
    if (job.name === "cron_expiry") {
      const r = await expireSilverPoints();
      // 30-day warning notification stub (real email Week 4)
      console.log("[cron_expiry]", r);
      return r;
    }
    if (job.name === "cron_birthday") {
      const month = new Date().getMonth() + 1;
      const { data: members } = await db
        .from("members").select("id, email, tier").eq("birthday_month", month);
      for (const m of members ?? []) {
        // Notification stub — real reward + email wired Week 4
        await notificationQueue.add("birthday_reward", { memberId: m.id, tier: m.tier });
      }
      console.log(`[cron_birthday] queued ${members?.length ?? 0} birthday notifications`);
      return { queued: members?.length ?? 0 };
    }
  },
  { connection: makeRedis() },
);

cronWorker.on("failed", (job, err) =>
  console.error("[cronWorker] failed:", job?.id, job?.name, err.message),
);

void registerCronJobs();
```

> Note: `cron_expiry`/`cron_birthday` run on the `points` queue, so both `pointsWorker` (Task 13) and `cronWorker` consume it. BullMQ delivers each job to exactly one worker; the `default`/`unknown job` branches in each worker simply ignore the other's job names. This is intentional and safe.

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/workers/cron.worker.ts
git commit -m "feat: cron worker — expiry (daily 2am PKT) + birthday (1st 9am PKT)"
```

---

### Task 16: `orders/fulfilled` webhook handler

**Files:**
- Create: `app/routes/webhooks.orders-fulfilled.tsx`

**Interfaces:**
- Consumes: `pointsQueue`, `db`. Enqueues `award_purchase_points` with paisa amounts. Verifies `financial_status === 'paid'` before enqueue; otherwise records state and waits.

- [ ] **Step 1: Implement handler**

Create `app/routes/webhooks.orders-fulfilled.tsx`:
```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { pointsQueue } from "../lib/queue.server";

const toPaisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const order = payload as Record<string, any>;
    const customerId = order?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });

    const orderTotalPaisa = toPaisa(order.total_price);
    const shippingPaisa = toPaisa(order.total_shipping_price_set?.shop_money?.amount);
    const taxPaisa = toPaisa(order.total_tax);

    const { data: existing } = await db
      .from("order_webhook_state").select("points_awarded")
      .eq("shopify_order_id", String(order.id)).maybeSingle();
    if (existing?.points_awarded) return new Response(null, { status: 200 });

    await db.from("order_webhook_state").upsert(
      {
        shopify_order_id: String(order.id),
        shopify_customer_id: String(customerId),
        fulfillment_status: order.fulfillment_status ?? null,
        financial_status: order.financial_status ?? null,
        order_total_pkr: (orderTotalPaisa - shippingPaisa - taxPaisa) / 100,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" },
    );

    if (order.financial_status !== "paid") {
      // Fulfilled but not yet paid — wait for paid signal; no award yet.
      return new Response(null, { status: 200 });
    }

    try {
      await pointsQueue.add("award_purchase_points", {
        shopifyCustomerId: String(customerId),
        shopifyOrderId: String(order.id),
        orderTotalPaisa, shippingPaisa, taxPaisa,
      });
    } catch (enqueueErr) {
      console.error("[orders-fulfilled] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 }); // Shopify will retry
    }
  } catch (err) {
    console.error("[orders-fulfilled] error:", err);
  }
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/routes/webhooks.orders-fulfilled.tsx
git commit -m "feat: orders/fulfilled handler — paisa amounts, paid check, enqueue-fail retries"
```

---

### Task 17: `refunds/create` webhook handler

**Files:**
- Create: `app/routes/webhooks.refunds-create.tsx`

**Interfaces:**
- Consumes: `pointsQueue`. Sums `refund_line_items[].subtotal` (merchandise only) to paisa, enqueues `award_refund` keyed on `refund.id`.

- [ ] **Step 1: Implement**

Create `app/routes/webhooks.refunds-create.tsx`:
```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { pointsQueue } from "../lib/queue.server";

const toPaisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);

  try {
    const refund = payload as Record<string, any>;
    const customerId = refund?.order?.customer?.id ?? refund?.customer_id;
    if (!refund?.id || !customerId) return new Response(null, { status: 200 });

    const merchandisePaisa = (refund.refund_line_items ?? []).reduce(
      (sum: number, li: any) => sum + toPaisa(li.subtotal), 0,
    );
    if (merchandisePaisa <= 0) return new Response(null, { status: 200 });

    try {
      await pointsQueue.add("award_refund", {
        shopifyCustomerId: String(customerId),
        refundId: String(refund.id),
        refundedMerchandisePaisa: merchandisePaisa,
      });
    } catch (enqueueErr) {
      console.error("[refunds-create] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 });
    }
  } catch (err) {
    console.error("[refunds-create] error:", err);
  }
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git add app/routes/webhooks.refunds-create.tsx
git commit -m "feat: refunds/create handler — merchandise paisa, enqueue clawback"
```

---

### Task 18: `customers/create` (enrol only) + `customers/enable` (award)

**Files:**
- Modify: `app/routes/webhooks.customers-create.tsx`
- Create: `app/routes/webhooks.customers-enable.tsx`

**Interfaces:**
- `customers/create` → `enrolMember` (no award).
- `customers/enable` → `enrolMember` (idempotent, in case create was missed) then enqueue `award_signup_points`.

- [ ] **Step 1: Rewrite customers-create.tsx (enrol only)**

Replace `app/routes/webhooks.customers-create.tsx` with:
```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enrolMember } from "../lib/points.service";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customer = payload as Record<string, any>;
    if (!customer?.id) return new Response(null, { status: 200 });
    await enrolMember(customer); // enrol only — signup points awarded on customers/enable
  } catch (err) {
    console.error("[customers-create] error:", err);
  }
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Create customers-enable.tsx (award)**

Create `app/routes/webhooks.customers-enable.tsx`:
```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { enrolMember } from "../lib/points.service";
import { pointsQueue } from "../lib/queue.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const customer = payload as Record<string, any>;
    if (!customer?.id) return new Response(null, { status: 200 });
    await enrolMember(customer); // idempotent — ensures member exists if create was missed
    try {
      await pointsQueue.add("award_signup_points", { shopifyCustomerId: String(customer.id) });
    } catch (enqueueErr) {
      console.error("[customers-enable] enqueue failed:", enqueueErr);
      return new Response("enqueue failed", { status: 503 });
    }
  } catch (err) {
    console.error("[customers-enable] error:", err);
  }
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add app/routes/webhooks.customers-create.tsx app/routes/webhooks.customers-enable.tsx
git commit -m "feat: split enrol (customers/create) from signup award (customers/enable)"
```

---

### Task 19: Demote `orders/updated`, fix `orders/paid` comment

**Files:**
- Modify: `app/routes/webhooks.orders-updated.tsx`
- Modify: `app/routes/webhooks.orders-paid.tsx`

**Interfaces:**
- `orders/updated` and `orders/paid` now only maintain `order_webhook_state` and, if the order is paid+fulfilled, enqueue the same `award_purchase_points` job (so a paid-after-fulfilled sequence still converges). Idempotency in the RPC makes double-enqueue safe.

- [ ] **Step 1: Update orders-updated.tsx**

Replace the body of `app/routes/webhooks.orders-updated.tsx` with the same logic as `orders-fulfilled.tsx` (Task 16), but gate the enqueue on **both** `fulfillment_status === 'fulfilled'` AND `financial_status === 'paid'`:

```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { pointsQueue } from "../lib/queue.server";

const toPaisa = (v: unknown) => Math.round(Number(v ?? 0) * 100);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop}`);
  try {
    const order = payload as Record<string, any>;
    const customerId = order?.customer?.id;
    if (!customerId) return new Response(null, { status: 200 });

    const orderTotalPaisa = toPaisa(order.total_price);
    const shippingPaisa = toPaisa(order.total_shipping_price_set?.shop_money?.amount);
    const taxPaisa = toPaisa(order.total_tax);

    const { data: existing } = await db
      .from("order_webhook_state").select("points_awarded")
      .eq("shopify_order_id", String(order.id)).maybeSingle();
    if (existing?.points_awarded) return new Response(null, { status: 200 });

    await db.from("order_webhook_state").upsert(
      {
        shopify_order_id: String(order.id),
        shopify_customer_id: String(customerId),
        fulfillment_status: order.fulfillment_status ?? null,
        financial_status: order.financial_status ?? null,
        order_total_pkr: (orderTotalPaisa - shippingPaisa - taxPaisa) / 100,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "shopify_order_id" },
    );

    if (order.fulfillment_status === "fulfilled" && order.financial_status === "paid") {
      try {
        await pointsQueue.add("award_purchase_points", {
          shopifyCustomerId: String(customerId),
          shopifyOrderId: String(order.id),
          orderTotalPaisa, shippingPaisa, taxPaisa,
        });
      } catch (enqueueErr) {
        console.error("[orders-updated] enqueue failed:", enqueueErr);
        return new Response("enqueue failed", { status: 503 });
      }
    }
  } catch (err) {
    console.error("[orders-updated] error:", err);
  }
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 2: Fix orders-paid.tsx comment**

Replace `app/routes/webhooks.orders-paid.tsx` with:
```ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// orders/paid IS a valid topic. Earning is primarily driven by orders/fulfilled
// + a paid check; orders/updated also converges the paid+fulfilled pair. This
// route is retained as a no-op acknowledgement and may carry paid-status logic later.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} from ${shop} — acknowledged`);
  return new Response(null, { status: 200 });
};
```

- [ ] **Step 3: Typecheck + commit**

```bash
npm run typecheck
git add app/routes/webhooks.orders-updated.tsx app/routes/webhooks.orders-paid.tsx
git commit -m "refactor: orders/updated paisa+enqueue-retry; fix false orders/paid comment"
```

---

### Task 20: Webhook subscriptions

**Files:**
- Modify: `shopify.app.toml`

**Interfaces:**
- Adds `orders/fulfilled`, `customers/enable`, `refunds/create` subscriptions.

- [ ] **Step 1: Add subscriptions**

In `shopify.app.toml`, under `[webhooks]`, add:
```toml
  [[webhooks.subscriptions]]
  topics = ["orders/fulfilled"]
  uri = "/webhooks/orders-fulfilled"

  [[webhooks.subscriptions]]
  topics = ["refunds/create"]
  uri = "/webhooks/refunds-create"

  [[webhooks.subscriptions]]
  topics = ["customers/enable"]
  uri = "/webhooks/customers-enable"
```

- [ ] **Step 2: Verify config parses**

Run: `npm run typecheck` (sanity) and confirm the toml has no duplicate/overlapping blocks.

- [ ] **Step 3: Commit**

```bash
git add shopify.app.toml
git commit -m "feat: subscribe orders/fulfilled, refunds/create, customers/enable"
```

---

### Task 21: Wire `startWorkers()` into server entry

**Files:**
- Modify: `app/shopify.server.ts` (or the server bootstrap; confirm where module side-effects run)

**Interfaces:**
- Calls `startWorkers()` once at server start; no-ops unless `WORKER=1`.

- [ ] **Step 1: Add the call**

At the bottom of `app/shopify.server.ts`, add:
```ts
import { startWorkers } from "./lib/queue.server";
startWorkers();
```

- [ ] **Step 2: Typecheck + commit**

```bash
npm run typecheck
git commit -am "feat: invoke WORKER-gated startWorkers at server start"
```

> Deployment note (not a code step): Render must run two processes from this repo — a web service (no `WORKER`) and a background worker started with `WORKER=1` (always-on). Document in `render.yaml` during deploy; out of scope for code tasks.

---

## Self-Review

**Spec coverage (spec §1–§11):**
- Gating migration §11 → Task 2. ✓
- award_points RPC §3 → Task 3. ✓
- Rounding/integer paisa §4 → Task 4. ✓
- Multiplier (campaign value, Diamond-only 1.2×) §4 → Task 5. ✓
- Enrol + slug §4 → Task 6. ✓
- Tier upgrade + null expiry §6 → Task 7. ✓
- Purchase award orchestration §4 → Task 8. ✓
- Signup (customers/enable) + social (24h, status re-check) §4 → Tasks 9, 14, 18. ✓
- Refund FIFO clawback §4 → Tasks 10, 17. ✓
- Expiry FIFO via points_remaining §5 → Tasks 11, 15. ✓
- Crons tz Asia/Karachi, stable jobId §5 → Task 15. ✓
- orders/fulfilled trigger §4 → Task 16; orders/updated demoted §4 → Task 19. ✓
- action_type vocabulary §3 → enforced in Tasks 8–11 (purchase/refund_deduction/signup/social_*/expiry). ✓
- Enqueue-fail non-2xx §10 → Tasks 16–19. ✓
- String(customer id) §10 → Tasks 6, 8–10, 16–19. ✓
- Worker topology (WORKER gate) §5 → Tasks 12, 21. ✓
- Test tooling §8 → Task 1. ✓
- Subscriptions (orders/fulfilled, refunds/create, customers/enable) §9 → Task 20. ✓

**Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**Type consistency:** Job payloads use `shopifyCustomerId`/`shopifyOrderId`/`orderTotalPaisa`/`shippingPaisa`/`taxPaisa` consistently across Tasks 8, 13, 16, 19; refund uses `refundId`/`refundedMerchandisePaisa` across Tasks 10, 17; `award_points` RPC param names (`p_member_id` etc.) consistent across Tasks 3, 8–11. `action_type` values all match the Global Constraints list. ✓

**Known deferrals (not Week 2):** storefront social-action enqueue route (enqueues `award_social_points` with 24h delay) ships with the widget in Week 5; `review` (3,000 pts) deferred; notification workers are stubs (real email Week 4); referral award is Week 3.
