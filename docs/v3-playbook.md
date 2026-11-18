# HeyGirl Rewards v3 — build playbook

Purpose: everything a capable model needs to carry this build to launch with a team of sub-agents, without the original author. Read this file, then `docs/v3-contract.md` (binding names and rules). The contract wins where the two differ.

Section 12 is the live status. Update it whenever work lands.

## 1. What is being built and for whom

- **Store:** heygirl.pk, beauty and skincare, Pakistan. Shoppers are women 18–45, mostly on phones, many with WhatsApp and no email.
- **Goal:** a private Shopify app, "HeyGirl.pk Rewards", that replaces Smile.io: points, redemption codes, tiers, referrals, influencers, birthday rewards, reviews, a storefront panel and an admin.
- **Hard constraint:** it must not slow the store.
- **Owner's standing instructions:** never guess; read files before deciding; have every solution reviewed by an independent agent and state a confidence score out of 100 at the top of the answer.

## 2. Facts verified, with how

| Fact | Source |
|---|---|
| Store plan is Basic; currency PKR; primary domain `www.heygirl.pk`; admin domain `heygirll.myshopify.com` (double l); customer accounts are the new version | Shopify Admin API through the connector, Nov 2026 |
| Theme is Dawn, Online Store 2.0; cart type is `drawer`; Smile, Shopify Forms and a bank-transfer button app load as app embeds | Theme export (`config/settings_data.json`, `layout/theme.liquid`) |
| `scriptTagCreate` returns a user error on every API version since 1 Oct 2026; script tags stop running on storefronts 1 Mar 2027 | shopify.dev changelog, 24 Aug 2026 |
| No `priceRule*` mutations in the current Admin schema; use `discountCodeBasicCreate`, `discountCodeFreeShippingCreate`; customer targeting moved to a `context` input | Admin GraphQL schema inspection |
| `refunds/create` payload has `order_id` and no customer | shopify.dev webhook reference |
| Checkout-step UI extensions need Plus; Thank-you and Order-status extensions work on all plans except Starter | shopify.dev checkout technologies page |
| Flow extensions from a custom app work only on Plus, so the app cannot trigger Shopify Email on Basic | shopify.dev "About Flow" |
| Custom apps are exempt from expiring offline tokens | shopify.dev changelog, 2026 |
| Legacy customer accounts are deprecated (Feb 2026) | shopify.dev changelog |
| A custom-distribution app installs on one store; the method cannot be changed after selection | shopify.dev distribution docs |
| App-data metafields belong to the AppInstallation, are written with `metafieldsSet` and read in Liquid through `app.metafields` | Docs and schema check by the storefront agent |
| Dawn replaces `#CartDrawer` innerHTML on add and `.drawer__inner` on quantity change; only `<cart-drawer>` survives | `assets/cart-drawer.js` in the theme export |
| Dev database is the Supabase project `heygirl-rewards-dev`, migrations 001–009 applied; Railway runs web, worker (`WORKER=1`) and Redis | Owner's screenshots, 16 Nov 2026 |

**Not verified. Test on the dev store before relying on them:**

- That a live `discountCodeBasicCreate` call with the `context` customer lock works as coded.
- Whether Shopify frees a single-use code when its order is cancelled.
- How the bank-transfer discount app (no code, embed) combines with a reward code.
- `logged_in_customer_id` on app-proxy requests with new customer accounts.
- Whether `X-Forwarded-For` through the proxy is the shopper's address.
- The exact theme-editor deep link for enabling the embed.
- Whether the existing app's distribution type allows install on heygirl.pk (owner must send the Dev Dashboard Distribution card).
- Customer-account extensions and admin blocks on Basic for a custom app.

## 3. Decisions the owner has made

All are encoded as rules 1–19 in `docs/v3-contract.md` section 1. The ones most often got wrong:

