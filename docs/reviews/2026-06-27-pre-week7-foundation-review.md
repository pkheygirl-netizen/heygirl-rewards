# Pre-Week-7 Foundation Review — HeyGirl.pk Rewards

**Target:** `main` @ `0d52f26`
**Date:** 2026-06-27
**Mode:** Read-only audit (no code changed)
**Reviewers:** Agent 1 (Senior Shopify Eng — Cat 1/3/5), Agent 2 (QA — Cat 2/4), Agent 3 (Security pass — HMAC/CORS/injection/IDOR). Two findings independently re-verified by the synthesizer.

---

## Verdict

**Do NOT ship to production / submit for App Store review until the two Critical items are fixed.** The cryptographic foundations (webhook HMAC, proxy signature math, RPC concurrency, SQLi/secret hygiene) are genuinely solid. But there is **one single-line authorization bug that exposes every customer's data and points to any logged-in attacker**, and **one deployment gap that makes the entire points engine inert in production**. Everything else is High/Medium hardening.

| Category | Confidence | Headline |
|---|---|---|
| 1 — OAuth/Tokens | 85% | Solid; uninstall doesn't purge sessions |
| 2 — Storefront/Perf | 88% | Clean XSS; ScriptTag deprecation + modal a11y |
| 3 — Rate limits/Webhooks | 80% | Referral not awarded on `orders/updated` |
| 4 — GDPR/Security | 90%→**downgraded** | GDPR real, but see Security overrides below |
| 5 — Background jobs/DB | 70% | **Worker process not deployed** |
| **Security (cross-cutting)** | **38%** | **Critical IDOR on all proxy routes** |

---

## CRITICAL — fix before anything else

### C1. Proxy identity is spoofable → cross-customer IDOR on every storefront route
- **Severity:** Critical · **Class:** IDOR / broken auth
- **Location:** `app/lib/proxy-auth.server.ts:29` (callers: `proxy.customer.tsx:13`, `proxy.history.tsx:13`, `proxy.redeem.tsx:26`, `proxy.referral.tsx:13`, `proxy.social.tsx:25`)
- **Issue:** The HMAC verification is correct, but the verified identity is read from `customer_id`. Shopify App Proxy injects the *trusted* logged-in identity as **`logged_in_customer_id`**, and the signature covers **all** query params including any the caller appended. An attacker logged in as customer A (so Shopify signs their request) appends `&customer_id=<victimB>`; the signature validates and the app trusts B. Result: read any customer's dashboard/history/referral data **and redeem any customer's points** / queue social rewards on their behalf.
- **Adjudication note:** Agent 2 (QA) called this "no IDOR" because the id comes from inside the signed envelope. That reasoning is wrong — the signed envelope proves the request transited Shopify, not that `customer_id` is the authenticated user. Agent 3 is correct; verified against Shopify App Proxy behavior.
- **Fix:** Read `params.get("logged_in_customer_id")` after HMAC verification; never trust `customer_id`. Treat empty/absent as guest. One-line change in `extractProxyCustomerId`.

### C2. No worker process deployed → entire points engine never runs in production
- **Severity:** Critical · **Class:** Deployment / availability
- **Location:** `render.yaml:1-13` (only a `web` service); `app/lib/queue.server.ts:21-29` (`startWorkers()` no-ops unless `WORKER=1`); `app/shopify.server.ts:62-64`
- **Issue:** No second Render service, no `WORKER=1`, no `SHOP_DOMAIN` for the worker. Every job enqueued by webhooks (purchase/signup/referral/refund/social points) and all cron jobs (expiry, birthday, expiry warnings) sit in Redis unprocessed.
- **Verify first:** Confirm whether a worker service exists in the Render dashboard outside this repo. If not:
- **Fix:** Add a `type: worker` service in `render.yaml` running the build with `WORKER=1` and `SHOP_DOMAIN` set; confirm repeatable cron jobs register on boot.

---

## HIGH

### H1. Referral never awarded when order completes via `orders/updated`
- **Cat 3** · `webhooks.orders-fulfilled.tsx:55-62` vs `webhooks.orders-updated.tsx:37-48`
- `award_referral` is enqueued only in the fulfilled handler. Orders reaching paid+fulfilled via an `orders/updated` transition award purchase points but never award the referrer.
- **Fix:** Mirror the `award_referral` enqueue in `orders-updated` (service is idempotent, so safe).

