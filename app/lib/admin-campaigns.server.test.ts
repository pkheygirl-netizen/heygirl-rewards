import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, formOf } from "./admin-test-helpers";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.resetModules();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  const mod = await import("./admin-campaigns.server");
  return { fake, mod };
}

const input = { name: "Eid Edit", multiplier: 2, startsAt: "2026-12-01T19:00:00.000Z", endsAt: "2026-12-05T19:00:00.000Z", isActive: true };

describe("campaign form", () => {
  it("reads start and end as Pakistan time (R6)", async () => {
    const { mod } = await load();
    const res = mod.parseCampaignForm(formOf({ name: " Eid Edit ", multiplier: "2", starts_at: "2026-12-02T00:00", ends_at: "2026-12-06T00:00", is_active: "true" }));
    expect(res).toEqual({ ok: true, value: input });
  });

  it("rejects a blank name, a bad multiplier, bad dates and an end before the start", async () => {
    const { mod } = await load();
    const base = { name: "Eid", multiplier: "2", starts_at: "2026-12-02T00:00", ends_at: "2026-12-06T00:00" };
    expect(mod.parseCampaignForm(formOf({ ...base, name: "  " })).ok).toBe(false);
    for (const m of ["", "1", "10.1", "2.55", "double"]) {
      expect(mod.parseCampaignForm(formOf({ ...base, multiplier: m })).ok, m).toBe(false);
    }
    expect(mod.parseCampaignForm(formOf({ ...base, starts_at: "" })).ok).toBe(false);
    expect(mod.parseCampaignForm(formOf({ ...base, ends_at: "2026-02-31T00:00" })).ok).toBe(false);
    const backwards = mod.parseCampaignForm(formOf({ ...base, ends_at: "2026-12-02T00:00" }));
    expect(!backwards.ok && backwards.errors.ends_at).toBe("The end must be after the start.");
    const off = mod.parseCampaignForm(formOf(base));
    expect(off.ok && off.value.isActive).toBe(false);
  });
});

