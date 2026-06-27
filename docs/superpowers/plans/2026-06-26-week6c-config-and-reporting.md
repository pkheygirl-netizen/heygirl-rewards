# Week 6C — Config + Reporting (Analytics · Nudges · Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Analytics, Nudges, and Settings admin tabs, extend `app_settings` with the remaining configurable fields, and wire the points/birthday services to read them.

**Architecture:** Remix routes under `app.*` in the `app.tsx` shell (Plan 6A). Read aggregations in `app/lib/admin-analytics.server.ts`; settings read/write in `app/lib/admin-settings.server.ts`. Migration `006_week6_admin.sql` adds the missing `app_settings` columns; `birthday.service` and `points.service` are updated to read them.

**Tech Stack:** Remix 2, Shopify Polaris 13, `@shopify/polaris-viz`, Supabase (`db` from `app/db.server.ts`), Vitest.

**Depends on:** Plan 6A (shell, `admin-data.server.getTierBreakdown`) and Plan 6B (`csv.server`, `admin-influencers.getInfluencers`). Build 6A and 6B first.

## Global Constraints

- Every admin route loader/action MUST call `await authenticate.admin(request)` first.
- All data access via `db` from `../db.server`. Never instantiate a new client.
- `app_settings` is a single row with `id = 1`. All reads use `.eq("id", 1).maybeSingle()`; all writes use `.update(patch).eq("id", 1)`.
- New `app_settings` columns are added with `ADD COLUMN IF NOT EXISTS` and sensible `DEFAULT`s (idempotent migration — matches existing migration style).
- Because `app/database.types.ts` will not be regenerated as part of each task, service/settings reads of NEW columns select `"*"` and read fields off a `Record<string, unknown>` cast, with a numeric/string fallback. Do not add typed `.select("new_col")` calls that would fail `tsc` against stale types. (Task 11 optionally regenerates types.)
- No fake/seed data; sparse data → Polaris empty states.
- Vitest tests; `vi.mock` any module that transitively imports `queue.server`.
- Only create/modify `.ts`/`.tsx`.

---

## File Structure

- `supabase/migrations/006_week6_admin.sql` — NEW. Adds missing `app_settings` columns.
- `app/lib/admin-settings.server.ts` — NEW. `getSettings()`, `updateSettings(patch)`.
- `app/lib/admin-settings.server.test.ts` — NEW.
- `app/lib/admin-analytics.server.ts` — NEW. Range aggregations + funnel + top lists.
- `app/lib/admin-analytics.server.test.ts` — NEW.
- `app/lib/birthday.service.ts` — MODIFY. Read reward amounts from settings.
- `app/lib/points.service.ts` — MODIFY. Read per-platform social points from settings.
- `app/routes/app.settings.tsx` — NEW.
- `app/routes/app.nudges.tsx` — NEW.
- `app/routes/app.analytics.tsx` — NEW.
- `app/routes/app.analytics.export[.]csv.tsx` — NEW (resource route).

---

## Task 1: Migration — extend `app_settings`

**Files:**
- Create: `supabase/migrations/006_week6_admin.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/006_week6_admin.sql
-- Week 6 admin dashboard: remaining configurable settings fields.

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS birthday_reward_silver_pkr   INTEGER NOT NULL DEFAULT 250,
  ADD COLUMN IF NOT EXISTS birthday_reward_gold_pkr     INTEGER NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS birthday_reward_diamond_pkr  INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_youtube        INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_facebook       INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS social_points_instagram      INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS bonus_campaign_default_multiplier NUMERIC(3,1) NOT NULL DEFAULT 2.0,
  ADD COLUMN IF NOT EXISTS influencer_cta_link          TEXT,
  ADD COLUMN IF NOT EXISTS shopify_email_injection_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS terms_and_conditions         TEXT,
  ADD COLUMN IF NOT EXISTS faqs                         JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS nudges_config                JSONB NOT NULL DEFAULT '{}'::jsonb;
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool with name `week6_admin` and the SQL above, OR run it against the project. Then verify the columns exist:

Run (verification query via MCP `execute_sql` or psql):
```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'app_settings' AND column_name IN
('birthday_reward_silver_pkr','social_points_youtube','faqs','nudges_config','influencer_cta_link');
```
Expected: 5 rows returned.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/006_week6_admin.sql
git commit -m "feat(db): week6 app_settings columns for birthday/social/content/nudges config"
```

---

## Task 2: Settings read/write module

**Files:**
- Create: `app/lib/admin-settings.server.ts`
- Test: `app/lib/admin-settings.server.test.ts`

