# Week 2 — Points Engine Design

**Date:** 2026-06-25
**Phase:** Phase 1, Week 2 (per HeyGirl_Rewards_Build_Plan_v2.md §16)
**Builds on:** Week 1 infrastructure (Render, Supabase 10 tables, Redis, Shopify webhooks registered)

---

## 1. Goal

Implement the points **earning and removal** engine: the logic that adds or subtracts points when a customer purchases, follows on social, signs up, has a birthday, or when points expire. Week 1 left clean stubs (webhook writes order state to Supabase and enqueues to `pointsQueue`; workers have no business logic). Week 2 fills in that logic.

In scope this week:
- **Gating schema migration first** (§11) — idempotency index, `points_remaining`, FIFO index, balance CHECK, one-active-campaign constraint
- Atomic points-award path (RPC) — the single writer of `members.points_balance`
- Purchase points via **`orders/fulfilled`** trigger (multipliers + integer rounding + refund claw-back via new `refunds/create` webhook)
- Member enrolment on `customers/create`; **1,000 signup points on `customers/enable`**
- Social action award with **24-hour** delay
- Birthday cron (1st of month, 9:00 AM PKT) — logs + enqueues notification stub
- Points expiry cron (daily, 2:00 AM PKT) — FIFO, 30-day warning stub
- Shared `points.service.ts` holding all policy

Out of scope (later weeks):
- Actual email/WhatsApp sending — notification jobs are **stubs this week**, real sending in Week 4
- Discount code generation / redemption — Week 3
- Referral award logic — Week 3 (referral idempotency pattern is designed here for consistency, but referral business logic ships Week 3)
- Admin UI — Week 6

---

## 2. Architecture decision

**Chosen: Approach B — service layer + thin workers + atomic RPC.**

Rejected:
- **Approach C (event-sourced, derive balance by SUM):** killed by the storefront read-speed mandate (build plan §15: zero Lighthouse regression, mobile 62 / desktop 97). The launcher widget reads member balance on a hot path. With 23,876 migrated members + 5 years of imported order history, `points_ledger` is the largest table; a `SUM()` per widget load on Supabase free tier is exactly the latency forbidden. The schema already commits to stored balance (`members.points_balance`, `points_ledger.balance_after`). C also doesn't save work — FIFO expiry and lifetime-spend-derived tier both force materialized state anyway.
- **Approach A (flat workers, direct DB writes):** duplicates the most correctness-sensitive code (award, multiplier, tier-upgrade) across 5+ workers/crons, each doing a non-atomic read-modify-write of the balance. Under at-least-once webhook delivery, every copy is an independent double-award bug.

**Division of responsibility:** the RPC enforces *atomicity*; `points.service.ts` decides *intent* (which multiplier applies, eligibility, FIFO tranche selection). The RPC stays thin and deterministic so policy remains unit-testable in TypeScript.

### Module layout

```
app/lib/points.service.ts     all policy: awardPoints, deductPoints,
                              getActiveMultiplier, checkAndUpgradeTier,
                              enrolMember, selectExpiringTranches (FIFO)
app/workers/points.worker.ts   thin: purchase + refund award jobs
app/workers/social.worker.ts   thin: 24h-delayed social action award
app/workers/cron.worker.ts     thin: birthday + expiry repeatable jobs
app/lib/queue.server.ts        queues + worker registration (existing, refactored)
supabase migration             award_points RPC, idempotency unique index
```

The merchant never sees this structure; it only affects maintainability. Small focused worker files keep diffs clean and production debugging tractable as logic grows through Weeks 3–4.

---

## 3. The atomic award RPC (correctness core)

A single Postgres function `award_points(...)` is the **only writer of `members.points_balance`**. No worker or service code mutates the balance directly. Within one transaction:

