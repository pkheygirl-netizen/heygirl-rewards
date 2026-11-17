// app/widget/member-cache.ts
// sessionStorage cache for the signed-in member payload: five minutes, keyed by
// customer id, dropped on sign-out and after any action that changes it.
import { CACHE_TTL_MS, type MemberData } from "./shared";

export const CACHE_PREFIX = "hg_m:";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function cacheKey(customerId: string): string {
  return CACHE_PREFIX + customerId;
}

export function readCache(store: StorageLike, customerId: string, now: number = Date.now()): MemberData | null {
  try {
    const raw = store.getItem(cacheKey(customerId));
    if (!raw) return null;
    const v = JSON.parse(raw) as { t: number; d: MemberData };
    if (!v || typeof v.t !== "number" || now - v.t > CACHE_TTL_MS || now < v.t) return null;
    return v.d;
  } catch {
    return null;
  }
}

export function writeCache(store: StorageLike, customerId: string, d: MemberData, now: number = Date.now()): void {
  try {
    store.setItem(cacheKey(customerId), JSON.stringify({ t: now, d }));
  } catch {
    /* storage full or blocked: the widget simply refetches */
  }
}

/** Removes every member entry except `keepCustomerId` (pass null on sign-out). */
export function purgeCache(store: StorageLike, keepCustomerId: string | null): void {
  try {
    const drop: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && k.indexOf(CACHE_PREFIX) === 0 && k !== (keepCustomerId ? cacheKey(keepCustomerId) : "")) drop.push(k);
    }
    for (const k of drop) store.removeItem(k);
  } catch {
    /* noop */
  }
}