**Interfaces:**
- Produces:
  - `getSettings(): Promise<Record<string, unknown>>` — returns the full `app_settings` row (`select("*").eq("id",1).maybeSingle()`), or `{}` if missing.
  - `updateSettings(patch: Record<string, unknown>): Promise<void>` — whitelists keys against `EDITABLE_KEYS` (throws `Error("no editable fields")` if patch is empty after filtering), then `.update(filtered).eq("id", 1)`.
  - Exported `EDITABLE_KEYS: string[]`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/admin-settings.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("updateSettings", () => {
  it("drops non-whitelisted keys and writes the rest", async () => {
    const eq = vi.fn(() => Promise.resolve({ error: null }));
    const update = vi.fn(() => ({ eq }));
    vi.doMock("../db.server", () => ({ db: { from: vi.fn(() => ({ update })) } }));
    vi.resetModules();
    const { updateSettings } = await import("./admin-settings.server");
    await updateSettings({ program_name: "New Name", hacker_field: "x" } as any);
    expect(update).toHaveBeenCalledWith({ program_name: "New Name" });
    expect(eq).toHaveBeenCalledWith("id", 1);
  });

  it("throws when nothing editable remains", async () => {
    vi.doMock("../db.server", () => ({ db: {} }));
    vi.resetModules();
    const { updateSettings } = await import("./admin-settings.server");
    await expect(updateSettings({ hacker_field: "x" } as any)).rejects.toThrow("no editable fields");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
npx vitest run app/lib/admin-settings.server.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/lib/admin-settings.server.ts
import { db } from "../db.server";

export const EDITABLE_KEYS = [
  "program_name",
  "brand_color_primary",
  "brand_color_secondary",
  "tagline",
  "tier_gold_threshold_pkr",
  "tier_diamond_threshold_pkr",
  "signup_points",
  "purchase_points_rate",
  "referral_points",
  "review_points",
  "silver_expiry_days",
  "redemption_tiers",
  "social_points_youtube",
  "social_points_facebook",
  "social_points_instagram",
  "birthday_reward_silver_pkr",
  "birthday_reward_gold_pkr",
  "birthday_reward_diamond_pkr",
  "bonus_campaign_default_multiplier",
  "influencer_cta_link",
  "whatsapp_enabled",
  "whatsapp_provider",
  "whatsapp_api_key",
  "wa_referral_template",
  "shopify_email_injection_enabled",
  "terms_and_conditions",
  "faqs",
  "nudges_config",
] as const;

export async function getSettings(): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("app_settings")
    .select("*")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown>) ?? {};
}

export async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const allowed = new Set<string>(EDITABLE_KEYS as readonly string[]);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k)) filtered[k] = v;
  }
  if (Object.keys(filtered).length === 0) throw new Error("no editable fields");
  const { error } = await db.from("app_settings").update(filtered).eq("id", 1);
  if (error) throw error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
