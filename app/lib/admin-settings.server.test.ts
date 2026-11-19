import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, formOf } from "./admin-test-helpers";

const bustSettingsCache = vi.fn();
const syncStorefrontConfig = vi.fn();

beforeEach(() => {
  vi.resetModules();
  bustSettingsCache.mockReset();
  syncStorefrontConfig.mockReset();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig }));
  const mod = await import("./admin-settings.server");
  return { fake, mod };
}

describe("getSettingsRow", () => {
  it("never returns the WhatsApp API key", async () => {
    const { mod } = await load({ from: () => ({ data: { id: 1, program_name: "HeyGirl", whatsapp_api_key: "sk-secret" } }) });
    const row = await mod.getSettingsRow();
    expect(row.program_name).toBe("HeyGirl");
    expect(row).not.toHaveProperty("whatsapp_api_key");
    expect(JSON.stringify(row)).not.toContain("sk-secret");
  });

  it("returns an empty object when there is no row, and throws on a database error", async () => {
    expect(await (await load({ from: () => ({ data: null }) })).mod.getSettingsRow()).toEqual({});
    await expect((await load({ from: () => ({ error: { message: "down" } }) })).mod.getSettingsRow()).rejects.toThrow("down");
  });
});

describe("updateSettings", () => {
  it("writes only editable columns", async () => {
    const { fake, mod } = await load();
    await mod.updateSettings({ signup_points: 1500, id: 2, whatsapp_api_key: "x", brand_color_primary: "#000", shopify_email_injection_enabled: true, nudge_post_purchase_enabled: true, updated_at: "now" });
    expect(fake.firstArg("app_settings", "update")).toEqual({ signup_points: 1500 });
    expect(fake.tableCalls("app_settings")[0].chain).toContainEqual(["eq", ["id", 1]]);
  });

  it("refuses a patch with nothing editable in it", async () => {
    const { mod } = await load();
    await expect(mod.updateSettings({ whatsapp_api_key: "x" })).rejects.toThrow("no editable fields");
  });

  it("the dead settings are not in the editable list", async () => {
    const { mod } = await load();
    const keys: readonly string[] = mod.EDITABLE_KEYS;
    for (const dead of ["brand_color_primary", "brand_color_secondary", "shopify_email_injection_enabled", "nudge_post_purchase_enabled", "whatsapp_api_key"]) {
      expect(keys).not.toContain(dead);
    }
    // review_release_hours is retired (review claims wait for staff approval): no longer editable.
    expect(keys).not.toContain("review_release_hours");
    for (const live of ["earn_rules", "redemption_tiers", "reward_code_expiry_days", "social_url_instagram"]) {
      expect(keys).toContain(live);
    }
  });
});

