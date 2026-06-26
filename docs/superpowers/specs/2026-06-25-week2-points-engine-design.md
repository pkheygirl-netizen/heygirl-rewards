# Week 2 — Points Engine Design

**Date:** 2026-06-25
**Phase:** Phase 1, Week 2 (per HeyGirl_Rewards_Build_Plan_v2.md §16)
**Builds on:** Week 1 infrastructure (Render, Supabase 10 tables, Redis, Shopify webhooks registered)

---

## 1. Goal

Implement the points **earning and removal** engine: the logic that adds or subtracts points when a customer purchases, follows on social, signs up, has a birthday, or when points expire. Week 1 left clean stubs (webhook writes order state to Supabase and enqueues to `pointsQueue`; workers have no business logic). Week 2 fills in that logic.

In scope this week:
- Atomic points-award path (RPC) — the single writer of `members.points_balance`
- Purchase points (with multipliers + refund claw-back via new `refunds/create` webhook)
- Signup enrolment + 1,000 signup points (`customers/create` webhook, currently a stub)
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
2. Insert the `points_ledger` row **first**. A **unique index on `(member_id, action_type, reference_id)` created `NULLS NOT DISTINCT`** (Postgres 15+; project is on PG17) makes a duplicate raise a unique-violation, caught and treated as "already awarded." `NULLS NOT DISTINCT` is required because `points_ledger.reference_id` is nullable and a plain unique index treats NULLs as distinct — bypassing idempotency. The migration also makes `reference_id NOT NULL` for award paths by always supplying a key (see table below).
3. Compute `balance_after` inside the transaction; `UPDATE members SET points_balance = points_balance + <delta>`.
4. Where applicable, flip `order_webhook_state.points_awarded = true`.

### Why idempotency lives in the unique index, not the boolean flag

If the process crashes between the ledger insert and the balance update, the unique constraint still prevents a re-award on retry — idempotency is a property of the **data**, not of control flow. The existing `order_webhook_state.points_awarded` boolean becomes a cheap fast-path in the webhook handler, no longer the correctness boundary.

### Idempotency keys per action type

| Action | `action_type` | `reference_id` |
|---|---|---|
| Purchase | `purchase` | `shopify_order_id` |
| Refund/return | `refund` | `refund.id` (Shopify refund id — **not** order id; an order can have multiple partial refunds) |
| Signup | `signup` | `shopify_customer_id` |
| Social | `social` | `social_actions.id` |
| Referral (Week 3) | `referral` | `referrals.id` |
| Expiry | `expiry` | per-tranche `points_ledger.id` of the expiring row (deterministic, never null) |

---

## 4. Earning rules

### Purchases
- **Trigger:** order is **both paid AND fulfilled** (`financial_status == paid` AND `fulfillment_status == fulfilled`), via the existing `orders/updated` gate.
- **Partial fulfillment:** `fulfillment_status` of `"partial"` (or `null`) does **not** award — points are awarded only when the order reaches fully `"fulfilled"`. This is intended: a split shipment earns nothing until the final parcel ships. Documented so it is a deliberate choice, not a gap.
- **Base award:** 1 point per Rs.1 of `(order total − shipping − tax)` (subtraction already implemented in `webhooks.orders-updated.tsx`). `total_tax` / `total_shipping_price_set` may be absent on some orders; the existing `?? "0"` guards handle this.
- **Multiplier:** apply `getActiveMultiplier(member)` (see below), then award via the RPC.

### Multipliers — single value, no stacking
`getActiveMultiplier(member)` returns exactly one number, evaluated in priority order:
1. If a bonus campaign is currently active (`bonus_campaigns.is_active` and `now()` within `starts_at`/`ends_at`) → **2×**
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
- Removes points via the **same atomic RPC** with a negative delta and `action_type = refund`, `reference_id = refund.id` (so multiple partial refunds on one order each dedupe independently).
- Consumes the **same oldest-first (FIFO) tranches** that expiry would later touch, so points are never double-deducted (once by refund, once by expiry).