1. `pg_advisory_xact_lock(hashtextextended(<action_type> || ':' || <reference_id>, 0))` — serializes concurrent jobs for the same action+reference. **`hashtextextended` returns bigint (64-bit), and the key is scoped by `action_type`** so the lock unit matches the idempotency unit (plain `hashtext` returns int4 and would key on reference alone, risking cross-action-space collisions). This is the Week 3 race-condition fix pulled forward into Week 2 (approved). It retires the known dual-webhook race permanently. The lock is transaction-scoped (`_xact_`), so it auto-releases on commit/rollback.
2. Insert the `points_ledger` row **first**. A **unique index on `(member_id, action_type, reference_id)` created `NULLS NOT DISTINCT`** (Postgres 15+; project is on PG17) makes a duplicate raise a unique-violation, caught and treated as "already awarded." `reference_id` stays **nullable at the column level**, but **every award path supplies a non-null key** (see table below) — including a synthetic key (the ledger row's own UUID, generated client-side before insert) for reference-less actions like `adjustment` and `redemption`. This is deliberate: declaring `reference_id NOT NULL` globally would break legitimate manual adjustments, and relying on `NULLS NOT DISTINCT` to dedupe `adjustment` rows is actively wrong (two distinct manual awards to the same member would collapse into a false duplicate). Synthetic-UUID keys make every award row independently unique while real references (order/refund/social ids) still dedupe correctly.
3. Compute `balance_after` inside the transaction; `UPDATE members SET points_balance = points_balance + <delta>`.
4. Where applicable, flip `order_webhook_state.points_awarded = true`.

### Why idempotency lives in the unique index, not the boolean flag

If the process crashes between the ledger insert and the balance update, the unique constraint still prevents a re-award on retry — idempotency is a property of the **data**, not of control flow. The existing `order_webhook_state.points_awarded` boolean becomes a cheap fast-path in the webhook handler, no longer the correctness boundary.

### Idempotency keys per action type

**`action_type` values MUST match the live `points_ledger_action_type_check` CHECK constraint exactly.** The DB vocabulary is the source of truth (it is a working guardrail; we do not loosen it to match prose). The allowed values are: `signup, purchase, social_youtube, social_facebook, social_instagram, review, referral_earned, referral_bonus, redemption, expiry, adjustment, birthday, campaign_bonus, refund_deduction`. The advisory-lock key string in §3 step 1 uses the **same** `action_type` string.

| Action | `action_type` (canonical, matches CHECK) | `reference_id` |
|---|---|---|
| Purchase | `purchase` | `shopify_order_id` |
| Refund/return | `refund_deduction` | `refund.id` (Shopify refund id — **not** order id; an order can have multiple partial refunds) |
| Signup | `signup` | `shopify_customer_id` |
| Social (YouTube) | `social_youtube` | `social_actions.id` |
| Social (Facebook) | `social_facebook` | `social_actions.id` |
| Social (Instagram) | `social_instagram` | `social_actions.id` |
| Referral earn (Week 3) | `referral_earned` | `referrals.id` |
| Expiry | `expiry` | the expiring tranche's `points_ledger.id` (deterministic, never null) |
| Manual adjustment | `adjustment` | synthetic — the new ledger row's own UUID (never collides) |
| Redemption (Week 3) | `redemption` | `loyalty_codes.id` |

> Note: `social_actions.action_type` stores the short form (`youtube`/`facebook`/`instagram`); the ledger writes the `social_<platform>` long form. The service maps short→long when awarding so the ledger `action_type` always matches the CHECK.

---

## 4. Earning rules

### Purchases
- **Trigger:** the **`orders/fulfilled`** webhook is the primary earn signal — it is a clean "fully fulfilled" event, avoiding the flapping/`partial`/`null` ambiguity of polling top-level `fulfillment_status` on `orders/updated`. The award job then verifies the order is also `financial_status == paid` (read from the order) before awarding. We keep an `order_webhook_state` row so a paid-before-fulfilled or fulfilled-before-paid ordering still converges (whichever webhook completes the pair triggers the award). `orders/updated` is no longer the gate; `orders/fulfilled` + the paid check replace it. (`orders/paid` is a **valid** topic — the earlier code comment claiming otherwise is wrong — and may be added if a paid-state signal is needed, but `orders/fulfilled` + state row is sufficient.)
- **Partial fulfillment:** a `"partial"` fulfillment does **not** award — points are awarded only when the order is fully fulfilled. Intended: a split shipment earns nothing until the final parcel ships.
- **Base award:** 1 point per Rs.1 of `(order total − shipping − tax)`. **Compute on integer paisa, never `parseFloat` PKR** — IEEE-754 subtraction of float rupees can yield `1499.4999998`. Read the order's `numeric` money fields and work in integer paisa, divide at the end.
- **Multiplier + rounding:** apply `getActiveMultiplier(member)`, then **round to an integer with a single, centralized rule** (`points_balance`, `points`, `balance_after` are all `integer` columns): **awards floor, claw-backs ceil** — so we never over-credit and never under-deduct. This rule lives in `points.service.ts` only; the DB never implicitly coerces a fractional value. Award via the RPC.

### Multipliers — single value, no stacking
`getActiveMultiplier(member)` returns exactly one number, evaluated in priority order:
1. If a bonus campaign is currently active (`bonus_campaigns.is_active` and `now()` within `starts_at`/`ends_at`) → use the campaign's **own `multiplier` value** (`numeric(3,1)`, e.g. 2.0 or 2.5) — **not** a hardcoded 2×. One-active-at-a-time is enforced by the exclusion constraint (§11), so the lookup is deterministic.
2. Else if member tier is **Diamond** AND current month is the member's birthday month → **1.2×**
3. Else → **1×**

Rules:
- Birthday 1.2× multiplier applies to **Diamond tier ONLY** (changed from the original Gold/Diamond — see §7). Gold members receive their Rs.500 birthday discount reward but **no points multiplier**.
- Both multipliers apply to **purchase points only** — never to social, referral, or signup points.
- Only one bonus campaign active at a time (enforced elsewhere; the service assumes at most one).

### Refunds / returns / cancellations
- **Trigger (NEW — was missing):** the `refunds/create` webhook. `orders/updated` is **not** sufficient — the refunded *amount* and line items live only in the `refunds/create` payload (`refund_line_items`, `order_adjustments`), and a partial refund may not change top-level `financial_status` at all. Requires:
  - A new `refunds/create` subscription in `shopify.app.toml` (currently only `orders/updated`, `customers/create`, `app/uninstalled` are subscribed).
  - A new handler `app/routes/webhooks.refunds-create.tsx` that enqueues a refund job keyed on `refund.id`.
- **Amount:** points clawed back are proportional to the refunded merchandise amount (sum of `refund_line_items` subtotal, excl. shipping/tax — matching the original earn basis). Partial refunds claw back proportionally; full refunds claw back the order's full earned points.
- Removes points via the **same atomic RPC** with a negative delta and `action_type = refund_deduction`, `reference_id = refund.id` (so multiple partial refunds on one order each dedupe independently).
- **FIFO tranche consumption requires a new `points_remaining` column** on `points_ledger` (the current schema has only `points` + a boolean `expired`, which cannot represent a *partially* consumed tranche). Each purchase tranche carries `points_remaining` (initialized to `points`). Refunds decrement `points_remaining` oldest-first; expiry only expires `points_remaining > 0`. Without this column the "same FIFO tranche, no double-deduction" guarantee is **not implementable** — a partial refund of a tranche would later be re-expired in full. This column is part of the gating migration (§11).

### Signup — enrol on create, award on activate
The original "gate on `customer.state === 'enabled'` inside `customers/create`" was **wrong**: at `customers/create` time a new customer is almost always `state: "disabled"` and only flips to `enabled` *after* clicking the account-activation email — at which point Shopify fires **`customers/enable`**, not `customers/create`. Gating the award on `enabled` inside `customers/create` would award **nobody**. Corrected two-step design:

- **On `customers/create`:** call `enrolMember()` to create the `members` row (Silver, generate `referral_slug`) **but do NOT award signup points yet**. This captures both real signups and guest-checkout records so later merges work. Skip-and-log if `customer.email` is absent (`members.email` is `NOT NULL`; attempting a null insert would throw and silently drop the member).
- **On `customers/enable`** (new subscription): the customer has genuinely activated a storefront account → award **1,000** signup points via the RPC (`action_type = signup`, `reference_id = shopify_customer_id`). This is the correct "real account created" signal and naturally excludes guest-checkout records that never activate.
- `referral_slug`: first name + **random 4-digit suffix** (e.g. `sara-4821`), retry on unique collision — **not** the full Shopify customer id (which leaks the internal id into a public URL and is unshareable).

### Social actions
- Customer triggers a social action → row inserted into `social_actions` with `status = pending`, `pending_until = now() + 24h`.
- A delayed BullMQ job fires after **24 hours** (changed from 12h — see §7) and awards **1,000** points via the RPC.
- Before awarding, the job **re-checks `social_actions.status` inside the transaction** — a merchant may have voided it in the interim (build plan §4). If voided, no-op.
- One-time per action per account: the live schema already enforces `UNIQUE (member_id, action_type)` on `social_actions` (at most one row of each action type per member, ever). The ledger idempotency key `reference_id = social_actions.id` is consistent with this — the row is never re-created, so the two uniqueness axes never conflict.

---

## 5. Scheduled jobs (crons)

Implemented as **BullMQ repeatable jobs** (approved) — registered on app startup, no extra Render service, reusing existing Redis.

**Reliability requirements (NEW):**
- **Timezone:** BullMQ repeatable jobs default to **UTC**. Both crons MUST pass `{ pattern: '...', tz: 'Asia/Karachi' }` explicitly, or they fire 5 hours off. Pakistan is UTC+5 with no DST, so no DST drift once set.
- **No duplicate schedulers:** repeatable jobs are registered with a stable `jobId` / repeat key so app restarts re-registering don't create duplicate scheduler entries. Render is configured to run a **single always-on instance** for the worker process; if it ever scales >1, the scheduler must move behind a leader lock.
- **Always-on worker:** the crons must run in an always-on process, not a free-tier web dyno that sleeps when idle (a sleeping instance would miss the 2 AM run). The build plan specifies Render Starter (always-on); confirm the worker is co-located there or in a dedicated worker service.

### Birthday job — 1st of each month, 9:00 AM PKT
- Finds members whose `birthday_month` equals the current month.
- The Diamond 1.2× multiplier is applied **live** by `getActiveMultiplier()` during the month — the cron does not touch it.
- The cron triggers the birthday **reward** (discount code) and notification. **Week 2:** logs the intended reward and enqueues a notification job. No email sent (Week 4). Notification worker is a stub.

### Expiry job — daily, 2:00 AM PKT
- **Silver members only**, and only **purchase-earned** points older than 365 days, oldest-first (FIFO).
- In one atomic transaction per member: for the selected tranches set `points_remaining = 0` and `expired = true`, subtract their **remaining** sum from `points_balance` (never the original `points` — a tranche partly clawed back by a refund expires only what's left), write a compensating `action_type = expiry` ledger row.
- `points_balance` can never go negative — a `CHECK (points_balance >= 0)` constraint backs this and claw-backs/expiry clamp at zero (logging any shortfall).
- **`expires_at` is stamped only on purchase ledger rows for Silver members at award time** — signup/social/referral points and all Gold/Diamond points have `expires_at = null` and never expire.
- **Tier-upgrade interaction:** when `checkAndUpgradeTier()` promotes a member to Gold/Diamond, it **nulls out pending `expires_at`** on their existing points — points that the rules now say never expire must stop aging.
- **Catch-up:** queries by `expires_at < now()`, not "since last run" — a missed day is automatically picked up next run. (The **birthday cron has no catch-up** — if its run is missed, that month's birthday rewards are skipped. Mitigated by the always-on worker requirement above.)
- **Upgrade race:** tier upgrade nulls pending `expires_at` (§6) while this cron reads `expires_at < now()`. Both paths take the **same per-member advisory lock**, so a tranche cannot be expired in the instant between an upgrade reading and nulling its `expires_at`.
- **30-day warning:** enqueues a notification job for Silver members with points expiring within 30 days. Stub this week; real email Week 4.

---

## 6. Tier assignment (supporting logic)

- Tier is derived from `lifetime_spend_pkr` (cumulative PKR spend excl. shipping/tax/discounts): Silver default, Gold at Rs.50,000, Diamond at Rs.100,000. Lifetime — never downgraded.
- `checkAndUpgradeTier(member)` runs after each purchase award; on promotion it (a) updates `tier`, (b) nulls pending `expires_at`, (c) enqueues a tier-upgrade notification stub.

> Note: full tier *re-assignment from historical spend* (GraphQL bulk over 5 years) is a Week 7 migration task. Week 2 implements the forward-going upgrade check on new purchases only.

---

## 7. Changes from build plan v2.0 (deliberate, not oversights)

These design decisions diverge from HeyGirl_Rewards_Build_Plan_v2.md and are intentional, confirmed with the merchant:

1. **Social action delay: 24 hours** (build plan §4/§8/§14 say 12h). 24h is the new source of truth. Build plan text not yet updated in those spots — flagged here.
2. **Birthday 1.2× multiplier: Diamond tier ONLY** (build plan originally Gold + Diamond). Build plan §3 (×2) and §4 already updated to reflect this. **T&C requirement:** the (not-yet-drafted) Terms & Conditions must state "the 1.2× birthday-month points multiplier applies to Diamond members only." Recorded here because no T&C document exists yet (build plan §19 open item).
3. **Week 3 race-condition fix pulled into Week 2:** the `pg_advisory_xact_lock` in the award RPC. Build plan §16 deferred it to Week 3; building the earning engine on a known-racy gate was rejected. (The committed `orders-updated.tsx` comment still says "added in Week 3" — fix during implementation.)
4. **Earn trigger is `orders/fulfilled`, not the `orders/updated` / `orders/paid` dual gate** (build plan §4). `orders/paid` is a valid topic, but `orders/fulfilled` + a paid check is the cleaner signal and avoids `orders/updated` status-flapping. Build plan §4 still describes the old dual-webhook state machine — superseded here.
5. **Signup points award on `customers/enable`, not `customers/create`** (build plan §4/§7 imply instant-on-create). The customer is `disabled` at create time; `enabled` is the real activation signal.
6. **All points are integers with a fixed rounding rule** (floor awards / ceil claw-backs, computed on integer paisa). The build plan's "1 pt per Rs.1" with 1.2×/2× multipliers produces fractions the build plan never addressed.

---

## 8. Testing approach

- **Test tooling must be added this week** (no runner currently in `package.json`) — Vitest. Idempotency-under-retry is the single most important correctness property and currently has no harness; it ships in Week 2, not Week 8.
- Unit tests for `points.service.ts` policy functions (multiplier selection incl. campaign `multiplier` value, integer rounding floor/ceil, FIFO tranche selection with `points_remaining`, tier thresholds) — pure TypeScript, no DB.
- Integration tests for the `award_points` RPC: concurrent double-award attempt (must award once), crash-between-insert-and-update retry (must not double-award), partial-refund claw-back decrementing correct FIFO tranches, expiry consuming only `points_remaining`, balance never negative.
- Webhook handler tests: duplicate `orders/fulfilled` delivery is idempotent; `customers/create` enrols without awarding; `customers/enable` awards once.

---

## 9. Files touched

- `app/lib/points.service.ts` (new)
- `app/workers/points.worker.ts` (new)
- `app/workers/social.worker.ts` (new)
- `app/workers/cron.worker.ts` (new)
- `app/lib/queue.server.ts` (refactor — register workers, repeatable jobs)
- `app/routes/webhooks.orders-fulfilled.tsx` (**new** — primary earn trigger; route award through RPC; return non-2xx if the *enqueue* fails so Shopify retries — see §10)
- `app/routes/webhooks.orders-updated.tsx` (demoted — no longer the earn gate; kept only to maintain `order_webhook_state`/paid status if needed, or removed)
- `app/routes/webhooks.customers-create.tsx` (wire `enrolMember`, enrol only — no award; missing-email skip; random-4-digit slug)
- `app/routes/webhooks.customers-enable.tsx` (**new** — awards 1,000 signup points)
- `app/routes/webhooks.refunds-create.tsx` (**new** — refund claw-back trigger)
- `app/routes/webhooks.orders-paid.tsx` (fix the false "invalid topic" comment; remove or repurpose deliberately)
- `shopify.app.toml` (**new subscriptions** — `orders/fulfilled`, `customers/enable`, `refunds/create`)
- `app/database.types.ts` (regenerate via Supabase MCP after migration)

See §11 for the gating schema migration that must land before any of the above worker/RPC code.

## 11. Gating schema migration (must land FIRST)

The Approach-B correctness argument rests on schema objects that **do not yet exist**. None of the worker/RPC code is correct against the current schema until this single migration ships and `database.types.ts` is regenerated:

1. **Idempotency unique index** — `CREATE UNIQUE INDEX ... ON points_ledger (member_id, action_type, reference_id) NULLS NOT DISTINCT`. (Currently absent — only pkey + member_id/earned_at/expires_at indexes exist.)
2. **`points_remaining INTEGER`** on `points_ledger` (initialized to `points` for purchase tranches) — enables partial-refund FIFO without double-deduction.
3. **FIFO composite index** — `CREATE INDEX ... ON points_ledger (member_id, earned_at) WHERE action_type = 'purchase' AND expired = false` — serves the hot per-member FIFO scan (largest table after migration).
4. **`CHECK (points_balance >= 0)`** on `members`.
5. **`bonus_campaigns` one-active enforcement** — exclusion constraint preventing overlapping active campaigns, plus an index on `(is_active, starts_at, ends_at)` for the per-purchase multiplier lookup (hot path). Removes the nondeterminism of two active campaigns.

The `award_points` RPC, the refund path, and the expiry cron are all defined against this post-migration schema. The `action_type` CHECK constraint is **left as-is** (it is the canonical vocabulary — see §3).

## 10. Robustness notes (from infra review)

- **Enqueue failures are not swallowed.** Webhook handlers still return 200 for *business-logic* errors (to avoid Shopify retry storms on bad data), but if the BullMQ `add()` itself throws (e.g. Redis down), the handler returns a non-2xx so Shopify redelivers — otherwise the points job is lost silently after a 200.
- **Customer-id type consistency.** `shopify_customer_id` is `text` in the schema; all enqueue/award/lookup paths must `String(...)` the Shopify numeric customer id consistently (the current order handler enqueues a raw number) to avoid join misses.
- **RLS is service-key-only.** All 9 tables have RLS enabled with **zero policies**. The server uses the Supabase service key (which bypasses RLS), so this is fine — but it is recorded explicitly: **no anon/publishable key may read these tables** (it would silently return empty rows, no error). Any storefront balance read must go through the app server, never a direct anon-key query. Adding explicit policies is deferred until a client-direct read path is actually introduced.
