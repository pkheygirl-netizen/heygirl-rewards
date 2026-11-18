import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());
vi.mock("./queue.server", async () => (await import("./testing/harness")).queueModule());
vi.mock("./worker-admin.server", async () => (await import("./testing/harness")).adminModule());
const queued = vi.hoisted(() => ({ jobs: [] as Array<{ name: string; runId: string }>, fail: false, busy: false }));
vi.mock("./smile-import-queue.server", () => ({
  IMPORT_QUEUE_NAME: "smile-import",
  importJobBusy: async () => queued.busy,
  enqueueImportJob: async (name: string, runId: string) => {
    if (queued.fail) throw new Error("redis down");
    if (queued.busy) return { queued: false };
    queued.jobs.push({ name, runId });
    return { queued: true };
  },
}));

import { GraphqlQueryError, HttpInternalError, HttpResponseError, HttpThrottlingError } from "@shopify/shopify-api";
import { fakeAdmin, h, resetHarness, seedMember } from "./testing/harness";
import { bustSettingsCache } from "./settings.server";
import {
  ImportLockedError, LIMITS, NOT_UTF8, SMILE_HEADER, buildLookupQuery, buildReportCsv, classifyLookupError, confirmRun,
  createRun, discardRun, executeRun, getLaunchState, getRun, lookupCustomersByEmail, markRunFailed, pacing, planRun,
  purgeExpiredRows, purgeRunRows, resumeRun, worker, type ImportRow,
} from "./smile-import.server";

const HEAD = SMILE_HEADER.join(",");
const line = (id: string, email: string, points: string, vip = "") =>
  `${id},Smile,Name,${email},member,${points},https://example.test/r,${vip},1990-01-01`;
const file = (lines: string[]) => [`﻿${HEAD}\r\n${lines.join("\r\n")}\r\n`];

/** Shopify customers by e-mail for the fake admin. */
let shopify: Record<string, { id: string; firstName?: string; lastName?: string; phone?: string; email?: string }>;
function lookupHandler(_query: string, variables: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, email] of Object.entries(variables)) {
    const c = shopify[String(email)];
    out[`c${key.slice(1)}`] = c
      ? {
          id: `gid://shopify/Customer/${c.id}`, firstName: c.firstName ?? "Ayesha", lastName: c.lastName ?? "Khan",
          defaultEmailAddress: { emailAddress: c.email ?? String(email) },
          defaultPhoneNumber: c.phone ? { phoneNumber: c.phone } : null,
        }
      : null;
  }
  return out;
}

const rowsOf = (runId: string) =>
  (h.db.table("import_rows") as unknown as ImportRow[]).filter((r) => r.run_id === runId).sort((a, b) => a.row_number - b.row_number);
const members = () => h.db.table("members");
const ledger = () => h.db.table("points_ledger").filter((l) => l.action_type === "import");

async function upload(lines: string[]): Promise<string> {
  const res = await createRun({ source: file(lines), fileName: "smile.csv", actor: "tester" });
  if (!res.ok) throw new Error(res.error);
  return res.runId;
}
async function fullRun(lines: string[], tierFromSmile = false): Promise<string> {
  const runId = await upload(lines);
  await planRun(runId);
  const ok = await confirmRun(runId, { tierFromSmile });
  if (!ok.ok) throw new Error(ok.error);
  await executeRun(runId);
  return runId;
}

beforeEach(() => {
  resetHarness();
  queued.jobs = [];
  queued.fail = false;
  queued.busy = false;
  worker.id = "worker-a";
  bustSettingsCache();
  shopify = {};
  h.graphql = lookupHandler;
  pacing.sleep = async () => undefined;
});

describe("upload", () => {
  it("stores compact rows, settles what the file alone decides and queues the dry run", async () => {
    const runId = await upload([line("1", "A@Example.com", '"12,500"'), line("2", "", "40"), line("3", "a@example.com", "10")]);
    const run = await getRun(runId);
    expect(run).toMatchObject({ status: "planning", phase: "plan", file_name: "smile.csv" });
    expect(rowsOf(runId).map((r) => [r.email, r.points, r.state, r.reason])).toEqual([
      ["a@example.com", 12500, "pending", null],
      [null, 40, "unmatched", "no_email"],
      ["a@example.com", 10, "duplicate", "duplicate_email"],
    ]);
    expect(JSON.stringify(rowsOf(runId))).not.toMatch(/Smile|Name|1990|example\.test/);
    expect(queued.jobs).toEqual([{ name: "plan", runId }]);
    expect(run?.totals).toMatchObject({ rows: 3, filePoints: 12550, waitingForLookup: 1, unmatched: 1, duplicates: 1 });
  });

  it("refuses a wrong header, an empty file and a second run while one is open", async () => {
    expect(await createRun({ source: ["Email,Points\na@b.co,1\n"] })).toMatchObject({ ok: false });
    expect(await createRun({ source: [""] })).toMatchObject({ ok: false, error: "The file is empty." });
    expect(h.db.table("import_runs")).toHaveLength(0);
    await upload([line("1", "a@example.com", "1")]);
    const second = await createRun({ source: file([line("2", "b@example.com", "1")]) });
    expect(second).toMatchObject({ ok: false });
    expect(h.db.table("import_runs")).toHaveLength(1);
  });

  it("removes the upload again when the job cannot be queued", async () => {
    queued.fail = true;
    const res = await createRun({ source: file([line("1", "a@example.com", "1")]) });
    expect(res.ok).toBe(false);
    expect(h.db.table("import_runs")).toHaveLength(0);
  });
});

