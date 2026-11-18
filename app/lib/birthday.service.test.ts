import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());

import { h, opName, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import { birthdayDiscountForTier, birthdayDiscountPkr, issueBirthdayReward, listBirthdayMemberIds } from "./birthday.service";

const NODE = "gid://shopify/DiscountCodeNode/3";
const NOW = new Date("2026-11-01T04:00:00Z"); // 09:00 on 1 Nov in Karachi
const born = (over = {}) => seedMember(h.db, { birthday_month: 11, birthday_day: 20, birthday_set_at: "2026-06-01T00:00:00Z", ...over });

beforeEach(() => {
  resetHarness();
  bustSettingsCache();
  h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("reward size by tier (from settings)", () => {
  it("defaults", async () => {
    expect(await birthdayDiscountPkr("silver")).toBe(250);
    expect(await birthdayDiscountPkr("gold")).toBe(500);
    expect(await birthdayDiscountPkr("diamond")).toBe(1000);
    expect(await birthdayDiscountPkr("unknown")).toBe(250);
  });
  it("overrides", () => {
    const s = { birthday_reward_silver_pkr: 300, birthday_reward_gold_pkr: 750, birthday_reward_diamond_pkr: 1500 };
    expect(birthdayDiscountForTier("gold", s)).toBe(750);
  });
});

describe("issueBirthdayReward", () => {
  it("issues one customer-locked code sized by tier, keyed by member and year", async () => {
    const m = born({ tier: "gold", shopify_customer_id: "88" });
    const r = await issueBirthdayReward(String(m.id), { now: NOW });
    expect(r).toMatchObject({ issued: true, discountPkr: 500 });
    expect(r.code).toMatch(/^BDAY-/);
    expect(h.db.table("loyalty_codes")[0]).toMatchObject({ kind: "birthday", status: "active", issue_key: `birthday:${m.id}:2026`, discount_amount_pkr: 500, points_spent: 0 });
    const input = h.graphqlCalls[0].variables.basicCodeDiscount as Record<string, any>;
    expect(input.context).toEqual({ customers: { add: ["gid://shopify/Customer/88"] } });
  });

  it("running the job twice issues once", async () => {
    const m = born();
    await issueBirthdayReward(String(m.id), { now: NOW });
    expect(await issueBirthdayReward(String(m.id), { now: NOW })).toMatchObject({ issued: false, reason: "already_issued" });
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
    expect(h.graphqlCalls).toHaveLength(1);
  });

  it("L11: a failed Shopify call does not lose the reward; the retry issues it exactly once", async () => {
    const m = born();
    h.graphql = () => { throw new Error("Shopify 503"); };
    await expect(issueBirthdayReward(String(m.id), { now: NOW })).rejects.toThrow(/will retry/);
    expect(h.db.table("loyalty_codes")[0].status).toBe("pending");

    h.graphql = () => ({ discountCodeBasicCreate: { codeDiscountNode: { id: NODE }, userErrors: [] } });
    const retry = await issueBirthdayReward(String(m.id), { now: NOW });
    expect(retry.issued).toBe(true);
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
    expect(h.db.table("loyalty_codes")[0].status).toBe("active");
  });

  it("next year gets a new code", async () => {
    const m = born();
    await issueBirthdayReward(String(m.id), { now: NOW });
    expect((await issueBirthdayReward(String(m.id), { now: new Date("2027-11-01T04:00:00Z") })).issued).toBe(true);
    expect(h.db.table("loyalty_codes")).toHaveLength(2);
  });

  it("a birthday first set during its own month gets nothing until next year", async () => {
    const m = born({ birthday_set_at: "2026-11-01T02:00:00Z" }); // set on the 1st, Karachi time, before the cron
    expect(await issueBirthdayReward(String(m.id), { now: NOW })).toMatchObject({ issued: false, reason: "set_this_month" });
    expect((await issueBirthdayReward(String(m.id), { now: new Date("2027-11-01T04:00:00Z") })).issued).toBe(true);
  });

  it("blocked, opted-out, wrong month and a switched-off rule issue nothing", async () => {
    expect((await issueBirthdayReward(String(born({ is_blocked: true }).id), { now: NOW })).reason).toBe("blocked");
    expect((await issueBirthdayReward(String(born({ opted_out: true }).id), { now: NOW })).reason).toBe("opted_out");
    expect((await issueBirthdayReward(String(born({ birthday_month: 3 }).id), { now: NOW })).reason).toBe("not_birthday_month");
    h.db.table("app_settings")[0].earn_rules = { birthday: { enabled: false } };
    bustSettingsCache();
    expect((await issueBirthdayReward(String(born().id), { now: NOW })).reason).toBe("disabled");
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });
});

describe("listBirthdayMemberIds", () => {
  it("month in Pakistan time; skips blocked, opted-out and set-this-month members", async () => {
    const ok = born();
    born({ is_blocked: true });
    born({ opted_out: true });
    born({ birthday_month: 12 });
    born({ birthday_set_at: "2026-11-01T01:00:00Z" });
    expect(await listBirthdayMemberIds(NOW)).toEqual([ok.id]);
    // 31 Oct 19:30 UTC is already 1 Nov 00:30 in Karachi
    expect(await listBirthdayMemberIds(new Date("2026-10-31T19:30:00Z"))).toEqual([ok.id]);
    expect(await listBirthdayMemberIds(new Date("2026-10-31T18:30:00Z"))).toEqual([]);
  });
});

describe("rule 20: the program switch only pauses redeeming", () => {
  it("a birthday code is issued while the program is off", async () => {
    const m = born();
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    expect(await issueBirthdayReward(String(m.id), { now: NOW })).toMatchObject({ issued: true, discountPkr: 250 });
    expect(h.db.table("loyalty_codes")).toHaveLength(1);
  });
});