npx vitest run app/lib/admin-settings.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-settings.server.ts app/lib/admin-settings.server.test.ts
git commit -m "feat(admin): settings read/write module with key whitelist"
```

---

## Task 3: Wire birthday.service to settings amounts

**Files:**
- Modify: `app/lib/birthday.service.ts:24-29` (the hardcoded `rewardAmountForTier`-style function returning 250/500/1000)

**Interfaces:**
- Consumes: `db` from `../db.server` (already imported).
- The reward-amount function becomes async and reads `birthday_reward_{tier}_pkr` from `app_settings`, falling back to the current defaults.

- [ ] **Step 1: Read the current function**

Run:
```bash
sed -n '20,35p' app/lib/birthday.service.ts
```
Identify the function returning `1000`/`500`/`250` for diamond/gold/silver (named e.g. `rewardForTier`). Note its name and all call sites:
```bash
grep -n "rewardForTier\|return 1000\|return 500\|return 250" app/lib/birthday.service.ts
```

- [ ] **Step 2: Replace with a settings-backed async version**

Replace the synchronous function body with:

```ts
// near top of birthday.service.ts, after imports
async function birthdaySettings(): Promise<Record<string, unknown>> {
  const { data } = await db.from("app_settings").select("*").eq("id", 1).maybeSingle();
  return (data as Record<string, unknown>) ?? {};
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

// replace the old synchronous rewardForTier(tier) with:
async function rewardForTier(tier: "silver" | "gold" | "diamond"): Promise<number> {
  const s = await birthdaySettings();
  if (tier === "diamond") return num(s.birthday_reward_diamond_pkr, 1000);
  if (tier === "gold") return num(s.birthday_reward_gold_pkr, 500);
  return num(s.birthday_reward_silver_pkr, 250);
}
```

Then update each call site to `await rewardForTier(...)`. Search and fix:
```bash
grep -n "rewardForTier(" app/lib/birthday.service.ts
```
Add `await` and ensure the calling function is `async` (it already is for the award flow).

- [ ] **Step 3: Run birthday tests**

Run:
```bash
npx vitest run app/lib/birthday.service.test.ts
```
Expected: PASS. If a test asserted the old sync return value directly, update it to mock `app_settings` returning the default and `await` the call.

- [ ] **Step 4: Commit**

```bash
git add app/lib/birthday.service.ts app/lib/birthday.service.test.ts
git commit -m "feat(admin): birthday reward amounts read from app_settings"
```

---

## Task 4: Wire points.service social award to per-platform settings

**Files:**
- Modify: `app/lib/points.service.ts` (`awardSocial`, and `settingValue` helper around line 200)

**Interfaces:**
- `awardSocial` reads the per-platform value `social_points_{platform}` from settings, falling back to the existing `social_points`, then `1000`.

- [ ] **Step 1: Add a per-platform reader**

After the existing `settingValue` function, add:

```ts
async function socialPointsForPlatform(
  platform: "youtube" | "facebook" | "instagram",
): Promise<number> {
  const { data } = await db.from("app_settings").select("*").eq("id", 1).maybeSingle();
  const s = (data as Record<string, unknown> | null) ?? {};
  const perPlatform = s[`social_points_${platform}`];
  if (typeof perPlatform === "number") return perPlatform;
  if (typeof s.social_points === "number") return s.social_points;
  return 1000;
}
```

- [ ] **Step 2: Use it in `awardSocial`**

Replace, inside `awardSocial`:
```ts
  const points = await settingValue("social_points", 1000);
```
with:
```ts
  const platform = row.action_type as "youtube" | "facebook" | "instagram";
  const points = await socialPointsForPlatform(platform);
```
(Keep the existing `mapSocialActionType(row.action_type ...)` line.)

- [ ] **Step 3: Run points tests**

Run:
```bash
npx vitest run app/lib/points.service.test.ts
```
Expected: PASS. If a social test mocked `app_settings` for `social_points` only, the fallback path keeps it green; if it asserted the exact select shape, update the mock to return `{ social_points: 1000 }` from a `select("*")`.

- [ ] **Step 4: Commit**

```bash
git add app/lib/points.service.ts app/lib/points.service.test.ts
git commit -m "feat(admin): social points read per-platform from app_settings"
```

---

## Task 5: Settings tab route

**Files:**
- Create: `app/routes/app.settings.tsx`

**Interfaces:**
- Consumes: `getSettings`, `updateSettings` from `../lib/admin-settings.server`.

- [ ] **Step 1: Write the route**

```tsx
// app/routes/app.settings.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page, Card, FormLayout, TextField, Checkbox, Button, Banner, BlockStack, Box, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSettings, updateSettings } from "../lib/admin-settings.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ settings: await getSettings() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const patch: Record<string, unknown> = {
    program_name: String(form.get("program_name") ?? ""),
    tagline: String(form.get("tagline") ?? ""),
    brand_color_primary: String(form.get("brand_color_primary") ?? ""),
    brand_color_secondary: String(form.get("brand_color_secondary") ?? ""),
    tier_gold_threshold_pkr: Number(form.get("tier_gold_threshold_pkr")),
    tier_diamond_threshold_pkr: Number(form.get("tier_diamond_threshold_pkr")),
    signup_points: Number(form.get("signup_points")),
    referral_points: Number(form.get("referral_points")),
    review_points: Number(form.get("review_points")),
    social_points_youtube: Number(form.get("social_points_youtube")),
    social_points_facebook: Number(form.get("social_points_facebook")),
    social_points_instagram: Number(form.get("social_points_instagram")),
    birthday_reward_silver_pkr: Number(form.get("birthday_reward_silver_pkr")),
    birthday_reward_gold_pkr: Number(form.get("birthday_reward_gold_pkr")),
    birthday_reward_diamond_pkr: Number(form.get("birthday_reward_diamond_pkr")),
    silver_expiry_days: Number(form.get("silver_expiry_days")),
    bonus_campaign_default_multiplier: Number(form.get("bonus_campaign_default_multiplier")),
    influencer_cta_link: String(form.get("influencer_cta_link") ?? ""),
    whatsapp_enabled: form.get("whatsapp_enabled") === "on",
    whatsapp_provider: String(form.get("whatsapp_provider") ?? ""),
    whatsapp_api_key: String(form.get("whatsapp_api_key") ?? ""),
    wa_referral_template: String(form.get("wa_referral_template") ?? ""),
    shopify_email_injection_enabled: form.get("shopify_email_injection_enabled") === "on",
    terms_and_conditions: String(form.get("terms_and_conditions") ?? ""),
  };
  try {
    await updateSettings(patch);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

function s(v: unknown, fallback = ""): string {
  return v === null || v === undefined ? fallback : String(v);
}

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const saving = nav.state === "submitting";

  return (
    <Page title="Settings">
      <Form method="post">
        <BlockStack gap="400">
          {actionData?.ok ? <Banner tone="success">Settings saved.</Banner> : null}
          {actionData && !actionData.ok ? <Banner tone="critical">{actionData.error}</Banner> : null}

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Branding</Text>
                <FormLayout>
                  <TextField label="Program name" name="program_name" autoComplete="off" value={undefined} defaultValue={s(settings.program_name)} />
                  <TextField label="Tagline" name="tagline" autoComplete="off" defaultValue={s(settings.tagline)} />
                  <FormLayout.Group>
                    <TextField label="Primary colour" name="brand_color_primary" autoComplete="off" defaultValue={s(settings.brand_color_primary)} />
                    <TextField label="Secondary colour" name="brand_color_secondary" autoComplete="off" defaultValue={s(settings.brand_color_secondary)} />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Points & tiers</Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label="Gold threshold (Rs.)" name="tier_gold_threshold_pkr" type="number" autoComplete="off" defaultValue={s(settings.tier_gold_threshold_pkr)} />
                    <TextField label="Diamond threshold (Rs.)" name="tier_diamond_threshold_pkr" type="number" autoComplete="off" defaultValue={s(settings.tier_diamond_threshold_pkr)} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="Signup points" name="signup_points" type="number" autoComplete="off" defaultValue={s(settings.signup_points)} />
                    <TextField label="Referral points" name="referral_points" type="number" autoComplete="off" defaultValue={s(settings.referral_points)} />
                    <TextField label="Review points" name="review_points" type="number" autoComplete="off" defaultValue={s(settings.review_points)} />
                  </FormLayout.Group>
                  <FormLayout.Group>
                    <TextField label="YouTube points" name="social_points_youtube" type="number" autoComplete="off" defaultValue={s(settings.social_points_youtube, "1000")} />
                    <TextField label="Facebook points" name="social_points_facebook" type="number" autoComplete="off" defaultValue={s(settings.social_points_facebook, "1000")} />
                    <TextField label="Instagram points" name="social_points_instagram" type="number" autoComplete="off" defaultValue={s(settings.social_points_instagram, "1000")} />
                  </FormLayout.Group>
                  <TextField label="Silver points expiry (days)" name="silver_expiry_days" type="number" autoComplete="off" defaultValue={s(settings.silver_expiry_days, "365")} />
                  <TextField label="Campaign default multiplier" name="bonus_campaign_default_multiplier" type="number" autoComplete="off" defaultValue={s(settings.bonus_campaign_default_multiplier, "2")} />
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Birthday rewards (Rs.)</Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label="Silver" name="birthday_reward_silver_pkr" type="number" autoComplete="off" defaultValue={s(settings.birthday_reward_silver_pkr, "250")} />
                    <TextField label="Gold" name="birthday_reward_gold_pkr" type="number" autoComplete="off" defaultValue={s(settings.birthday_reward_gold_pkr, "500")} />
                    <TextField label="Diamond" name="birthday_reward_diamond_pkr" type="number" autoComplete="off" defaultValue={s(settings.birthday_reward_diamond_pkr, "1000")} />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Integrations & content</Text>
                <FormLayout>
                  <TextField label="Influencer CTA link" name="influencer_cta_link" autoComplete="off" defaultValue={s(settings.influencer_cta_link)} />
                  <Checkbox label="Enable WhatsApp notifications" name="whatsapp_enabled" checked={undefined} defaultChecked={Boolean(settings.whatsapp_enabled)} />
                  <FormLayout.Group>
                    <TextField label="WhatsApp provider" name="whatsapp_provider" autoComplete="off" defaultValue={s(settings.whatsapp_provider)} />
                    <TextField label="WhatsApp API key" name="whatsapp_api_key" autoComplete="off" defaultValue={s(settings.whatsapp_api_key)} />
                  </FormLayout.Group>
                  <TextField label="WhatsApp referral template" name="wa_referral_template" multiline={3} autoComplete="off" defaultValue={s(settings.wa_referral_template)} />
                  <Checkbox label="Inject loyalty content into Shopify Email" name="shopify_email_injection_enabled" defaultChecked={Boolean(settings.shopify_email_injection_enabled)} />
                  <TextField label="Terms & Conditions" name="terms_and_conditions" multiline={5} autoComplete="off" defaultValue={s(settings.terms_and_conditions)} />
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Button submit variant="primary" loading={saving}>Save settings</Button>
        </BlockStack>
      </Form>
    </Page>
  );
}
```

> NOTE: `redemption_tiers`, `faqs`, and `nudges_config` are JSON structures edited on dedicated surfaces (redemption table inline editor can be added later; FAQs are editable here only if you add a repeatable field set). For this task, those three are left to their existing values — `updateSettings` only writes the keys present in `patch`, so omitting them preserves them. Polaris `TextField` is uncontrolled here via `defaultValue` (note `value={undefined}`); this is intentional for a plain `<Form method="post">` submit.

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.settings.tsx`.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.settings.tsx
git commit -m "feat(admin): Settings tab editing branding, points, tiers, birthday, integrations, content"
```

---

## Task 6: Nudges tab route

**Files:**
- Create: `app/routes/app.nudges.tsx`

**Interfaces:**
- Consumes: `getSettings`, `updateSettings` from `../lib/admin-settings.server`.
- Reads the 5 boolean toggles already in `app_settings` (`nudge_account_creation_enabled`, `nudge_points_spending_enabled`, `nudge_reward_usage_enabled`, `nudge_post_purchase_enabled`, `nudge_tier_progress_enabled`) plus the `nudges_config` JSONB for per-nudge customisation, and the tier-progress thresholds.

> The five `nudge_*_enabled` booleans and `tier_progress_*_threshold_pkr` already exist (migration 001). Add them to `EDITABLE_KEYS` in `admin-settings.server.ts` if not present, so the action can persist them.

- [ ] **Step 1: Extend `EDITABLE_KEYS`**

In `app/lib/admin-settings.server.ts`, add to `EDITABLE_KEYS`:
```ts
  "nudge_account_creation_enabled",
  "nudge_points_spending_enabled",
  "nudge_reward_usage_enabled",
  "nudge_post_purchase_enabled",
  "nudge_tier_progress_enabled",
  "tier_progress_gold_threshold_pkr",
  "tier_progress_diamond_threshold_pkr",
