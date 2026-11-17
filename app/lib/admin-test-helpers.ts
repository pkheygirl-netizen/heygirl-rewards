// Test helper for the admin libraries: a stand-in for the Supabase client that
// records every call and answers from a script. Used with vi.doMock("../db.server").
import { vi } from "vitest";

export type Call = { table?: string; rpc?: string; args?: unknown; chain: Array<[string, unknown[]]> };
type Answer = { data?: unknown; count?: number | null; error?: { message: string; code?: string } | null };
type Script = {
  /** answer for db.rpc(name, args) */
  rpc?: (name: string, args: Record<string, unknown>) => Answer;
  /** answer for a query on db.from(table); `chain` is the calls made so far */
  from?: (table: string, chain: Array<[string, unknown[]]>) => Answer;
};

const CHAIN_METHODS = [
  "select", "insert", "update", "upsert", "delete", "eq", "neq", "gt", "gte", "lt", "lte", "in", "is", "or",
  "not", "order", "limit", "range", "ilike",
] as const;

export function fakeDb(script: Script = {}) {
  const calls: Call[] = [];
  const full = (a: Answer) => ({ data: a.data ?? null, count: a.count ?? null, error: a.error ?? null });

  const from = vi.fn((table: string) => {
    const call: Call = { table, chain: [] };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const m of CHAIN_METHODS) {
      builder[m] = (...args: unknown[]) => {
        call.chain.push([m, args]);
        return builder;
      };
    }
    const answer = () => full(script.from ? script.from(table, call.chain) : {});
    builder.maybeSingle = () => {
      call.chain.push(["maybeSingle", []]);
      return Promise.resolve(answer());
    };
    builder.single = builder.maybeSingle;
    // A query is awaited directly: make the builder thenable.
    builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(answer()).then(resolve, reject);
    return builder;
  });

  const rpc = vi.fn((name: string, args: Record<string, unknown> = {}) => {
    calls.push({ rpc: name, args, chain: [] });
    return Promise.resolve(full(script.rpc ? script.rpc(name, args) : {}));
  });

  return {
    db: { from, rpc },
    calls,
    rpcCalls: (name: string) => calls.filter((c) => c.rpc === name),
    tableCalls: (table: string) => calls.filter((c) => c.table === table),
    /** arguments of the first chained call to `method` on `table`, e.g. the update payload */
    firstArg: (table: string, method: string): unknown => {
      for (const c of calls) {
        if (c.table !== table) continue;
        const hit = c.chain.find(([m]) => m === method);
        if (hit) return hit[1][0];
      }
      return undefined;
    },
  };
}

/** A form made from a plain object, as an action receives it. */
export function formOf(fields: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string) => (name in fields ? fields[name] : null) };
}