### H2. Unused `api.redeem` / `api.referral-visit` routes are a points-fraud surface
- **Cat 4 / Security** · `api.redeem.tsx:7-19,32-68`; `api.referral-visit.tsx:6-60`
- Auth is `HMAC(SHOPIFY_API_SECRET, customerId)` with no nonce/timestamp/body binding — a static per-customer bearer token, replayable forever if leaked. Not called by the widget (which uses the proxy routes). `api.referral-visit` also trusts client-supplied `referredIp`/`referredEmail`/fingerprint, defeating fraud heuristics.
- **Fix:** Delete both routes (preferred — they're unused). If kept, bind HMAC to timestamp + body and derive IP server-side.

### H3. FIFO `points_remaining` / lifetime-spend updates are non-atomic
- **Cat 5** · `points.service.ts:309-330` (refund), `334-371` (expiry), `191-196` (purchase RMW)
- Balance is atomic in the RPC, but tranche decrements and `lifetime_spend_pkr` increments are separate client-side queries. Parallel BullMQ jobs can lose updates → wrong tier/expiry math.
- **Fix:** Move the FIFO decrement + lifetime-spend/tier update into `award_points` (or a dedicated RPC) under the same transaction/locks.

### H4. ScriptTag API delivery (deprecation + App Store rejection risk)
- **Cat 2** · `app/lib/scripttag.server.ts` (whole file)
- Widget is injected via the deprecated ScriptTag API rather than a Theme App Extension app embed. Likely App Store review rejection and future-removal risk. (Already flagged in project memory.)
- **Fix:** Migrate to a Theme App Extension embed block before submission; keep ScriptTag only as transitional fallback.

---

## MEDIUM

| ID | Cat | Location | Issue | Fix |
|---|---|---|---|---|
| M1 | Sec | `proxy-auth.server.ts:11-31` | No replay protection — signed proxy URL valid indefinitely; replay re-triggers `proxy.redeem`/`proxy.social` | Reject when `timestamp` param older than ~60s |
| M2 | 1 | `webhooks.app-uninstalled.tsx:6-12` | Only logs; custom session storage means tokens are NOT auto-purged → stale offline tokens linger until shop/redact | Call `findSessionsByShop` + `deleteSessions`; consider encrypting `access_token` at rest (`supabase-session-storage.server.ts:14`) |
| M3 | 3 | `webhooks.customers-create.tsx:12`, `customers-enable.tsx:12` | `enrolMember` (SELECT + INSERT w/ retries) runs inline before 200 — slow webhook | Enqueue an `enrol_member` job, return 200 immediately |
| M4 | 3 | `scripttag.server.ts:41-67` | ScriptTag/page create bypasses `shopifyGraphqlWithRetry` and ignores `userErrors` → silent skip on throttle | Route through retry wrapper; inspect `userErrors` |
| M5 | 2 | `app/widget/hub.ts:23-97` | Hub modal has no `role="dialog"`/`aria-modal`, no Esc-to-close, no focus trap/restore | Add dialog semantics, Esc handler, focus trap |
| M6 | 2 | static serving (`remix-serve`) | `loyalty-widget.js` unfingerprinted, short default cache → stale widgets or no edge caching | `Cache-Control: immutable` + version/fingerprint on ScriptTag `src` |
| M7 | 4 | `proxy.redeem.tsx:40` | `requestedPoints` not bounds/integer-checked at route (service does validate via tier match) | Validate `Number.isInteger(n) && n>0 && n<=MAX` at route |

---

## LOW

- **L1 (Sec/XSS):** `app/widget/embeds.ts:59` interpolates `code.code` into `innerHTML` raw (every other sink uses `escHtml`). Server-generated today, latent. Also `:65` builds discount URL without `encodeURIComponent`. → wrap with `escHtml` / `encodeURIComponent`.
- **L2 (Cat 5):** `001_initial_schema.sql:157-164` — 3 `CREATE TRIGGER` lack `IF NOT EXISTS`/`DROP ... IF EXISTS`; re-running migration errors. → make idempotent.
- **L3 (Cat 5):** `003_week2_gating.sql:22-24` idempotency index uses `NULLS NOT DISTINCT` (PG15+ hard dependency; silent on older PG). → document/assert PG15.
- **L4 (Cat 3):** `shopify-graphql.server.ts:32-41` backoff is heuristic; doesn't retry top-level throttle errors lacking `extensions.cost`. → compute wait from cost/restoreRate.
- **L5 (Cat 5):** `cron.worker.ts:35-83` loads all rows into memory and enqueues per-row; won't scale. → paginate later.
- **L6 (Cat 2):** Decorative emojis/tier glyphs (◈ ★ ◆) read literally by screen readers. → `aria-hidden="true"`.
- **L7 (Cat 4):** `proxy.history.tsx:19` `type` filter not whitelisted (Supabase `.eq` is safe from SQLi; defense-in-depth only). → whitelist against known `action_type`.

---

## Confirmed clean (verified, not assumed)
- **Webhook HMAC:** all 9 `webhooks.*.tsx` use `authenticate.webhook` (raw-body base64 HMAC, timing-safe).
- **GDPR is real, not stubbed:** `customers/redact`→`redactCustomer` anonymizes PII; `shop/redact`→`redactShop` deletes all rows FK-safe; `customers/data_request` logs-only (acceptable single-merchant).
- **SQL injection:** no raw interpolation; all Supabase access parameter-bound; `award_points` is parameterized plpgsql (advisory lock + `FOR UPDATE` + negative-clamp + unique-violation idempotency), not `SECURITY DEFINER`.
- **Redeem amount validation:** `redemption.service.ts:28-37` requires exact tier match, ≥3000, ≤balance — once identity (C1) is fixed, redeem is well-guarded.
- **Secrets:** service-role key from env only, never logged; no hardcoded secrets.
- **API version** pinned `April25`, matches TOML; real Supabase session storage (no MemorySessionStorage).
- **CORS** locked to `https://heygirl.pk` (no wildcard); OPTIONS preflight handled.
- **Widget XSS:** `escHtml` applied to all untrusted sinks except the one latent L1.

---

## Recommended fix order before Week 7
1. **C1** — `logged_in_customer_id` (one line, Critical).
2. **C2** — deploy worker service (verify Render dashboard first).
3. **H2** — delete unused `api.redeem`/`api.referral-visit`.
4. **H1** — referral enqueue on `orders/updated`.
5. **H3** — atomic FIFO/lifetime-spend in RPC.
6. **M1/M2/M3** — proxy replay window, uninstall session purge, async enrol.
7. **H4** — ScriptTag → Theme App Extension (larger; schedule before App Store submission).
8. Low items as cleanup.
