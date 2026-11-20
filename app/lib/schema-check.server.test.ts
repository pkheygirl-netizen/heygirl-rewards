import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.server", async () => (await import("./testing/harness")).dbModule());

import { h, resetHarness } from "./testing/harness";
import { classifyHeartbeats, summariseHealth } from "./admin-health.server";
import { isMissingFunctionError, readSchemaVersion, SCHEMA_ALERT_KEY, verifyReferralSchema } from "./schema-check.server";

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetHarness();
  err = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("review 13: worker self-check for migration 017", () => {
  it("017 in place (hg_schema_version = 17): ok, no alert, an earlier alert is removed", async () => {
    h.db.seed("system_heartbeat", { key: SCHEMA_ALERT_KEY, at: new Date().toISOString(), detail: {} });
    expect(await verifyReferralSchema("startup")).toEqual({ status: "ok", version: 17 });
    expect(h.db.table("system_heartbeat").find((r) => r.key === SCHEMA_ALERT_KEY)).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it("function missing (PGRST202): a loud error naming the migration file and alert:schema_017, shown by System health", async () => {
    h.db.schemaVersion = null;
    expect(await verifyReferralSchema("startup")).toEqual({ status: "missing", version: null });
    expect(String(err.mock.calls[0][0])).toContain("migration 017_referral_payment.sql is NOT applied");
    const alert = h.db.table("system_heartbeat").find((r) => r.key === SCHEMA_ALERT_KEY);
    expect(alert).toMatchObject({ detail: { migration: "017_referral_payment.sql", found: "none" } });
    const views = classifyHeartbeats([{ key: String(alert!.key), at: String(alert!.at), detail: alert!.detail as Record<string, unknown> }]);
    expect(views[0]).toMatchObject({ kind: "alert" });
    expect(views[0].detail).toContain("017_referral_payment.sql");
    expect(summariseHealth(views, 0).status).toBe("attention");
  });

  it("a partly applied 017 (version 16: a function or the column missing) is missing too", async () => {
    h.db.schemaVersion = 16;
    expect(await readSchemaVersion()).toEqual({ status: "missing", version: 16 });
    await verifyReferralSchema("sweep");
    expect(h.db.table("system_heartbeat").find((r) => r.key === SCHEMA_ALERT_KEY)).toMatchObject({ detail: { found: 16 } });
  });

  it("the database cannot be asked: unknown, logged, no alert raised or removed", async () => {
    h.db.seed("system_heartbeat", { key: SCHEMA_ALERT_KEY, at: new Date().toISOString(), detail: {} });
    h.db.failNext("rpc:hg_schema_version", "select", { code: "08006", message: "connection reset" });
    expect(await verifyReferralSchema("sweep")).toEqual({ status: "unknown", error: "connection reset" });
    expect(h.db.table("system_heartbeat").find((r) => r.key === SCHEMA_ALERT_KEY)).toBeDefined();
  });

  it("recognises PostgREST and Postgres 'function missing' errors only", () => {
    expect(isMissingFunctionError({ code: "PGRST202", message: "Could not find the function public.hg_schema_version without parameters in the schema cache" })).toBe(true);
    expect(isMissingFunctionError({ code: "42883", message: "function public.hg_schema_version() does not exist" })).toBe(true);
    expect(isMissingFunctionError({ code: "08006", message: "connection reset" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });
});
