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
  rejectReviewClaim: vi.fn(), approveReviewClaim: vi.fn(), bustSettingsCache: vi.fn(), syncStorefrontConfig: vi.fn(), readHeartbeats: vi.fn(),
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
  vi.doMock("./review-claims.service", () => ({ rejectReviewClaim: svc.rejectReviewClaim, approveReviewClaim: svc.approveReviewClaim }));
  vi.doMock("./settings.server", () => ({ bustSettingsCache: svc.bustSettingsCache }));
  vi.doMock("./storefront-config.server", () => ({ syncStorefrontConfig: svc.syncStorefrontConfig }));
  vi.doMock("./heartbeat.server", () => ({ readHeartbeats: svc.readHeartbeats }));
  vi.doMock("./queue.server", () => ({}));
  vi.doMock("./smile-import-queue.server", () => ({}));
  return fake;
}

function post(url: string, fields: Record<string, string>): Request {
  return new Request(`https://app.test${url}`, { method: "POST", body: new URLSearchParams(fields) });
}
type Body = {
  ok: boolean; message?: string; error?: string; warning?: string;
  errors?: Record<string, string>; conflicts?: Array<{ id: string; name: string }>;
};
/** The JSON an action answered with, read loosely so a test can look at any field. */
const read = async (res: Response): Promise<Body> => (await res.json()) as Body;
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
    const body = await read(res);
    expect(body.ok).toBe(false);
    expect(body.errors).toMatchObject({ points: "Points is required.", reason: "Reason is required." });
    expect(fake.rpcCalls("award_points")).toHaveLength(0);
  });

  it("a double submit of the same form is applied once", async () => {
    let n = 0;
    const fake = setup({ rpc: () => ({ data: [{ awarded: n++ === 0, new_balance: 18950 }] }) });
    const { action } = await import("../routes/app.customers.$id");
    const first = await read(await action(args(post(`/app/customers/${ID}`, adjust), { id: ID })));
    const second = await read(await action(args(post(`/app/customers/${ID}`, adjust), { id: ID })));
    expect(first).toMatchObject({ ok: true, message: "Balance adjusted. New balance 18,950 points" });
    expect(second).toMatchObject({ ok: true, message: "This adjustment was already applied. The balance was not changed again" });
    const calls = fake.rpcCalls("award_points");
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0].args).toMatchObject({ p_reference_id: `admin-adjust:${adjust.idempotency_key}`, p_points: 500, p_reason_note: "[by Ayesha] Goodwill", p_customer_note: "Sorry" });
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
    const body = await read(await action(args(post(`/app/customers/${ID}`, { intent: "cancel_code", code_id: CODE }), { id: ID })));
    expect(body).toMatchObject({ ok: true, message: "Code cancelled and 6,000 points returned" });
    expect(svc.cancelRewardCode).toHaveBeenCalledWith({ codeId: CODE, shop: SHOP, actor: "Ayesha" });
  });

  it("explains a cancel that the engine refused", async () => {
    setup({ from: () => ({ data: { id: CODE } }) });
    svc.cancelRewardCode.mockResolvedValueOnce({ ok: false, pointsReturned: 0, reason: "not_active" });
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, { intent: "cancel_code", code_id: CODE }), { id: ID }));
    expect(res.status).toBe(409);
    expect((await read(res)).error).toContain("already been used, cancelled or has expired");
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

  it("blocking records the staff member and answers 404 for a customer who is gone (A6)", async () => {
    const fake = setup({ from: (t) => (t === "members" ? { data: [{ id: ID }] } : {}) });
    const { action } = await import("../routes/app.customers.$id");
    const ok = await read(await action(args(post(`/app/customers/${ID}`, { intent: "block" }), { id: ID })));
    expect(ok).toMatchObject({ ok: true, message: "Customer blocked" });
    expect(fake.firstArg("staff_notes", "insert")).toEqual({ member_id: ID, note: "Blocked this customer", author: "Ayesha" });

    setup({ from: () => ({ data: [] }) });
    const again = await import("../routes/app.customers.$id");
    const res = await again.action(args(post(`/app/customers/${ID}`, { intent: "unblock" }), { id: ID }));
    expect(res.status).toBe(404);
    expect((await read(res)).error).toContain("no longer exists");
  });

  it("removing influencer status from the profile deletes her Shopify code first and aborts if that fails (A1)", async () => {
    setup({ from: () => ({ data: { id: ID, is_influencer: true, influencer_code: "SANA10" } }) });
    svc.removeInfluencerCode.mockResolvedValueOnce({ ok: false, reason: "shopify_unavailable" });
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, { intent: "influencer_off" }), { id: ID }));
    expect(res.status).toBe(409);
    expect((await read(res)).error).toContain("could not be removed from Shopify, so she is still an influencer and the code still works");
    expect(svc.setInfluencer).not.toHaveBeenCalled();

    svc.removeInfluencerCode.mockResolvedValueOnce({ ok: true });
    svc.setInfluencer.mockResolvedValueOnce({ ok: true });
    const done = await read(await action(args(post(`/app/customers/${ID}`, { intent: "influencer_off" }), { id: ID })));
    expect(done.message).toBe("No longer an influencer. Discount code SANA10 was removed from Shopify");
    expect(svc.removeInfluencerCode).toHaveBeenLastCalledWith({ memberId: ID, shop: SHOP });
    expect(svc.setInfluencer).toHaveBeenCalledWith(ID, { isInfluencer: false });
  });

  it("pause and resume from a stale profile tab do not make a removed member an influencer again (A5)", async () => {
    setup({ from: () => ({ data: { id: ID, is_influencer: false, influencer_code: null } }) });
    const { action } = await import("../routes/app.customers.$id");
    for (const intent of ["influencer_pause", "influencer_resume"]) {
      const res = await action(args(post(`/app/customers/${ID}`, { intent }), { id: ID }));
      expect(res.status, intent).toBe(409);
      expect((await read(res)).error).toContain("no longer an influencer");
    }
    expect(svc.setInfluencer).not.toHaveBeenCalled();
  });

  it("a database failure is shown as a generic message, with the detail only in the server log (A10)", async () => {
    setup({ rpc: () => ({ error: { message: 'null value in column "balance_after" of relation "points_ledger" violates not-null constraint' } }) });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { action } = await import("../routes/app.customers.$id");
    const res = await action(args(post(`/app/customers/${ID}`, adjust), { id: ID }));
    expect(res.status).toBe(500);
    const body = await read(res);
    expect(body.error).toContain("Something went wrong");
    expect(JSON.stringify(body)).not.toMatch(/points_ledger|balance_after|constraint/);
    expect(log.mock.calls.flat().join(" ")).toContain("points_ledger");
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
    expect((await read(res)).errors?.signup_points).toBe("Points given is required.");
    expect(fake.calls.some((c) => c.chain.some(([m]) => m === "update"))).toBe(false);
    expect(svc.syncStorefrontConfig).not.toHaveBeenCalled();
    expect(svc.bustSettingsCache).not.toHaveBeenCalled();
  });

  it("after a valid save it drops the settings cache and syncs the storefront config", async () => {
    const fake = setup({ from: () => ({ data: { earn_rules: {} } }) });
    const { action } = await import("../routes/app.program");
    const body = await read(await action(args(post("/app/program", { intent: "save_expiry", silver_expiry_days: "365", reward_code_expiry_days: "30" }))));
    expect(body).toMatchObject({ ok: true, message: "Expiry saved" });
    expect(fake.firstArg("app_settings", "update")).toEqual({ silver_expiry_days: 365, reward_code_expiry_days: 30 });
    expect(svc.bustSettingsCache).toHaveBeenCalledTimes(1);
    expect(svc.syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("keeps the save and returns a warning when the storefront copy fails", async () => {
    setup({ from: () => ({ data: { earn_rules: {} } }) });
    svc.syncStorefrontConfig.mockResolvedValueOnce({ ok: false, reason: "metafield_write_failed" });
    const { action } = await import("../routes/app.program");
    const body = await read(await action(args(post("/app/program", { intent: "toggle_rule", rule: "review", enabled: "true" }))));
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("metafield_write_failed");
  });

  it("saves the hidden flag of each reward and publishes the storefront config", async () => {
    const fake = setup({ from: () => ({ data: {} }) });
    const { action } = await import("../routes/app.program");
    const tiers = [{ points: "3000", discount_pkr: "100", hidden: false }, { points: "6000", discount_pkr: "250", hidden: true }];
    const body = await read(await action(args(post("/app/program", { intent: "save_redemption", tiers: JSON.stringify(tiers) }))));
    expect(body).toMatchObject({ ok: true, message: "Ways to redeem saved. 1 hidden from customers" });
    expect(fake.firstArg("app_settings", "update")).toEqual({
      redemption_tiers: [{ points: 3000, discount_pkr: 100 }, { points: 6000, discount_pkr: 250, hidden: true }],
    });
    expect(svc.bustSettingsCache).toHaveBeenCalledTimes(1);
    expect(svc.syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("allows every reward to be hidden and says customers have nothing to redeem", async () => {
    const fake = setup({ from: () => ({ data: {} }) });
    const { action } = await import("../routes/app.program");
    const tiers = [{ points: 3000, discount_pkr: 100, hidden: true }, { points: 6000, discount_pkr: 250, hidden: true }];
    const body = await read(await action(args(post("/app/program", { intent: "save_redemption", tiers: JSON.stringify(tiers) }))));
    expect(body).toMatchObject({ ok: true, message: "Saved. Every reward is hidden, so customers have nothing to redeem" });
    expect((fake.firstArg("app_settings", "update") as { redemption_tiers: unknown[] }).redemption_tiers).toHaveLength(2);
    expect(svc.syncStorefrontConfig).toHaveBeenCalledWith(admin);
  });

  it("rejects a hidden flag that is not true or false, and a hidden row that breaks the rules", async () => {
    setup({ from: () => ({ data: {} }) });
    const { action } = await import("../routes/app.program");
    const badFlag = await action(args(post("/app/program", { intent: "save_redemption", tiers: JSON.stringify([{ points: 3000, discount_pkr: 100, hidden: "yes" }]) })));
    expect(badFlag.status).toBe(400);
    const dup = await action(args(post("/app/program", { intent: "save_redemption", tiers: JSON.stringify([{ points: 3000, discount_pkr: 100 }, { points: 3000, discount_pkr: 250, hidden: true }]) })));
    expect(dup.status).toBe(400);
    expect(svc.syncStorefrontConfig).not.toHaveBeenCalled();
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

  it("returns the overlapping campaigns until confirmed, in one atomic database call (R7, A2)", async () => {
    const fake = setup({ rpc: () => ({ data: { ok: false, conflicts: [{ id: CODE, name: "Winter Glow" }] } }) });
    const { action } = await import("../routes/app.campaigns._index");
    const res = await action(args(post("/app/campaigns", save)));
    expect(res.status).toBe(409);
    expect((await read(res)).conflicts).toEqual([{ id: CODE, name: "Winter Glow" }]);
    expect(fake.rpcCalls("admin_save_campaign")).toHaveLength(1);
    expect(fake.calls.some((c) => c.chain.some(([m]) => m === "insert" || m === "update"))).toBe(false);
  });

  it("stores Pakistan times as UTC and passes the confirmation through (R6, A2)", async () => {
    const fake = setup({ rpc: () => ({ data: { ok: true, id: ID, switched_off: ["Winter Glow"] } }) });
    const { action } = await import("../routes/app.campaigns._index");
    const body = await read(await action(args(post("/app/campaigns", { ...save, replace_overlapping: "true" }))));
    expect(body).toMatchObject({ ok: true, message: "Campaign saved. Winter Glow switched off." });
    expect(fake.rpcCalls("admin_save_campaign")[0].args).toMatchObject({
      p_starts_at: "2026-12-01T19:00:00.000Z", p_ends_at: "2026-12-05T19:00:00.000Z", p_replace_overlapping: true,
    });
  });

  it("always publishes the storefront copy after a save attempt, whatever the outcome (A2)", async () => {
    for (const answer of [
      { ok: true, id: ID, switched_off: [] },
      { ok: false, conflicts: [{ id: CODE, name: "Winter Glow" }] },
      { ok: false, error: "overlap" },
    ]) {
      setup({ rpc: () => ({ data: answer }) });
      const { action } = await import("../routes/app.campaigns._index");
      await action(args(post("/app/campaigns", save)));
      expect(svc.bustSettingsCache, JSON.stringify(answer)).toHaveBeenCalledTimes(1);
      expect(svc.syncStorefrontConfig, JSON.stringify(answer)).toHaveBeenCalledWith(admin);
    }
    setup({ rpc: () => ({ data: { ok: true } }) });
    const { action } = await import("../routes/app.campaigns._index");
    await action(args(post("/app/campaigns", { intent: "set_active", id: ID, active: "false" })));
    expect(svc.syncStorefrontConfig).toHaveBeenCalledTimes(1);
  });

  it("switching off goes through the database rule and tells staff placed orders keep the multiplier (A3)", async () => {
    const fake = setup({ rpc: () => ({ data: { ok: true } }) });
    const { action } = await import("../routes/app.campaigns._index");
    const body = await read(await action(args(post("/app/campaigns", { intent: "set_active", id: ID, active: "false" }))));
    expect(body.message).toBe("Campaign switched off. Orders already placed during it keep its multiplier");
    expect(fake.rpcCalls("admin_set_campaign_active")[0].args).toEqual({ p_id: ID, p_active: false });
    // the action never writes is_active on the table itself
    expect(fake.tableCalls("bonus_campaigns")).toHaveLength(0);
  });

  it("rejects an invalid campaign form", async () => {
    setup();
    const { action } = await import("../routes/app.campaigns._index");
    const res = await action(args(post("/app/campaigns", { ...save, multiplier: "", ends_at: "2026-12-01T00:00" })));
    expect(res.status).toBe(400);
    expect(Object.keys((await read(res)).errors ?? {})).toContain("multiplier");
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
    setup({ from: () => ({ data: { id: ID, is_influencer: true, influencer_code: null } }) });
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

  it("a stale influencer tab cannot re-add a removed member: rate, pause, resume and code are refused (A5)", async () => {
    setup({ from: () => ({ data: { id: ID, is_influencer: false, influencer_code: null } }) });
    const { action } = await import("../routes/app.influencers.$id");
    const attempts: Array<Record<string, string>> = [
      { intent: "save_rate", multiplier_choice: "2", campaign: "", rate_starts: "", rate_ends: "" },
      { intent: "pause" }, { intent: "resume" },
      { intent: "create_code", code: "SANA10", percent_off: "10" },
    ];
    for (const fields of attempts) {
      const res = await action(args(post(`/app/influencers/${ID}`, fields), { id: ID }));
      expect(res.status, fields.intent).toBe(409);
      expect((await read(res)).error, fields.intent).toContain("no longer an influencer");
    }
    expect(svc.setInfluencer).not.toHaveBeenCalled();
    expect(svc.createInfluencerCode).not.toHaveBeenCalled();

    setup({ from: () => ({ data: null }) });
    const gone = await import("../routes/app.influencers.$id");
    expect((await gone.action(args(post(`/app/influencers/${ID}`, { intent: "pause" }), { id: ID }))).status).toBe(404);
  });

  it("removing influencer status deletes her Shopify code first; a Shopify failure aborts and she stays (A1)", async () => {
    setup({ from: () => ({ data: { id: ID, is_influencer: true, influencer_code: "SANA10" } }) });
    const { action } = await import("../routes/app.influencers.$id");
    svc.removeInfluencerCode.mockResolvedValueOnce({ ok: false, reason: "shopify_error" });
    const failed = await action(args(post(`/app/influencers/${ID}`, { intent: "remove_influencer" }), { id: ID }));
    expect(failed.status).toBe(409);
    expect((await read(failed)).error).toContain("she is still an influencer and the code still works");
    expect(svc.setInfluencer).not.toHaveBeenCalled();

    const order: string[] = [];
    svc.removeInfluencerCode.mockImplementationOnce(async () => { order.push("code"); return { ok: true }; });
    svc.setInfluencer.mockImplementationOnce(async () => { order.push("status"); return { ok: true }; });
    const ok = await read(await action(args(post(`/app/influencers/${ID}`, { intent: "remove_influencer" }), { id: ID })));
    expect(order).toEqual(["code", "status"]);
    expect(ok.message).toBe("She is no longer an influencer. Discount code SANA10 was removed from Shopify");
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

  it("approving a review claim from Home adds the points through the engine, records who did it and says so", async () => {
    setup();
    const { action } = await import("../routes/app._index");
    expect((await action(args(post("/app", { intent: "approve_claim", claim_id: "nope" })))).status).toBe(400);
    expect(svc.approveReviewClaim).not.toHaveBeenCalled();
    svc.approveReviewClaim.mockResolvedValueOnce({ ok: true, points: 3000, alreadyPaid: false });
    const ok = await read(await action(args(post("/app", { intent: "approve_claim", claim_id: ID }))));
    expect(svc.approveReviewClaim).toHaveBeenCalledWith(ID, "Ayesha");
    expect(ok).toEqual({ ok: true, message: "Review approved. 3,000 points added" });
    for (const [reason, text] of [["already_resolved", "already approved or rejected"], ["blocked", "blocked or opted out"], ["disabled", "switched off"], ["order_gone", "cancelled or refunded"]]) {
      svc.approveReviewClaim.mockResolvedValueOnce({ ok: false, reason });
      const res = await action(args(post("/app", { intent: "approve_claim", claim_id: ID })));
      expect(res.status).toBe(409);
      expect((await read(res)).error).toContain(text);
    }
  });

  it("the customer profile approves or rejects only her own waiting claims", async () => {
    const OTHER = "33333333-3333-4333-8333-333333333333";
    setup({ from: (t) => (t === "review_claims" ? { data: [{ id: CODE, member_id: ID, points: 3000, claimed_at: "t", members: null }], count: 1 } : { data: [] }) });
    const { action } = await import("../routes/app.customers.$id");
    const foreign = await action(args(post(`/app/customers/${ID}`, { intent: "approve_claim", claim_id: OTHER }), { id: ID }));
    expect(foreign.status).toBe(404);
    expect(svc.approveReviewClaim).not.toHaveBeenCalled();
    svc.approveReviewClaim.mockResolvedValueOnce({ ok: true, points: 3000, alreadyPaid: false });
    const ok = await read(await action(args(post(`/app/customers/${ID}`, { intent: "approve_claim", claim_id: CODE }), { id: ID })));
    expect(ok).toMatchObject({ ok: true, message: "Review approved. 3,000 points added" });
    expect(svc.approveReviewClaim).toHaveBeenCalledWith(CODE, "Ayesha");
    svc.rejectReviewClaim.mockResolvedValueOnce({ ok: true });
    expect(await read(await action(args(post(`/app/customers/${ID}`, { intent: "reject_claim", claim_id: CODE }), { id: ID })))).toMatchObject({ ok: true, message: "Review claim rejected. No points were added" });
    expect(svc.rejectReviewClaim).toHaveBeenCalledWith(CODE, "Ayesha");
  });
});

describe("settings", () => {
  it("old storefront script: shown with a button while Shopify has one; removed on request; a missing scope is explained", async () => {
    setup();
    const OLD = "https://app.heygirl.pk/loyalty-widget.js?v=f58b83ff&shop=heygirl-dev.myshopify.com";
    const reply = (data: unknown) => ({ json: async () => ({ data }) });
    admin.graphql.mockImplementation(async (q: string) =>
      q.includes("scriptTagDelete") ? reply({ scriptTagDelete: { deletedScriptTagId: "gid://shopify/ScriptTag/1", userErrors: [] } })
        : reply({ scriptTags: { edges: [{ node: { id: "gid://shopify/ScriptTag/1", src: OLD } }] } }));
    const { loader, action } = await import("../routes/app.settings");
    const page = (await (await loader(args(new Request("https://app.test/app/settings")))).json()) as { legacyScript: unknown };
    expect(page.legacyScript).toEqual({ found: 1, noScope: false });
    expect(await read(await action(args(post("/app/settings", { intent: "remove_legacy_script" }))))).toEqual({ ok: true, message: "Old storefront script removed" });

    admin.graphql.mockImplementation(async () => { throw new Error("Access denied for scriptTags field. Required access: `read_script_tags` access scope."); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const denied = await action(args(post("/app/settings", { intent: "remove_legacy_script" })));
    expect(denied.status).toBe(403);
    expect((await read(denied)).error).toContain("To remove the old script, the app needs temporary script-tag permission");
    const later = (await (await loader(args(new Request("https://app.test/app/settings")))).json()) as { legacyScript: unknown };
    expect(later.legacyScript).toEqual({ found: 0, noScope: true });
    admin.graphql.mockReset();
  });

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

describe("exports", () => {
  it("an influencer's referrals CSV shows Pakistan time, not UTC (A10)", async () => {
    let page = 0;
    setup({
      from: () => ({
        data: page++ === 0
          ? [{ id: "r1", referred_email: "friend@example.com", referred_shopify_customer_id: "C1", status: "completed", reward_points: 12000, shopify_order_id: "555", created_at: "2026-11-15T20:30:00Z", completed_at: "2026-11-16T07:05:00Z" }]
          : [],
      }),
    });
    const { loader } = await import("../routes/app.influencers.export[.]csv");
    const res = await loader(args(new Request(`https://app.test/app/influencers/export.csv?id=${ID}`)));
    const text = await res.text();
    expect(text).toContain("Referred at (Asia/Karachi),Completed at (Asia/Karachi)");
    // 20:30 UTC on the 15th is 1:30 am on the 16th in Karachi
    expect(text).toContain('"16 Nov 2026, 1:30 am","16 Nov 2026, 12:05 pm"');
    expect(text).not.toContain("2026-11-15T20:30:00Z");
    expect(text).not.toMatch(/\(UTC\)/);
  });

  it("the customers export keeps going after a short page and stops on an empty one (A8)", async () => {
    const row = (i: number) => ({ id: `m${i}`, name: `Member ${i}`, email: null, phone: "+923001234567", tier: "silver", points_balance: i, lifetime_spend_pkr: 0, enrolled_at: "2026-01-01T00:00:00Z", total_count: 1300 });
    const offsets: number[] = [];
    setup({
      rpc: (_name, a) => {
        const offset = Number(a.p_offset);
        offsets.push(offset);
        // the server hands back fewer rows than asked for on the first page, then the rest, then nothing
        if (offset === 0) return { data: Array.from({ length: 700 }, (_, i) => row(i)) };
        if (offset === 700) return { data: Array.from({ length: 300 }, (_, i) => row(700 + i)) };
        return { data: [] };
      },
    });
    const { loader } = await import("../routes/app.customers.export[.]csv");
    const text = await (await loader(args(new Request("https://app.test/app/customers/export.csv")))).text();
    // each request starts after the rows already received: nothing skipped, nothing twice
    expect(offsets).toEqual([0, 700, 1000]);
    expect(text).toContain("Member 699,");
    expect(text).toContain("Member 700,");
    expect(text.trim().split("\n")).toHaveLength(1 + 1000);
    // a plain phone number is exported as typed, with no apostrophe (A7)
    expect(text).toContain(",+923001234567,");
    expect(text).not.toContain("'+92");
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

  it.each(files)("%s exports only Remix route exports", (file) => {
    // Any other export from a route file stays in the browser bundle and can pull
    // server-only code into it, which breaks the production build.
    const allowed = new Set(["loader", "action", "default", "ErrorBoundary", "headers", "links", "meta", "handle", "shouldRevalidate", "HydrateFallback"]);
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
    if (/^export\s+default\b/m.test(src)) names.push("default");
    expect(names.filter((n) => !allowed.has(n))).toEqual([]);
    expect(src).not.toMatch(/^export\s*\{/m);
    expect(src).not.toMatch(/^export\s+type\s/m);
  });

  it("the navigation lives in a component file and lists every section once", async () => {
    const { NAV_ITEMS, HOME_PATH } = await import("../components/admin-nav");
    expect(HOME_PATH).toBe("/app");
    expect(NAV_ITEMS.map((n) => n.label)).toEqual(["Customers", "Program", "Referrals", "Influencers", "Campaigns", "Analytics", "On-site", "Settings", "Import"]);
    expect(new Set(NAV_ITEMS.map((n) => n.path)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      // each link has a route file behind it (app.import.tsx is the import stream's)
      const base = `app.${item.path.replace("/app/", "")}`;
      expect(fs.existsSync(path.join(dir, `${base}.tsx`)) || fs.existsSync(path.join(dir, `${base}._index.tsx`)), item.path).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, "app.tsx"), "utf8")).not.toContain("export const NAV_ITEMS");
  });

  it("no page offers the removed settings", () => {
    for (const file of files) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      expect(src, file).not.toMatch(/brand_color|shopify_email_injection|nudge_post_purchase|whatsapp_api_key|IP match/i);
    }
  });
});