- Points are awarded only when an order is **fulfilled and paid and not cancelled**. COD is marked paid by hand 7–10 days after delivery; show points as pending until then.
- Welcome bonus at **first sign-in only**, never at order time. Orders still enrol the customer (auto-consent).
- Balance never goes negative. Refunds and cancellations always reverse, capped per order.
- All Silver points expire after 365 days; deductions use oldest points first.
- Tiers are never taken away.
- Same-network referrals are **held for approval**, not rejected.
- Influencers get a **multiplier** of the standard referral reward, optional dates, pause, and their own Shopify discount code whose orders are attributed to them.
- Review claims: one per delivered and paid order, released after 72 hours. The storefront never says it is unverified.
- Smile import: match by email only; zero-point records import at zero; imported points expire one year from import. The Smile export has no phone column and writes points with thousands separators.
- Emails are sent by the app (SMTP). WhatsApp is built behind a switch and stays off until the store has a WhatsApp Business API account.

Owner answers, 17 Nov 2026:
- A paused influencer earns the standard referral reward (6,000). As built.
- The Smile import runs **before** the storefront launcher is switched on.
- Live uses a **new, separate** Supabase project (owner changed this answer the same day). `heygirl-rewards-dev` stays for testing.
- Birthday-month 1.2x purchase multiplier is **Diamond only** (as built).
- Keep the Rs.5,000 and Rs.10,000 redemption rewards; the owner will deactivate them in admin if needed.
- "Ways to earn" icons (item 4 of `coding changes.txt`): no specific list; owner wants them clear and easy to tap, in the style of Smile's panel.
- Owner states the app will be owned by heygirl.pk's own organization and installed only on that store (so exempt from the IP allowlist rule). NOT verified: the Dev Dashboard screenshot has not been seen.
- Copying `shopify.app.example.toml` into the real `shopify.app.toml` and making the GitHub repo private: done together with the owner after the build is complete.

Still open with the owner: cutover date (to be set together after the build); Dev Dashboard screenshot showing which organization owns the app and whether it has a Distribution or an Installs card.

## 4. Defects in the pre-v3 code that v3 must not reintroduce

Full list with file references: project doc `HeyGirl_Rewards_Completion_Handbook.md`. Categories to re-check in any review:

1. **Field names across a boundary.** The old widget read `error`, `discount_pkr`, `referralRate`, `alreadyClaimed` while the server sent `reason`, `discountPkr`, `customRate`, `reason`. The contract fixes one name per field; compare producer and consumer literally.
2. **Settings saved but never read.** Any setting in the admin must be read by the engine through `getSettings()` and reach the storefront through the config metafield.
3. **Hard-coded business numbers** in widget, Liquid or services (thresholds, reward table, 365, 6000).
4. **Money and time.** Pakistan time for every boundary. Discount-adjusted amounts for refund proportion. Gift-card amounts excluded from earning.
5. **Idempotency and races.** Every award has a unique (member, action, reference). Per-order caps live in the database under a row lock. Automatic codes use `issue_key` and a pending-then-active marker.
6. **Blocked and opted-out members** must be checked in every earn, redeem, birthday, referral and proxy path.
7. **Silent failure.** Always read `userErrors`; never swallow an error that skips a customer's reward.
8. **Admin numbers from partial data.** No table downloads; totals in SQL.
9. **Destructive privacy webhook.** `shop/redact` only logs.
10. **Stray compiled `.js`** beside sources: `tsconfig.json` must have `noEmit`.

## 5. Architecture

- **Server:** Remix app on Railway (web) plus the same image as a worker (`WORKER=1`) running BullMQ queues and cron on Redis. Supabase Postgres through the service key. Single merchant.
- **Storefront:** theme app extension `extensions/hg-loyalty` (app embed + product, cart and rewards-page blocks). Core script small and deferred; hub script loaded on first open. Guests never call the app server. Members call `/apps/loyalty/customer` once when idle, cached five minutes.
- **Settings to storefront:** admin save → `syncStorefrontConfig(admin)` → app-data metafield `hg_loyalty.config` → Liquid.
- **Points accounting:** three SQL functions in migration 010: `award_points`, `award_order_points`, `reverse_order_points`.
- **Admin:** embedded, Polaris, sections Home, Customers, Program, Referrals, Influencers, Campaigns, Analytics, On-site, Settings, Import.

## 6. Team structure

Four build streams with exclusive file ownership (contract section 6), then three reviewers, then one integrator (the lead model).

