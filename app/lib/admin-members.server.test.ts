import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, formOf } from "./admin-test-helpers";

const ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.resetModules();
});

async function load(script: Parameters<typeof fakeDb>[0] = {}) {
  vi.resetModules();
  const fake = fakeDb(script);
  vi.doMock("../db.server", () => ({ db: fake.db }));
  const mod = await import("./admin-members.server");
  return { fake, mod };
}

describe("customer filters", () => {
  it("reads search, filters, sort and page from the URL", async () => {
    const { mod } = await load();
    const f = mod.parseCustomerFilters(new URLSearchParams("q=%20sara%20&tier=gold&points=yes&blocked=no&optedout=yes&influencer=no&sort=points&dir=asc&page=3"));
    expect(f).toEqual({
      query: "sara", tier: "gold", hasPoints: true, blocked: false, optedOut: true, influencer: false,
      sort: "points", desc: false, page: 3,
    });
  });

  it("drops anything unexpected", async () => {
    const { mod } = await load();
    const f = mod.parseCustomerFilters(new URLSearchParams("tier=platinum&points=maybe&sort=password&page=-4&dir=sideways"));
    expect(f).toMatchObject({ tier: null, hasPoints: null, sort: "joined", desc: true, page: 0, query: "" });
    expect(mod.parseCustomerFilters(new URLSearchParams(`q=${"x".repeat(300)}`)).query).toHaveLength(100);
  });
});

describe("searchCustomers", () => {
  it("passes the search text as a parameter, so brackets and commas are safe", async () => {
    const { fake, mod } = await load({
      rpc: () => ({
        data: [{
          id: ID, name: "Sara (K)", email: "s@x.com", phone: null, tier: "gold", points_balance: 4500,
          lifetime_spend_pkr: "60000.00", is_blocked: false, opted_out: false, is_influencer: true,
          enrolled_at: "2026-01-01T00:00:00Z", total_count: 57,
        }],
      }),
    });
    const res = await mod.searchCustomers({ query: "sara (k), x%", tier: "gold", sort: "spend", desc: false, page: 2 }, 25);
    expect(res.total).toBe(57);
    expect(res.customers[0]).toMatchObject({ id: ID, name: "Sara (K)", tier: "gold", lifetimeSpendPkr: 60000, isInfluencer: true });
    expect(fake.rpcCalls("admin_search_members")[0].args).toEqual({
      p_query: "sara (k), x%", p_tier: "gold", p_has_points: null, p_blocked: null, p_opted_out: null,
      p_influencer: null, p_sort: "spend", p_desc: false, p_limit: 25, p_offset: 50,
    });
    // the members table is never filtered with a hand-built or() string
    expect(fake.db.from).not.toHaveBeenCalled();
  });

  it("returns an empty page with total 0", async () => {
    const { mod } = await load({ rpc: () => ({ data: [] }) });
    expect(await mod.searchCustomers({})).toEqual({ customers: [], total: 0 });
  });
});

