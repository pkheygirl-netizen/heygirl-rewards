// app/lib/admin-settings.server.ts
// Reading and saving the single app_settings row from the admin, publishing a
// save to the storefront, On-site content validation, notification status and
// the privacy-request log.
import { adb, num, str, type Row } from "./admin-db.server";
import { FormReader, type FieldErrors } from "./admin-validate.server";
import { ONSITE_LIMITS, PANEL_THEMES } from "../components/admin-constants";
import { bustSettingsCache } from "./settings.server";
import { syncStorefrontConfig } from "./storefront-config.server";

/**
 * Columns the admin may write. Deliberately absent: brand colours, the Shopify
 * Email injection switch and the post-purchase nudge (nothing reads them), and
 * whatsapp_api_key (credentials live in the environment, never in the browser).
 */
export const EDITABLE_KEYS = [
  "program_enabled",
  "program_name",
  "tagline",
  "tier_gold_threshold_pkr",
  "tier_diamond_threshold_pkr",
  "tier_reward_gold_free_shipping",
  "tier_reward_diamond_pkr",
  "signup_points",
  "purchase_points_rate",
  "referral_points",
  "referral_friend_free_shipping",
  "review_points",
  "silver_expiry_days",
  "reward_code_expiry_days",
  "redemption_tiers",
  "earn_rules",
  "social_points_youtube",
  "social_points_facebook",
  "social_points_instagram",
  "social_url_youtube",
  "social_url_facebook",
  "social_url_instagram",
  "birthday_reward_silver_pkr",
  "birthday_reward_gold_pkr",
  "birthday_reward_diamond_pkr",
  "whatsapp_enabled",
  "terms_and_conditions",
  "faqs",
  "nudge_account_creation_enabled",
  "nudge_points_spending_enabled",
  "nudge_reward_usage_enabled",
  "nudge_tier_progress_enabled",
  "tier_progress_gold_threshold_pkr",
  "tier_progress_diamond_threshold_pkr",
  "panel_theme",
  "launcher_label",
] as const;

/** Never sent to the browser, whatever a loader does with the row. */
const SECRET_KEYS = ["whatsapp_api_key"] as const;

export async function getSettingsRow(): Promise<Row> {
  const { data, error } = await adb().from("app_settings").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error(`could not read settings: ${error.message}`);
  const row: Row = { ...((data as Row | null) ?? {}) };
  for (const k of SECRET_KEYS) delete row[k];
  return row;
}

export async function updateSettings(patch: Record<string, unknown>): Promise<void> {
  const allowed = new Set<string>(EDITABLE_KEYS);
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.has(k) && v !== undefined) filtered[k] = v;
  }
  if (Object.keys(filtered).length === 0) throw new Error("no editable fields");
  const { error } = await adb().from("app_settings").update(filtered).eq("id", 1);
  if (error) throw new Error(`could not save settings: ${error.message}`);
}

type AdminClient = Parameters<typeof syncStorefrontConfig>[0];

/**
 * Call after every settings, program or campaign save: drops the in-process
 * settings cache and rewrites the storefront config metafield. A failed publish
 * does not undo the save; it comes back as a warning for the banner.
 */
export async function publishSettings(admin: AdminClient): Promise<{ warning?: string }> {
  bustSettingsCache();
  try {
    const res = await syncStorefrontConfig(admin);
    if (res.ok) return {};
    return {
      warning: `Saved, but the storefront copy was not updated (${res.reason ?? "unknown reason"}). Save again to retry.`,
    };
  } catch (e) {
    console.error("[admin] syncStorefrontConfig failed:", e instanceof Error ? e.message : e);
    return { warning: "Saved, but the storefront copy was not updated. Save again to retry." };
  }
}

// ── On-site content ──────────────────────────────────────────────────────────

export type Faq = { q: string; a: string };

export function readFaqs(v: unknown): Faq[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((f) => {
      const o = (f ?? {}) as Row;
      return { q: str(o.q ?? o.question).trim(), a: str(o.a ?? o.answer).trim() };
    })
    .filter((f) => f.q !== "" || f.a !== "");
}

export { ONSITE_LIMITS };

