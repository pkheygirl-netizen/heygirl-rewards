import { db } from "../db.server";
import type { Json } from "../database.types";

/**
 * Write (or overwrite) one heartbeat row. Never throws: a monitoring write
 * must not fail the job it is reporting on.
 */
export async function recordHeartbeat(key: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const { error } = await db
      .from("system_heartbeat")
      .upsert({ key, at: new Date().toISOString(), detail: detail as Json }, { onConflict: "key" });
    if (error) console.error(`[heartbeat] ${key} not written:`, error.message);
  } catch (err) {
    console.error(`[heartbeat] ${key} not written:`, err instanceof Error ? err.message : err);
  }
}

export async function readHeartbeats(): Promise<Array<{ key: string; at: string; detail: Record<string, unknown> }>> {
  const { data, error } = await db.from("system_heartbeat").select("key, at, detail").order("key", { ascending: true });
  if (error) throw new Error(`could not read heartbeats: ${error.message}`);
  return (data ?? []).map((r) => ({
    key: r.key,
    at: r.at,
    detail: r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {},
  }));
}