```

- [ ] **Step 2: Write the route**

```tsx
// app/routes/app.nudges.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, Form, useNavigation } from "@remix-run/react";
import {
  Page, Card, BlockStack, Box, Text, Checkbox, TextField, Button, Banner, FormLayout,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getSettings, updateSettings } from "../lib/admin-settings.server";

const NUDGES = [
  { key: "nudge_account_creation_enabled", label: "Account creation" },
  { key: "nudge_points_spending_enabled", label: "Points spending" },
  { key: "nudge_reward_usage_enabled", label: "Reward usage" },
  { key: "nudge_post_purchase_enabled", label: "Post-purchase (email only on Basic)" },
  { key: "nudge_tier_progress_enabled", label: "Tier progress" },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({ settings: await getSettings() });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  const masterOff = form.get("master_disable") === "on";
  const patch: Record<string, unknown> = {
    tier_progress_gold_threshold_pkr: Number(form.get("tier_progress_gold_threshold_pkr")),
    tier_progress_diamond_threshold_pkr: Number(form.get("tier_progress_diamond_threshold_pkr")),
  };
  for (const n of NUDGES) {
    patch[n.key] = masterOff ? false : form.get(n.key) === "on";
  }
  try {
    await updateSettings(patch);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: (e as Error).message }, { status: 400 });
  }
};