describe("Shopify lookup", () => {
  it("builds one aliased, variable-only query", () => {
    const q = buildLookupQuery(2);
    expect(q).toContain("query HgImportCustomersByEmail($e0: String!, $e1: String!)");
    expect(q).toContain("c1: customerByIdentifier(identifier: { emailAddress: $e1 })");
    expect(q).not.toContain("@example.com");
  });

  it("batches e-mails and accepts only an exact e-mail match", async () => {
    const emails = Array.from({ length: 120 }, (_, i) => `u${i}@example.com`);
    for (const e of emails.slice(0, 100)) shopify[e] = { id: e.slice(1).split("@")[0] };
    shopify["u5@example.com"].email = "someone-else@example.com";
    const res = await lookupCustomersByEmail(fakeAdmin, emails);
    expect(h.graphqlCalls).toHaveLength(Math.ceil(120 / LIMITS.lookupBatch));
    expect(res.get("u0@example.com")).toMatchObject({ id: "0", email: "u0@example.com" });
    expect(res.get("u5@example.com")).toBe("not_found");
    expect(res.get("u110@example.com")).toBe("not_found");
  });

  it("waits and retries when throttled, and isolates one address that makes Shopify fail", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" }, "c@example.com": { id: "3" } };
    let calls = 0;
    const sleeps: number[] = [];
    pacing.sleep = async (ms) => void sleeps.push(ms);
    const admin = {
      graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
        calls++;
        const vars = opts?.variables ?? {};
        if (calls === 2) return { json: async () => ({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }) };
        if (Object.values(vars).includes("bad@example.com")) return { json: async () => ({ errors: [{ message: "boom" }] }) };
        return { json: async () => ({ data: lookupHandler(query, vars) }) };
      },
    };
    const first = await lookupCustomersByEmail(admin, ["a@example.com"]);
    expect(first.get("a@example.com")).toMatchObject({ id: "1" });
    const stats = { found: 1, errors: 0, lastError: null };
    const res = await lookupCustomersByEmail(admin, ["b@example.com", "bad@example.com", "c@example.com", "nobody@example.com"], stats);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(res.get("b@example.com")).toMatchObject({ id: "2" });
    expect(res.get("c@example.com")).toMatchObject({ id: "3" });
    expect(res.get("bad@example.com")).toBe("error");
    expect(res.get("nobody@example.com")).toBe("not_found");
  });

  it("fails loudly when no lookup has ever worked", async () => {
    const admin = { graphql: async () => ({ json: async () => ({ errors: [{ message: "access denied" }] }) }) };
    const emails = Array.from({ length: 12 }, (_, i) => `u${i}@example.com`);
    await expect(lookupCustomersByEmail(admin, emails)).rejects.toThrow(/access denied/);
  });
});

describe("dry run", () => {
  it("matches by e-mail, counts new and existing members and changes nothing", async () => {
    seedMember(h.db, { shopify_customer_id: "200", email: "old@example.com", points_balance: 70 });
    shopify = { "new@example.com": { id: "100", phone: "+923001234567" }, "old@example.com": { id: "200" }, "zero@example.com": { id: "300" } };
    const runId = await upload([
      line("1", "new@example.com", '"1,500"'), line("2", "old@example.com", "300"), line("3", "zero@example.com", "0"),
      line("4", "gone@example.com", "900"), line("5", "", "25"), line("6", "neg@example.com", "-40"),
    ]);
    shopify["neg@example.com"] = { id: "400" };
    expect(await planRun(runId)).toEqual({ status: "planned" });

    const run = await getRun(runId);
    expect(run?.totals).toMatchObject({
      rows: 6, matched: 4, unmatched: 2, duplicates: 0, membersToCreate: 3, membersToUpdate: 1,
      pointsToImport: 1800, zeroPointMembers: 2, filePoints: 1500 + 300 + 900 + 25 - 40, unexplained: 0,
    });
    expect(rowsOf(runId).map((r) => [r.state, r.reason])).toEqual([
      ["matched", null], ["matched", null], ["matched", null], ["unmatched", "no_shopify_customer"], ["unmatched", "no_email"], ["matched", null],
    ]);
    expect(members()).toHaveLength(1);
    expect(ledger()).toHaveLength(0);
    expect(queued.jobs.map((j) => j.name)).toEqual(["plan"]);
  });

  it("keeps one row when two e-mails reach the same Shopify customer", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "1", email: "b@example.com" } };
    const runId = await upload([line("1", "a@example.com", "10"), line("2", "b@example.com", "90")]);
    await planRun(runId);
    expect(rowsOf(runId).map((r) => [r.state, r.reason])).toEqual([["duplicate", "same_shopify_customer"], ["matched", null]]);
  });

  it("does nothing for a run that was discarded", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "10")]);
    await discardRun(runId);
    expect(await planRun(runId)).toEqual({ status: "cancelled" });
    expect(h.graphqlCalls).toHaveLength(0);
  });
});

