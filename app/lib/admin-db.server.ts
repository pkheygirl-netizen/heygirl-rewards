// app/lib/admin-db.server.ts
// The admin reads tables, columns and SQL functions added by migrations 010 and
// 011. The generated Database type is owned by another workstream and may lag
// behind those migrations, so the admin talks to the same service client through
// an untyped handle and types each result where it is read.
import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../db.server";

// `any` is unavoidable here: it is the schema parameter of the untyped client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseClient = SupabaseClient<any, "public", any>;

/** Resolved on each call so tests can replace `../db.server` with a mock. */
export function adb(): LooseClient {
  return db as unknown as LooseClient;
}

export type Row = Record<string, unknown>;

/** Call a SQL function that returns rows. */
export async function rpcRows<T = Row>(fn: string, args: Record<string, unknown> = {}): Promise<T[]> {
  const { data, error } = await adb().rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  if (data === null || data === undefined) return [];
  return (Array.isArray(data) ? data : [data]) as T[];
}

/** Call a SQL function that returns one jsonb object. */
export async function rpcObject(fn: string, args: Record<string, unknown> = {}): Promise<Row> {
  const { data, error } = await adb().rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  const v = Array.isArray(data) ? data[0] : data;
  return v && typeof v === "object" ? (v as Row) : {};
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

export function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

export function memberName(m: {
  first_name?: unknown; last_name?: unknown; email?: unknown; phone?: unknown;
} | null | undefined): string {
  if (!m) return "Customer";
  const full = [m.first_name, m.last_name].map(str).filter(Boolean).join(" ").trim();
  return full || str(m.email) || str(m.phone) || "Customer";
}

/** Numeric part of a Shopify customer id, whether stored bare or as a gid. */
export function shopifyNumericId(id: unknown): string {
  const m = /(\d+)\s*$/.exec(str(id));
  return m ? m[1] : "";
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