export default function Nudges() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();

  return (
    <Page title="Nudges">
      <Form method="post">
        <BlockStack gap="400">
          {actionData?.ok ? <Banner tone="success">Nudges saved.</Banner> : null}
          {actionData && !actionData.ok ? <Banner tone="critical">{actionData.error}</Banner> : null}

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Checkbox label="Disable all nudges (master switch)" name="master_disable" />
                <Text as="p" tone="subdued">When enabled, all nudges below are turned off on save.</Text>
                {NUDGES.map((n) => (
                  <Checkbox
                    key={n.key}
                    label={n.label}
                    name={n.key}
                    defaultChecked={Boolean(settings[n.key])}
                  />
                ))}
              </BlockStack>
            </Box>
          </Card>

          <Card>
            <Box padding="400">
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Tier progress thresholds (Rs.)</Text>
                <FormLayout>
                  <FormLayout.Group>
                    <TextField label="Within Rs. of Gold" name="tier_progress_gold_threshold_pkr" type="number" autoComplete="off" defaultValue={String(settings.tier_progress_gold_threshold_pkr ?? 5000)} />
                    <TextField label="Within Rs. of Diamond" name="tier_progress_diamond_threshold_pkr" type="number" autoComplete="off" defaultValue={String(settings.tier_progress_diamond_threshold_pkr ?? 10000)} />
                  </FormLayout.Group>
                </FormLayout>
              </BlockStack>
            </Box>
          </Card>

          <Button submit variant="primary" loading={nav.state === "submitting"}>Save nudges</Button>
        </BlockStack>
      </Form>
    </Page>
  );
}
```

> NOTE: Per-nudge customisation (icon/title/description/button text/frequency stored in `nudges_config` JSONB) and the live brand-colour preview are deferred to a follow-up within this task only if the reviewer wants them now; the toggles + thresholds + master switch satisfy the core Nudges spec and the storefront already consumes the boolean toggles.

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `app/routes/app.nudges.tsx`.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.nudges.tsx app/lib/admin-settings.server.ts
git commit -m "feat(admin): Nudges tab with master/per-nudge toggles and tier thresholds"
```

---

## Task 7: Analytics aggregations — pure helpers

**Files:**
- Create: `app/lib/admin-analytics.server.ts`
- Test: `app/lib/admin-analytics.server.test.ts`

**Interfaces:**
- Produces (pure, unit-tested here):
  - `bucketFlowByDay(rows: Array<{ points: number; action_type: string; earned_at: string }>): Array<{ date: string; issued: number; redeemed: number; expired: number }>` — issued = sum of positive non-redemption/non-expiry points; redeemed = abs sum where `action_type='redemption'`; expired = abs sum where `action_type='expiry'`; sorted by date.
  - `parseRange(searchParams: URLSearchParams): { from: Date; to: Date }` — supports `range=7d|30d|90d` (default 30d) or explicit `from`/`to` ISO dates.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/admin-analytics.server.test.ts
import { describe, it, expect } from "vitest";
import { bucketFlowByDay, parseRange } from "./admin-analytics.server";

describe("bucketFlowByDay", () => {
  it("splits issued/redeemed/expired per day", () => {
    const out = bucketFlowByDay([
      { points: 1000, action_type: "purchase", earned_at: "2026-06-01T00:00:00Z" },
      { points: -250, action_type: "redemption", earned_at: "2026-06-01T01:00:00Z" },
      { points: -100, action_type: "expiry", earned_at: "2026-06-01T02:00:00Z" },
      { points: 500, action_type: "signup", earned_at: "2026-06-02T00:00:00Z" },
    ]);
    expect(out).toEqual([
      { date: "2026-06-01", issued: 1000, redeemed: 250, expired: 100 },
      { date: "2026-06-02", issued: 500, redeemed: 0, expired: 0 },
    ]);
  });
});