describe("import", () => {
  it("needs a finished dry run and an explicit confirmation step", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "10")]);
    expect(await confirmRun(runId, { tierFromSmile: false })).toMatchObject({ ok: false });
    expect(await executeRun(runId)).toEqual({ status: "planning" });
    expect(members()).toHaveLength(0);
  });

  it("creates members, adds points once and reconciles to zero", async () => {
    const old = seedMember(h.db, {
      shopify_customer_id: "200", email: "old@example.com", points_balance: 70, first_name: "Keep", consent_source: "order", tier: "silver",
    });
    shopify = {
      "new@example.com": { id: "100", firstName: "Sana", lastName: "Ali", phone: "+923001234567" },
      "old@example.com": { id: "200", firstName: "Changed" }, "zero@example.com": { id: "300" }, "neg@example.com": { id: "400" },
    };
    const runId = await fullRun([
      line("1", "new@example.com", '"1,500"'), line("2", "old@example.com", "300"), line("3", "zero@example.com", "0"),
      line("4", "gone@example.com", "900"), line("5", "", "25"), line("6", "neg@example.com", "-40"),
    ]);

    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    const created = members().find((m) => m.shopify_customer_id === "100");
    expect(created).toMatchObject({
      email: "new@example.com", first_name: "Sana", last_name: "Ali", phone: "+923001234567", tier: "silver", points_balance: 1500,
      consent_given: true, consent_source: "import", imported_from_smile: true, birthday_month: null, lifetime_spend_pkr: 0,
    });
    expect(String(created?.referral_slug)).toMatch(/^sana-ali-\d{4}$/);
    // Existing member: points added, marker set, nothing else overwritten.
    expect(members().find((m) => m.id === old.id)).toMatchObject({
      points_balance: 370, first_name: "Keep", consent_source: "order", imported_from_smile: true,
    });
    expect(members().find((m) => m.shopify_customer_id === "300")).toMatchObject({ points_balance: 0, consent_source: "import" });
    expect(members().find((m) => m.shopify_customer_id === "400")).toMatchObject({ points_balance: 0 });
    // Ledger: action import, reference smile:<id>, only for rows with points.
    expect(ledger().map((l) => [l.reference_id, l.points]).sort()).toEqual([["smile:1", 1500], ["smile:2", 300]]);
    expect(h.db.rpcCalls.every((c) => c.args.p_action_type === "import" && c.args.p_expires_at === undefined)).toBe(true);
    // No welcome bonus, no tier reward, no notification queued by the import.
    expect(h.points.jobs).toHaveLength(0);
    expect(h.notifications.jobs).toHaveLength(0);
    expect(h.db.table("points_ledger").some((l) => l.action_type === "signup")).toBe(false);

    expect(run?.totals).toMatchObject({
      imported: 4, importedPoints: 1800, membersToCreate: 3, membersToUpdate: 1, unmatched: 2, errors: 0, unexplained: 0,
      filePoints: 2685,
    });
    const diffs = Object.fromEntries((run?.totals.differences ?? []).map((d) => [d.key, d.points]));
    expect(diffs).toEqual({ no_shopify_customer: 900, no_email: 25, negative: -40 });
    // Contact details held for the dry run are cleared once a row is done.
    expect(rowsOf(runId).every((r) => r.shopify_first_name === null && r.shopify_phone === null)).toBe(true);
  });

  it("is idempotent: the same file again, or the job run twice, adds nothing", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" } };
    const lines = [line("1", "a@example.com", "500"), line("2", "b@example.com", "0")];
    const first = await fullRun(lines);
    await executeRun(first); // duplicate job delivery
    expect(members()).toHaveLength(2);
    expect(ledger()).toHaveLength(1);

    // A later export where the balance and even the Smile id changed.
    const second = await upload([line("9", "a@example.com", "800"), line("2", "b@example.com", "0")]);
    await planRun(second);
    expect((await getRun(second))?.totals).toMatchObject({ skipped: 1, pointsToImport: 0, membersToCreate: 0, membersToUpdate: 1 });
    await confirmRun(second, { tierFromSmile: false });
    await executeRun(second);
    expect(members()).toHaveLength(2);
    expect(ledger()).toHaveLength(1);
    expect(members().find((m) => m.shopify_customer_id === "1")?.points_balance).toBe(500);
    const totals = (await getRun(second))?.totals;
    expect(totals).toMatchObject({ importedPoints: 0, unexplained: 0 });
    expect(totals?.differences).toEqual([expect.objectContaining({ key: "already_imported", points: 800 })]);
  });

  it("resumes after a crash between adding the points and recording the row", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" } };
    const runId = await upload([line("1", "a@example.com", "500"), line("2", "b@example.com", "200")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    h.db.failNext("import_rows", "upsert", { code: "XX000", message: "connection lost" });
    await expect(executeRun(runId)).rejects.toThrow(/connection lost/);
    expect(ledger()).toHaveLength(2); // points are in, rows still say "matched"
    expect((await getRun(runId))?.status).toBe("running");

    expect(await executeRun(runId)).toEqual({ status: "completed" });
    expect(ledger()).toHaveLength(2);
    expect(members().map((m) => m.points_balance).sort()).toEqual([200, 500]);
    expect((await getRun(runId))?.totals).toMatchObject({ imported: 2, importedPoints: 700, unexplained: 0 });
  });

  it("marks the run failed when the worker gives up, and Resume continues it", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "500")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    await markRunFailed(runId, "worker died");
    expect(await getRun(runId)).toMatchObject({ status: "failed", error: "worker died" });
    expect(await createRun({ source: file([line("2", "b@example.com", "1")]) })).toMatchObject({ ok: false });
    expect(await resumeRun(runId)).toMatchObject({ ok: true });
    expect(queued.jobs.at(-1)).toEqual({ name: "execute", runId });
    expect(await executeRun(runId)).toEqual({ status: "completed" });
    expect(ledger()).toHaveLength(1);
  });

  it("records a row whose points cannot be added and retries it on request", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" } };
    const runId = await upload([line("1", "a@example.com", "500"), line("2", "b@example.com", "200")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    for (let i = 0; i < 3; i++) h.db.failNext("rpc:award_points", "select", { code: "XX000", message: "timeout" });
    const before = LIMITS.awardConcurrency;
    LIMITS.awardConcurrency = 1;
    await executeRun(runId);
    LIMITS.awardConcurrency = before;
    const run = await getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.totals).toMatchObject({ errors: 1, imported: 1, importedPoints: 200, unexplained: 0 });
    expect(run?.error).toMatch(/1 row/);

    expect(await resumeRun(runId)).toMatchObject({ ok: true });
    await executeRun(runId);
    expect((await getRun(runId))?.totals).toMatchObject({ errors: 0, imported: 2, importedPoints: 700 });
  });

  it("stops when the run is closed in the middle", async () => {
    shopify = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`u${i}@example.com`, { id: String(i + 1) }]));
    const runId = await upload(Array.from({ length: 5 }, (_, i) => line(String(i + 1), `u${i}@example.com`, "10")));
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    await discardRun(runId);
    expect(await executeRun(runId)).toEqual({ status: "cancelled" });
    expect(members()).toHaveLength(0);
  });

  it("survives a referral-slug clash and a member created by a webhook meanwhile", async () => {
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" } };
    const runId = await upload([line("1", "a@example.com", "5"), line("2", "b@example.com", "7")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    h.db.failNext("members", "insert", { code: "23505", message: 'duplicate key value violates unique constraint "members_referral_slug_key"' });
    seedMember(h.db, { shopify_customer_id: "2", email: "b@example.com", consent_source: "order" }); // appeared after the dry run
    await executeRun(runId);
    expect(members()).toHaveLength(2);
    expect(members().map((m) => m.points_balance).sort()).toEqual([5, 7]);
    expect((await getRun(runId))?.totals).toMatchObject({ imported: 2, errors: 0 });
  });
});

