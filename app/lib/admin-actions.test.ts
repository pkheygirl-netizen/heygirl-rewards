// Action and loader behaviour of the admin routes: validation, idempotency,
// what is called after a save, and that every route checks the admin session.
// (Kept outside app/routes because every file there becomes a route.)
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fakeDb } from "./admin-test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";
const CODE = "22222222-2222-4222-8222-222222222222";
const SHOP = "heygirl-pk.myshopify.com";

const admin = { graphql: vi.fn() };
const authenticateAdmin = vi.fn();
const svc = {
  setOptOut: vi.fn(), setBirthday: vi.fn(), cancelRewardCode: vi.fn(), setInfluencer: vi.fn(),
  createInfluencerCode: vi.fn(), removeInfluencerCode: vi.fn(), approveReferral: vi.fn(), rejectReferral: vi.fn(),
  rejectReviewClaim: vi.fn(), bustSettingsCache: vi.fn(), syncStorefrontConfig: vi.fn(), readHeartbeats: vi.fn(),
};

function setup(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  Object.values(svc).forEach((f) => f.mockReset());
  authenticateAdmin.mockReset();
  authenticateAdmin.mockResolvedValue({ admin, session: { shop: SHOP, onlineAccessInfo: { associated_user: { first_name: "Ayesha" } } } });
  svc.syncStorefrontConfig.mockResolvedValue({ ok: true });
  svc.readHeartbeats.mockResolvedValue([]);
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  vi.doMock("../shopify.server", () => ({ authenticate: { admin: authenticateAdmin } }));
  vi.doMock("./points.service", () => ({ setOptOut: svc.setOptOut, setBirthday: svc.setBirthday }));
  vi.doMock("./redemption.service", () => ({ cancelRewardCode: svc.cancelRewardCode }));
  vi.doMock("./influencer.service", () => ({
    setInfluencer: svc.setInfluencer, createInfluencerCode: svc.createInfluencerCode,
    removeInfluencerCode: svc.removeInfluencerCode, effectiveReferralPoints: (_m: unknown, s: number) => s,
  }));
  vi.doMock("./referrals.service", () => ({ approveReferral: svc.approveReferral, rejectReferral: svc.rejectReferral }));
  vi.doMock("./review-claims.service", () => ({ rejectReviewClaim: svc.rejectReviewClaim }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache: svc.bustSettingsCache }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig: svc.syncStorefrontConfig }));
  vi.doMock("./heartbeat.server", () => ({ readHeartbeats: svc.readHeartbeats }));
  vi.doMock("./queue.server", () => ({}));
  return fake;
}