describe("parseRange", () => {
  it("defaults to 30 days", () => {
    const { from, to } = parseRange(new URLSearchParams());
    const days = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(days).toBe(30);
  });
  it("honours range=7d", () => {
    const { from, to } = parseRange(new URLSearchParams("range=7d"));
    const days = Math.round((to.getTime() - from.getTime()) / 86400000);
    expect(days).toBe(7);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
npx vitest run app/lib/admin-analytics.server.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement pure helpers**

```ts
// app/lib/admin-analytics.server.ts
import { db } from "../db.server";

export function bucketFlowByDay(
  rows: Array<{ points: number; action_type: string; earned_at: string }>,
): Array<{ date: string; issued: number; redeemed: number; expired: number }> {
  const map = new Map<string, { issued: number; redeemed: number; expired: number }>();
  for (const r of rows) {
    const day = new Date(r.earned_at).toISOString().slice(0, 10);
    const cur = map.get(day) ?? { issued: 0, redeemed: 0, expired: 0 };
    if (r.action_type === "redemption") cur.redeemed += Math.abs(r.points);
    else if (r.action_type === "expiry") cur.expired += Math.abs(r.points);
    else if (r.points > 0) cur.issued += r.points;
    map.set(day, cur);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

export function parseRange(sp: URLSearchParams): { from: Date; to: Date } {
  const to = new Date();
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  if (fromParam && toParam) {
    return { from: new Date(fromParam), to: new Date(toParam) };
  }
  const range = sp.get("range") ?? "30d";
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  return { from: new Date(to.getTime() - days * 86400000), to };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run app/lib/admin-analytics.server.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/admin-analytics.server.ts app/lib/admin-analytics.server.test.ts
git commit -m "feat(admin): analytics pure helpers (flow bucketing, range parsing)"
```

---

## Task 8: Analytics queries — flow, top lists, funnel

**Files:**
- Modify: `app/lib/admin-analytics.server.ts`

**Interfaces:**
- Produces:
  - `getPointsFlowSeries(from: Date, to: Date)` → `ReturnType<bucketFlowByDay>` for ledger rows in range.
  - `getTopEarners(limit?: number)` / `getTopRedeemers(limit?: number)` → `Array<{ name: string; email: string; points: number }>` (earners = sum positive points; redeemers = abs sum of `redemption` rows), default limit 10.
  - `getPopularRedemptionTier()` → `{ pkr: number; count: number } | null` (most frequent `discount_amount_pkr` in `loyalty_codes`).
  - `getReferralFunnel()` → `{ clicks: number; withOrder: number; completed: number }` (clicks = all referral rows; withOrder = rows with non-null `shopify_order_id`; completed = status `completed`).

- [ ] **Step 1: Implement query functions**

```ts
// append to app/lib/admin-analytics.server.ts
export async function getPointsFlowSeries(from: Date, to: Date) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, action_type, earned_at")
    .gte("earned_at", from.toISOString())
    .lte("earned_at", to.toISOString());
  if (error) throw error;
  return bucketFlowByDay((data ?? []) as any);
}

export async function getTopEarners(limit = 10) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, members(first_name,last_name,email)")
    .gt("points", 0);
  if (error) throw error;
  return aggregateByMember(data ?? [], (r) => r.points as number, limit);
}

export async function getTopRedeemers(limit = 10) {
  const { data, error } = await db
    .from("points_ledger")
    .select("points, members(first_name,last_name,email)")
    .eq("action_type", "redemption");
  if (error) throw error;
  return aggregateByMember(data ?? [], (r) => Math.abs(r.points as number), limit);
}

function aggregateByMember(
  rows: any[],
  value: (r: any) => number,
  limit: number,
): Array<{ name: string; email: string; points: number }> {
  const map = new Map<string, { name: string; email: string; points: number }>();
  for (const r of rows) {
    const m = r.members;
    if (!m) continue;
    const email = m.email ?? "—";
    const cur =
      map.get(email) ?? {
        name: [m.first_name, m.last_name].filter(Boolean).join(" ") || email,
        email,
        points: 0,
      };
    cur.points += value(r);
    map.set(email, cur);
  }
  return [...map.values()].sort((a, b) => b.points - a.points).slice(0, limit);
}

export async function getPopularRedemptionTier(): Promise<{ pkr: number; count: number } | null> {
  const { data, error } = await db.from("loyalty_codes").select("discount_amount_pkr");
  if (error) throw error;
  const counts = new Map<number, number>();
  for (const r of data ?? []) {
    const pkr = (r.discount_amount_pkr as number) ?? 0;
    counts.set(pkr, (counts.get(pkr) ?? 0) + 1);
  }
  let best: { pkr: number; count: number } | null = null;
  for (const [pkr, count] of counts) {
    if (!best || count > best.count) best = { pkr, count };
  }
  return best;
}

export async function getReferralFunnel(): Promise<{
  clicks: number;
  withOrder: number;
  completed: number;
}> {
  const [clicks, withOrder, completed] = await Promise.all([
    db.from("referrals").select("*", { count: "exact", head: true }),
    db.from("referrals").select("*", { count: "exact", head: true }).not("shopify_order_id", "is", null),
    db.from("referrals").select("*", { count: "exact", head: true }).eq("status", "completed"),
  ]);
  return {
    clicks: clicks.count ?? 0,
    withOrder: withOrder.count ?? 0,
    completed: completed.count ?? 0,
  };
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
```
Expected: no errors referencing `admin-analytics.server.ts`.

- [ ] **Step 3: Commit**

```bash
git add app/lib/admin-analytics.server.ts
git commit -m "feat(admin): analytics queries for flow, top earners/redeemers, funnel, popular tier"
```

---

## Task 9: Analytics tab route

**Files:**
- Create: `app/routes/app.analytics.tsx`

**Interfaces:**
- Consumes: `parseRange`, `getPointsFlowSeries`, `getTopEarners`, `getTopRedeemers`, `getPopularRedemptionTier`, `getReferralFunnel` from `../lib/admin-analytics.server`; `getTierBreakdown` from `../lib/admin-data.server`; `getInfluencers` from `../lib/admin-influencers.server`.

- [ ] **Step 1: Write the route**

```tsx
// app/routes/app.analytics.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, Form } from "@remix-run/react";
import {
  Page, Card, Select, BlockStack, Box, Text, InlineGrid, IndexTable, EmptyState,
} from "@shopify/polaris";
import { StackedAreaChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import {
  parseRange, getPointsFlowSeries, getTopEarners, getTopRedeemers,
  getPopularRedemptionTier, getReferralFunnel,
} from "../lib/admin-analytics.server";
import { getTierBreakdown } from "../lib/admin-data.server";
import { getInfluencers } from "../lib/admin-influencers.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const { from, to } = parseRange(url.searchParams);
  const [flow, earners, redeemers, popular, funnel, tiers, influencers] = await Promise.all([
    getPointsFlowSeries(from, to),
    getTopEarners(10),
    getTopRedeemers(10),
    getPopularRedemptionTier(),
    getReferralFunnel(),
    getTierBreakdown(),
    getInfluencers(),
  ]);
  return json({
    flow, earners, redeemers, popular, funnel, tiers, influencers,
    range: url.searchParams.get("range") ?? "30d",
  });
};

export default function Analytics() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  return (
    <Page
      title="Analytics"
      primaryAction={{ content: "Export CSV", url: `/app/analytics/export.csv?range=${data.range}` }}
    >
      <BlockStack gap="400">
        <Card>
          <Box padding="400">
            <Form method="get">
              <Select
                label="Range" labelHidden name="range" value={data.range}
                options={[
                  { label: "Last 7 days", value: "7d" },
                  { label: "Last 30 days", value: "30d" },
                  { label: "Last 90 days", value: "90d" },
                ]}
                onChange={(v) => {
                  const next = new URLSearchParams(params);
                  next.set("range", v);
                  setParams(next);
                }}
              />
            </Form>
          </Box>
        </Card>

        <Card>
          <Box padding="400">
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Points issued / redeemed / expired</Text>
              {data.flow.length === 0 ? (
                <Text as="p" tone="subdued">No ledger activity in this range.</Text>
              ) : (
                <StackedAreaChart
                  data={[
                    { name: "Issued", data: data.flow.map((d) => ({ key: d.date, value: d.issued })) },
                    { name: "Redeemed", data: data.flow.map((d) => ({ key: d.date, value: d.redeemed })) },
                    { name: "Expired", data: data.flow.map((d) => ({ key: d.date, value: d.expired })) },
                  ]}
                />
              )}
            </BlockStack>
          </Box>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Top earners</Text>
                {data.earners.length === 0 ? <Text as="p" tone="subdued">No data.</Text> :
                  data.earners.map((e) => (
                    <Text as="p" key={e.email}>{e.name} — {e.points.toLocaleString()} pts</Text>
                  ))}
              </BlockStack>
            </Box>
          </Card>
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Top redeemers</Text>
                {data.redeemers.length === 0 ? <Text as="p" tone="subdued">No data.</Text> :
                  data.redeemers.map((e) => (
                    <Text as="p" key={e.email}>{e.name} — {e.points.toLocaleString()} pts</Text>
                  ))}
              </BlockStack>
            </Box>
          </Card>
        </InlineGrid>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Referral funnel</Text>
                <Text as="p">Clicks: {data.funnel.clicks}</Text>
                <Text as="p">With order: {data.funnel.withOrder}</Text>
                <Text as="p">Completed: {data.funnel.completed}</Text>
              </BlockStack>
            </Box>
          </Card>
          <Card>
            <Box padding="400">
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">Most popular redemption</Text>
                {data.popular ? (
                  <Text as="p">Rs.{data.popular.pkr} off — used {data.popular.count} times</Text>
                ) : (
                  <Text as="p" tone="subdued">No redemptions yet.</Text>
                )}
                <Text as="span" tone="subdued">
                  Members: {data.tiers.silver} Silver · {data.tiers.gold} Gold · {data.tiers.diamond} Diamond
                </Text>
              </BlockStack>
            </Box>
          </Card>
        </InlineGrid>

        <Card>
          <Box padding="400">
            <Text as="h2" variant="headingMd">Influencer comparison</Text>
          </Box>
          {data.influencers.length === 0 ? (
            <Box padding="400">
              <EmptyState heading="No influencers tagged" image="">
                <p>Tag members as influencers from the Members tab to compare performance.</p>
              </EmptyState>
            </Box>
          ) : (
            <IndexTable
              resourceName={{ singular: "influencer", plural: "influencers" }}
              itemCount={data.influencers.length}
              selectable={false}
              headings={[
                { title: "Name" }, { title: "Conversions" }, { title: "Conv %" }, { title: "Pts" },
              ]}
            >
              {data.influencers.map((inf, i) => (
                <IndexTable.Row id={inf.id} key={inf.id} position={i}>
                  <IndexTable.Cell>{inf.name}</IndexTable.Cell>
                  <IndexTable.Cell>{inf.conversions}</IndexTable.Cell>
                  <IndexTable.Cell>{(inf.conversionRate * 100).toFixed(0)}%</IndexTable.Cell>
                  <IndexTable.Cell>{inf.pointsEarned.toLocaleString()}</IndexTable.Cell>
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
Expected: no errors. (If `StackedAreaChart` is not exported in the installed Polaris Viz version, substitute `BarChart` with the same data shape — confirm via `node -e "console.log(Object.keys(require('@shopify/polaris-viz')))"`.)

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.analytics.tsx
git commit -m "feat(admin): Analytics tab with flow chart, top lists, funnel, influencer comparison"
```

---

## Task 10: Analytics CSV export + full suite + deploy

**Files:**
- Create: `app/routes/app.analytics.export[.]csv.tsx`

**Interfaces:**
- Consumes: `parseRange`, `getPointsFlowSeries` from `../lib/admin-analytics.server`; `toCsv`, `csvResponse` from `../lib/csv.server`.

- [ ] **Step 1: Write the resource route**

```tsx
// app/routes/app.analytics.export[.]csv.tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { parseRange, getPointsFlowSeries } from "../lib/admin-analytics.server";
import { toCsv, csvResponse } from "../lib/csv.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const { from, to } = parseRange(url.searchParams);
  const flow = await getPointsFlowSeries(from, to);
  const csv = toCsv(flow, [
    { key: "date", header: "Date" },
    { key: "issued", header: "Issued" },
    { key: "redeemed", header: "Redeemed" },
    { key: "expired", header: "Expired" },
  ] as const);
  return csvResponse("analytics-points-flow.csv", csv);
};
```

- [ ] **Step 2: Full type-check + test suite**

Run:
```bash
npx tsc --noEmit -p tsconfig.json && npx vitest run
```
Expected: no type errors; all tests PASS.

- [ ] **Step 3: Production build**

Run:
```bash
npm run build
```
Expected: succeeds.

- [ ] **Step 4: Commit & push**

```bash
git add "app/routes/app.analytics.export[.]csv.tsx"
git commit -m "feat(admin): analytics CSV export route"
git status --porcelain
git add -A && git commit -m "chore(admin): build artifacts for Week 6C config + reporting" || echo "nothing to commit"
git push origin main
```
Expected: push succeeds; Render auto-deploys.

---

## Task 11 (optional): Regenerate database types

**Files:**
- Modify: `app/database.types.ts`

- [ ] **Step 1: Regenerate**

Use the Supabase MCP `generate_typescript_types` tool and write the result to `app/database.types.ts`. This picks up the new `app_settings` columns so future code can use typed `.select("birthday_reward_silver_pkr")` instead of `select("*")` casts.

- [ ] **Step 2: Type-check & commit**

Run:
```bash
npx tsc --noEmit -p tsconfig.json
git add app/database.types.ts
git commit -m "chore(db): regenerate types for week6 app_settings columns"
```

---

## Self-Review Notes

- **Spec coverage (6C scope):** Settings — program name/colours/tagline/tier thresholds/expiry/redemption table(preserved)/social per-action/birthday per tier/campaign default multiplier/influencer CTA/WhatsApp creds+template/Shopify Email toggle/T&C (Tasks 1–5). Nudges — master + 5 toggles + tier thresholds (Task 6). Analytics — points flow stacked chart, top earners/redeemers, popular redemption tier, referral funnel, tier distribution, influencer comparison, range selector, CSV (Tasks 7–10). ✅
- **Service wiring:** birthday amounts (Task 3) and per-platform social points (Task 4) now read from settings, so Settings edits change live behaviour. `redemption_tiers` already wired in `redemption.service`. ✅
- **Migration idempotent** via `ADD COLUMN IF NOT EXISTS` (Task 1), matching existing migration style. ✅
- **Deferred (documented):** per-nudge JSONB customisation (icon/title/description/button/frequency) + live brand-colour preview, and inline redemption-table/FAQ editors — interfaces (`nudges_config`, `faqs`, `redemption_tiers`) and columns exist; these are richer editors to add when the merchant needs them. Core toggles/thresholds and all points-affecting settings are functional now.
- **Reward Room** settings (low-stock threshold) intentionally omitted — Phase 2.