describe("tier option", () => {
  const lines = [line("1", "g@example.com", "100", "Gold Girl"), line("2", "d@example.com", "0", "DIAMOND"), line("3", "s@example.com", "5", "Silver")];
  beforeEach(() => {
    shopify = { "g@example.com": { id: "1" }, "d@example.com": { id: "2" }, "s@example.com": { id: "3" } };
  });

  it("off by default: everyone starts at silver", async () => {
    await fullRun(lines);
    expect(members().map((m) => m.tier)).toEqual(["silver", "silver", "silver"]);
    expect(h.db.table("tier_history")).toHaveLength(0);
  });

  it("on: gold and diamond names set the tier, never lower one, and issue no tier reward", async () => {
    const existing = seedMember(h.db, { shopify_customer_id: "1", email: "g@example.com", tier: "diamond" });
    const upgraded = seedMember(h.db, { shopify_customer_id: "2", email: "d@example.com", tier: "silver" });
    h.db.seed("points_ledger", { member_id: upgraded.id, action_type: "signup", reference_id: "2", points: 10, points_remaining: 10, balance_after: 10, expires_at: "2027-01-01T00:00:00Z" });
    await fullRun(lines, true);
    expect(members().find((m) => m.id === existing.id)?.tier).toBe("diamond");
    expect(members().find((m) => m.id === upgraded.id)?.tier).toBe("diamond");
    expect(members().find((m) => m.shopify_customer_id === "3")?.tier).toBe("silver");
    expect(h.db.table("tier_history").map((t) => [t.from_tier, t.to_tier])).toEqual([["silver", "diamond"]]);
    expect(h.db.table("points_ledger").find((l) => l.action_type === "signup")?.expires_at).toBeNull();
    expect(h.points.named("issue_tier_reward")).toHaveLength(0);
    expect(h.db.table("loyalty_codes")).toHaveLength(0);
  });

  it("on: a new member is created directly at the Smile tier", async () => {
    await fullRun(lines, true);
    expect(members().map((m) => [m.shopify_customer_id, m.tier])).toEqual([["1", "gold"], ["2", "diamond"], ["3", "silver"]]);
    expect(h.db.table("tier_history").map((t) => [t.from_tier, t.to_tier])).toEqual([["silver", "gold"], ["silver", "diamond"]]);
    expect(h.points.jobs).toHaveLength(0);
  });
});

