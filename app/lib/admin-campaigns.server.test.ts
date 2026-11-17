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

describe("saveCampaign (R7)", () => {
  it("looks only for active campaigns that overlap the dates, excluding itself", async () => {
    const { fake, mod } = await load({ from: () => ({ data: [] }) });
    await mod.findOverlapping(input.startsAt, input.endsAt, A);
    expect(fake.tableCalls("bonus_campaigns")[0].chain).toEqual([
      ["select", ["id, name"]], ["eq", ["is_active", true]], ["lt", ["starts_at", input.endsAt]],
      ["gt", ["ends_at", input.startsAt]], ["neq", ["id", A]],
    ]);
  });

  it("saves nothing and reports the conflict until the admin confirms", async () => {
    const { fake, mod } = await load({
      from: (_t, chain) => (chain.some(([m]) => m === "lt") ? { data: [{ id: B, name: "Winter Glow" }] } : { data: [{ id: A }] }),
    });
    const res = await mod.saveCampaign(null, input);
    expect(res).toEqual({ ok: false, conflicts: [{ id: B, name: "Winter Glow" }] });
    const wrote = fake.tableCalls("bonus_campaigns").some((c) => c.chain.some(([m]) => m === "insert" || m === "update"));
    expect(wrote).toBe(false);
  });

  it("on confirmation switches off only the overlapping campaigns, then saves", async () => {
    const { fake, mod } = await load({
      from: (_t, chain) => (chain.some(([m]) => m === "lt") ? { data: [{ id: B, name: "Winter Glow" }] } : { data: [{ id: A }] }),
    });
    const res = await mod.saveCampaign(null, input, { replaceOverlapping: true });
    expect(res).toEqual({ ok: true, switchedOff: ["Winter Glow"] });
    const calls = fake.tableCalls("bonus_campaigns");
    const off = calls.find((c) => c.chain[0][0] === "update")!;
    // scoped to the overlapping ids: never "every other campaign"
    expect(off.chain).toEqual([["update", [{ is_active: false }]], ["in", ["id", [B]]]]);
    const insert = calls.find((c) => c.chain[0][0] === "insert")!;
    expect(insert.chain[0][1][0]).toEqual({ name: "Eid Edit", multiplier: 2, starts_at: input.startsAt, ends_at: input.endsAt, is_active: true });
  });

  it("does not look for overlaps when the campaign is saved switched off", async () => {
    const { fake, mod } = await load({ from: () => ({ data: [{ id: A }] }) });
    const res = await mod.saveCampaign(A, { ...input, isActive: false });
    expect(res).toEqual({ ok: true, switchedOff: [] });
    const calls = fake.tableCalls("bonus_campaigns");
    expect(calls).toHaveLength(1);
    expect(calls[0].chain[0][0]).toBe("update");
    expect(calls[0].chain).toContainEqual(["eq", ["id", A]]);
  });

  it("turns the database's no-overlap rule into a plain message", async () => {
    const { mod } = await load({
      from: (_t, chain) => (chain.some(([m]) => m === "insert") ? { error: { message: "conflicting key value violates exclusion constraint", code: "23P01" } } : { data: [] }),
    });
    const res = await mod.saveCampaign(null, input);
    expect(res.ok).toBe(false);
    expect(!res.ok && "error" in res && res.error).toContain("overlaps these dates");
  });

  it("reports a campaign that no longer exists, and refuses a malformed id", async () => {
    const { mod } = await load({ from: () => ({ data: [] }) });
    expect(await mod.saveCampaign(A, { ...input, isActive: false })).toEqual({ ok: false, error: "That campaign no longer exists." });
    expect((await mod.saveCampaign("1; drop", input)).ok).toBe(false);
  });
});

describe("switch on, switch off, delete", () => {
  it("switching on is refused while another active campaign overlaps", async () => {
    const { fake, mod } = await load({
      from: (_t, chain) => {
        if (chain.some(([m]) => m === "maybeSingle")) return { data: { name: "Eid", starts_at: input.startsAt, ends_at: input.endsAt } };
        if (chain.some(([m]) => m === "lt")) return { data: [{ id: B, name: "Winter Glow" }] };
        return {};
      },
    });
    const res = await mod.setCampaignActive(A, true);
    expect(res).toEqual({ ok: false, conflicts: [{ id: B, name: "Winter Glow" }] });
    expect(fake.tableCalls("bonus_campaigns").some((c) => c.chain[0][0] === "update")).toBe(false);
  });

  it("switching off touches only that campaign", async () => {
    const { fake, mod } = await load();
    expect(await mod.setCampaignActive(A, false)).toEqual({ ok: true, switchedOff: [] });
    expect(fake.tableCalls("bonus_campaigns")[0].chain).toEqual([["update", [{ is_active: false }]], ["eq", ["id", A]]]);
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
      from: () => ({ data: page++ === 0 ? Array.from({ length: 1000 }, (_, i) => row(i)) : [row(1000)] }),
    });
    const res = await mod.listLedger({ from: "a", to: "b", actionType: "adjustment" });
    expect(res.rows).toHaveLength(1001);
    expect(res.truncated).toBe(false);
    expect(res.rows[0]).toMatchObject({ memberName: "=Evil", points: -500, reason: "entered twice", customerNote: "Correction" });
    const calls = fake.tableCalls("points_ledger");
    expect(calls).toHaveLength(2);
    expect(calls[0].chain).toContainEqual(["range", [0, 999]]);
    expect(calls[1].chain).toContainEqual(["range", [1000, 1999]]);
    expect(calls[0].chain).toContainEqual(["eq", ["action_type", "adjustment"]]);
    expect(calls[0].chain).toContainEqual(["lt", ["earned_at", "b"]]);
  });
});