function post(url: string, fields: Record<string, string>): Request {
  return new Request(`https://app.test${url}`, { method: "POST", body: new URLSearchParams(fields) });
}
type Args = { request: Request; params: Record<string, string>; context: Record<string, never> };
const args = (request: Request, params: Record<string, string> = {}): Args => ({ request, params, context: {} });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("customer profile action", () => {
  const adjust = { intent: "adjust", direction: "add", points: "500", reason: "Goodwill", customer_note: "Sorry", idempotency_key: "0f8fad5b-d9cb-469f-a165-70867728950e" };

  it("rejects an invalid adjustment on the server and changes nothing", async () => {
    const fake = setup();
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, { ...adjust, points: "", reason: "" }), { id: ID }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors).toMatchObject({ points: "Points is required.", reason: "Reason is required." });
    expect(fake.rpcCalls("award_points")).toHaveLength(0);
  });

  it("a double submit of the same form is applied once", async () => {
    let n = 0;
    const fake = setup({ rpc: () => ({ data: [{ awarded: n++ === 0, new_balance: 18950 }] }) });
    const { action } = await import("../routes/app.customers.$id");
    const first = await (await action(args(post(`/app/customers/${ID}`, adjust), { id: ID }))).json();
    const second = await (await action(args(post(`/app/customers/${ID}`, adjust), { id: ID }))).json();
    expect(first).toMatchObject({ ok: true, message: "Balance adjusted. New balance 18,950 points" });
    expect(second).toMatchObject({ ok: true, message: "This adjustment was already applied. The balance was not changed again" });
    const calls = fake.rpcCalls("award_points");
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0].args).toMatchObject({ p_reference_id: `admin-adjust:${adjust.idempotency_key}`, p_points: 500, p_reason_note: "Goodwill", p_customer_note: "Sorry" });
  });

  it("will not cancel a code that belongs to another customer", async () => {
    setup({ from: () => ({ data: null }) });
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, { intent: "cancel_code", code_id: CODE }), { id: ID }));
    expect(res.status).toBe(404);
    expect(svc.cancelRewardCode).not.toHaveBeenCalled();
  });

  it("cancels her active code through the engine and reports the points returned", async () => {
    setup({ from: () => ({ data: { id: CODE } }) });
    svc.cancelRewardCode.mockResolvedValueOnce({ ok: true, pointsReturned: 6000 });
    const { action } = await import("../routes/app.customers.$id");
    const body = await (await action(args(post(`/app/customers/${ID}`, { intent: "cancel_code", code_id: CODE }), { id: ID }))).json();
    expect(body).toMatchObject({ ok: true, message: "Code cancelled and 6,000 points returned" });
    expect(svc.cancelRewardCode).toHaveBeenCalledWith({ codeId: CODE, shop: SHOP, actor: "Ayesha" });
  });

  it("explains a cancel that the engine refused", async () => {
    setup({ from: () => ({ data: { id: CODE } }) });
    svc.cancelRewardCode.mockResolvedValueOnce({ ok: false, pointsReturned: 0, reason: "not_active" });
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, { intent: "cancel_code", code_id: CODE }), { id: ID }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("already been used, cancelled or has expired");
  });

  it("sets a birthday as admin, and opt-out and influencer through the engine", async () => {
    setup();
    svc.setBirthday.mockResolvedValue({ ok: true });
    svc.setInfluencer.mockResolvedValue({ ok: true });
    const { action } = await import("../routes/app.customers.$id");
    await action(args(post(`/app/customers/${ID}`, { intent: "birthday", birthday_month: "8", birthday_day: "12" }), { id: ID }));
    expect(svc.setBirthday).toHaveBeenCalledWith(ID, 8, 12, { byAdmin: true });
    const bad = await action(args(post(`/app/customers/${ID}`, { intent: "birthday", birthday_month: "2", birthday_day: "31" }), { id: ID }));
    expect(bad.status).toBe(400);
    expect(svc.setBirthday).toHaveBeenCalledTimes(1);
    await action(args(post(`/app/customers/${ID}`, { intent: "opt_out" }), { id: ID }));
    expect(svc.setOptOut).toHaveBeenCalledWith(ID, true);
    await action(args(post(`/app/customers/${ID}`, { intent: "influencer_on" }), { id: ID }));
    expect(svc.setInfluencer).toHaveBeenCalledWith(ID, { isInfluencer: true });
  });

  it("answers 404 for a malformed customer id and 400 for an unknown action", async () => {
    setup();
    const { action } = await import("../routes/app.customers.$id");
    expect((await action(args(post("/app/customers/x", adjust), { id: "x" }))).status).toBe(404);
    expect((await action(args(post(`/app/customers/${ID}`, { intent: "explode" }), { id: ID }))).status).toBe(400);
  });
});