describe("getCustomerProfile", () => {
  it("returns null for an id that is not a uuid without touching the database", async () => {
    const { fake, mod } = await load();
    expect(await mod.getCustomerProfile("1 or 1=1")).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it("combines the member row with her pending points and referral counts", async () => {
    const { mod } = await load({
      from: () => ({
        data: {
          id: ID, shopify_customer_id: "gid://shopify/Customer/778899", first_name: null, last_name: null,
          email: null, phone: "03001234567", tier: "silver", points_balance: 18450, lifetime_spend_pkr: "71200.50",
          enrolled_at: "2025-03-14T00:00:00Z", consent_source: "order", is_blocked: false, opted_out: true,
          referrals_blocked: false, imported_from_smile: true, birthday_month: 8, birthday_day: 12,
          birthday_set_at: null, referral_slug: "sara-k", is_influencer: true, influencer_paused: false,
          influencer_multiplier: "2.00", influencer_referral_rate: null, influencer_campaign: "Winter Glow",
          influencer_rate_starts_at: null, influencer_rate_ends_at: null, influencer_code: "SARA10", influencer_code_percent: 10,
          last_seen_ip: "10.0.0.1",
        },
      }),
      rpc: () => ({ data: { pending_points: 4250, referrals_completed: 2, referrals_pending: 1, referrals_held: 0, next_expiry: { points: 900, at: "2026-12-01T00:00:00Z" } } }),
    });
    const p = await mod.getCustomerProfile(ID);
    expect(p).toMatchObject({
      name: "03001234567", email: null, shopifyNumericId: "778899", pointsBalance: 18450, pendingPoints: 4250,
      lifetimeSpendPkr: 71201, optedOut: true, birthdayMonth: 8, birthdayDay: 12,
      referrals: { completed: 2, pending: 1, held: 0 }, nextExpiry: { points: 900, at: "2026-12-01T00:00:00Z" },
    });
    expect(p!.influencer).toMatchObject({ isInfluencer: true, multiplier: 2, campaign: "Winter Glow", code: "SARA10", codePercent: 10 });
    // her network address is never part of what the page receives
    expect(JSON.stringify(p)).not.toContain("10.0.0.1");
  });

  it("returns null when the member does not exist", async () => {
    const { mod } = await load({ from: () => ({ data: null }), rpc: () => ({ data: null }) });
    expect(await mod.getCustomerProfile(ID)).toBeNull();
  });
});

describe("reward codes", () => {
  it("only an active reward code can be cancelled for a return", async () => {
    const { mod } = await load();
    const base = { id: "c", code: "REWARD-1", discount_amount_pkr: 500, points_spent: 11500, created_at: "t" };
    expect(mod.toRewardCode({ ...base, kind: "reward", status: "active" }).canCancel).toBe(true);
    expect(mod.toRewardCode({ ...base, kind: "reward", status: "used" }).canCancel).toBe(false);
    expect(mod.toRewardCode({ ...base, kind: "reward", status: "cancelled" }).canCancel).toBe(false);
    expect(mod.toRewardCode({ ...base, kind: "birthday", status: "active" }).canCancel).toBe(false);
    expect(mod.toRewardCode({ ...base, kind: "tier_gold", status: "active" }).kindLabel).toBe("Gold reward");
  });

  it("checks that a code belongs to the customer before it is cancelled from her page", async () => {
    const { fake, mod } = await load({ from: () => ({ data: null }) });
    expect(await mod.codeBelongsTo("22222222-2222-4222-8222-222222222222", ID)).toBe(false);
    expect(fake.tableCalls("loyalty_codes")[0].chain).toContainEqual(["eq", ["member_id", ID]]);
    expect(await mod.codeBelongsTo("not-a-uuid", ID)).toBe(false);
  });
});

describe("tier progress", () => {
  const t = { gold: 50000, diamond: 100000 };
  it("measures Silver towards Gold and Gold towards Diamond from settings thresholds", async () => {
    const { mod } = await load();
    expect(mod.tierProgress(20000, "silver", t)).toEqual({ tier: "silver", nextTier: "gold", nextThresholdPkr: 50000, remainingPkr: 30000, percent: 40 });
    expect(mod.tierProgress(71200, "gold", t)).toEqual({ tier: "gold", nextTier: "diamond", nextThresholdPkr: 100000, remainingPkr: 28800, percent: 42 });
  });
  it("is complete at Diamond, and never negative when a refund lowered spend below the tier", async () => {
    const { mod } = await load();
    expect(mod.tierProgress(5000, "diamond", t)).toMatchObject({ nextTier: null, percent: 100, remainingPkr: 0 });
    expect(mod.tierProgress(30000, "gold", t)).toMatchObject({ nextTier: "diamond", percent: 0, remainingPkr: 70000 });
    expect(mod.tierProgress(999999, "silver", t)).toMatchObject({ percent: 100, remainingPkr: 0 });
  });
});

describe("adjust balance", () => {
  const good = { direction: "add", points: "500", reason: "Goodwill", customer_note: "Sorry for the delay", idempotency_key: "0f8fad5b-d9cb-469f-a165-70867728950e" };

  it("previews the new balance with the zero floor", async () => {
    const { mod } = await load();
    expect(mod.previewBalance(18450, "add", 500)).toBe(18950);
    expect(mod.previewBalance(300, "remove", 500)).toBe(0);
    expect(mod.previewBalance(300, "remove", 100)).toBe(200);
    expect(mod.previewBalance(300, "add", Number.NaN)).toBe(300);
  });

  it("accepts a complete form", async () => {
    const { mod } = await load();
    expect(mod.parseAdjustment(formOf(good))).toEqual({
      ok: true,
      value: { direction: "add", points: 500, reason: "Goodwill", customerNote: "Sorry for the delay", idempotencyKey: good.idempotency_key },
    });
    const noNote = mod.parseAdjustment(formOf({ ...good, customer_note: "" }));
    expect(noNote.ok && noNote.value.customerNote).toBeNull();
  });

  it("rejects blank, zero, negative, decimal and oversized points", async () => {
    const { mod } = await load();
    for (const points of ["", "0", "-5", "1.5", "1000001", "abc"]) {
      const res = mod.parseAdjustment(formOf({ ...good, points }));
      expect(res.ok, points).toBe(false);
    }
  });

  it("requires a reason, a valid direction and an idempotency key", async () => {
    const { mod } = await load();
    const noReason = mod.parseAdjustment(formOf({ ...good, reason: "   " }));
    expect(!noReason.ok && noReason.errors.reason).toBe("Reason is required.");
    expect(mod.parseAdjustment(formOf({ ...good, direction: "multiply" })).ok).toBe(false);
    expect(mod.parseAdjustment(formOf({ ...good, idempotency_key: "" })).ok).toBe(false);
    expect(mod.parseAdjustment(formOf({ ...good, idempotency_key: "short" })).ok).toBe(false);
    expect(mod.parseAdjustment(formOf({ ...good, customer_note: "x".repeat(141) })).ok).toBe(false);
  });

  it("sends the reason and the customer note to separate columns, keyed by the form's key", async () => {
    const { fake, mod } = await load({ rpc: () => ({ data: [{ awarded: true, new_balance: 18950 }] }) });
    const res = await mod.adjustBalance(ID, { direction: "remove", points: 500, reason: "Entered twice", customerNote: null, idempotencyKey: "key-12345" });
    expect(res).toEqual({ applied: true, newBalance: 18950 });
    expect(fake.rpcCalls("award_points")[0].args).toEqual({
      p_member_id: ID, p_action_type: "adjustment", p_reference_id: "admin-adjust:key-12345",
      p_points: -500, p_reason_note: "Entered twice", p_customer_note: null,
    });
  });

  it("a second submit with the same key is reported as not applied again", async () => {
    let n = 0;
    const { fake, mod } = await load({ rpc: () => ({ data: [{ awarded: n++ === 0, new_balance: 1500 }] }) });
    const a = { direction: "add" as const, points: 500, reason: "x", customerNote: null, idempotencyKey: "same-key-1" };
    expect((await mod.adjustBalance(ID, a)).applied).toBe(true);
    expect((await mod.adjustBalance(ID, a)).applied).toBe(false);
    const refs = fake.rpcCalls("award_points").map((c) => (c.args as { p_reference_id: string }).p_reference_id);
    expect(refs).toEqual(["admin-adjust:same-key-1", "admin-adjust:same-key-1"]);
  });

  it("throws when the database refuses", async () => {
    const { mod } = await load({ rpc: () => ({ error: { message: "nope" } }) });
    await expect(mod.adjustBalance(ID, { direction: "add", points: 1, reason: "x", customerNote: null, idempotencyKey: "k-123456" }))
      .rejects.toThrow("could not adjust the balance: nope");
  });
});

describe("block and notes", () => {
  it("sets the blocked flag on that member only", async () => {
    const { fake, mod } = await load();
    await mod.setBlocked(ID, true);
    const chain = fake.tableCalls("members")[0].chain;
    expect(chain).toEqual([["update", [{ is_blocked: true }]], ["eq", ["id", ID]]]);
  });

  it("saves a trimmed note with its author and refuses empty or oversized notes", async () => {
    const { fake, mod } = await load();
    await mod.addStaffNote(ID, "  Called her about the parcel  ", "Ayesha");
    expect(fake.firstArg("staff_notes", "insert")).toEqual({ member_id: ID, note: "Called her about the parcel", author: "Ayesha" });
    await expect(mod.addStaffNote(ID, "   ", "Ayesha")).rejects.toThrow("Write a note");
    await expect(mod.addStaffNote(ID, "x".repeat(1001), "Ayesha")).rejects.toThrow("1000 characters");
  });

  it("deletes a note only within the same member", async () => {
    const { fake, mod } = await load();
    await mod.deleteStaffNote(ID, "n1");
    expect(fake.tableCalls("staff_notes")[0].chain).toEqual([["delete", []], ["eq", ["id", "n1"]], ["eq", ["member_id", ID]]]);
  });

  it("lists notes newest first", async () => {
    const { mod } = await load({ from: () => ({ data: [{ id: "n1", note: "hi", author: null, created_at: "t" }] }) });
    expect(await mod.listStaffNotes(ID)).toEqual([{ id: "n1", note: "hi", author: null, createdAt: "t" }]);
  });
});

describe("birthday, links and actor", () => {
  it("validates day against month", async () => {
    const { mod } = await load();
    expect(mod.parseBirthday(formOf({ birthday_month: "2", birthday_day: "29" }))).toEqual({ ok: true, month: 2, day: 29 });
    expect(mod.parseBirthday(formOf({ birthday_month: "2", birthday_day: "30" })).ok).toBe(false);
    expect(mod.parseBirthday(formOf({ birthday_month: "4", birthday_day: "31" })).ok).toBe(false);
    expect(mod.parseBirthday(formOf({ birthday_month: "13", birthday_day: "1" })).ok).toBe(false);
    expect(mod.parseBirthday(formOf({ birthday_month: "", birthday_day: "" })).ok).toBe(false);
  });

  it("builds the referral link on the public store address when one is configured", async () => {
    const { mod } = await load();
    expect(mod.referralLink("sara k", "heygirl-pk.myshopify.com", "https://heygirl.pk/")).toBe("https://heygirl.pk/?ref=sara%20k");
    expect(mod.referralLink("sara", "heygirl-pk.myshopify.com", undefined)).toBe("https://heygirl-pk.myshopify.com/?ref=sara");
    expect(mod.referralLink("", "x.myshopify.com", undefined)).toBe("");
  });

  it("links to the customer in Shopify admin only for a real shop domain and id", async () => {
    const { mod } = await load();
    expect(mod.shopifyCustomerUrl("heygirl-pk.myshopify.com", "778899")).toBe("https://heygirl-pk.myshopify.com/admin/customers/778899");
    expect(mod.shopifyCustomerUrl("evil.example.com", "778899")).toBeNull();
    expect(mod.shopifyCustomerUrl("heygirl-pk.myshopify.com", "")).toBeNull();
  });

  it("names the signed-in staff member, falling back when the session has no user", async () => {
    const { mod } = await load();
    expect(mod.actorFromSession({ onlineAccessInfo: { associated_user: { first_name: "Ayesha", last_name: "R" } } })).toBe("Ayesha R");
    expect(mod.actorFromSession({ shop: "x" })).toBe("Store staff");
    expect(mod.actorFromSession(null)).toBe("Store staff");
  });
});