| Stream | Scope | Starts |
|---|---|---|
| A engine | Migration 010, services, webhooks, workers, discounts module, notifications, config files | Immediately |
| B storefront | Theme app extension, widget bundles, proxy routes, storefront config sync | Immediately |
| C admin | All `app.*` routes and `admin-*` libs, migration 011 | Immediately |
| D import | Smile import lib, worker, `/app/import`, migration 012 | After A lands |

Brief for each build agent (adapt, keep every element):

1. Role, repo path, branch, baseline test state.
2. "Read `docs/v3-contract.md` fully; it is binding." Plus the handbook sections relevant to the stream and the files it owns.
3. A numbered deliverable list (see section 7).
4. Verify every Shopify operation with the schema and docs tools; never call a tool that changes the live store.
5. Other agents are editing the same tree; do not edit outside ownership; import other streams' functions by the contract signature even if not present yet.
6. Unit tests for everything; run `tsc` and own tests at the end.
7. A capped final report: files, deviations, verified versus assumed, test results, changes needed elsewhere, doubts. "Do not claim something works unless you ran it."
8. "Write files early and often" (agents can be cut off by usage limits; a resumed agent continues from its transcript).

Practical notes from running this:

- Launch build agents in the background and resume a stopped one with a message to the same agent; do not start a duplicate.
- Agents cannot always install packages (jsdom was refused). Accept pure-function tests and say what is untested.
- The GraphQL validation tool may be a no-op; schema inspection still works.
- One agent staged a deletion with `git rm --cached`. Tell agents not to touch the index at all.
- Reviewers must be fresh agents that did not write the code, told to disprove it, and given file:line evidence requirements.

## 7. Deliverables by stream

**A engine**
- `supabase/migrations/010_v3_core.sql` per contract section 2, with the three functions, tested on a real Postgres (embedded-postgres in a scratch directory works): FIFO across action types, insufficient redemption, idempotent replay, refund then cancel, cancel before award, expiry after partial spend, floor at zero, concurrent reversals.
- `app/lib/discounts.server.ts`: amount-off and free-shipping customer-locked codes, public percentage code for influencers, deactivate; `userErrors` checked.
- API version bump in `app/shopify.server.ts` and `shopify.app.example.toml`; subscribe `orders/create`, `orders/cancelled`; remove `customers/enable`; remove script-tag code and scopes but keep rewards-page creation.
- All rules 1–19; contract section 3 exports exactly.
- Heartbeat each minute from the worker; queues with `removeOnComplete`; cron in Asia/Karachi; a daily `syncStorefrontConfig` so a campaign that starts without a save still shows.
- Branded email layout; WhatsApp provider that is a no-op without credentials.
- `database.types.ts`, `.env.example`, `tsconfig.json` (`noEmit`), README runbook.

**B storefront**
- Extension blocks: embed, product points, cart points, rewards page. Bundles built into `extensions/hg-loyalty/assets` with gzip budgets (core 8 KB, hub 22 KB).
- Cart drawer line inserted before `.cart__ctas`, never inside, re-inserted by observing `<cart-drawer>`.
- Proxy API per contract section 4, one error field `error`, HMAC first, shop from the signed query.
- `syncStorefrontConfig`.
- Accessibility: real buttons, focus trap, 44 px targets, 4.5:1 contrast, reduced motion. Mobile first.

**C admin**
- Navigation in Shopify's app nav; old routes redirect.
- Home, Customers (list and full-page profile), Program, Referrals, Influencers (list and detail), Campaigns, Analytics, On-site, Settings as specified in `HeyGirl_Rewards_Build_Plan_v3.md` section 11 and the mockup canvas.
- Every numeric input validated server-side with a range; blanks rejected.
- `supabase/migrations/011_admin_stats.sql`; CSV injection protection on text cells; "today" in Pakistan time.
- Calls `syncStorefrontConfig(admin)` and `bustSettingsCache()` after every save.

**D import**
- Parse the Smile CSV (columns: Smile Customer ID, First name, Last name, Email, Membership status, Points balance, Referral url, Vip tier name, Date of birth). Strip thousands separators. Email-only match to Shopify customers; unmatched rows to a review file.
- Idempotent and re-runnable; import through `award_points` with action `import` and expiry one year from import; reconcile totals against the file; dry-run mode; never give a welcome bonus at import.
- Admin page with upload, dry-run report, run, progress and result.