describe("report and clean-up", () => {
  it("lists every row that was not imported and nothing else", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await fullRun([line("1", "a@example.com", "5"), line("2", "=evil@example.com", "7"), line("3", "", "1"), line("4", "a@example.com", "1")]);
    const { csv, rows } = await buildReportCsv(runId);
    expect(rows).toBe(3);
    const out = csv.split("\n");
    expect(out[0]).toBe("Row in file,Smile Customer ID,Email,Smile status,Points in file,Outcome,Why");
    expect(out[1]).toContain("3,2,'=evil@example.com,member,7,Unmatched,");
    expect(csv).not.toContain("a@example.com,member,5");
    expect(csv).toContain("Duplicate");
  });

  it("deletes the stored rows of a finished run only", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "5")]);
    expect(await purgeRunRows(runId)).toMatchObject({ ok: false });
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    await executeRun(runId);
    expect(await purgeRunRows(runId)).toMatchObject({ ok: true });
    expect(rowsOf(runId)).toHaveLength(0);
    expect((await getRun(runId))?.totals).toMatchObject({ imported: 1, importedPoints: 5 });
    expect(members()).toHaveLength(1);
  });
});

// ── Fix round (review items I2–I9) ────────────────────────────────────────

const httpParams = (code: number) => ({ message: `HTTP ${code}`, code, statusText: "x", body: {}, headers: {} });
const gqlError = (errors: Array<{ message: string; extensions?: { code?: string } }>) =>
  new GraphqlQueryError({
    message: errors[0].message, response: {} as never, headers: {},
    body: { errors: { graphQLErrors: errors }, extensions: { cost: { requestedQueryCost: 150, throttleStatus: { restoreRate: 100 } } } } as never,
  });
/** A client that behaves like the real one: it throws, it never returns `{ errors }`. */
function throwingAdmin(plan: (emails: string[], call: number) => Error | null) {
  const state = { calls: 0 };
  return {
    state,
    graphql: async (query: string, opts?: { variables?: Record<string, unknown> }) => {
      const vars = opts?.variables ?? {};
      const err = plan(Object.values(vars).map(String), ++state.calls);
      if (err) throw err;
      return { json: async () => ({ data: lookupHandler(query, vars) }) };
    },
  };
}

describe("I2: the real Shopify client throws", () => {
  it("classifies each thrown error", () => {
    expect(classifyLookupError(gqlError([{ message: "Throttled", extensions: { code: "THROTTLED" } }]))).toEqual({ kind: "throttled", waitMs: 1500 });
    expect(classifyLookupError(gqlError([{ message: "Email is invalid" }]))).toEqual({ kind: "query", message: "Email is invalid" });
    expect(classifyLookupError(new HttpThrottlingError({ ...httpParams(429), retryAfter: 2 }))).toEqual({ kind: "throttled", waitMs: 2000 });
    expect(classifyLookupError(new HttpInternalError(httpParams(502))).kind).toBe("transient");
    expect(classifyLookupError(new HttpResponseError(httpParams(403))).kind).toBe("fatal");
    expect(classifyLookupError(new Error("fetch failed")).kind).toBe("transient");
  });

  it("waits and retries on a thrown THROTTLED error and on a thrown 429", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const sleeps: number[] = [];
    pacing.sleep = async (ms) => void sleeps.push(ms);
    const admin = throwingAdmin((_e, call) =>
      call === 1 ? gqlError([{ message: "Throttled", extensions: { code: "THROTTLED" } }])
        : call === 2 ? new HttpThrottlingError({ ...httpParams(429), retryAfter: 3 }) : null);
    const res = await lookupCustomersByEmail(admin, ["a@example.com"]);
    expect(res.get("a@example.com")).toMatchObject({ id: "1" });
    expect(sleeps).toEqual([1500, 3000]);
    expect(admin.state.calls).toBe(3);
  });

  it("bisects on a thrown GraphQL error and isolates the one rejected address", async () => {
    const emails = Array.from({ length: 8 }, (_, i) => `u${i}@example.com`);
    for (const e of emails) shopify[e] = { id: e.slice(1, 2) + "0" };
    const admin = throwingAdmin((list) => (list.includes("u0@example.com") ? gqlError([{ message: "Email is invalid" }]) : null));
    const res = await lookupCustomersByEmail(admin, emails);
    expect(res.get("u0@example.com")).toBe("error"); // head of the list, nothing found yet: still not fatal
    expect(emails.slice(1).every((e) => typeof res.get(e) === "object")).toBe(true);
  });

  it("retries a thrown 5xx, then gives up so the job is retried; a 403 stops at once", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const flaky = throwingAdmin((_e, call) => (call <= 2 ? new HttpInternalError(httpParams(503)) : null));
    expect((await lookupCustomersByEmail(flaky, ["a@example.com"])).get("a@example.com")).toMatchObject({ id: "1" });
    const down = throwingAdmin(() => new HttpInternalError(httpParams(503)));
    await expect(lookupCustomersByEmail(down, ["a@example.com"])).rejects.toThrow(/lookup failed/);
    expect(down.state.calls).toBe(LIMITS.transientRetries + 1);
    const denied = throwingAdmin(() => new HttpResponseError(httpParams(403)));
    await expect(lookupCustomersByEmail(denied, ["a@example.com", "b@example.com"])).rejects.toThrow(/HTTP 403/);
    expect(denied.state.calls).toBe(1);
  });

  it("stops when every address is rejected and nothing was ever found", async () => {
    const admin = throwingAdmin(() => gqlError([{ message: "Access denied for customerByIdentifier field" }]));
    const emails = Array.from({ length: 20 }, (_, i) => `u${i}@example.com`);
    await expect(lookupCustomersByEmail(admin, emails)).rejects.toThrow(/Access denied/);
  });

  it("a rejected address at the head of the remaining rows marks that row and the dry run finishes", async () => {
    shopify = { "ok1@example.com": { id: "1" }, "ok2@example.com": { id: "2" } };
    const runId = await upload([line("1", "bad@example.com", "50"), line("2", "ok1@example.com", "10"), line("3", "ok2@example.com", "20")]);
    const admin = throwingAdmin((list) => (list.includes("bad@example.com") ? gqlError([{ message: "Email is invalid" }]) : null));
    expect(await planRun(runId, { admin })).toEqual({ status: "planned" });
    expect(rowsOf(runId).map((r) => [r.state, r.reason])).toEqual([
      ["unmatched", "shopify_lookup_error"], ["matched", null], ["matched", null],
    ]);
    const run = await getRun(runId);
    expect(run?.error).toMatch(/Email is invalid/);
    expect(run?.totals.differences).toContainEqual(expect.objectContaining({ key: "shopify_lookup_error", points: 50 }));
  });
});

