// app/lib/schema-check.server.ts
// Review 13: the worker checks that migration 017_referral_payment.sql is in
// the database (hg_schema_version() = 17: pay_referral, release_referral_claim,
// reverse_referral and referrals.completion_email_queued_at all present) at
// start and before every 10-minute sweep. Missing: a loud error in the log and
// the alert heartbeat `alert:schema_017` (System health, staff morning email);
// the referral sweeps are skipped until it is there. Present: the alert is
// removed. A check that cannot be made (database unreachable) raises nothing.
import { db } from "../db.server";
import { clearHeartbeat, recordHeartbeat } from "./heartbeat.server";

export const REQUIRED_SCHEMA_VERSION = 17;
export const SCHEMA_MIGRATION_FILE = "017_referral_payment.sql";
export const SCHEMA_ALERT_KEY = "alert:schema_017";

export type SchemaCheck =
  | { status: "ok"; version: number }
  | { status: "missing"; version: number | null }
  | { status: "unknown"; error: string };

/** PostgREST "function not in the schema cache" (PGRST202) or Postgres undefined_function (42883). */
export function isMissingFunctionError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

export async function readSchemaVersion(): Promise<SchemaCheck> {
  try {
    const { data, error } = await db.rpc("hg_schema_version");
    if (error) {
      if (isMissingFunctionError(error)) return { status: "missing", version: null };
      return { status: "unknown", error: error.message };
    }
    const v = Number(Array.isArray(data) ? data[0] : data);
    if (!Number.isFinite(v)) return { status: "unknown", error: "hg_schema_version returned no number" };
    return v >= REQUIRED_SCHEMA_VERSION ? { status: "ok", version: v } : { status: "missing", version: v };
  } catch (err) {
    return { status: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Check, log and raise or clear the alert. Never throws. */
export async function verifyReferralSchema(when: "startup" | "sweep"): Promise<SchemaCheck> {
  const r = await readSchemaVersion();
  if (r.status === "missing") {
    console.error(
      `[schema] ERROR (${when}): migration ${SCHEMA_MIGRATION_FILE} is NOT applied to this database ` +
        `(hg_schema_version: ${r.version ?? "not found"}, need ${REQUIRED_SCHEMA_VERSION}). ` +
        "Referral rewards cannot be paid or reversed until it is applied in the Supabase SQL editor; the referral sweeps are paused.",
    );
    await recordHeartbeat(SCHEMA_ALERT_KEY, {
      migration: SCHEMA_MIGRATION_FILE,
      found: r.version ?? "none",
      note: `Apply ${SCHEMA_MIGRATION_FILE} in the Supabase SQL editor; referral rewards are waiting`,
    });
  } else if (r.status === "ok") {
    await clearHeartbeat(SCHEMA_ALERT_KEY);
  } else {
    console.error(`[schema] could not check for migration ${SCHEMA_MIGRATION_FILE} (${when}): ${r.error}; will check again`);
  }
  return r;
}
