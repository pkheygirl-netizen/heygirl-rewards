# HeyGirl Rewards

Customer loyalty programme for heygirl.pk: a single-store custom Shopify app (Remix), Supabase database, BullMQ queues on Redis, hosted on Railway as two services (web and worker). The storefront reaches the app only through the app proxy (`/apps/loyalty/*`) and a theme app extension.

The binding rules for this version are in `docs/v3-contract.md`.

## Runbook

### 1. Environment variables

Set these on **both** Railway services (web and worker). Names only; see `.env.example` for the format.

| Variable | Needed | Notes |
|---|---|---|
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | yes | From the app in the Shopify Dev Dashboard |
| `SHOPIFY_APP_URL` | yes | Public URL of the web service |
| `SCOPES` | yes | Must match `[access_scopes]` in `shopify.app.toml` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | yes | Service-role key; never the anon key |
| `REDIS_URL` | yes | Same Redis for web and worker |
| `WORKER` | worker only | `1` on the worker service; unset on web |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | for email | Without `SMTP_HOST` no email is sent |
| `STOREFRONT_URL` | optional | e.g. `https://www.heygirl.pk`; adds the button to emails |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | optional | See WhatsApp below |

`SHOPIFY_SHOP_DOMAIN` and `SHOP_DOMAIN` are **no longer used** and can be deleted. The shop comes from the signed webhook or proxy request; scheduled jobs read it from the stored install session.

### 2. Database migrations

Run the files in `supabase/migrations/` in number order in the Supabase SQL editor, one file at a time:

| Order | File | What it does |
|---|---|---|
| 1-9 | `001` ... `009` | The original schema (already applied on the existing database) |
| 10 | `010_v3_core.sql` | v3 columns and tables, and the points functions (`award_points`, `award_order_points`, `reverse_order_points`, `reconcile_order_points`, `sync_order_snapshot`, `upgrade_member_tier`) |
| 11 | `011_admin_stats.sql` | Totals for the admin screens |
| 12 | `012_import.sql` | Tables for the Smile import |

There is no `013`: the engine fixes of 17 November were made in `010` itself, because `010` had not been applied to any database yet.

- **Take a Supabase backup before `010`.** It replaces the points function and back-fills existing ledger rows.
- `010` can be run again safely.
- `010` removes the two old versions of `award_points`. Deploy the new app code straight after running it: the old code calls the old function.
- To test `010` on a throwaway Postgres: `supabase/tests/010_v3_core.pgtest.mjs` (instructions at the top of the file).

### 3. Deploy

1. Push to the branch Railway deploys. Both services rebuild. The worker log must show `[workers] started`.
2. Copy `shopify.app.example.toml` to `shopify.app.toml` (not committed) and fill in the client id and URLs.
3. Run `shopify app deploy`. This is separate from Railway and does three things: registers the webhook subscriptions, applies the access scopes, and releases the theme app extension (the storefront widget). Re-run it whenever `shopify.app.toml` or `extensions/` changes.
4. Open the app once in Shopify admin. This stores the install session that background jobs use, and accepts the changed permission list (the script-tag scopes were removed).
5. In the theme editor, on a **duplicate** of the live theme first: switch on the HeyGirl Rewards app embed, add the product and cart blocks, and assign the `page.rewards` template to the Rewards page. The app creates `/pages/rewards` at install if it does not exist.
6. Check health: the `system_heartbeat` table has a row with key `worker` that is less than two minutes old.

Webhooks this app needs (all in the example toml): `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/cancelled`, `refunds/create`, `customers/create`, `app/uninstalled`, and the three privacy topics. `customers/enable` was removed.

### 4. Cash on delivery: marking an order paid

Points are awarded only when an order is **fulfilled and paid and not cancelled**. A cash-on-delivery order stays "payment pending" in Shopify until someone marks it paid, and until then the customer sees its points as *pending*.

When the courier has paid out (usually 7 to 10 days after delivery):

1. Shopify admin → **Orders** → open the order.
2. In the payment section choose **Mark as paid** and confirm.

Shopify then sends the order update, and the worker awards the points within a minute or so. Nothing else is needed. If an order is cancelled or returned instead, cancel or refund it in Shopify as usual: pending points disappear, and awarded points are reversed automatically.

### 5. What `shop/redact` does

Shopify sends `shop/redact` about 48 hours after the app is uninstalled, asking for the shop's data to be erased.

**This app does not delete anything when it arrives.** It:

- writes a row to `gdpr_requests` (type `shop_redact`), and
- raises an alert (`system_heartbeat` key `alert:shop_redact`) that the admin's system-health view shows.

This is deliberate: an uninstall and reinstall during maintenance must not wipe every customer's balance. If the store really is leaving the app and the data must be erased, do it by hand:

1. Confirm the shop named in the `gdpr_requests` row is the one you mean to erase.
2. Take a Supabase backup and keep it for as long as you are obliged to.
3. Delete in this order (child tables first): `review_claims`, `staff_notes`, `tier_history`, `notification_log`, `points_ledger`, `loyalty_codes`, `social_actions`, `referrals`, `order_webhook_state`, `members`.
4. Set the `gdpr_requests` row's `status` to `fulfilled`.

`customers/redact` (one customer) is automatic: the member's name, email, phone, birthday and network address are removed and she is opted out; the anonymous points history is kept.

### 6. Scheduled jobs (Pakistan time)

| Job | When | What |
|---|---|---|
| heartbeat | every minute | `system_heartbeat` key `worker`, with failed-job counts |
| pending codes | every 10 minutes | finishes automatic codes left half-made; for a reward code that was never created, returns the points |
| storefront config | hourly at :05 | republishes the storefront settings when a campaign started or ended, and once a day regardless |
| expiry | 02:00 daily | expires overdue Silver points and overdue codes |
| expiry warning | 02:30 daily | emails members whose points expire within 30 days |
| birthday | 09:00 daily | issues birthday codes (once per member per year; a missed day is caught up) |

Each run also writes a `cron:<job>` heartbeat with its result.

### 7. Email and WhatsApp

- Email is sent by the app over SMTP with one branded layout. Events: welcome, points earned, reward code issued, tier upgrade, birthday, referral completed, points expiring, review released.
- WhatsApp is off unless it is enabled in the app's settings **and** both `WHATSAPP_*` variables are set. It sends approved template messages only; create templates named `hg_welcome`, `hg_points_earned`, `hg_reward_code_issued`, `hg_tier_upgrade`, `hg_birthday`, `hg_referral_completed`, `hg_points_expiring`, `hg_review_released` in the WhatsApp Business account first. The WhatsApp sender has not been tested against the live service.

### 8. Development

```
npm install
npm run typecheck   # tsc with noEmit: writes no .js files
npm test            # vitest
npm run dev         # shopify app dev
```