describe("I3: resume, fixed job id and lease", () => {
  const started = async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "500")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    return runId;
  };

  it("refuses Resume while the run is still making progress", async () => {
    const runId = await started();
    const before = queued.jobs.length;
    expect(await resumeRun(runId)).toMatchObject({ ok: false, error: expect.stringMatching(/still working/) });
    expect(queued.jobs).toHaveLength(before);
  });

  it("refuses Resume when a job for the run is queued or active, even after the stall window", async () => {
    const runId = await started();
    queued.busy = true;
    const later = new Date(Date.now() + LIMITS.stallMs + 1000);
    expect(await resumeRun(runId, later)).toMatchObject({ ok: false, error: expect.stringMatching(/already queued or running/) });
    await markRunFailed(runId, "x");
    expect(await resumeRun(runId, later)).toMatchObject({ ok: false });
    expect((await getRun(runId))?.status).toBe("failed");
  });

  it("allows Resume once the run has stalled and no job is left", async () => {
    const runId = await started();
    const later = new Date(Date.now() + LIMITS.stallMs + 1000);
    expect(await resumeRun(runId, later)).toMatchObject({ ok: true });
    expect(queued.jobs.at(-1)).toEqual({ name: "execute", runId });
  });

  it("a second worker cannot process a run another worker holds, and takes over when the lease expires", async () => {
    const runId = await started();
    const run = h.db.table("import_runs").find((r) => r.id === runId)!;
    Object.assign(run, { locked_by: "worker-b", locked_until: new Date(Date.now() + 60_000).toISOString() });
    await expect(executeRun(runId)).rejects.toBeInstanceOf(ImportLockedError);
    expect(ledger()).toHaveLength(0);
    expect(await resumeRun(runId, new Date(Date.now() + 30_000))).toMatchObject({ ok: false });

    run.locked_until = new Date(Date.now() - 1000).toISOString(); // worker-b died
    expect(await executeRun(runId)).toEqual({ status: "completed" });
    expect(ledger()).toHaveLength(1);
    expect(run).toMatchObject({ locked_by: null, locked_until: null }); // released
  });

  it("a worker that lost its lease stops instead of working beside the new owner", async () => {
    shopify = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`u${i}@example.com`, { id: String(i + 1) }]));
    const runId = await upload(Array.from({ length: 3 }, (_, i) => line(String(i + 1), `u${i}@example.com`, "10")));
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    const before = LIMITS.executeBatch;
    LIMITS.executeBatch = 1;
    const run = h.db.table("import_runs").find((r) => r.id === runId)!;
    const realRpc = h.db.rpc.bind(h.db);
    // After the first award another worker takes the run over.
    h.db.rpc = async (fn: string, args: Record<string, unknown>) => {
      const res = await realRpc(fn, args);
      run.locked_by = "worker-b";
      return res;
    };
    await expect(executeRun(runId)).rejects.toBeInstanceOf(ImportLockedError);
    LIMITS.executeBatch = before;
    expect(ledger()).toHaveLength(1);
    expect(run.locked_by).toBe("worker-b"); // not released by the loser
  });

  it("the dry run takes the same lease", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "5")]);
    Object.assign(h.db.table("import_runs")[0], { locked_by: "worker-b", locked_until: new Date(Date.now() + 60_000).toISOString() });
    await expect(planRun(runId)).rejects.toBeInstanceOf(ImportLockedError);
    expect(h.graphqlCalls).toHaveLength(0);
  });
});