describe("program action", () => {
  it("rejects a blank number, saves nothing and publishes nothing (R3)", async () => {
    const fake = setup({ from: () => ({ data: { earn_rules: {} } }) });
    const { action } = await import("../routes/app.program");
    const res = await action(args(post("/app/program", { intent: "save_rule", rule: "signup", enabled: "true", signup_points: "" })));
    expect(res.status).toBe(400);
    expect((await res.json()).errors.signup_points).toBe("Points given is required.");
    expect(fake.calls.some((c) => c.chain.some(([m]) => m === "update"))).toBe(false);
    expect(svc.syncStorefrontConfig).not.toHaveBeenCalled();
    expect(svc.bustSettingsCache).not.toHaveBeenCalled();
  });

  it("after a valid save it drops the settings cache and syncs the storefront config", async () => {
    const fake = setup({ from: () => ({ data: { earn_rules: {} } }) });
    const { action } = await import("../routes/app.program");
    const body = await (await action(args(post("/app/program", { intent: "save_expiry", silver_expiry_days: "365", reward_code_expiry_days: "30" })))).json();
    expect(body).toMatchObject({ ok: true, message: "Expiry saved" });
    expect(fake.firstArg("app_settings", "update")).toEqual({ silver_expiry_days: 365, reward_code_expiry_days: 30 });
    expect(svc.bustSettingsCache).toHaveBeenCalledTimes(1);
    expect(svc.syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("keeps the save and returns a warning when the storefront copy fails", async () => {
    setup({ from: () => ({ data: { earn_rules: {} } }) });
    svc.syncStorefrontConfig.mockResolvedValueOnce({ ok: false, reason: "metafield_write_failed" });
    const { action } = await import("../routes/app.program");
    const body = await (await action(args(post("/app/program", { intent: "toggle_rule", rule: "review", enabled: "true" })))).json();
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("metafield_write_failed");
  });

  it("refuses an unknown rule and an invalid reward table", async () => {
    setup({ from: () => ({ data: {} }) });
    const { action } = await import("../routes/app.program");
    expect((await action(args(post("/app/program", { intent: "toggle_rule", rule: "hack", enabled: "true" })))).status).toBe(400);
    const res = await action(args(post("/app/program", { intent: "save_redemption", tiers: JSON.stringify([{ points: 3000, discount_pkr: 100 }, { points: 3000, discount_pkr: 250 }]) })));
    expect(res.status).toBe(400);
    expect(svc.syncStorefrontConfig).not.toHaveBeenCalled();
  });
});

describe("campaigns action", () => {
  const save = { intent: "save", id: "", name: "Eid Edit", multiplier: "2", starts_at: "2026-12-02T00:00", ends_at: "2026-12-06T00:00", is_active: "true", replace_overlapping: "false" };

  it("returns the overlapping campaigns and saves nothing until confirmed (R7)", async () => {
    const fake = setup({ from: (_t, chain) => (chain.some(([m]) => m === "lt") ? { data: [{ id: CODE, name: "Winter Glow" }] } : { data: [{ id: ID }] }) });
    const { action } = await import("../routes/app.campaigns._index");
    const res = await action(args(post("/app/campaigns", save)));
    expect(res.status).toBe(409);
    expect((await res.json()).conflicts).toEqual([{ id: CODE, name: "Winter Glow" }]);
    expect(fake.calls.some((c) => c.chain.some(([m]) => m === "insert" || m === "update"))).toBe(false);
    expect(svc.syncStorefrontConfig).not.toHaveBeenCalled();
  });

  it("stores Pakistan times as UTC and publishes after saving (R6)", async () => {
    const fake = setup({ from: (_t, chain) => (chain.some(([m]) => m === "lt") ? { data: [] } : { data: [{ id: ID }] }) });
    const { action } = await import("../routes/app.campaigns._index");
    const body = await (await action(args(post("/app/campaigns", save)))).json();
    expect(body.ok).toBe(true);
    expect(fake.firstArg("bonus_campaigns", "insert")).toMatchObject({ starts_at: "2026-12-01T19:00:00.000Z", ends_at: "2026-12-05T19:00:00.000Z" });
    expect(svc.syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("rejects an invalid campaign form", async () => {
    setup();
    const { action } = await import("../routes/app.campaigns._index");
    const res = await action(args(post("/app/campaigns", { ...save, multiplier: "", ends_at: "2026-12-01T00:00" })));
    expect(res.status).toBe(400);
    expect(Object.keys((await res.json()).errors)).toContain("multiplier");
  });
});

describe("referrals, influencers and home actions", () => {
  it("approve and reject go to the engine with the shop and the staff name", async () => {
    setup();
    svc.approveReferral.mockResolvedValueOnce({ ok: true, paid: false });
    svc.rejectReferral.mockResolvedValueOnce({ ok: true });
    const { action } = await import("../routes/app.referrals");
    await action(args(post("/app/referrals", { intent: "approve", referral_id: ID })));
    expect(svc.approveReferral).toHaveBeenCalledWith(ID, "Ayesha", SHOP);
    await action(args(post("/app/referrals", { intent: "reject", referral_id: ID, note: "same household" })));
    expect(svc.rejectReferral).toHaveBeenCalledWith(ID, "Ayesha", "same household");
  });

  it("influencer rate, code and removal use the contract signatures", async () => {
    setup();
    svc.setInfluencer.mockResolvedValue({ ok: true });
    svc.createInfluencerCode.mockResolvedValue({ ok: true });
    svc.removeInfluencerCode.mockResolvedValue({ ok: true });
    const { action } = await import("../routes/app.influencers.$id");
    await action(args(post(`/app/influencers/${ID}`, { intent: "save_rate", multiplier_choice: "custom", multiplier_custom: "2.5", campaign: "Winter Glow", rate_starts: "2026-12-01", rate_ends: "" }), { id: ID }));
    expect(svc.setInfluencer).toHaveBeenCalledWith(ID, { isInfluencer: true, multiplier: 2.5, campaign: "Winter Glow", rateStartsAt: "2026-11-30T19:00:00.000Z", rateEndsAt: null });
    await action(args(post(`/app/influencers/${ID}`, { intent: "create_code", code: "sana10", percent_off: "10" }), { id: ID }));
    expect(svc.createInfluencerCode).toHaveBeenCalledWith({ memberId: ID, code: "SANA10", percentOff: 10, shop: SHOP });
    await action(args(post(`/app/influencers/${ID}`, { intent: "remove_code" }), { id: ID }));
    expect(svc.removeInfluencerCode).toHaveBeenCalledWith({ memberId: ID, shop: SHOP });
    await action(args(post(`/app/influencers/${ID}`, { intent: "pause" }), { id: ID }));
    expect(svc.setInfluencer).toHaveBeenLastCalledWith(ID, { isInfluencer: true, paused: true });
    const bad = await action(args(post(`/app/influencers/${ID}`, { intent: "create_code", code: "a b", percent_off: "95" }), { id: ID }));
    expect(bad.status).toBe(400);
    expect(svc.createInfluencerCode).toHaveBeenCalledTimes(1);
  });

  it("rejecting a review claim from Home calls the engine once, with a valid id only", async () => {
    setup();
    svc.rejectReviewClaim.mockResolvedValueOnce({ ok: true });
    const { action } = await import("../routes/app._index");
    expect((await action(args(post("/app", { intent: "reject_claim", claim_id: "nope" })))).status).toBe(400);
    await action(args(post("/app", { intent: "reject_claim", claim_id: ID })));
    expect(svc.rejectReviewClaim).toHaveBeenCalledTimes(1);
    expect(svc.rejectReviewClaim).toHaveBeenCalledWith(ID, "Ayesha");
  });
});

describe("settings", () => {
  it("the WhatsApp switch writes only the switch", async () => {
    const fake = setup();
    const { action } = await import("../routes/app.settings");
    await action(args(post("/app/settings", { intent: "set_whatsapp", enabled: "true", whatsapp_api_key: "sneaky" })));
    expect(fake.firstArg("app_settings", "update")).toEqual({ whatsapp_enabled: true });
  });

  it("the page data never contains a credential", async () => {
    setup({
      from: (t) => (t === "app_settings" ? { data: { program_enabled: true, whatsapp_enabled: true, whatsapp_api_key: "db-secret-key" } } : { data: [], count: 0 }),
    });
    vi.stubEnv("SMTP_HOST", "smtp.x.com");
    vi.stubEnv("SMTP_PASS", "smtp-secret-pass");
    vi.stubEnv("WHATSAPP_TOKEN", "wa-secret-token");
    vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "1234567890123");
    const { loader } = await import("../routes/app.settings");
    const text = await (await loader(args(new Request("https://app.test/app/settings")))).text();
    vi.unstubAllEnvs();
    expect(text).toContain('"whatsappCredentialsPresent":true');
    expect(text).not.toMatch(/db-secret-key|smtp-secret-pass|wa-secret-token|1234567890123/);
  });
});

describe("old addresses", () => {
  it("/app/members and /app/nudges redirect, keeping the query string", async () => {
    setup();
    const members = await import("../routes/app.members");
    const res = await members.loader(args(new Request("https://app.test/app/members?shop=x&host=y")));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/customers?shop=x&host=y");
    const nudges = await import("../routes/app.nudges");
    expect((await nudges.loader(args(new Request("https://app.test/app/nudges")))).headers.get("Location")).toBe("/app/onsite");
    expect(authenticateAdmin).toHaveBeenCalledTimes(2);
  });
});

describe("every admin route checks the admin session", () => {
  const dir = path.join(process.cwd(), "app", "routes");
  // app.import.tsx belongs to the import workstream.
  const files = fs.readdirSync(dir).filter((f) => f.startsWith("app") && f.endsWith(".tsx") && f !== "app.import.tsx");

  it("covers the whole admin", () => {
    for (const expected of [
      "app._index.tsx", "app.customers._index.tsx", "app.customers.$id.tsx", "app.program.tsx", "app.referrals.tsx",
      "app.influencers._index.tsx", "app.influencers.$id.tsx", "app.campaigns._index.tsx", "app.analytics._index.tsx",
      "app.onsite.tsx", "app.settings.tsx", "app.members.tsx", "app.nudges.tsx",
    ]) expect(files).toContain(expected);
  });

  it.each(files)("%s authenticates in every loader and action", (file) => {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const handlers = src.split(/export const (?:loader|action) = /).slice(1);
    expect(handlers.length).toBeGreaterThan(0);
    for (const body of handlers) {
      // authentication is the first statement of the handler
      const first = body.slice(0, body.indexOf(";") + 1);
      expect(first).toContain("await authenticate.admin(request)");
    }
  });

  it("no page offers the removed settings", () => {
    for (const file of files) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/brand_color|shopify_email_injection|nudge_post_purchase|whatsapp_api_key|IP match/i);
    }
  });
});