/** Validate the On-site form. Returns the patch for updateSettings, or the errors. */
export function parseOnsiteForm(
  form: { get(name: string): unknown },
): { ok: true; patch: Record<string, unknown> } | { ok: false; errors: FieldErrors } {
  const r = new FormReader(form);
  const patch: Record<string, unknown> = {
    program_name: r.text("program_name", "Program name", { max: ONSITE_LIMITS.programName, required: true }),
    tagline: r.text("tagline", "Tagline", { max: ONSITE_LIMITS.tagline }),
    terms_and_conditions: r.text("terms_and_conditions", "Terms and conditions", { max: ONSITE_LIMITS.terms }),
    nudge_account_creation_enabled: r.bool("nudge_account_creation_enabled"),
    nudge_points_spending_enabled: r.bool("nudge_points_spending_enabled"),
    nudge_reward_usage_enabled: r.bool("nudge_reward_usage_enabled"),
    nudge_tier_progress_enabled: r.bool("nudge_tier_progress_enabled"),
    tier_progress_gold_threshold_pkr: r.int(
      "tier_progress_gold_threshold_pkr", "Gold reminder distance", 0, ONSITE_LIMITS.withinMax),
    tier_progress_diamond_threshold_pkr: r.int(
      "tier_progress_diamond_threshold_pkr", "Diamond reminder distance", 0, ONSITE_LIMITS.withinMax),
    panel_theme: r.oneOf("panel_theme", "Panel style", PANEL_THEMES),
    launcher_label: r.text("launcher_label", "Launcher button text", { max: ONSITE_LIMITS.launcherLabel, required: true }),
  };
  // Plain text only: no markup characters, no line breaks or other control characters.
  if (typeof patch.launcher_label === "string" && /[<>\u0000-\u001f\u007f]/.test(patch.launcher_label)) {
    r.fail("launcher_label", "Launcher button text can only be plain text (no < or > and no line breaks).");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.raw("faqs") || "[]");
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    r.fail("faqs", "The questions could not be read. Reload the page and try again.");
  } else {
    const faqs: Faq[] = [];
    parsed.forEach((item, i) => {
      const o = (item ?? {}) as Row;
      const q = str(o.q).trim();
      const a = str(o.a).trim();
      if (q === "" && a === "") return; // an untouched empty row is dropped
      if (q === "") r.fail(`faq_q_${i}`, `Question ${i + 1} needs a question.`);
      else if (q.length > ONSITE_LIMITS.faqQuestion) {
        r.fail(`faq_q_${i}`, `Question ${i + 1} must be ${ONSITE_LIMITS.faqQuestion} characters or fewer.`);
      }
      if (a === "") r.fail(`faq_a_${i}`, `Question ${i + 1} needs an answer.`);
      else if (a.length > ONSITE_LIMITS.faqAnswer) {
        r.fail(`faq_a_${i}`, `Answer ${i + 1} must be ${ONSITE_LIMITS.faqAnswer} characters or fewer.`);
      }
      faqs.push({ q, a });
    });
    if (faqs.length > ONSITE_LIMITS.faqCount) {
      r.fail("faqs", `No more than ${ONSITE_LIMITS.faqCount} questions.`);
    }
    patch.faqs = faqs;
  }
  return r.ok ? { ok: true, patch } : { ok: false, errors: r.errors };
}

// ── notifications ────────────────────────────────────────────────────────────

export type NotificationStatus = {
  emailConfigured: boolean;
  /** The "from" address is not a secret; shown so staff can confirm it. */
  emailFrom: string;
  whatsappEnabled: boolean;
  /** Only whether credentials exist. The values never leave the server. */
  whatsappCredentialsPresent: boolean;
};

export function notificationStatus(
  settings: Row,
  env: Record<string, string | undefined> = process.env,
): NotificationStatus {
  return {
    emailConfigured: Boolean(env.SMTP_HOST),
    emailFrom: env.SMTP_HOST ? str(env.SMTP_FROM ?? env.SMTP_USER) : "",
    whatsappEnabled: settings.whatsapp_enabled === true,
    whatsappCredentialsPresent: Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID),
  };
}

// ── privacy requests ─────────────────────────────────────────────────────────

export type GdprRequest = {
  id: string;
  type: string;
  typeLabel: string;
  shopifyCustomerId: string | null;
  status: string;
  createdAt: string;
};

const GDPR_LABELS: Record<string, string> = {
  data_request: "Customer asked for a copy of their data",
  customer_redact: "Customer data erasure",
  shop_redact: "Shop data erasure (logged only, nothing deleted)",
};

export async function listGdprRequests(page = 0, pageSize = 25): Promise<{ rows: GdprRequest[]; total: number }> {
  // The payload column can hold personal data, so it is not selected.
  const { data, count, error } = await adb()
    .from("gdpr_requests")
    .select("id, type, shopify_customer_id, status, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);
  if (error) throw new Error(`could not read privacy requests: ${error.message}`);
  const rows = ((data ?? []) as Row[]).map((r) => ({
    id: str(r.id),
    type: str(r.type),
    typeLabel: GDPR_LABELS[str(r.type)] ?? str(r.type),
    shopifyCustomerId: r.shopify_customer_id ? str(r.shopify_customer_id) : null,
    status: str(r.status),
    createdAt: str(r.created_at),
  }));
  return { rows, total: num(count) };
}

export async function setGdprRequestStatus(id: string, status: "open" | "fulfilled"): Promise<void> {
  const { error } = await adb().from("gdpr_requests").update({ status }).eq("id", id);
  if (error) throw new Error(`could not update the request: ${error.message}`);
}