describe("I4: opted-out and blocked members", () => {
  it("receive no Smile points; the dry run names them and the reconciliation explains them", async () => {
    const out = seedMember(h.db, { shopify_customer_id: "1", email: "out@example.com", opted_out: true, points_balance: 5 });
    const blocked = seedMember(h.db, { shopify_customer_id: "2", email: "blocked@example.com", is_blocked: true });
    shopify = { "out@example.com": { id: "1" }, "blocked@example.com": { id: "2" }, "ok@example.com": { id: "3" } };
    const runId = await upload([line("1", "out@example.com", "300"), line("2", "blocked@example.com", "200"), line("3", "ok@example.com", "100")]);
    await planRun(runId);
    expect(rowsOf(runId).map((r) => [r.state, r.reason])).toEqual([
      ["skipped", "member_opted_out"], ["skipped", "member_blocked"], ["matched", null],
    ]);
    expect((await getRun(runId))?.totals).toMatchObject({ pointsToImport: 100, skipped: 2 });
    await confirmRun(runId, { tierFromSmile: false });
    await executeRun(runId);
    expect(members().find((m) => m.id === out.id)).toMatchObject({ points_balance: 5, imported_from_smile: false });
    expect(members().find((m) => m.id === blocked.id)).toMatchObject({ points_balance: 0, imported_from_smile: false });
    const totals = (await getRun(runId))?.totals;
    expect(totals).toMatchObject({ importedPoints: 100, unexplained: 0 });
    expect(Object.fromEntries((totals?.differences ?? []).map((d) => [d.key, d.points]))).toEqual({ member_opted_out: 300, member_blocked: 200 });
    const { csv } = await buildReportCsv(runId);
    expect(csv).toMatch(/opted out/);
    expect(csv).toMatch(/blocked/);
  });

  it("a member blocked after the dry run is skipped by the import too", async () => {
    const m = seedMember(h.db, { shopify_customer_id: "1", email: "a@example.com" });
    shopify = { "a@example.com": { id: "1" } };
    const runId = await upload([line("1", "a@example.com", "300")]);
    await planRun(runId);
    m.is_blocked = true;
    await confirmRun(runId, { tierFromSmile: false });
    await executeRun(runId);
    expect(ledger()).toHaveLength(0);
    expect(rowsOf(runId)[0]).toMatchObject({ state: "skipped", reason: "member_blocked" });
    expect(m).toMatchObject({ points_balance: 0, imported_from_smile: false });
  });
});

describe("I5: personal data retention", () => {
  it("discarding a dry run deletes every stored row", async () => {
    shopify = { "a@example.com": { id: "1", phone: "+923001234567" } };
    const runId = await upload([line("1", "a@example.com", "5"), line("2", "", "1")]);
    await planRun(runId);
    expect(rowsOf(runId)[0].shopify_phone).toBe("+923001234567");
    expect(await discardRun(runId)).toMatchObject({ ok: true });
    expect(rowsOf(runId)).toHaveLength(0);
    expect((await getRun(runId))?.rows_purged_at).toBeTruthy();
  });

  it("stopping an import removes the Shopify name and phone but keeps the report rows", async () => {
    shopify = { "a@example.com": { id: "1", phone: "+923001234567" } };
    const runId = await upload([line("1", "a@example.com", "5")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: false });
    await discardRun(runId);
    expect(rowsOf(runId)).toHaveLength(1);
    expect(rowsOf(runId)[0]).toMatchObject({ shopify_first_name: null, shopify_last_name: null, shopify_phone: null, email: "a@example.com" });
  });

  it("a finished run holds no name or phone, and its rows are deleted after the retention period", async () => {
    shopify = { "a@example.com": { id: "1", phone: "+923001234567" }, "b@example.com": { id: "1", email: "b@example.com", phone: "+923001234567" } };
    const runId = await fullRun([line("1", "a@example.com", "5"), line("2", "b@example.com", "1"), line("3", "", "1")]);
    expect(rowsOf(runId)).toHaveLength(3);
    expect(rowsOf(runId).every((r) => !r.shopify_first_name && !r.shopify_last_name && !r.shopify_phone)).toBe(true);

    const day = 86_400_000;
    expect(await purgeExpiredRows(new Date(Date.now() + (LIMITS.retentionDays - 1) * day))).toBe(0);
    expect(rowsOf(runId)).toHaveLength(3);
    expect(await purgeExpiredRows(new Date(Date.now() + (LIMITS.retentionDays + 1) * day))).toBe(1);
    expect(rowsOf(runId)).toHaveLength(0);
    const run = await getRun(runId);
    expect(run?.rows_purged_at).toBeTruthy();
    expect(run?.totals).toMatchObject({ imported: 1, importedPoints: 5 }); // totals stay
    expect(await purgeExpiredRows(new Date(Date.now() + 90 * day))).toBe(0);
    expect(await resumeRun(runId)).toMatchObject({ ok: false });
  });

  it("never purges an open run", async () => {
    const runId = await upload([line("1", "a@example.com", "5")]);
    expect(await purgeExpiredRows(new Date(Date.now() + 365 * 86_400_000))).toBe(0);
    expect(rowsOf(runId)).toHaveLength(1);
  });
});