describe("publishSettings", () => {
  const admin = { graphql: vi.fn() };

  it("drops the settings cache and rewrites the storefront config", async () => {
    const { mod } = await load();
    syncStorefrontConfig.mockResolvedValueOnce({ ok: true });
    expect(await mod.publishSettings(admin)).toEqual({});
    expect(bustSettingsCache).toHaveBeenCalledTimes(1);
    expect(syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("returns a warning, not an error, when the storefront copy could not be written", async () => {
    const { mod } = await load();
    syncStorefrontConfig.mockResolvedValueOnce({ ok: false, reason: "metafield_write_failed" });
    expect((await mod.publishSettings(admin)).warning).toContain("metafield_write_failed");
    syncStorefrontConfig.mockRejectedValueOnce(new Error("network"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await mod.publishSettings(admin)).warning).toContain("was not updated");
    spy.mockRestore();
    expect(bustSettingsCache).toHaveBeenCalledTimes(2);
  });
});

describe("On-site form", () => {
  const base = {
    program_name: "HeyGirl.pk Rewards", tagline: "Shop. Earn. Glow.", terms_and_conditions: "Terms",
    nudge_account_creation_enabled: "true", nudge_tier_progress_enabled: "true",
    tier_progress_gold_threshold_pkr: "5000", tier_progress_diamond_threshold_pkr: "10000", panel_theme: "light",
    launcher_label: "  Shop & Earn ",
    faqs: JSON.stringify([{ q: "When do I get points?", a: "When your order is delivered and paid." }, { q: " ", a: "" }]),
  };

  it("builds the patch, treating unticked switches as off and dropping empty question rows", async () => {
    const { mod } = await load();
    const res = mod.parseOnsiteForm(formOf(base));
    expect(res).toEqual({
      ok: true,
      patch: {
        program_name: "HeyGirl.pk Rewards", tagline: "Shop. Earn. Glow.", terms_and_conditions: "Terms",
        nudge_account_creation_enabled: true, nudge_points_spending_enabled: false,
        nudge_reward_usage_enabled: false, nudge_tier_progress_enabled: true,
        tier_progress_gold_threshold_pkr: 5000, tier_progress_diamond_threshold_pkr: 10000, panel_theme: "light",
        launcher_label: "Shop & Earn",
        faqs: [{ q: "When do I get points?", a: "When your order is delivered and paid." }],
      },
    });
    if (res.ok) expect(res.patch).not.toHaveProperty("nudge_post_purchase_enabled");
  });

  it("panel style: light or dark only; anything else is refused with a message", async () => {
    const { mod } = await load();
    const dark = mod.parseOnsiteForm(formOf({ ...base, panel_theme: "dark" }));
    expect(dark.ok && dark.patch.panel_theme).toBe("dark");
    for (const bad of ["", "blue", "DARK"]) {
      const r = mod.parseOnsiteForm(formOf({ ...base, panel_theme: bad }));
      expect(!r.ok && r.errors.panel_theme, bad).toBe("Panel style is not a valid choice.");
    }
    expect(mod.EDITABLE_KEYS).toContain("panel_theme");
  });

  it("launcher text: trimmed, 1 to 24 characters, plain text only", async () => {
    const { mod } = await load();
    expect(mod.EDITABLE_KEYS).toContain("launcher_label");
    const ok = mod.parseOnsiteForm(formOf({ ...base, launcher_label: "x".repeat(24) }));
    expect(ok.ok && ok.patch.launcher_label).toBe("x".repeat(24));
    for (const [bad, msg] of [["", "Launcher button text is required."], ["   ", "Launcher button text is required."], ["x".repeat(25), "Launcher button text must be 24 characters or fewer."], ["<b>Earn</b>", "plain text"], ["Shop\u0007Earn", "plain text"]]) {
      const r = mod.parseOnsiteForm(formOf({ ...base, launcher_label: bad }));
      expect(r.ok, bad).toBe(false);
      expect(!r.ok && r.errors.launcher_label, bad).toContain(msg);
    }
  });

  it("rejects a blank program name and blank or negative distances (R3)", async () => {
    const { mod } = await load();
    expect(mod.parseOnsiteForm(formOf({ ...base, program_name: "" })).ok).toBe(false);
    expect(mod.parseOnsiteForm(formOf({ ...base, tier_progress_gold_threshold_pkr: "" })).ok).toBe(false);
    expect(mod.parseOnsiteForm(formOf({ ...base, tier_progress_diamond_threshold_pkr: "-1" })).ok).toBe(false);
    expect(mod.parseOnsiteForm(formOf({ ...base, tagline: "x".repeat(121) })).ok).toBe(false);
  });

  it("rejects a question without an answer, too many questions and unreadable input", async () => {
    const { mod } = await load();
    const half = mod.parseOnsiteForm(formOf({ ...base, faqs: JSON.stringify([{ q: "Why?", a: "" }]) }));
    expect(!half.ok && half.errors.faq_a_0).toBe("Question 1 needs an answer.");
    const many = Array.from({ length: 31 }, (_, i) => ({ q: `Q${i}`, a: "A" }));
    expect(mod.parseOnsiteForm(formOf({ ...base, faqs: JSON.stringify(many) })).ok).toBe(false);
    expect(mod.parseOnsiteForm(formOf({ ...base, faqs: "{" })).ok).toBe(false);
    expect(mod.parseOnsiteForm(formOf({ ...base, faqs: JSON.stringify({ q: "x" }) })).ok).toBe(false);
  });

  it("reads stored questions in either key style", async () => {
    const { mod } = await load();
    expect(mod.readFaqs([{ question: "Q", answer: "A" }, { q: "", a: "" }, null])).toEqual([{ q: "Q", a: "A" }]);
    expect(mod.readFaqs(null)).toEqual([]);
  });
});

describe("notification status", () => {
  it("reports whether email and WhatsApp are set up without exposing any credential", async () => {
    const { mod } = await load();
    const env = { SMTP_HOST: "smtp.x.com", SMTP_USER: "u", SMTP_PASS: "p4ss", SMTP_FROM: "rewards@heygirl.pk", WHATSAPP_TOKEN: "tok-123", WHATSAPP_PHONE_NUMBER_ID: "999" };
    const s = mod.notificationStatus({ whatsapp_enabled: true }, env);
    expect(s).toEqual({ emailConfigured: true, emailFrom: "rewards@heygirl.pk", whatsappEnabled: true, whatsappCredentialsPresent: true });
    expect(JSON.stringify(s)).not.toMatch(/p4ss|tok-123|999/);
  });

  it("says not configured when the environment has nothing", async () => {
    const { mod } = await load();
    expect(mod.notificationStatus({ whatsapp_enabled: false }, {})).toEqual({
      emailConfigured: false, emailFrom: "", whatsappEnabled: false, whatsappCredentialsPresent: false,
    });
    expect(mod.notificationStatus({}, { WHATSAPP_TOKEN: "t" }).whatsappCredentialsPresent).toBe(false);
  });
});

describe("privacy requests", () => {
  it("lists requests newest first without selecting the payload", async () => {
    const { fake, mod } = await load({
      from: () => ({ count: 1, data: [{ id: "g1", type: "shop_redact", shopify_customer_id: null, status: "open", created_at: "t" }] }),
    });
    const res = await mod.listGdprRequests(0, 25);
    expect(res).toEqual({ total: 1, rows: [{ id: "g1", type: "shop_redact", typeLabel: "Shop data erasure (logged only, nothing deleted)", shopifyCustomerId: null, status: "open", createdAt: "t" }] });
    expect(String(fake.tableCalls("gdpr_requests")[0].chain[0][1][0])).not.toContain("payload");
  });

  it("marks one request answered", async () => {
    const { fake, mod } = await load();
    await mod.setGdprRequestStatus("g1", "fulfilled");
    expect(fake.tableCalls("gdpr_requests")[0].chain).toEqual([["update", [{ status: "fulfilled" }]], ["eq", ["id", "g1"]]]);
  });
});