## 8. Integration steps (lead)

1. `npx tsc --noEmit` and `npx vitest run`; fix cross-stream mismatches by making code match the contract, not the reverse.
2. Grep every contract export for at least one caller and every proxy field for producer/consumer agreement.
3. Apply migrations 001–012 to a scratch Postgres in order; run the SQL tests.
4. `npm run build` (widget bundles then Remix); confirm bundle sizes.
5. `shopify theme check` on the extension if the CLI is available.
6. Commit on a feature branch; open a pull request. **Never push to `main`:** Railway deploys `main` automatically.

## 9. Review protocol (three independent agents, in parallel)

- **Reviewer 1, accounting:** migration 010 and every caller of the three functions; re-derive each rule 1–19 from code; look for double awards, missed reversals, time-zone and rounding errors, blocked/opted-out gaps.
- **Reviewer 2, storefront and API:** proxy routes against contract section 4, widget consumers against producers, HMAC and rate limits, Liquid against the config shape, performance (requests per page for a guest must be zero to the app), accessibility.
- **Reviewer 3, admin and security:** every loader/action authenticated and validated, CSV injection, secrets never sent to the browser, SQL stats correctness, destructive actions confirmed, the section 4 defect categories.

Each returns: findings with file:line and a concrete failure scenario, severity, and a confidence score. Fix, then have a fourth fresh agent verify the fixes. Report the lowest reviewer score to the owner, not the average.

## 10. Dev-store acceptance test (needed before any claim above 90)

