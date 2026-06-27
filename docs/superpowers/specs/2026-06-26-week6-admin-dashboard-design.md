# Week 6 — Admin Dashboard Design

**Date:** 2026-06-26
**Status:** Approved (brainstorming)
**Scope:** Embedded Shopify admin dashboard for HeyGirl.pk Rewards — 9 tabs across 3 sequenced plans.

---

## 1. Goals & Context

Build the merchant-facing admin dashboard so the store owner can monitor the loyalty
program, manage members, run campaigns/referrals/influencers, view analytics, and
configure all program settings — replacing the current placeholder
[`app._index.tsx`](../../../app/routes/app._index.tsx).

**Constraints / facts:**
- Pre-migration: real customer/order data lands in Week 7. Data-heavy views query
  **live Supabase data** and render proper **empty/zero states** when sparse. No fake data.
- Single-merchant embedded app; all routes authenticated via `authenticate.admin(request)`.
- All computation server-side on Render (Remix loaders/actions). No client data fetching.
- Charts via **Polaris Viz** (admin-only — no storefront bundle impact).
- The data layer is largely ready: `members` has `tier`, `is_blocked`, `is_influencer`,
  `influencer_referral_rate`; tables exist for `points_ledger`, `loyalty_codes`,
  `referrals`, `social_actions`, `bonus_campaigns`, and a single-row `app_settings`
  that services already read from.

---

## 2. Architecture

### Routing & shell
- A shared **admin nav shell** layout route (`app.tsx`) renders the Polaris navigation
  (tabs) and `<Outlet/>` for all child tabs. Each tab is its own Remix route:
  - `app._index.tsx` (Overview), `app.members.tsx`, `app.influencers.tsx`,
    `app.referrals.tsx`, `app.campaigns.tsx`, `app.analytics.tsx`, `app.nudges.tsx`,
    `app.settings.tsx`.
- Each route: server `loader` (reads) + `action` (writes). No client-side fetching.

### Data access
- New read module `app/lib/admin-data.server.ts` for aggregation queries
  (tier counts, points-issued time series, redemption conversion, referral funnel,
  top earners/redeemers, influencer comparison). Keeps route loaders thin and testable.
- Writes route through existing services where one exists (point adjustments →
  `points.service`); new admin service functions where needed
  (`admin-members.server.ts`, `admin-campaigns.server.ts`, `admin-settings.server.ts`).
- **Audit trail (full):** manual point adjustments insert a `points_ledger` row with
  `action_type = 'manual_adjust'` and a **required reason** note. Block/unblock and
  influencer-tag changes are timestamped on the member row.

### Activity feed
- Derived from real recent rows across `points_ledger`, `loyalty_codes`, and
  `referrals` (last 7 days), merged and sorted. Rendered as an animated "ticker" UX
  over **real data** (no static/fake rows). Empty state when no recent activity.

---

## 3. Sequencing — 3 sequenced, independently shippable plans

### Plan 6A — Shell + core views
- Admin nav shell layout (`app.tsx`) + Polaris navigation across all 9 tabs.
- **Overview:** tier-breakdown donut, points-issued line chart, redemption conversion
  rate, real-data activity feed (7d) with empty states.
- **Members:** searchable/filterable table; customer detail drawer showing balance,
  tier, lifetime spend, action log, referral stats; actions — manual adjust (+reason),
  block/unblock, influencer tag, custom referral rate.

### Plan 6B — Operational tools
- **Influencer:** per-influencer stats (clicks, conversions, rate, pts, Rs. equiv),
  referral link edit, CSV export.
- **Referrals:** all referral events with fraud flags highlighted; Review & Unblock action.
- **Campaigns:** active campaign status, create/edit/delete (name, multiplier,
  start/end date), history, points-ledger CSV export.

### Plan 6C — Config + reporting
- **Analytics:** members-by-tier-over-time, points issued/redeemed/expired, top
  earners/redeemers, most-popular redemption tier, referral funnel, influencer
  comparison; date ranges 7d/30d/90d/custom + CSV export.
- **Nudges:** master toggle + per-nudge toggles and customisation (icon, title,
  description with dynamic vars, button text, frequency, tier thresholds).
- **Settings:** full program config (see §4).

---

## 4. Data layer additions — migration `006_week6_admin.sql`

Extend `app_settings` so the Settings tab is fully functional as specced, and wire
the relevant services to read these instead of hardcoded values:

- **Redemption table** — JSONB array of `{ points, pkr }` tiers
  (default seeds the 6 current tiers: 3k/100, 6k/250, 11.5k/500, 22k/1000,
  100k/5000, 180k/10000). `redemption.service` reads this.
- **Per-platform social points** — `social_points_youtube`, `social_points_facebook`,
  `social_points_instagram` (default 1000 each). `points.service` reads these.
- **Birthday reward amounts** — `birthday_reward_silver_pkr` (250),
  `birthday_reward_gold_pkr` (500), `birthday_reward_diamond_pkr` (1000).
  `birthday.service` reads these.
- **Content** — `terms_and_conditions` TEXT, `faqs` JSONB (array of `{q, a}`).
- **Nudge customisation** — `nudges_config` JSONB keyed per nudge
  (`{ icon, title, description, button_text, frequency, tier_thresholds }`),
  consumed by the storefront widget data endpoint.
- **`points_ledger`** — ensure `action_type` CHECK/vocab includes `manual_adjust`;
  reason stored in the existing note/metadata column.

No new `admin_activity` table — the activity feed derives from existing tables.

---

## 5. Error handling

- Loaders catch Supabase errors and render Polaris empty/error states; a failed
  aggregation never blanks the whole dashboard (per-card error boundaries where practical).
- Writes (`action`) validate input, return Polaris-friendly field errors, and are
  idempotent where possible. Manual adjust rejects when reason is empty.
- All routes require `authenticate.admin`; unauthenticated requests redirect to Shopify auth.

---

## 6. Testing

- `admin-data.server.ts` aggregation functions: unit tests with mocked Supabase
  (tier counts, time series bucketing, funnel math, empty-data cases).
- Write actions: tests for manual-adjust ledger creation (reason required),
  block/unblock, influencer tag, campaign CRUD, settings persistence.
- Follow existing test conventions (vitest; `queue.server` mocked in files that import it).
- Charts/UI: smoke-render loaders return well-formed data; no snapshot churn.

---

## 7. Out of scope (this week)

- Reward Room admin tab — Phase 2 (Weeks 9–10).
- Migration tooling — Week 7.
- WhatsApp send logic — credentials editable in Settings but dormant until API approved.
