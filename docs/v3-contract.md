# HeyGirl Rewards v3 — build contract

This file is the single source of truth for names shared between workstreams. Do not rename anything defined here. If something here is impossible, implement the closest working thing and say so in your report.

Store facts: Shopify **Basic** plan, new customer accounts, Dawn theme (Online Store 2.0), cart type **drawer**, currency PKR, timezone Asia/Karachi. App is a single-merchant custom app (Remix, Supabase via service key, BullMQ on Redis, Railway web + worker with `WORKER=1`). The storefront reaches the app only through the app proxy `/apps/loyalty/*` → `/proxy/*`.

## 0. Rules for every workstream

- Stay inside your file ownership (section 6). Never edit another stream's files; if you need a change there, list it in your report.
- Do not run `git commit`, `git checkout`, `git stash` or `git reset`. Do not touch `.env*` or `shopify.app.toml`.
- Never call a tool that changes the live Shopify store (no `graphql_mutation`, product/discount/theme create/update tools). Read-only schema and docs tools are allowed and expected: before writing any Admin GraphQL operation, confirm its exact shape with `mcp__Shopify__graphql_schema` and validate the final operation text with `mcp__Shopify__validate_graphql_codeblocks` when available. Use `mcp__Shopify__search_docs_chunks` for docs. If a tool is unavailable, say which operations are unverified.
- TypeScript strict; no `any` unless unavoidable and commented. Keep existing code style. Every new module gets vitest unit tests next to it (`*.test.ts`), mocking Supabase/Shopify the way existing tests do.
- Other streams are editing the same working tree at the same time. Run `npx tsc --noEmit` and `npx vitest run <your files>` near the end; fix only errors in your own files and report errors that originate elsewhere.
- Money is integer rupees in UI, `numeric` in DB. Points are integers. All "today"/period boundaries and displayed times use Asia/Karachi.
- No secrets in code, logs or client responses.

## 1. Business rules (decided by the store owner)