describe("campaign status", () => {
  const c = { startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-05T00:00:00Z" };
  it("is scheduled, live, ended or switched off", async () => {
    const { mod } = await load();
    expect(mod.campaignStatus({ ...c, isActive: true }, new Date("2026-11-30T00:00:00Z"))).toBe("scheduled");
    expect(mod.campaignStatus({ ...c, isActive: true }, new Date("2026-12-03T00:00:00Z"))).toBe("live");
    expect(mod.campaignStatus({ ...c, isActive: true }, new Date("2026-12-05T00:00:00Z"))).toBe("ended");
    expect(mod.campaignStatus({ ...c, isActive: false }, new Date("2026-12-03T00:00:00Z"))).toBe("off");
    expect(mod.campaignStatus({ ...c, isActive: false }, new Date("2026-12-09T00:00:00Z"))).toBe("ended");
  });
});

describe("listCampaigns", () => {
  it("attaches each campaign's results from the database", async () => {
    const { mod } = await load({
      from: () => ({ data: [
        { id: A, name: "Eid Edit", multiplier: "2.0", starts_at: "2026-11-01T00:00:00Z", ends_at: "2026-11-30T00:00:00Z", is_active: true },
        { id: B, name: "Old", multiplier: "1.5", starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-01-02T00:00:00Z", is_active: true },
      ] }),
      rpc: () => ({ data: [{ campaign_id: A, orders: 12, sales_pkr: "48000.00", points_issued: 90000, points_pending: 6000 }] }),
    });
    const list = await mod.listCampaigns(new Date("2026-11-16T00:00:00Z"));
    expect(list[0]).toMatchObject({ status: "live", multiplier: 2, results: { orders: 12, salesPkr: 48000, pointsIssued: 90000, pointsPending: 6000 } });
    expect(list[1]).toMatchObject({ status: "ended", results: { orders: 0, salesPkr: 0, pointsIssued: 0, pointsPending: 0 } });
  });
});

describe("saveCampaign (R7, A2, A3)", () => {
  it("is one database call, so switching off the overlap and saving cannot be half done", async () => {
    const { fake, mod } = await load({ rpc: () => ({ data: { ok: true, id: A, switched_off: ["Winter Glow"] } }) });
    const res = await mod.saveCampaign(null, input, { replaceOverlapping: true });
    expect(res).toEqual({ ok: true, switchedOff: ["Winter Glow"] });
    expect(fake.rpcCalls("admin_save_campaign")).toHaveLength(1);
    expect(fake.rpcCalls("admin_save_campaign")[0].args).toEqual({
      p_id: null, p_name: "Eid Edit", p_multiplier: 2, p_starts_at: input.startsAt, p_ends_at: input.endsAt,
      p_is_active: true, p_replace_overlapping: true,
    });
    // no separate table writes from the application: nothing to leave half finished
    expect(fake.db.from).not.toHaveBeenCalled();
  });

  it("reports the overlapping campaigns when the admin has not confirmed, and does not ask to replace", async () => {
    const { fake, mod } = await load({ rpc: () => ({ data: { ok: false, conflicts: [{ id: B, name: "Winter Glow" }] } }) });
    expect(await mod.saveCampaign(null, input)).toEqual({ ok: false, conflicts: [{ id: B, name: "Winter Glow" }] });
    expect((fake.rpcCalls("admin_save_campaign")[0].args as { p_replace_overlapping: boolean }).p_replace_overlapping).toBe(false);
  });

  it("turns the database's answers into plain messages", async () => {
    const overlap = await load({ rpc: () => ({ data: { ok: false, error: "overlap" } }) });
    const r1 = await overlap.mod.saveCampaign(null, input);
    expect(!r1.ok && "error" in r1 && r1.error).toContain("overlaps these dates");
    const gone = await load({ rpc: () => ({ data: { ok: false, error: "not_found" } }) });
    expect(await gone.mod.saveCampaign(A, input)).toEqual({ ok: false, error: "That campaign no longer exists." });
    const odd = await load({ rpc: () => ({ data: { ok: false, error: "something_else" } }) });
    expect(await odd.mod.saveCampaign(A, input)).toEqual({ ok: false, error: "The campaign could not be saved." });
  });

  it("refuses a malformed id without calling the database, and throws when the call itself fails", async () => {
    const { fake, mod } = await load();
    expect((await mod.saveCampaign("1; drop", input)).ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
    const broken = await load({ rpc: () => ({ error: { message: "function admin_save_campaign does not exist" } }) });
    await expect(broken.mod.saveCampaign(null, input)).rejects.toThrow("admin_save_campaign failed");
  });
});

describe("switch on, switch off, delete", () => {
  it("switching on or off is one database call that applies the rule-2 switch-off", async () => {
    const { fake, mod } = await load({ rpc: () => ({ data: { ok: true } }) });
    expect(await mod.setCampaignActive(A, false)).toEqual({ ok: true, switchedOff: [] });
    expect(fake.rpcCalls("admin_set_campaign_active")[0].args).toEqual({ p_id: A, p_active: false });
    // the application never writes is_active itself (that would skip ends_at = least(ends_at, now()))
    expect(fake.db.from).not.toHaveBeenCalled();
  });

  it("switching on is refused while another active campaign overlaps, or once it has ended", async () => {
    const clash = await load({ rpc: () => ({ data: { ok: false, conflicts: [{ id: B, name: "Winter Glow" }] } }) });
    expect(await clash.mod.setCampaignActive(A, true)).toEqual({ ok: false, conflicts: [{ id: B, name: "Winter Glow" }] });
    const ended = await load({ rpc: () => ({ data: { ok: false, error: "ended" } }) });
    const res = await ended.mod.setCampaignActive(A, true);
    expect(!res.ok && "error" in res && res.error).toContain("already ended");
    expect((await ended.mod.setCampaignActive("nope", true)).ok).toBe(false);
  });

  it("a campaign with orders is kept as a record", async () => {
    const { fake, mod } = await load({ from: (t) => (t === "order_webhook_state" ? { count: 4 } : {}) });
    const res = await mod.deleteCampaign(A);
    expect(res.ok).toBe(false);
    expect(fake.tableCalls("bonus_campaigns")).toHaveLength(0);
  });

  it("a campaign with no orders can be deleted", async () => {
    const { fake, mod } = await load({ from: (t) => (t === "order_webhook_state" ? { count: 0 } : {}) });
    expect(await mod.deleteCampaign(A)).toEqual({ ok: true });
    expect(fake.tableCalls("bonus_campaigns")[0].chain).toEqual([["delete", []], ["eq", ["id", A]]]);
  });
});

describe("ledger export", () => {
  it("reads the ledger in pages and keeps the internal reason apart from the customer note", async () => {
    let page = 0;
    const row = (i: number) => ({
      id: `l${i}`, earned_at: "2026-11-16T05:00:00Z", action_type: "adjustment", points: -500, balance_after: 100,
      reason_note: "entered twice", customer_note: "Correction", shopify_order_id: null,
      members: { first_name: "=Evil", last_name: null, email: "e@x.com" },
    });
    const { fake, mod } = await load({
      from: () => ({ data: page === 0 ? (page++, Array.from({ length: 1000 }, (_, i) => row(i))) : page++ === 1 ? [row(1000)] : [] }),
    });
    const res = await mod.listLedger({ from: "a", to: "b", actionType: "adjustment" });
    expect(res.rows).toHaveLength(1001);
    expect(res.truncated).toBe(false);
    expect(res.rows[0]).toMatchObject({ memberName: "=Evil", points: -500, reason: "entered twice", customerNote: "Correction" });
    const calls = fake.tableCalls("points_ledger");
    // third request is the empty page that proves the end was reached (A8)
    expect(calls).toHaveLength(3);
    expect(calls[0].chain).toContainEqual(["range", [0, 999]]);
    expect(calls[1].chain).toContainEqual(["range", [1000, 1999]]);
    expect(calls[2].chain).toContainEqual(["range", [1001, 2000]]);
    expect(calls[0].chain).toContainEqual(["eq", ["action_type", "adjustment"]]);
    expect(calls[0].chain).toContainEqual(["lt", ["earned_at", "b"]]);
  });
});