Deploy the branch to the dev store, in this order: (a) back up `heygirl-rewards-dev`; (b) confirm Railway `SUPABASE_SERVICE_KEY` is the service-role key (done: `sb_secret_`); (c) apply migrations 010, 011, 012, 013, 014 in order BEFORE the new code starts (010 drops old function signatures; 014 adds `panel_theme`, which the On-site save needs); (d) set env (`STOREFRONT_URL` must be the address of the store being tested — the dev store's address while testing on the dev store, `https://www.heygirl.pk` only for live); (e) deploy the branch on Railway (web and worker); (f) copy the example toml changes into `shopify.app.toml`, `shopify app deploy`; (g) enable the embed and blocks in the theme editor; (h) make one admin save (e.g. On-site) so the storefront config is republished with `redeemPaused` and `panelTheme`. Then:

1. Guest: launcher shows; network tab shows no request to `/apps/loyalty`.
2. Sign in as a new customer: member created, +welcome bonus once; reload does not add again.
3. Place a COD order: pending points appear; mark fulfilled, then paid: points awarded once with correct amount; tier and lifetime spend update.
4. Order with a reward code and with a gift card: earning basis excludes both. Order with a free-shipping code: basis excludes shipping and tax and is not reduced by the undiscounted shipping price (compare `total_shipping_price_set`, `current_shipping_price_set`, `shipping_lines[].discounted_price` in the webhook against the awarded basis).
5. Redeem: code created in Shopify, locked to the customer, applies from the drawer link; second redeem with insufficient points is refused.
6. Refund part of a delivered order: proportional reversal. Cancel it: remainder reversed, never below zero, no double reversal.
7. Cancel an unfulfilled order that used a reward code: redeemed points returned.
8. Referral: friend signs in from a link and gets the free-shipping code; referrer paid only after the friend's first order is fulfilled and paid; same network → held; approve → paid.
9. Influencer: set 2×; create her code; a new customer orders with it → order attributed, she earns after delivery and payment.
10. Birthday: set once from the storefront; second attempt refused; run the birthday job → one code; rerun → no second code.
11. Review claim: refused with no delivered order; accepted after one; released after the wait (shorten `review_release_hours` for the test).
12. Expiry: backdate a Silver ledger row, run the expiry job: only unspent points removed.
13. Block and opt-out: no earning, no redemption, clear storefront state.
14. Admin: change a reward-table row and a tier threshold → storefront and engine both reflect it after save.
15. Bank-transfer button and reward code on the same order.
16. Lighthouse mobile on home, product and cart with the embed on versus off (several runs each).

## 11. Go-live checklist

- Confirm the distribution type allows install on heygirl.pk, or create a second app entry (new client id, secret, proxy, env).
- Separate Supabase project and Redis for live. Never point live at `heygirl-rewards-dev`.
- **Live database plan (owner decision, 18 Nov 2026): Supabase FREE plan plus our own daily backup** (the owner declined Pro at $25/month for now). This uses both free projects (dev + live).
  - Build before go-live: a scheduled Railway job that runs `pg_dump` of the live database every night and keeps the last ~14 copies on a private Railway volume. Copies contain customer emails and phone numbers: never put them on GitHub or any public place. The database connection string is kept only as a Railway variable.
  - Test one restore from a copy into the dev project before go-live, and note how long it took.
  - Pausing: free projects pause after a week of too little database activity; the app queries every minute, and Supabase emails a warning about a week before. Whoever receives Supabase account emails must act on that warning.
  - Upgrade to Pro (one click, no code change) if the database nears 400 MB, the app is slow, or the program clearly pays for itself.
  - Details of the backup job (connection type, Postgres version match, cost) are being checked by an independent reviewer; record the outcome here.
- Backup before migrations and before the import; test one restore.
- Protected customer data access granted for the live app.
- Theme steps on a duplicate of the live theme first.
- Fresh Smile export, freeze Smile, import with dry run, reconcile, then turn the Smile embed off and ours on. Keep Smile installed until reconciled (rollback path).
- Decide what happens to Smile codes customers already hold and to orders placed under Smile but delivered after the switch.
- Do not uninstall the app after members are imported.
- Make the GitHub repository private.

## 12. Status log

- 2026-11-16: Contract written. Baseline: `tsc` clean, 83/84 tests (one redeem test times out). Streams A, B, C launched.
- 2026-11-16: **Stream B finished.** Bundles: core 4.16 KB gzip, hub 11.39 KB gzip. 86/86 of its tests pass. Not run in a browser. Its deviations and unverified items are in its report (extra config keys; `GET /proxy/referral` added; social award keeps a 24-hour delay; no jsdom, so event wiring is untested). It needs: C to call `syncStorefrontConfig` on every save and provide social URL and FAQ fields; A to add a daily config sync and `STOREFRONT_URL` to `.env.example`.
- 2026-11-16: **Stream A finished.** Migration 010 applied on a real Postgres 18 (embedded-postgres) after 001–009, twice: 72 of 72 checks pass, including refund-then-cancel, cancel-before-award, concurrent reversals and redemptions. About 290 unit tests pass. Shopify operations were checked field by field against the schema; none was run against a store. API version set to `2026-10` as a string because the installed SDK enum stops at 2025-10. Its deviations to keep in mind:
  - `award_points` gives a Silver member's positive row an expiry even when the caller passes none; no advisory lock.
  - After 010 runs, deploy the new code immediately: 010 drops the two old `award_points` signatures.
  - Multiplier is fixed when the order is first seen. Earning basis uses the order's current totals.
  - A same-network (flagged) referral holds the friend's free-shipping code until approval.
  - Silver straight to Diamond gets both tier codes. An influencer-code sale is reversed on cancel or full refund.
  - `customers/redact` also sets `opted_out`.
  - `recordReferralVisit` is the referral entry point (returns `{ ok, recorded, blocked, status, reason?, friendCode? }`).
  - Heartbeat keys: `worker`, `cron:<job>`, `cron_failed:<job>`, `alert:shop_redact`.
  - Owner action: copy the example toml changes into the real `shopify.app.toml`, then `shopify app deploy`.
  - Open doubts: tax-inclusive prices may make refund reversal slightly high (still capped); an out-of-order webhook retry can overwrite newer order status until the next event; WhatsApp sender and real email untested.
- 2026-11-16: **Stream C finished.** Whole repo verified by the lead: `npx tsc --noEmit` clean; `npx vitest run` 44 files, 564 tests, all pass. Migration 011 applied on a local Postgres 16 after 001–010 with 40+ assertions. Production build succeeds. Not opened in a real embedded admin. Its deviations:
  - No per-rule "name customers see"; panel texts are program name and tagline only.
  - Theme-embed on/off status is not shown (needs `read_themes`).
  - "Earned" excludes `import` and `redemption_return`.
  - Admin reads `app_settings` directly, then calls `bustSettingsCache()` and `syncStorefrontConfig(admin)`; a failed sync is a warning, the save stands.
  - Influencer custom multiplier limited to 1–10. Block/unblock writes `members.is_blocked` directly.
  - Added dependency `@shopify/app-bridge-react`.
  - Unverified: the literal theme-editor deep-link path and parameter names; nav, save bar, toasts and CSV download inside a real admin.
- 2026-11-16: **Stream D (import) finished its first pass.** Dry parse of the real Smile file (counts only): 23,876 rows; 20,221 with an email (1,816 with points, 18,405 at zero); 3,655 with no email and zero points; no duplicates; 14,535,144 points; VIP tier blank on every row.
- 2026-11-17: **Independent reviews done.** Scores as first written: engine 62, storefront 74, admin 80, import 15. Findings are listed in the fix-round messages; summary:
  - Engine: refund arriving before the award was discarded (H1); amount-only refunds reversed nothing (H2); codes or points could be stranded by a restart (H3); plus M1–M6, L1–L7.
  - Storefront: no high. Referral slug lost on temporary errors; drawer line flicker; no influencer view; paused/not-enrolled state shown as a load error; plus low items.
  - Admin: no high. Influencer code left live when status removed (A1); non-atomic campaign replace (A2); campaign switch-off semantics (A3); search over-match on digits (A4); A5–A10.
  - Import: worker never started (I1); Shopify error handling written for a client that returns errors, but the real client throws (I2); resume while active (I3); opted-out/blocked members would receive points (I4); personal data retention (I5); I6–I9.
- 2026-11-17: **Engine fix round done.** All H, M, L items fixed with tests. Order rows now hold running totals and are reconciled regardless of webhook order (`reconcile_order_points`, `sync_order_snapshot`, `upgrade_member_tier` in 010, which was edited in place because it has not been applied anywhere). Pending-code sweep every 10 minutes. Birthday job daily. `bonus_campaigns.deactivated_at` set by trigger. Import worker wired into `startWorkers`. Postgres harness 106 of 106.
  - `order_webhook_state.refunded_basis_pkr` now means total refunded since placement, including before the award.
  - New heartbeat keys `cron:pending_codes`, `cron:storefront_config`.
  - Unverified: refund webhook field names for the amount-only path; harness ran on Postgres 18, Supabase is older.
- 2026-11-17: **Storefront fix round done.** All 14 items fixed. Bundles 5.42 KB and 11.87 KB gzip. Config gains `nextCampaign`; `GET /proxy/customer` gains `influencer` and `state`; `POST /proxy/referral` status is only `recorded | not_eligible | try_again`. Still no DOM test of `core.ts`/`hub.ts`. Left over: `proxy.social.tsx` still passes a fixed job id `social-<id>` (drop it).
- 2026-11-17: **Lead verification after both fix rounds:** `tsc` clean; 47 test files, 705 tests pass.
- 2026-11-17: **New Shopify requirement found (read on shopify.dev, changelog dated 11 Nov 2026).** A custom app installed on a store **outside the organization that owns the app** needs an IP allowlist: for new installs from 20 Nov 2026 23:59 ET, for existing installs from 1 Jan 2027. Apps installed only on stores inside the owning organization, and apps created by the merchant, are not affected. Set in Dev Dashboard > app > Settings > IP allowlist (IPs/CIDR up to 250, or up to 10 ASNs, optionally limited by country; "Test against recent traffic" before enforcing). When enforced, Admin API calls from other addresses get 403. Both Railway services (web and worker) call the Admin API. Railway static outbound IPs need the Pro plan and are shared, not dedicated; the alternative is allowing Railway's network by ASN. NOT yet known: which organization owns this app, the Railway plan, Railway's ASN. Do not guess these.
- 2026-11-17: **Admin (A1-A10) and import (I2-I9) fix rounds done**, commit `5800eb7`. Build blocker found: a route file exported a helper, which breaks `remix vite:build` though tsc and vitest pass. `npm run build` is now part of lead verification.
- 2026-11-17: **Independent verification of 5800eb7** (fresh agent). No way found to double-award, under- or over-reverse, or go negative (own randomized test, 1,000 orders, 0 violations; 010/011/012 pass on Postgres 18.6 and 15.19). No High defect. Its scores: engine 78, storefront 68, admin 76, import 66, overall 68. New defects V1-V11: V1 throttle retry was dead code; V2 shipping basis with free-shipping codes; V3 social award lost with Redis; V4 ambiguous deduction error; V5 code used while pending; V6 RLS missing on eleven older tables; V7 non-route exports; V9 pre-v3 refunded orders; V11 fixed social job id.
- 2026-11-17: **V1-V11 fix round done** plus two owner requests: a Hide switch per redemption reward (`hidden: true` on a `redemption_tiers` entry; engine refuses it as `invalid_tier`, storefront config omits it, Program page switch) and new "ways to earn" rows (own line icon per row, whole row is the tap target, state in words). New migration `013_rls.sql` (RLS on every app table, no policies; the app must be using the service-role key - CHECK the Railway `SUPABASE_SERVICE_KEY` before applying). First test of `core.ts` wiring against a simulated page (`app/widget/core.dom.test.ts`).
- 2026-11-17: **Lead verification after that round:** tsc clean; 49 files, 880 tests pass; `npm run build` succeeds (core 5.42 KB, hub 12.25 KB gzip); 010+013 harness 123/123 on Postgres 18.6.
- Known and not fixed: `classifyLookupError` in the import has name checks that can never match (status checks still catch the cases); `rewards-page.server.ts` mutation has no 5xx retry; hub.ts click handling has no automated DOM test.
- Not done: re-verification of the V-round by the independent agent; dev-store test (section 10). Nothing has run on a store.
- Branch `v3-rebuild` is not ready to merge to `main` until the dev-store test passes.
- 2026-11-17: Second and third independent passes on `7a5d4d5` and `ce84374`: V-round fixes confirmed; new M1 (influencer code retry could leave an unrecorded public discount) and L1-L4 fixed in `ce84374`; double-submit race found in that fix and fixed in `1f708bd`. Reviewer scores: engine 80, storefront 71, admin 77, import 66, overall 70. Lead checks at `1f708bd`: tsc clean, 884/884 tests, build OK (core 5.42 KB, hub 12.33 KB gzip). Open with owner: should a switched-off program stop purchase points (engine still awards today, orders.server.ts); add FAQ line about points on amount paid after discounts.
- 2026-11-17 (evening): **Owner reversed rule 20.** The program switch now only pauses redeeming (admin label "Redeeming"); earning, enrolment, emails, expiry and the whole storefront carry on, and reward codes already issued still work until they expire. All earn-blocking from `925a230` removed (switch history, `program_on_at_placement`, program checks in engine, proxies and widget). Migration 014 renamed `014_faq_panel_theme.sql` (not applied anywhere): `panel_theme` column, FAQ, new defaults. New: "Panel style" Light/Dark on the On-site page (config `panelTheme`). New defaults: social follows 500 each, reward 50,000 → Rs. 2,500; a saved settings row (dev store) is not changed and is edited on the Program page.
- 2026-11-17 (evening): owner decisions: Dark is the default panel style (014 default 'dark', fallbacks dark); Smile had the Rs.5,000/100,000 and Rs.10,000/180,000 rewards too, so the 7-row table matches what customers saw; imported Smile points keep the built-in expiry (silver_expiry_days from import, Silver only), no fixed use-by date; reviews stay 3,000; social 500; no minimum orders. Railway `SUPABASE_SERVICE_KEY` is the secret key (sb_secret_), so 013 is safe. `STOREFRONT_URL` set to https://www.heygirl.pk on both Railway services.
- 2026-11-18: Owner decision: live database stays on Supabase Free with our own nightly backup job (see section 11); Pro deferred. Dev store address `heygirl-dev.myshopify.com`; Railway `STOREFRONT_URL` set to `https://heygirl-dev.myshopify.com` and `SCOPES` to the new list on both services (deploys skipped; apply at the branch switch). Dev database has no backup (free plan); owner proceeding because it holds test data only. Dev setup files written to the owner's computer: `D:\Heygirlpk Rewards\Dev setup` (migrations 010-014 numbered 1-5, `shopify.app.toml` for the dev app, step-3 commands).