### Signup
- `customers/create` webhook (currently a stub) wired to `enrolMember()`.
- **Over-trigger guard (NEW):** `customers/create` fires for **any** customer record creation — including **guest checkout** (Shopify creates a customer record for a guest who supplies an email) and merchant/admin/import-created customers — not only genuine storefront sign-ups. Awarding 1,000 points unconditionally would leak points/cost. **Enrolment + signup points are gated on `customer.state === 'enabled'`** (the closest signal that the customer has an actual storefront account). Guest-checkout customers (`state` of `disabled`/`invited`/`declined`) are **not** auto-enrolled here — they follow the guest opt-in flow (build plan §7, later week).
- **Missing email (NEW):** `members.email` is `NOT NULL` in the schema, but a customer can be created without an email (admin/import paths). `enrolMember()` **skips enrolment and logs** when `customer.email` is absent, rather than attempting an insert that would throw a NOT NULL violation and silently drop. (Alternatively the migration may relax `members.email` to nullable — decision recorded for implementation; default is skip-and-log.)
- On valid enrolment: creates the `members` row as Silver, generates `referral_slug` (first name + random 4-digit suffix, unique on collision), awards **1,000** signup points via the RPC (`action_type = signup`, `reference_id = shopify_customer_id`).

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
- In one atomic transaction per member: mark the selected `points_ledger` tranches `expired = true`, subtract their sum from `points_balance`, write a compensating `action_type = expiry` ledger row.
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
3. **Week 3 race-condition fix pulled into Week 2:** the `pg_advisory_xact_lock` in the award RPC. Build plan §16 deferred it to Week 3; building the earning engine on a known-racy gate was rejected.

---

## 8. Testing approach

- Unit tests for `points.service.ts` policy functions (multiplier selection, FIFO tranche selection, tier thresholds) — pure TypeScript, no DB.
- Integration tests for the `award_points` RPC: concurrent double-award attempt (must award once), crash-between-insert-and-update retry (must not double-award), refund claw-back consuming correct FIFO tranches, expiry consistency between ledger and stored balance.
- Webhook handler tests: duplicate `orders/updated` delivery is idempotent.

---

## 9. Files touched

- `app/lib/points.service.ts` (new)
- `app/workers/points.worker.ts` (new)
- `app/workers/social.worker.ts` (new)
- `app/workers/cron.worker.ts` (new)
- `app/lib/queue.server.ts` (refactor — register workers, repeatable jobs)
- `app/routes/webhooks.orders-updated.tsx` (route award through RPC; keep boolean as fast-path; return non-2xx if the *enqueue* fails so Shopify retries delivery — see §10)
- `app/routes/webhooks.customers-create.tsx` (wire `enrolMember` with `state === 'enabled'` guard + missing-email skip)
- `app/routes/webhooks.refunds-create.tsx` (**new** — refund claw-back trigger)
- `shopify.app.toml` (**new subscription** — `refunds/create`)
- Supabase migration: `award_points` RPC, unique index `(member_id, action_type, reference_id) NULLS NOT DISTINCT` on `points_ledger`, `reference_id NOT NULL` for award paths
- `app/database.types.ts` (regenerate via Supabase MCP after migration)

## 10. Robustness notes (from infra review)

- **Enqueue failures are not swallowed.** Webhook handlers still return 200 for *business-logic* errors (to avoid Shopify retry storms on bad data), but if the BullMQ `add()` itself throws (e.g. Redis down), the handler returns a non-2xx so Shopify redelivers — otherwise the points job is lost silently after a 200.
- **Customer-id type consistency.** `shopify_customer_id` is `text` in the schema; all enqueue/award/lookup paths must `String(...)` the Shopify numeric customer id consistently (the current order handler enqueues a raw number) to avoid join misses.