describe("I6: welcome bonus order", () => {
  it("the dry run counts matched members who already have the welcome bonus", async () => {
    const welcomed = seedMember(h.db, { shopify_customer_id: "1", email: "a@example.com", points_balance: 1000 });
    h.db.seed("points_ledger", { member_id: welcomed.id, action_type: "signup", reference_id: "1", points: 1000, points_remaining: 1000, balance_after: 1000 });
    seedMember(h.db, { shopify_customer_id: "2", email: "b@example.com" });
    shopify = { "a@example.com": { id: "1" }, "b@example.com": { id: "2" }, "c@example.com": { id: "3" } };
    const runId = await upload([line("1", "a@example.com", "300"), line("2", "b@example.com", "10"), line("3", "c@example.com", "10")]);
    await planRun(runId);
    expect((await getRun(runId))?.totals).toMatchObject({ welcomeAlready: 1, matched: 3 });
    await confirmRun(runId, { tierFromSmile: false });
    await executeRun(runId);
    // She keeps the welcome bonus and gets her Smile points on top.
    expect(members().find((m) => m.id === welcomed.id)?.points_balance).toBe(1300);
    expect((await getRun(runId))?.totals).toMatchObject({ welcomeAlready: 1 });
  });

  it("reports whether customers are already signing in", async () => {
    expect(await getLaunchState()).toEqual({ welcomeBonusesGiven: 0, signedInMembers: 0 });
    const m = seedMember(h.db, { consent_source: "signin" });
    seedMember(h.db, { consent_source: "order" });
    h.db.seed("points_ledger", { member_id: m.id, action_type: "signup", reference_id: "x", points: 1000, balance_after: 1000 });
    // Redeeming paused (rule 20) changes nothing here.
    h.db.table("app_settings")[0].program_enabled = false;
    bustSettingsCache();
    expect(await getLaunchState()).toEqual({ welcomeBonusesGiven: 1, signedInMembers: 1 });
  });
});

describe("I7: reconciliation includes rejected rows", () => {
  it("counts a repeated Smile id and a row with the wrong column count in the file total", async () => {
    shopify = { "a@example.com": { id: "1" } };
    const runId = await fullRun([
      line("1", "a@example.com", "100"),
      line("1", "again@example.com", '"2,500"'), // same Smile id
      '9,Short,Row,short@example.com,member,"1,200"', // 6 columns
      line("5", "c@example.com", "lots"),
    ]);
    const totals = (await getRun(runId))?.totals;
    expect(totals).toMatchObject({ filePoints: 3800, importedPoints: 100, invalid: 3, pointsUnreadable: 1, unexplained: 0 });
    expect(Object.fromEntries((totals?.differences ?? []).map((d) => [d.key, d.points]))).toEqual({ duplicate_smile_id: 2500, wrong_column_count: 1200 });
  });
});

describe("I9: tier history and file encoding", () => {
  it("a failure between creating the member and raising the tier loses nothing", async () => {
    shopify = { "g@example.com": { id: "1" } };
    const runId = await upload([line("1", "g@example.com", "100", "Gold")]);
    await planRun(runId);
    await confirmRun(runId, { tierFromSmile: true });
    h.db.failNext("rpc:upgrade_member_tier", "select", { code: "XX000", message: "connection lost" });
    await executeRun(runId);
    // Member exists at Silver, no history, no points; the row is marked failed.
    expect(members()[0]).toMatchObject({ tier: "silver", points_balance: 0 });
    expect(h.db.table("tier_history")).toHaveLength(0);
    expect(rowsOf(runId)[0].state).toBe("error");

    expect(await resumeRun(runId)).toMatchObject({ ok: true });
    await executeRun(runId);
    expect(members()).toHaveLength(1);
    expect(members()[0]).toMatchObject({ tier: "gold", points_balance: 100 });
    expect(h.db.table("tier_history").map((t) => [t.member_id, t.from_tier, t.to_tier])).toEqual([[members()[0].id, "silver", "gold"]]);
    expect(h.db.rpcCalls.filter((c) => c.fn === "upgrade_member_tier")).toHaveLength(2);
    expect(h.points.named("issue_tier_reward")).toHaveLength(0);
  });

  it("refuses a file that is not UTF-8", async () => {
    const latin1 = Buffer.from(`${HEAD}\n${line("1", "josé@example.com", "5")}\n`, "latin1");
    expect(await createRun({ source: [new Uint8Array(latin1)] })).toEqual({ ok: false, error: NOT_UTF8 });
    const replaced = `${HEAD}\n${line("1", "jos�@example.com", "5")}\n`;
    expect(await createRun({ source: [new TextEncoder().encode(replaced)] })).toEqual({ ok: false, error: NOT_UTF8 });
    expect(h.db.table("import_runs")).toHaveLength(0);
    const fine = await createRun({ source: [new TextEncoder().encode(`${HEAD}\n${line("1", "josé@example.com", "5")}\n`)] });
    expect(fine.ok).toBe(true);
  });
});