1. Purchase points: `floor(basis × purchase_points_rate × multiplier)`. Basis = money actually paid for merchandise: order total − shipping − tax − amount paid by gift card. Discount codes (reward codes included) already reduce the total. Awarded only when the order is **fulfilled AND paid AND not cancelled**. COD orders are marked paid by hand 7–10 days after delivery; until then the points are "pending".
2. Multiplier is the one in force when the order was **placed** (campaign active at `placed_at`, including campaigns since ended or deactivated after the fact; Diamond birthday-month 1.2× if no campaign).
3. Auto-consent: placing an order or signing in on the storefront enrols the customer (`consent_given=true`, `consent_source` 'order' | 'signin'). Admin opt-out (`opted_out=true`) stops earning, redemption and re-enrolment. `is_blocked` (fraud) stops earning, redeeming, birthday and referral rewards, and is separate from opt-out.
4. Welcome bonus (`signup_points`, default 1000): once per customer, at first **sign-in** on the storefront only (never at order time). Must also be given to members whose row was created earlier by a webhook or by import with zero points.
5. Customers with no email (phone only) are enrolled; `members.email` is nullable, `members.phone` stored.
6. Balance never goes below zero. Refund after award reverses `awarded × refunded_basis / earning_basis`, capped at what that order still has un-reversed. Cancellation reverses the remainder. Never more than awarded per order, enforced in the database under a row lock. A cancelled order can never be awarded later.
7. Reward code used on an order that is cancelled **before fulfilment**: return the redeemed points (`redemption_return`), code stays used. No return after fulfilment.
8. Expiry: every positive ledger row of a **Silver** member expires 365 days (`silver_expiry_days`) after `earned_at`; Gold/Diamond do not expire (upgrade clears pending expiry as today). All deductions consume oldest unexpired points first (`points_remaining`, FIFO). Imported Smile balances expire one year from import.
9. Tiers by lifetime spend, thresholds from `app_settings` (`tier_gold_threshold_pkr`, `tier_diamond_threshold_pkr`). Tiers are never taken away. On upgrade issue once: Gold → free-shipping code; Diamond → Rs. `tier_reward_diamond_pkr` (500) code.
10. Referral: friend arrives with `?ref=slug`. When the friend first signs in with a stored ref, record the referral and immediately issue the friend a **free-shipping code** (if `referral_friend_free_shipping`). Friend must have **zero prior orders** and must not already be referred. Referrer earns when the friend's **first** order is fulfilled and paid. Referrer and friend on the same network address (friend IP equals referrer's `last_seen_ip`) → status `flagged`, held for admin approve/reject; approve returns it to `pending` and it pays only when the order condition is met (pay immediately if already met). Same email → `blocked` and `referrals_blocked=true` on the referrer. If the qualifying order is later refunded in full or cancelled after award, reverse the referrer's points (`referral_reversal`, floor zero).
11. Referral reward: standard `referral_points` (6000). Influencer (`is_influencer`, not `influencer_paused`, and now within `influencer_rate_starts_at..ends_at` when set): `round(referral_points × influencer_multiplier)`; if multiplier null, legacy `influencer_referral_rate`; else standard.
12. Influencer discount codes: an influencer may have one public Shopify discount code (`influencer_code`, `influencer_code_percent` % off, not customer-locked, combinable with nothing). Any order whose `discount_codes` contains it is attributed (`order_webhook_state.influencer_member_id`). When that order is fulfilled and paid the influencer earns the same referral reward as rule 11 once per **new customer's first order** (action `influencer_sale`, reference = order id); repeat customers are counted in stats but earn nothing. An order cannot pay both a link referral and a code attribution: link referral wins.
13. Birthday: customer sets day+month once from the storefront (`birthday_set_at`); afterwards only admin can change it. Cron on the 1st (Asia/Karachi) issues a code (`birthday_reward_*_pkr` by tier) to non-blocked, non-opted-out members with that month. A birthday first set during its own month gets nothing until next year. Diamond-only 1.2× purchase multiplier in the birthday month.
14. Reviews: customer taps "I posted a review" (told to tag @heygirl.pk). Allowed only if the member has more awarded orders than existing non-rejected claims (one claim per delivered+paid order). Claim is `pending`, released automatically after `review_release_hours` (72) as `review` points (`review_points`). Admin can reject while pending. The storefront never says it is unverified.
15. Social follows (YouTube, Facebook, Instagram): unchanged honour system, once each; buttons must open the profile URL (from settings) in a new tab before confirming.
16. Redemption: tiers from `app_settings.redemption_tiers`; code single-use, customer-locked, 30-day expiry, does not combine with other discount codes. Admin can cancel an **active** code: deactivate in Shopify first, then return the points.
17. Earn rules can be switched off individually (`earn_rules`), which hides them on the storefront and stops new awards for that rule.
18. `shop/redact` never deletes anything automatically: it logs a `gdpr_requests` row and a heartbeat/alert.
19. Emails via existing SMTP path with one branded HTML layout; WhatsApp through a provider interface that is a no-op unless `whatsapp_enabled` and credentials (env `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`) exist. Events: welcome, points earned, reward code issued, tier upgrade, birthday, referral completed, points expiring (30 days), review released.
20. Program switch (`app_settings.program_enabled`, owner decision 17 Nov 2026 evening, replacing the earlier one; labelled "Redeeming" in the admin): while it is **off**, only redeeming is paused. `/proxy/redeem` and `redeemPoints` refuse with `program_disabled`; the storefront panel shows a "redeeming is paused" notice instead of the Redeem buttons, and the cart line leaves out the "points to spend" nudge (config `redeemPaused: true`). Everything else works exactly as when it is on: all earning (each earn rule's own switch, rule 17, still applies), enrolment, welcome bonus, referrals, influencer codes, reviews, social, birthday, tier codes, campaigns, expiry, emails, and the launcher, panel, product/cart points lines and rewards page. Reward codes already issued are not deactivated and keep working at checkout until they expire. Nothing about the switch is recorded per order. Only a missing storefront config hides the storefront.

## 2. Database — migration `supabase/migrations/010_v3_core.sql` (stream A)

Idempotent (`IF NOT EXISTS`, guarded constraint changes). Exact names:

**members**: `email` DROP NOT NULL; add `phone text`, `consent_source text CHECK (consent_source IN ('order','signin','import','admin'))`, `opted_out boolean NOT NULL DEFAULT false`, `birthday_set_at timestamptz`, `last_seen_ip text`, `referrals_blocked boolean NOT NULL DEFAULT false`, `influencer_multiplier numeric(4,2)`, `influencer_campaign text`, `influencer_paused boolean NOT NULL DEFAULT false`, `influencer_rate_starts_at timestamptz`, `influencer_rate_ends_at timestamptz`, `influencer_code text UNIQUE`, `influencer_code_percent integer`, `influencer_code_discount_id text`, `imported_from_smile boolean NOT NULL DEFAULT false`, `first_order_awarded_at timestamptz`.

**points_ledger**: add `customer_note text`. `action_type` CHECK extended with `'order_cancelled','referral_reversal','redemption_return','tier_reward','influencer_sale','import'`. Backfill `points_remaining = points` for existing positive non-expired rows where it is null, and set `expires_at` for Silver members' positive rows lacking one. Replace the FIFO index with one covering all positive rows.

**order_webhook_state**: add `order_name text`, `placed_at timestamptz`, `cancelled_at timestamptz`, `earning_basis_pkr numeric(12,2)`, `gift_card_amount_pkr numeric(12,2) NOT NULL DEFAULT 0`, `refunded_basis_pkr numeric(12,2) NOT NULL DEFAULT 0`, `multiplier_used numeric(4,2)`, `campaign_id uuid`, `pending_points integer NOT NULL DEFAULT 0`, `points_awarded_amount integer NOT NULL DEFAULT 0`, `points_reversed_amount integer NOT NULL DEFAULT 0`, `discount_codes text[] NOT NULL DEFAULT '{}'`, `influencer_member_id uuid REFERENCES members(id)`, `is_first_order boolean`. Index on `shopify_customer_id`.

**loyalty_codes**: add `kind text NOT NULL DEFAULT 'reward' CHECK (kind IN ('reward','birthday','referral_friend','tier_gold','tier_diamond'))` (backfill from code prefix), `shopify_discount_id text`, `issue_key text UNIQUE`, `cancelled_at timestamptz`; status CHECK becomes `('pending','active','used','expired','cancelled')`. `issue_key` is the idempotency key for automatic codes: `birthday:<member>:<year>`, `referral_friend:<referral id>`, `tier_gold:<member>`, `tier_diamond:<member>`.

**referrals**: status CHECK adds `'rejected'`; add `reward_points integer`, `friend_code_id uuid`, `reviewed_at timestamptz`, `reviewed_note text`. De-duplicate, then unique partial index: one row with status in ('pending','flagged') per `referred_shopify_customer_id`.

**New tables**: `review_claims(id uuid pk, member_id uuid fk, shopify_order_id text, status text CHECK IN ('pending','awarded','rejected') DEFAULT 'pending', points integer NOT NULL, claimed_at timestamptz DEFAULT now(), release_at timestamptz NOT NULL, resolved_at timestamptz)`; `tier_history(id, member_id fk, from_tier text, to_tier text, shopify_order_id text, created_at)`; `staff_notes(id, member_id fk, note text NOT NULL, author text, created_at)`; `system_heartbeat(key text PRIMARY KEY, at timestamptz NOT NULL, detail jsonb NOT NULL DEFAULT '{}')`.

**app_settings**: add `earn_rules jsonb NOT NULL DEFAULT` `{"purchase":{"enabled":true},"signup":{"enabled":true},"referral":{"enabled":true},"instagram":{"enabled":true},"facebook":{"enabled":true},"youtube":{"enabled":true},"review":{"enabled":true},"birthday":{"enabled":true}}`; `referral_friend_free_shipping boolean NOT NULL DEFAULT true`; `tier_reward_gold_free_shipping boolean NOT NULL DEFAULT true`; `tier_reward_diamond_pkr integer NOT NULL DEFAULT 500`; `review_release_hours integer NOT NULL DEFAULT 72`; `social_url_instagram text`, `social_url_facebook text`, `social_url_youtube text`; `reward_code_expiry_days integer NOT NULL DEFAULT 30`.

**Functions** (plpgsql, all row-locking the member `FOR UPDATE`):

- `award_points(p_member_id uuid, p_action_type text, p_reference_id text, p_points integer, p_expires_at timestamptz DEFAULT NULL, p_shopify_order_id text DEFAULT NULL, p_reason_note text DEFAULT NULL, p_purchase_amount_pkr numeric DEFAULT NULL, p_customer_note text DEFAULT NULL) RETURNS TABLE(awarded boolean, new_balance integer, new_lifetime_spend_pkr numeric)` — same idempotency (unique member/action/reference) and redemption-rejects-when-insufficient behaviour as today. Changes: every positive row gets `points_remaining = points`; every negative row (any action) consumes FIFO across all unexpired positive rows; `expiry` deducts exactly `LEAST(that row's points_remaining, balance)` and marks it expired; floor at zero kept; no longer touches `order_webhook_state`.
- `award_order_points(p_shopify_order_id text, p_member_id uuid, p_points integer, p_basis_pkr numeric, p_multiplier numeric, p_expires_at timestamptz) RETURNS TABLE(awarded boolean, new_balance integer, new_lifetime_spend_pkr numeric)` — locks the order row; returns `awarded=false` if `cancelled_at IS NOT NULL` or already awarded; else writes the `purchase` ledger row (reference = order id), adds `p_basis_pkr` to lifetime spend, sets `points_awarded=true`, `points_awarded_amount`, `multiplier_used`, `pending_points=0`.
- `reverse_order_points(p_shopify_order_id text, p_kind text /* 'refund'|'cancel' */, p_reference_id text, p_refunded_basis_pkr numeric DEFAULT NULL) RETURNS TABLE(reversed integer, new_balance integer)` — locks the order row; on `cancel` sets `cancelled_at`, `pending_points=0`; computes amount per rule 6; writes `refund_deduction` or `order_cancelled` ledger row; bumps `points_reversed_amount`, `refunded_basis_pkr`; reduces lifetime spend (floor 0). No-op (0) when the order row is missing or nothing was awarded.

Stream A must test these three functions against a real Postgres (try the `embedded-postgres` npm package as a devDependency-free scratch install outside the repo, or any Postgres you can start); cover: FIFO across action types, redemption insufficient, idempotent replays, refund then cancel (no double reversal), cancel before award blocks later award, expiry after partial spend, floor at zero, two concurrent reversals.

Migration `supabase/migrations/014_faq_panel_theme.sql`: column `app_settings.panel_theme text NOT NULL DEFAULT 'light' CHECK (panel_theme IN ('light','dark'))`; new column defaults (social points 500 each; reward table gains 50,000 → Rs. 2,500), which change no existing row; and the owner-approved FAQ ("How are my points calculated?") written to `app_settings.faqs` only when that list is empty.

Stream C owns `supabase/migrations/011_admin_stats.sql` (SQL functions/views for admin totals; no table changes to the tables above).

## 3. Server functions other streams may call (stream A implements, exact exports)

```ts
// app/lib/points.service.ts
export async function enrolFromSignin(input: { shopifyCustomerId: string; shop: string; ip?: string | null }): Promise<{ memberId: string | null; welcomeQueued: boolean; reason?: string }>; // enrol or update consent, record last_seen_ip, queue welcome bonus if never awarded
export async function setOptOut(memberId: string, optedOut: boolean): Promise<void>;
export async function setBirthday(memberId: string, month: number, day: number, opts: { byAdmin: boolean }): Promise<{ ok: boolean; reason?: 'already_set' | 'invalid_date' }>;
export function tierForSpend(spendPkr: number, s: { gold: number; diamond: number }): 'silver' | 'gold' | 'diamond';
// app/lib/settings.server.ts
export async function getSettings(): Promise<AppSettings>; // typed row, 30 s in-process cache, bustSettingsCache()
export function bustSettingsCache(): void;
// app/lib/redemption.service.ts
export async function redeemPoints(input: { memberId: string; points: number; shop: string }): Promise<{ ok: true; code: string; discountPkr: number; expiresAt: string } | { ok: false; reason: string }>;
export async function cancelRewardCode(input: { codeId: string; shop: string; actor: string }): Promise<{ ok: boolean; pointsReturned: number; reason?: string }>;
// app/lib/review-claims.service.ts
export async function claimReview(memberId: string): Promise<{ ok: true; releaseAt: string } | { ok: false; reason: 'no_eligible_order' | 'disabled' | 'blocked' }>;
export async function rejectReviewClaim(claimId: string, actor: string): Promise<{ ok: boolean }>;
// app/lib/referrals.service.ts
export async function approveReferral(referralId: string, actor: string, shop: string): Promise<{ ok: boolean; paid: boolean; reason?: string }>;
export async function rejectReferral(referralId: string, actor: string, note?: string): Promise<{ ok: boolean }>;
// app/lib/influencer.service.ts
export async function setInfluencer(memberId: string, input: { isInfluencer: boolean; multiplier?: number | null; campaign?: string | null; paused?: boolean; rateStartsAt?: string | null; rateEndsAt?: string | null }): Promise<{ ok: boolean; reason?: string }>;
export async function createInfluencerCode(input: { memberId: string; code: string; percentOff: number; shop: string }): Promise<{ ok: boolean; reason?: string }>;
export async function removeInfluencerCode(input: { memberId: string; shop: string }): Promise<{ ok: boolean; reason?: string }>;
export function effectiveReferralPoints(member: { is_influencer: boolean; influencer_paused: boolean; influencer_multiplier: number | null; influencer_referral_rate: number | null; influencer_rate_starts_at: string | null; influencer_rate_ends_at: string | null }, standardPoints: number, at?: Date): number;
// app/lib/heartbeat.server.ts
export async function recordHeartbeat(key: string, detail?: Record<string, unknown>): Promise<void>;
export async function readHeartbeats(): Promise<Array<{ key: string; at: string; detail: Record<string, unknown> }>>;
// app/lib/worker-admin.server.ts
export async function getAdminForShop(shop?: string): Promise<AdminGraphqlClient>; // shop optional: falls back to the single stored offline session's shop; no hard-coded domain
```

Stream B implements and owns `app/lib/storefront-config.server.ts`:

```ts
export async function syncStorefrontConfig(admin: AdminGraphqlClient): Promise<{ ok: boolean; reason?: string }>;
// Builds the public config JSON from getSettings() + active campaign and writes it to an app-data metafield (namespace "hg_loyalty", key "config", type json) owned by the current app installation, so theme app extension Liquid can read app.metafields.hg_loyalty.config.value.
```

Stream C calls `syncStorefrontConfig(admin)` after every settings/program/campaign save; stream A calls it nowhere.

Public config JSON shape (written by B, read by Liquid and widget): `{ enabled /* always true */, redeemPaused /* rule 20 */, panelTheme /* 'light' | 'dark' */, programName, tagline, pointsRate, signupPoints, referralPoints, reviewPoints, social: { instagram: {points,url,enabled}, facebook: {...}, youtube: {...} }, earnRules, tiers: { gold, diamond }, redemptionTiers: [{points, discountPkr}], birthday: { silver, gold, diamond }, nudges: { accountCreation, pointsSpending, rewardUsage, tierProgress, goldWithin, diamondWithin }, campaign: { name, multiplier, startsAt, endsAt } | null, terms, faqs }`.

## 4. Storefront proxy API (stream B owns; JSON, `Cache-Control: no-store`, HMAC verified first)

- `GET /proxy/customer` → guests are never expected to call it. Signed-in: calls `enrolFromSignin`, returns `{ member: { firstName, tier, pointsBalance, pendingPoints, lifetimeSpendPkr, referralLink, birthday: {month, day} | null, canSetBirthday, isInfluencer, optedOut, blocked }, codes: [{ id, code, kind, discountPkr, expiresAt }], social: { instagram, facebook, youtube: 'available'|'claimed' }, review: { eligible, pending }, nextExpiry: { points, at } | null }`. `pendingPoints` = sum of `order_webhook_state.pending_points` for the customer where not cancelled and not awarded.
- `GET /proxy/history?filter=all|earned|redeemed|referral|other&page=` → rows `{ id, type, label, points, at, note }` where `note` is `customer_note` only (never `reason_note`).
- `POST /proxy/redeem {points}` → `{ ok, code, discountPkr, expiresAt }` or `{ ok:false, error }` (one error field name everywhere: `error`).
- `POST /proxy/social {platform}` → `{ ok, status: 'awarded'|'already_claimed', points }` or `{ ok:false, error }`.
- `POST /proxy/review` → `{ ok, releaseAt }` or `{ ok:false, error }`.
- `POST /proxy/birthday {month, day}` → `{ ok }` or `{ ok:false, error }`.
- `POST /proxy/referral {slug}` → `{ ok, status, friendCode? }`.

## 5. Admin information architecture (stream C)

Routes: `/app` Home, `/app/customers` + `/app/customers/$id`, `/app/program`, `/app/referrals`, `/app/influencers` + `/app/influencers/$id`, `/app/campaigns`, `/app/analytics`, `/app/onsite`, `/app/settings`, `/app/import` (page shell owned by stream D). Old routes `/app/members`, `/app/nudges` redirect. Navigation through Shopify's app nav (App Bridge `ui-nav-menu` / `NavMenu`), verified against Shopify docs.

## 6. File ownership

- **A (engine)**: `supabase/migrations/010_v3_core.sql`; `app/lib/{points,redemption,birthday,referral-bonus,referrals,notifications,email}.service.ts`; new `app/lib/{settings.server,discounts.server,review-claims.service,influencer.service,tier-rewards.service,whatsapp.service,heartbeat.server,orders.server}.ts`; `app/lib/{shopify-graphql,worker-admin,queue}.server.ts`; `app/workers/*`; `app/routes/webhooks.*`; `app/shopify.server.ts`; `shopify.app.example.toml`; `app/database.types.ts`; `app/lib/scripttag.server.ts` (delete; keep rewards-page creation in a new `app/lib/rewards-page.server.ts`); `.env.example`; `tsconfig.json`; `README.md`; tests for these.
- **B (storefront)**: `extensions/**`; `app/widget/**`; `scripts/build-widget.mjs`; `public/**`; `app/routes/proxy.*`; `app/lib/{widget-data,proxy-auth,storefront-config}.server.ts`; `package.json` scripts for the widget build only; tests for these.
- **C (admin)**: `app/routes/app*.tsx`, `app/routes/_index.tsx`, `app/routes/auth.$.tsx`; `app/lib/admin-*.server.ts`; `app/lib/csv*.ts`; `app/components/**`; `app/root.tsx`; `supabase/migrations/011_admin_stats.sql`; tests for these. Exception: `app/routes/app.import.tsx` belongs to D.
- **D (Smile import, starts after A)**: `app/lib/smile-import*.ts`, `app/workers/import.worker.ts`, `app/routes/app.import.tsx`, `supabase/migrations/012_import.sql`, tests.
- `package.json` dependencies: any stream may add a dependency it needs; add only, never remove or bump others; report what you added.
